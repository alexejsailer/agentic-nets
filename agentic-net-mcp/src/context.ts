/**
 * AppContext — shared clients for all tool handlers.
 *
 * Reuses the CLI's transport stack: GatewayClient (OAuth2 auto-auth via
 * AGENTICOS_ADMIN_SECRET / AGENTICOS_GATEWAY_SECRET_FILE), typed MasterApi /
 * NodeApi wrappers, and ToolExecutor (which pins modelId per instance — hence
 * the lazy per-model map; the scope guard validates the model BEFORE
 * executorFor() is ever called, so out-of-allowlist models never instantiate
 * anything).
 */
import { GatewayClient } from '@agenticos/cli/gateway/client';
import { MasterApi } from '@agenticos/cli/gateway/master-api';
import { NodeApi } from '@agenticos/cli/gateway/node-api';
import { ToolExecutor } from '@agenticos/cli/agent/tool-executor';
import type { LlmProvider } from '@agenticos/cli/llm/provider';
import type { McpConfig } from './config.js';
import { scopeFromConfig, type ModelScope } from './scope.js';
import type { HostedRunner } from './tools/hosted.js';

/**
 * GatewayClient that reroutes node event execution (POST /node-api/events/
 * execute/{modelId}) through master's events proxy (POST /api/proxy/events/
 * {modelId}/execute). Same request/response contract — the proxy delegates to
 * the identical node endpoint — but master publishes every mutation to the
 * model event line on the way through. Node-direct writes bypass that line,
 * which left MCP-written tokens without event_trail provenance and broke the
 * "auditably answer why memory says X" promise. All CLI helpers the MCP
 * reuses (ToolExecutor, NodeApi) funnel node traffic through this one method,
 * so every mutating tool is covered without forking the CLI transport.
 */
export class AuditedGatewayClient extends GatewayClient {
  constructor(options: any, private readonly mcpSessionId: string) {
    super(options);
  }

  override async nodeApi<T = any>(
    method: string,
    path: string,
    body?: any,
    query?: Record<string, string>,
  ): Promise<T> {
    const events = /^\/events\/execute\/([^/?]+)$/.exec(path);
    if (events && method.toUpperCase() === 'POST') {
      const auditedBody = {
        ...(body ?? {}),
        options: {
          ...(body?.options ?? {}),
          sessionId: body?.options?.sessionId ?? this.mcpSessionId,
          source: body?.options?.source ?? 'mcp',
        },
      };
      return this.masterApi<T>('POST', `/proxy/events/${events[1]}/execute`, auditedBody, query);
    }
    return super.nodeApi<T>(method, path, body, query);
  }
}

export class AppContext {
  readonly client: GatewayClient;
  readonly master: MasterApi;
  readonly node: NodeApi;
  readonly scope: ModelScope;
  private readonly executors = new Map<string, ToolExecutor>();
  private activeExternalAgent?: {
    model: string;
    transitionId: string;
    fireId: string;
    sessionId?: string;
    allowedTools: Set<string>;
  };

  constructor(readonly config: McpConfig) {
    this.client = new AuditedGatewayClient({
      gatewayUrl: config.gatewayUrl,
      profileName: config.mode === 'readonly' ? 'mcp-readonly' : 'mcp',
      clientId: config.mode === 'readonly' ? 'agenticos-readonly' : 'agenticos-admin',
    }, config.session);
    this.master = new MasterApi(this.client);
    this.node = new NodeApi(this.client);
    this.scope = scopeFromConfig(config);
    this.scope.toolGuard = (model, spec, args) =>
      this.guardExternalAgentTool(model, spec.name, args);
  }

  /** One ToolExecutor per allowed model, created on first use. */
  executorFor(modelId: string): ToolExecutor {
    let executor = this.executors.get(modelId);
    if (!executor) {
      executor = new ToolExecutor(this.client, modelId, this.config.session);
      this.executors.set(modelId, executor);
    }
    return executor;
  }

  activateExternalAgentFire(
    model: string,
    prepared: { transitionId: string; fireId: string; sessionId?: string; allowedTools?: string[] },
  ): void {
    if (
      this.activeExternalAgent &&
      (this.activeExternalAgent.fireId !== prepared.fireId ||
        this.activeExternalAgent.model !== model)
    ) {
      throw new Error(
        `external agent fire '${this.activeExternalAgent.fireId}' is still active; ` +
          'complete or abandon it before preparing another agent fire',
      );
    }
    this.activeExternalAgent = {
      model,
      transitionId: prepared.transitionId,
      fireId: prepared.fireId,
      sessionId: prepared.sessionId,
      allowedTools: new Set((prepared.allowedTools ?? []).map((name) => name.toUpperCase())),
    };
  }

