import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

export interface ProfileConfig {
  gateway_url: string;
  model_id: string;
  session_id: string;
  client_id: string;
  default_provider: string;
  default_role: string;
  anthropic?: {
    api_key?: string;
    model?: string;
    helper_model?: string;
    thinking_model?: string;
  };
  ollama?: {
    base_url?: string;
    model?: string;
  };
  claude_code?: {
    binary?: string;
    model?: string;
    thinking_model?: string;
  };
  codex?: {
    binary?: string;
    model?: string;
    thinking_model?: string;
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
  anthropic: {
    api_key: '${ANTHROPIC_API_KEY}',
    model: 'claude-sonnet-4-5-20250929',
    thinking_model: undefined,
  },
  ollama: {
    base_url: 'http://localhost:11434',
    model: 'llama3.2',
  },
  claude_code: {
    binary: 'claude',
    model: 'sonnet',
    thinking_model: undefined,
  },
  codex: {
    binary: 'codex',
    model: 'o3',
    thinking_model: undefined,
  },
};

const DEFAULT_CONFIG: AgetnticOSConfig = {
  active_profile: 'local',
  profiles: {
    local: DEFAULT_PROFILE,
  },
};

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
    anthropic: {
      api_key: resolveValue(profile.anthropic?.api_key, 'ANTHROPIC_API_KEY'),
      model: profile.anthropic?.model,
      helper_model: profile.anthropic?.helper_model,
      thinking_model: process.env['ANTHROPIC_THINKING_MODEL'] ?? profile.anthropic?.thinking_model,
    },
    ollama: {
      base_url: process.env['OLLAMA_BASE_URL'] ?? profile.ollama?.base_url,
      model: process.env['OLLAMA_MODEL'] ?? profile.ollama?.model,
    },
    claude_code: {
      binary: profile.claude_code?.binary,
      model: profile.claude_code?.model,
      thinking_model: process.env['CLAUDE_CODE_THINKING_MODEL'] ?? profile.claude_code?.thinking_model,
    },
    codex: {
      binary: profile.codex?.binary,
      model: profile.codex?.model,
      thinking_model: process.env['CODEX_THINKING_MODEL'] ?? profile.codex?.thinking_model,
    },
  };
}

export function getConfigFilePath(): string {
  return CONFIG_FILE;
}
