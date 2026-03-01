import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

export type ModelTier = 'high' | 'medium' | 'low';

export interface ProfileConfig {
  gateway_url: string;
  model_id: string;
  session_id: string;
  client_id: string;
  default_provider: string;
  default_role: string;
  default_tier?: ModelTier;
  anthropic?: {
    api_key?: string;
    model?: string;
    helper_model?: string;
    thinking_model?: string;
    high_model?: string;
    medium_model?: string;
    low_model?: string;
  };
  ollama?: {
    base_url?: string;
    model?: string;
    high_model?: string;
    medium_model?: string;
    low_model?: string;
  };
  openai?: {
    api_key?: string;
    high_model?: string;
    medium_model?: string;
    low_model?: string;
  };
  claude_code?: {
    binary?: string;
    model?: string;
    thinking_model?: string;
    high_model?: string;
    medium_model?: string;
    low_model?: string;
  };
  codex?: {
    binary?: string;
    model?: string;
    thinking_model?: string;
    high_model?: string;
    medium_model?: string;
    low_model?: string;
  };
}

export interface AgetnticOSConfig {
  active_profile: string;
  profiles: Record<string, ProfileConfig>;
}

const CONFIG_DIR = join(homedir(), '.agenticos');
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml');
const TOKENS_DIR = join(CONFIG_DIR, 'tokens');

const DEFAULT_PROFILE: ProfileConfig = {
  gateway_url: 'http://localhost:8083',
  model_id: 'default',
  session_id: '',
  client_id: 'agenticos-admin',
  default_provider: 'claude',
  default_role: 'rw',
  default_tier: 'medium',
  anthropic: {
    api_key: '${ANTHROPIC_API_KEY}',
    model: 'claude-sonnet-4-5-20250929',
    thinking_model: undefined,
    high_model: 'claude-opus-4-6',
    medium_model: 'claude-sonnet-4-6',
    low_model: 'claude-haiku-4-5-20251001',
  },
  ollama: {
    base_url: 'http://localhost:11434',
    model: 'minimax-m2.5:cloud',
    high_model: 'qwen3.5:cloud',
    medium_model: 'minimax-m2.5:cloud',
    low_model: 'gemini-3-flash-preview:cloud',
  },
  openai: {
    api_key: '${OPENAI_API_KEY}',
    high_model: 'gpt-5.2',
    medium_model: 'o4-mini',
    low_model: 'gpt-5-nano',
  },
  claude_code: {
    binary: 'claude',
    model: 'sonnet',
    thinking_model: undefined,
    high_model: 'opus',
    medium_model: 'sonnet',
    low_model: 'haiku',
  },
  codex: {
    binary: 'codex',
    model: 'gpt-5.2-codex',
    thinking_model: undefined,
    high_model: 'gpt-5.3-codex',
    medium_model: 'gpt-5.2-codex',
    low_model: 'gpt-5.1-codex-mini',
  },
};

const DEFAULT_CONFIG: AgetnticOSConfig = {
  active_profile: 'local',
  profiles: {
    local: DEFAULT_PROFILE,
  },
};

/**
 * Resolve the model name for a given tier from provider config.
 * Checks tier-specific fields first, then falls back to legacy fields, then the provided fallback.
 */
export function resolveModelForTier(
  tier: ModelTier,
  opts: { high_model?: string; medium_model?: string; low_model?: string; thinking_model?: string; model?: string; helper_model?: string } | undefined,
  fallback: string,
): string {
  if (!opts) return fallback;

  // Tier-specific fields first
  if (tier === 'high' && opts.high_model) return opts.high_model;
  if (tier === 'medium' && opts.medium_model) return opts.medium_model;
  if (tier === 'low' && opts.low_model) return opts.low_model;

  // Legacy fallbacks
  if (tier === 'high' && opts.thinking_model) return opts.thinking_model;
  if (tier === 'low' && opts.helper_model) return opts.helper_model;

  // Generic model field
  if (opts.model) return opts.model;

  return fallback;
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(TOKENS_DIR)) {
    mkdirSync(TOKENS_DIR, { recursive: true });
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getTokensDir(): string {
  return TOKENS_DIR;
}

export function loadConfig(): AgetnticOSConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = YAML.parse(content) as AgetnticOSConfig;
    return parsed ?? DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: AgetnticOSConfig): void {
  ensureConfigDir();
  const content = YAML.stringify(config, { indent: 2 });
  writeFileSync(CONFIG_FILE, content, 'utf-8');
}

