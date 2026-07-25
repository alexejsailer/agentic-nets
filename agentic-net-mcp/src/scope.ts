/**
 * The model-scope chokepoint. EVERY tool handler is registered through wrapTool(),
 * which (a) resolves and validates the target model against the allowlist — even a
 * `model` argument smuggled past the advertised schema is checked — and (b) rejects
 * mutating tools in readonly mode before any network call is made.
 *
 * Honest security note (documented in the README): the underlying gateway credential
 * is not model-scoped (the stack has no per-model authz today), so this guard protects
 * against LLM mistakes and prompt-injection through the MCP client — not against a
 * malicious operator of this process.
 */
import type { McpConfig } from './config.js';

export interface ModelScope {
  allowed: string[];
  defaultModel: string;
  multiModel: boolean;
  /** Optional per-call gate installed by AppContext (used by active external agent fires). */
  toolGuard?: (model: string, spec: ToolSpec, args: Record<string, any>) => Promise<void>;
}

export function scopeFromConfig(
  config: Pick<McpConfig, 'models'> & Partial<Pick<McpConfig, 'allowModelCreate'>>,
): ModelScope {
  return {
    allowed: [...config.models],
    defaultModel: config.models[0],
    // With model creation enabled, tools must expose a `model` param even for a
    // single-model allowlist — otherwise a freshly created model would be
    // unreachable (schemas are fixed at registration time).
    multiModel: config.models.length > 1 || config.allowModelCreate === true,
  };
}

/**
 * Grow the allowlist at runtime — ONLY for models created through create_model
 * in this session. Never widens access to pre-existing, un-listed models.
 */
export function grantModel(scope: ModelScope, modelId: string): void {
  if (!scope.allowed.includes(modelId)) scope.allowed.push(modelId);
}

export class ScopeError extends Error {
  readonly code = 'MODEL_NOT_ALLOWED';
  constructor(
    requested: string,
    public readonly allowed: string[],
  ) {
    super(`Model '${requested}' is not in the AGENTICOS_MODELS allowlist`);
    this.name = 'ScopeError';
  }
}

export class ReadonlyError extends Error {
  readonly code = 'READONLY_MODE';
  constructor(tool: string) {
    super(`Tool '${tool}' mutates state and is unavailable in readonly mode`);
    this.name = 'ReadonlyError';
  }
}

export function resolveModel(scope: ModelScope, requested?: string): string {
  if (requested === undefined || requested === null || requested === '') {
    return scope.defaultModel;
  }
  if (scope.allowed.includes(requested)) {
    return requested;
  }
  throw new ScopeError(requested, scope.allowed);
}

/** MCP tool result content shape (kept local to avoid coupling to SDK internals). */
export interface ToolCallResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  mutates: boolean;
  /** Irreversibly removes data (deletes, unpublish) — surfaces as destructiveHint. */
  destructive?: boolean;
}

/**
 * Every wrapTool() call records its spec here; createServer() reads it to stamp
 * the MCP-standard annotations (readOnlyHint/destructiveHint) onto the tool
 * registration — so clients can reason about risk BEFORE calling, from the one
 * `mutates` flag the server already maintains (protocol-hardening trap #2).
 */
export const toolRegistry = new Map<string, ToolSpec>();

/**
 * Connection session name echoed into responses (see wrapTool scope echo).
 * Set once at server assembly; optional so bare unit-tested handlers still work.
 */
let echoSession: string | undefined;
export function setScopeEchoSession(session: string): void {
  echoSession = session;
}

export type ScopedHandler = (model: string, args: Record<string, any>) => Promise<any>;

