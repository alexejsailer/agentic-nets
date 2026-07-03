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
import type { McpConfig } from './config.js';
import { scopeFromConfig, type ModelScope } from './scope.js';

export class AppContext {
  readonly client: GatewayClient;
  readonly master: MasterApi;
  readonly node: NodeApi;
  readonly scope: ModelScope;
  private readonly executors = new Map<string, ToolExecutor>();

  constructor(readonly config: McpConfig) {
    this.client = new GatewayClient({
      gatewayUrl: config.gatewayUrl,
      profileName: config.mode === 'readonly' ? 'mcp-readonly' : 'mcp',
      clientId: config.mode === 'readonly' ? 'agenticos-readonly' : 'agenticos-admin',
    });
    this.master = new MasterApi(this.client);
    this.node = new NodeApi(this.client);
    this.scope = scopeFromConfig(config);
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

  /** Inscription host string for a model: `{model}@{nodeHost}`. */
  hostFor(modelId: string): string {
    return `${modelId}@${this.config.nodeHost}`;
  }
}
