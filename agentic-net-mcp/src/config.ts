/**
 * Env-first configuration for the Agentic-Nets MCP server.
 *
 * IMPORTANT: this process speaks MCP on stdout — all diagnostics go to stderr.
 * Secrets are read lazily by GatewayClient.ensureAuth() (AGENTICOS_ADMIN_SECRET /
 * AGENTICOS_GATEWAY_SECRET_FILE); config only validates that one is present so we
 * can fail fast with a clear message instead of 401-ing on the first tool call.
 */
import { existsSync } from 'node:fs';

export type McpMode = 'rw' | 'readonly';
export type McpTransport = 'stdio' | 'http';

export interface McpConfig {
  gatewayUrl: string;
  /** Model allowlist; first entry is the default model. */
  models: string[];
  mode: McpMode;
  /** Session name under which MCP-created nets/places live. */
  session: string;
  /** Host string injected into inscription presets/postsets: `${model}@${nodeHost}`. */
  nodeHost: string;
  transport: McpTransport;
  httpPort: number;
  /** Bearer token required on the HTTP transport (ignored for stdio). */
  httpToken?: string;
  /**
   * LLM provider used when THIS process executes hosted llm/agent transitions
   * (host_transition): 'claude-code' shells out to the local `claude` binary
   * (the user's own subscription — zero server-side LLM setup), or
   * ollama | claude | openai | codex. Model/tier are optional overrides.
   */
  llmProvider: string;
  llmModel?: string;
  llmTier: 'low' | 'medium' | 'high';
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const models = (env.AGENTICOS_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) {
    throw new ConfigError(
      'AGENTICOS_MODELS is required (comma-separated allowlist of model ids; the first is the default). ' +
        'Example: AGENTICOS_MODELS=my-notes',
    );
  }

  const mode = (env.AGENTICOS_MODE ?? 'rw') as McpMode;
  if (mode !== 'rw' && mode !== 'readonly') {
    throw new ConfigError(`AGENTICOS_MODE must be 'rw' or 'readonly', got '${mode}'`);
  }

  const hasSecret =
    Boolean(env.AGENTICOS_ADMIN_SECRET) ||
    Boolean(env.AGENTICOS_GATEWAY_SECRET_FILE && existsSync(env.AGENTICOS_GATEWAY_SECRET_FILE));
  if (!hasSecret) {
    throw new ConfigError(
      'No gateway secret configured. Set AGENTICOS_ADMIN_SECRET (the client secret for ' +
        (mode === 'readonly' ? 'the agenticos-readonly client' : 'the agenticos-admin client') +
        ') or AGENTICOS_GATEWAY_SECRET_FILE pointing at the secret file.',
    );
  }

  const transport = (env.AGENTICOS_MCP_TRANSPORT ?? 'stdio') as McpTransport;
  if (transport !== 'stdio' && transport !== 'http') {
    throw new ConfigError(`AGENTICOS_MCP_TRANSPORT must be 'stdio' or 'http', got '${transport}'`);
  }
  const httpToken = env.AGENTICOS_MCP_HTTP_TOKEN;
  if (transport === 'http' && !httpToken) {
    throw new ConfigError('AGENTICOS_MCP_HTTP_TOKEN is required for the http transport.');
  }

  const llmTier = (env.AGENTICOS_LLM_TIER ?? 'medium') as 'low' | 'medium' | 'high';
  if (!['low', 'medium', 'high'].includes(llmTier)) {
    throw new ConfigError(`AGENTICOS_LLM_TIER must be low|medium|high, got '${llmTier}'`);
  }

  return {
    gatewayUrl: env.AGENTICOS_GATEWAY_URL ?? 'http://localhost:8083',
    models,
    mode,
    session: env.AGENTICOS_SESSION ?? 'mcp',
    nodeHost: env.AGENTICOS_NODE_HOST ?? 'localhost:8080',
    transport,
    httpPort: Number(env.AGENTICOS_MCP_HTTP_PORT ?? '8091'),
    httpToken,
    llmProvider: env.AGENTICOS_LLM_PROVIDER ?? 'claude-code',
    llmModel: env.AGENTICOS_LLM_MODEL || undefined,
    llmTier,
  };
}