export function getActiveProfile(config: AgetnticOSConfig): ProfileConfig {
  const name = config.active_profile || 'local';
  return config.profiles[name] ?? DEFAULT_PROFILE;
}

export function resolveValue(value: string | undefined, envVar?: string): string {
  if (!value) return '';
  // Resolve ${ENV_VAR} patterns
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) {
    return process.env[match[1]] ?? '';
  }
  // Check env override
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }
  return value;
}

/** Resolve all env-var overrides for the active profile. */
export function resolveProfile(profile: ProfileConfig): ProfileConfig {
  return {
    ...profile,
    gateway_url: process.env['AGENTICOS_GATEWAY_URL'] ?? process.env['AGENTICOS_GATEWAY'] ?? profile.gateway_url,
    model_id: process.env['AGENTICOS_MODEL'] ?? profile.model_id,
    session_id: process.env['AGENTICOS_SESSION'] ?? profile.session_id,
    default_provider: process.env['AGENTICOS_PROVIDER'] ?? profile.default_provider,
    default_tier: (process.env['AGENTICOS_MODEL_TIER'] as ModelTier) ?? profile.default_tier,
    anthropic: {
      api_key: resolveValue(profile.anthropic?.api_key, 'ANTHROPIC_API_KEY'),
      model: profile.anthropic?.model,
      helper_model: profile.anthropic?.helper_model,
      thinking_model: process.env['ANTHROPIC_THINKING_MODEL'] ?? profile.anthropic?.thinking_model,
      high_model: process.env['ANTHROPIC_HIGH_MODEL'] ?? profile.anthropic?.high_model,
      medium_model: process.env['ANTHROPIC_MEDIUM_MODEL'] ?? profile.anthropic?.medium_model,
      low_model: process.env['ANTHROPIC_LOW_MODEL'] ?? profile.anthropic?.low_model,
    },
    ollama: {
      base_url: process.env['OLLAMA_BASE_URL'] ?? profile.ollama?.base_url,
      model: process.env['OLLAMA_MODEL'] ?? profile.ollama?.model,
      high_model: process.env['OLLAMA_HIGH_MODEL'] ?? profile.ollama?.high_model,
      medium_model: process.env['OLLAMA_MEDIUM_MODEL'] ?? profile.ollama?.medium_model,
      low_model: process.env['OLLAMA_LOW_MODEL'] ?? profile.ollama?.low_model,
    },
    openai: {
      api_key: resolveValue(profile.openai?.api_key, 'OPENAI_API_KEY'),
      high_model: process.env['OPENAI_HIGH_MODEL'] ?? profile.openai?.high_model,
      medium_model: process.env['OPENAI_MEDIUM_MODEL'] ?? profile.openai?.medium_model,
      low_model: process.env['OPENAI_LOW_MODEL'] ?? profile.openai?.low_model,
    },
    claude_code: {
      binary: profile.claude_code?.binary,
      model: profile.claude_code?.model,
      thinking_model: process.env['CLAUDE_CODE_THINKING_MODEL'] ?? profile.claude_code?.thinking_model,
      high_model: process.env['CLAUDE_CODE_HIGH_MODEL'] ?? profile.claude_code?.high_model,
      medium_model: process.env['CLAUDE_CODE_MEDIUM_MODEL'] ?? profile.claude_code?.medium_model,
      low_model: process.env['CLAUDE_CODE_LOW_MODEL'] ?? profile.claude_code?.low_model,
    },
    codex: {
      binary: profile.codex?.binary,
      model: profile.codex?.model,
      thinking_model: process.env['CODEX_THINKING_MODEL'] ?? profile.codex?.thinking_model,
      high_model: process.env['CODEX_HIGH_MODEL'] ?? profile.codex?.high_model,
      medium_model: process.env['CODEX_MEDIUM_MODEL'] ?? profile.codex?.medium_model,
      low_model: process.env['CODEX_LOW_MODEL'] ?? profile.codex?.low_model,
    },
  };
}

export function getConfigFilePath(): string {
  return CONFIG_FILE;
}
