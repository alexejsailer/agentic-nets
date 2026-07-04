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
}

export type ScopedHandler = (model: string, args: Record<string, any>) => Promise<any>;

function textResult(data: any, isError = false): ToolCallResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Wrap a tool handler with model-scope + readonly enforcement and uniform
 * error shaping. Errors come back as TOOL results (isError), never protocol
 * errors — that keeps the client LLM in the loop and able to correct itself.
 */
export function wrapTool(scope: ModelScope, mode: 'rw' | 'readonly', spec: ToolSpec, handler: ScopedHandler) {
  return async (args: Record<string, any> = {}): Promise<ToolCallResult> => {
    try {
      if (mode === 'readonly' && spec.mutates) {
        throw new ReadonlyError(spec.name);
      }
      const model = resolveModel(scope, args?.model);
      const data = await handler(model, args ?? {});
      return textResult(data ?? { ok: true });
    } catch (err: any) {
      if (err instanceof ScopeError) {
        return textResult({ code: err.code, error: err.message, allowedModels: err.allowed }, true);
      }
      if (err instanceof ReadonlyError) {
        return textResult({ code: err.code, error: err.message }, true);
      }
      // GatewayError from @agenticos/cli carries status + body. Empty-body errors
      // (common on 404) render as a bare "Gateway 404: " — add a hint so the client
      // LLM isn't left guessing.
      if (err?.name === 'GatewayError') {
        const body = String(err.body ?? '').trim();
        const hint =
          body ||
          (err.status === 404
            ? 'resource not found — check the id/path'
            : err.status === 403
              ? 'forbidden (readonly mode blocks writes; ArcQL POSTs are readonly-blocked)'
              : 'no response body');
        return textResult({ code: 'GATEWAY_ERROR', status: err.status, error: hint.slice(0, 500) }, true);
      }
      return textResult({ code: 'TOOL_ERROR', error: String(err?.message ?? err).slice(0, 500) }, true);
    }
  };
}
