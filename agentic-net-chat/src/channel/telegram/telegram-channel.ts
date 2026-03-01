import { Bot } from 'grammy';
import type { ChatChannel, MessageSender, ChannelSecurityConfig } from '../types.js';
import type { SessionManager } from '../../session/session-manager.js';
import { splitMessage } from './message-splitter.js';

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
        '/compact - Summarize conversation to save context',
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