  /** True when (model, transitionId, fireId) is the agent fire THIS process prepared and still holds. */
  isActiveAgentFire(model: string, transitionId: string, fireId: string): boolean {
    const active = this.activeExternalAgent;
    return Boolean(
      active &&
        active.model === model &&
        active.transitionId === transitionId &&
        active.fireId === fireId,
    );
  }

  clearExternalAgentFire(model: string, transitionId: string, fireId: string): void {
    const active = this.activeExternalAgent;
    if (
      active &&
      active.model === model &&
      active.transitionId === transitionId &&
      active.fireId === fireId
    ) {
      this.activeExternalAgent = undefined;
    }
  }

  private async guardExternalAgentTool(
    model: string,
    toolName: string,
    args: Record<string, any>,
  ): Promise<void> {
    const active = this.activeExternalAgent;
    if (!active) return;
    if (model !== active.model) {
      throw new Error(
        `external agent fire '${active.fireId}' is scoped to model '${active.model}'`,
      );
    }

    if (toolName === 'complete_external_fire' || toolName === 'abandon_external_fire') {
      if (
        String(args.transitionId ?? '') !== active.transitionId ||
        String(args.fireId ?? '') !== active.fireId
      ) {
        throw new Error(
          `active external agent fire is ${active.transitionId}/${active.fireId}; ` +
            `${toolName} must target that fire`,
        );
      }
      return;
    }
    if (
      toolName === 'prepare_external_fire' ||
      toolName === 'set_external' ||
      toolName === 'host_transition' ||
      toolName === 'unhost_transition'
    ) {
      throw new Error(
        `external agent fire '${active.fireId}' is active; complete or abandon it first`,
      );
    }

    const canonicalTool = toolName.toUpperCase();
    if (!active.allowedTools.has(canonicalTool)) {
      throw new Error(
        `tool '${toolName}' is not granted to external fire '${active.fireId}'. ` +
          `Use one of: ${[...active.allowedTools].sort().join(', ')}`,
      );
    }
    const { model: _model, ...params } = args ?? {};
    const authorization: any = await this.client.masterApi(
      'POST',
      `/transitions/${encodeURIComponent(active.transitionId)}/external/authorize-tool`,
      {
        modelId: model,
        fireId: active.fireId,
        tool: canonicalTool,
        params,
        sessionId: active.sessionId ?? this.config.session,
      },
    );
    if (!authorization?.allowed) {
      throw new Error(
        `master denied ${canonicalTool}: ${authorization?.reason ?? 'capability policy rejected it'}`,
      );
    }
  }

  /** Inscription host string for a model: `{model}@{nodeHost}`. */
  hostFor(modelId: string): string {
    return `${modelId}@${this.config.nodeHost}`;
  }

  /**
   * Cache of runtime places already confirmed to exist, per model. The memory
   * write hot path re-ensures the same places on every call (container walk +
   * CREATE_RUNTIME_PLACE existence check ≈ 3 node round-trips); once confirmed,
   * subsequent writes to that place skip all of it. Keyed model + NUL + placeId (NUL cannot appear in either id, so keys never collide).
   * Never caches a NEGATIVE (a place could be created out-of-band), so it can
   * only avoid redundant work, never mask a missing place.
   */
  private readonly knownPlaces = new Set<string>();
  private placeKey(modelId: string, placeId: string): string {
    return `${modelId}\u0000${placeId}`;
  }
  placeKnown(modelId: string, placeId: string): boolean {
    return this.knownPlaces.has(this.placeKey(modelId, placeId));
  }
  markPlaceKnown(modelId: string, placeId: string): void {
    this.knownPlaces.add(this.placeKey(modelId, placeId));
  }

  /**
   * Client-hosted transition runners (host_transition): this process acts as
   * the executor for these llm/agent transitions, keyed `${model}::${tid}`.
   * The provider is built lazily from AGENTICOS_LLM_* config on first use.
   */
  readonly hostedRunners = new Map<string, HostedRunner>();
  hostedLlm?: LlmProvider;
}
