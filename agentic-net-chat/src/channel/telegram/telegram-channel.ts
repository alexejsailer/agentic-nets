import { Bot } from 'grammy';
import type { ChatChannel, MessageSender, ChannelSecurityConfig } from '../types.js';
import { SessionManager } from '../../session/session-manager.js';
import { splitMessage } from './message-splitter.js';

const VALID_TIERS = ['high', 'medium', 'low'] as const;

export class TelegramChannel implements ChatChannel, MessageSender {
  readonly platform = 'telegram';
  private bot: Bot;
  private security: ChannelSecurityConfig;
  private sessionManager: SessionManager;

  constructor(
    botToken: string,
    security: ChannelSecurityConfig,
    sessionManager: SessionManager,
  ) {
    this.bot = new Bot(botToken);
    this.security = security;
    this.sessionManager = sessionManager;
    this.setupHandlers();
  }

  private isAllowed(userId: number): boolean {
    if (this.security.allowedUserIds.length === 0) return true;
    return this.security.allowedUserIds.includes(String(userId));
  }

  private setupHandlers(): void {
    // Security middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const username = ctx.from?.username || 'unknown';
      console.log(`[Telegram] Message from user ${userId} (@${username})`);
      if (!userId || !this.isAllowed(userId)) {
        await ctx.reply(`Access denied. Your user ID (${userId}) is not in the allowed list.`);
        return;
      }
      await next();
    });

    // Commands
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        'AgetnticOS Agent connected.\n\n' +
        'Send any message to interact with the agent.\n\n' +
        'Commands:\n' +
        '/clear - Reset conversation\n' +
        '/context - Show session info\n' +
        '/compact - Summarize conversation to save context\n' +
        '/provider <name> - Switch LLM provider\n' +
        '/model <high|medium|low> - Set model tier\n' +
        '/setkey <provider> <key> - Set API key\n' +
        '/config - Show current LLM configuration',
      );
    });

    this.bot.command('clear', async (ctx) => {
      const chatId = String(ctx.chat.id);
      this.sessionManager.clearSession(chatId);
      await ctx.reply('Conversation cleared. Starting fresh.');
    });

    this.bot.command('context', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const info = this.sessionManager.getSessionInfo(chatId);
      await ctx.reply(
        `Model: ${info.modelId}\n` +
        `Session: ${info.sessionId}\n` +
        `Turns: ${info.turnCount}\n` +
        `History: ${info.messageCount} messages (~${info.estimatedTokens} tokens)`,
      );
    });

    this.bot.command('compact', async (ctx) => {
      const chatId = String(ctx.chat.id);
      try {
        const result = await this.sessionManager.compactSession(chatId);
        await ctx.reply(`Compacted to ~${result.estimatedTokens} tokens.`);
      } catch (err: any) {
        await ctx.reply(`Compact failed: ${err.message}`);
      }
    });

    this.bot.command('provider', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const args = ctx.match?.toString().trim();
      if (!args) {
        await ctx.reply(`Usage: /provider <name>\nSupported: ${SessionManager.supportedProviders.join(', ')}`);
        return;
      }
      const provider = args.toLowerCase();
      if (!SessionManager.supportedProviders.includes(provider)) {
        await ctx.reply(`Unknown provider: ${provider}\nSupported: ${SessionManager.supportedProviders.join(', ')}`);
        return;
      }
      this.sessionManager.setProvider(chatId, provider);
      await ctx.reply(`Switched to provider: ${provider}`);
    });

    this.bot.command('setkey', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const args = ctx.match?.toString().trim();
      if (!args) {
        await ctx.reply('Usage: /setkey <provider> <api-key>');
        return;
      }
      const parts = args.split(/\s+/, 2);
      if (parts.length < 2) {
        await ctx.reply('Usage: /setkey <provider> <api-key>');
        return;
      }
      const [provider, key] = parts;
      this.sessionManager.setApiKey(chatId, provider.toLowerCase(), key);

      // Try to delete the message containing the API key for security
      try {
        await ctx.deleteMessage();
      } catch {
        // May not have permission to delete messages
      }

      await ctx.reply(`API key set for ${provider}. (Please delete your message if it wasn't auto-deleted.)`);
    });

    this.bot.command('model', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const args = ctx.match?.toString().trim().toLowerCase();
      if (!args || !VALID_TIERS.includes(args as any)) {
        await ctx.reply(`Usage: /model <high|medium|low>`);
        return;
      }
      this.sessionManager.setTier(chatId, args as 'high' | 'medium' | 'low');
      await ctx.reply(`Model tier set to: ${args}`);
    });

    this.bot.command('config', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const overrides = this.sessionManager.getUserOverrides(chatId);
      const info = this.sessionManager.getSessionInfo(chatId);

      const lines: string[] = [
        'Current LLM Configuration:',
        `  Provider: ${overrides.provider || '(default)'}`,
        `  Tier: ${overrides.tier || '(default)'}`,
        `  Model: ${info.modelId}`,
      ];

      if (overrides.apiKeys && Object.keys(overrides.apiKeys).length > 0) {
        const keyList = Object.keys(overrides.apiKeys).map(k => `${k}: ***set***`).join(', ');
        lines.push(`  API Keys: ${keyList}`);
      } else {
        lines.push('  API Keys: (none overridden)');
      }

      lines.push('');
      lines.push('Commands:');
      lines.push('  /provider <name> - Switch provider');
      lines.push('  /model <high|medium|low> - Set tier');
      lines.push('  /setkey <provider> <key> - Set API key');
      lines.push('  /clear - Reset conversation');
      lines.push('  /compact - Compress context');

      await ctx.reply(lines.join('\n'));
    });

    // Text messages → agent
    this.bot.on('message:text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text;

      // Skip if it's a command (already handled)
      if (text.startsWith('/')) return;

      await this.sessionManager.handleMessage(chatId, text, this);
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err.message);
    });
  }

  async start(): Promise<void> {
    console.log('[Telegram] Starting bot with long polling...');
    // bot.start() returns a promise that resolves when bot is stopped
    this.bot.start({
      onStart: () => console.log('[Telegram] Bot is running.'),
    });
  }

  async stop(): Promise<void> {
    console.log('[Telegram] Stopping bot...');
    await this.bot.stop();
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      // Send as plain text — Telegram's legacy Markdown parser is too strict
      // and causes duplicate/garbled messages with code blocks and special chars.
      await this.bot.api.sendMessage(Number(chatId), chunk);
    }
  }

  async sendTypingAction(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), 'typing');
    } catch {
      // Non-fatal: typing indicator is best-effort
    }
  }
}