function textResult(data: any, isError = false): ToolCallResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Which layer answered (badly): the gateway routes /api → master, /node-api →
 * node, /vault-api → vault. Naming the layer turns "GATEWAY_ERROR 404" into a
 * debuggable statement (protocol-hardening trap #7).
 */
function layerOf(path: string | undefined): string {
  const p = String(path ?? '').replace(/^[A-Z]+\s+/, '');
  if (p.startsWith('/node-api')) return 'node';
  if (p.startsWith('/vault-api')) return 'vault';
  if (p.startsWith('/api')) return 'master';
  return 'gateway';
}

/** An executable next step per failure shape — a wrong suggestion is worse than none, so stay generic where we cannot know. */
function suggestionFor(status: number, path: string | undefined, model: string | undefined): string | undefined {
  const p = String(path ?? '');
  if (status === 401) return 'gateway rejected the credential — check AGENTICOS_ADMIN_SECRET / AGENTICOS_GATEWAY_SECRET_FILE against the gateway data/jwt secrets';
  if (status === 403) return 'the credential lacks this scope (readonly blocks every POST, including ArcQL and native reads) — use rw mode for mutations';
  if (status === 404) {
    if (/\/admin\/models/.test(p)) return 'the model does not exist on the node — list_models shows what exists; create_model mints it';
    return (
      'the id/path does not exist server-side — verify with list_models / net_overview / list_transitions' +
      (model ? `; if '${model}' is brand-new, run readiness to check its workspace containers` : '')
    );
  }
  if (status >= 500) return 'server-side failure — the mutation may still have been applied; re-read the resource before retrying (a blind retry can double-create)';
  return undefined;
}

/**
 * Wrap a tool handler with model-scope + readonly enforcement and uniform
 * error shaping. Errors come back as TOOL results (isError), never protocol
 * errors — that keeps the client LLM in the loop and able to correct itself.
 */
export function wrapTool(scope: ModelScope, mode: 'rw' | 'readonly', spec: ToolSpec, handler: ScopedHandler) {
  toolRegistry.set(spec.name, spec);
  return async (args: Record<string, any> = {}): Promise<ToolCallResult> => {
    let model: string | undefined;
    try {
      if (mode === 'readonly' && spec.mutates) {
        throw new ReadonlyError(spec.name);
      }
      model = resolveModel(scope, args?.model);
      if (scope.toolGuard) {
        await scope.toolGuard(model, spec, args ?? {});
      }
      const data = await handler(model, args ?? {});
      const payload = data ?? { ok: true };
      // Scope echo (protocol-hardening trap #1): any answer that depends on the
      // connection's implicit context must carry that context IN the data. Only
      // added when the handler didn't already state it — never overrides.
      if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        (payload as any).model === undefined &&
        (payload as any).scope === undefined
      ) {
        (payload as any).scope = { model, ...(echoSession ? { session: echoSession } : {}) };
      }
      return textResult(payload);
    } catch (err: any) {
      if (err instanceof ScopeError) {
        return textResult({ code: err.code, error: err.message, allowedModels: err.allowed }, true);
      }
      if (err instanceof ReadonlyError) {
        return textResult({ code: err.code, error: err.message }, true);
      }
      // GatewayError from @agenticos/cli carries status + body + the attempted
      // "METHOD /path" — surface all of it, name the failing layer, and give an
      // executable next step. Empty-body errors (common on 404) otherwise render
      // as a bare "Gateway 404: " and leave the client LLM guessing.
      if (err?.name === 'GatewayError') {
        const body = String(err.body ?? '').trim();
        const path: string | undefined = err.path ? String(err.path) : undefined;
        const hint =
          body ||
          (err.status === 404
            ? 'resource not found'
            : err.status === 403
              ? 'forbidden'
              : 'no response body');
        const suggestion = suggestionFor(Number(err.status), path, model);
        return textResult(
          {
            code: 'GATEWAY_ERROR',
            status: err.status,
            layer: layerOf(path),
            ...(path ? { attempted: path } : {}),
            error: hint.slice(0, 500),
            ...(suggestion ? { suggestion } : {}),
          },
          true,
        );
      }
      return textResult({ code: 'TOOL_ERROR', error: String(err?.message ?? err).slice(0, 500) }, true);
    }
  };
}
