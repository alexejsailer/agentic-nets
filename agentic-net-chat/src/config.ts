import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

export interface TelegramChatConfig {
  bot_token: string;
  allowed_user_ids: string[];
  session_prefix: string;
}

export interface ChatConfig {
  telegram?: TelegramChatConfig;
}

const CONFIG_FILE = join(homedir(), '.agenticos', 'config.yaml');

/**
 * Read the `chat:` section from ~/.agenticos/config.yaml.
 * Falls back to environment variables for bot token.
 */
export function loadChatConfig(): ChatConfig {
  let chatConfig: ChatConfig = {};

  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = YAML.parse(content);
      if (parsed?.chat) {
        chatConfig = parsed.chat;
      }
    } catch {
      // Config parse error - fall through to defaults
    }
  }

  // Resolve env vars in bot_token
  if (chatConfig.telegram) {
    chatConfig.telegram.bot_token = resolveValue(
      chatConfig.telegram.bot_token,
      'TELEGRAM_BOT_TOKEN',
    );
    chatConfig.telegram.allowed_user_ids = chatConfig.telegram.allowed_user_ids ?? [];
    chatConfig.telegram.session_prefix = chatConfig.telegram.session_prefix ?? 'tg';
  } else if (process.env['TELEGRAM_BOT_TOKEN']) {
    // Minimal config from env vars only
    chatConfig.telegram = {
      bot_token: process.env['TELEGRAM_BOT_TOKEN']!,
      allowed_user_ids: process.env['TELEGRAM_ALLOWED_USERS']?.split(',').map(s => s.trim()) ?? [],
      session_prefix: 'tg',
    };
  }

  return chatConfig;
}

function resolveValue(value: string | undefined, envVar: string): string {
  if (!value) return process.env[envVar] ?? '';
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) {
    return process.env[match[1]] ?? '';
  }
  if (process.env[envVar]) {
    return process.env[envVar]!;
  }
  return value;
}
