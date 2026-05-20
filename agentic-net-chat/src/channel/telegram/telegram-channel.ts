import { Bot } from 'grammy';
import type { ChannelSecurityConfig } from '../types.js';
import { PersonaClient, type AgentEvent } from '@agenticos/cli/master/persona-client';
import { ChatStateStore } from '../../chat-state.js';
import { splitMessage } from './message-splitter.js';

/**
 * Escape text for Telegram MarkdownV2 while preserving common markdown formatting.
 * Preserves: **bold**, `inline code`, ```code blocks```, _italic_
 * Escapes all other MarkdownV2 special characters.
 */
function escapeMarkdownV2(text: string): string {
  const SPECIAL = /([[\]()~>#+=|{}.!-])/g;
  const parts: string[] = [];
  const codePattern = /(```[\s\S]*?```|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(text)) !== null) {
    parts.push(escapeSegment(text.slice(lastIndex, match.index), SPECIAL));
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  parts.push(escapeSegment(text.slice(lastIndex), SPECIAL));
  return parts.join('');
}

function escapeSegment(text: string, specialPattern: RegExp): string {
  const BOLD_RE = /\*\*(.+?)\*\*/g;
  const ITALIC_RE = /__(.+?)__/g;
  const BOLD_PH = '\x01BOLD\x02';
  const ITALIC_PH = '\x01ITALIC\x02';
  const bolds: string[] = [];
  const italics: string[] = [];
  let result = text.replace(BOLD_RE, (_, content) => {
    bolds.push(content);
    return `${BOLD_PH}${bolds.length - 1}${BOLD_PH}`;
  });
  result = result.replace(ITALIC_RE, (_, content) => {
    italics.push(content);
    return `${ITALIC_PH}${italics.length - 1}${ITALIC_PH}`;
  });
  result = result.replace(specialPattern, '\\$1');
  result = result.replace(
    new RegExp(`\\\\?${escapeRegex(BOLD_PH)}(\\d+)\\\\?${escapeRegex(BOLD_PH)}`, 'g'),
    (_, idx) => `*${bolds[Number(idx)].replace(specialPattern, '\\$1')}*`,
  );
  result = result.replace(
    new RegExp(`\\\\?${escapeRegex(ITALIC_PH)}(\\d+)\\\\?${escapeRegex(ITALIC_PH)}`, 'g'),
    (_, idx) => `_${italics[Number(idx)].replace(specialPattern, '\\$1')}_`,
  );
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Telegram bridge that relays user messages to master's persona endpoints.
 *
 * <p>Architecture: the bot does NOT run an agent loop. It calls
 * {@code /api/assistant/p/{persona}/{model}/chat/start} (lazily, on first
 * message in a chat) and streams agent events from {@code /agent-stream}.
 * Text events become Telegram messages; tool-call events become breadcrumbs.</p>
 *
 * <p>Per-Telegram-chat state (persona, modelId, conversationId) lives in
 * {@link ChatStateStore} in memory. Restarting the chat container drops it
 * — users start fresh, master keeps its own conversation history regardless.</p>
 */
export class TelegramChannel {
  readonly platform = 'telegram';
  private bot: Bot;
  private security: ChannelSecurityConfig;
  private personaClient: PersonaClient;
  private stateStore: ChatStateStore;

  constructor(
    botToken: string,
    security: ChannelSecurityConfig,
    personaClient: PersonaClient,
    stateStore: ChatStateStore,
  ) {
    this.bot = new Bot(botToken);
    this.security = security;
    this.personaClient = personaClient;
    this.stateStore = stateStore;
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

    this.bot.command('start', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = this.stateStore.get(chatId);
      await ctx.reply(
        `AgenticNetOS Chat Bridge connected.\n\n` +
        `Active persona: ${state.persona}\n` +
        `Active model:   ${state.modelId}\n\n` +
        `Send any message to chat with the agent. The persona runs on master, ` +
        `so behaviour matches the GUI's Universal Assistant.\n\n` +
        `Commands:\n` +
        `/personas - List available personas\n` +
        `/persona <id> - Switch persona (resets conversation)\n` +
        `/model <id> - Switch model (resets conversation)\n` +
        `/context - Show current chat state\n` +
        `/clear - Start a fresh conversation (same persona/model)`,
      );
    });

    this.bot.command('clear', async (ctx) => {
      const chatId = String(ctx.chat.id);
      this.stateStore.clearConversation(chatId);
      await ctx.reply('Conversation cleared. Next message starts a fresh one.');
    });

    this.bot.command('context', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const state = this.stateStore.get(chatId);
      await ctx.reply(
        `Persona:         ${state.persona}\n` +
        `Model:           ${state.modelId}\n` +
        `Conversation:    ${state.conversationId ?? '(not started)'}\n`,
      );
    });

    this.bot.command('personas', async (ctx) => {
      try {
        const personas = await this.personaClient.listPersonas();
        const lines = personas.map(
          (p) => `${p.id} (${p.role}, ${p.toolCount} tools) — ${p.description.slice(0, 80)}`,
        );
        await ctx.reply(`Available personas:\n${lines.join('\n\n')}\n\nUse /persona <id> to switch.`);
      } catch (err: any) {
        await ctx.reply(`Failed to list personas: ${err.message}`);
      }
    });

    this.bot.command('persona', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const arg = ctx.match?.toString().trim();
      if (!arg) {
        const state = this.stateStore.get(chatId);
        await ctx.reply(`Current persona: ${state.persona}\nUse /personas to list, /persona <id> to switch.`);
        return;
      }
      const state = this.stateStore.setPersona(chatId, arg);
      await ctx.reply(`Persona set to ${state.persona}. Conversation reset; next message starts fresh.`);
    });

    this.bot.command('model', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const arg = ctx.match?.toString().trim();
      if (!arg) {
        const state = this.stateStore.get(chatId);
        await ctx.reply(`Current model: ${state.modelId}\nUse /model <modelId> to switch.`);
        return;
      }
      const state = this.stateStore.setModel(chatId, arg);
      await ctx.reply(`Model set to ${state.modelId}. Conversation reset; next message starts fresh.`);
    });

    // Plain text messages → master persona agent-stream
    this.bot.on('message:text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text;
      if (text.startsWith('/')) return; // commands handled above

      await this.handleUserMessage(chatId, text);
    });

    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err.message);
    });
  }

  /**
   * The whole user-facing flow: ensure a conversation exists, open the SSE
   * stream, surface tool-call breadcrumbs as short messages, and send the
   * final text/summary back when the agent completes.
   */
  private async handleUserMessage(chatId: string, text: string): Promise<void> {
    await this.sendTypingAction(chatId);

    // Ensure conversation exists
    const state = this.stateStore.get(chatId);
    if (!state.conversationId) {
      try {
        const started = await this.personaClient.startChat(state.persona, state.modelId);
        this.stateStore.setConversation(chatId, started.conversationId);
        if (started.domainBootstrap === 'created') {
          await this.sendText(chatId, `_Initializing persona memory for ${state.modelId}…_`);
        }
      } catch (err: any) {
        await this.sendText(chatId, `Failed to start conversation: ${err.message}`);
        return;
      }
    }

    const conversationId = this.stateStore.get(chatId).conversationId!;

    // Stream events from master
    const finalChunks: string[] = [];
    let lastTypingAt = Date.now();
    try {
      for await (const event of this.personaClient.streamAgent(
        state.persona,
        state.modelId,
        conversationId,
        text,
      )) {
        // Refresh typing indicator every ~4s while streaming
        if (Date.now() - lastTypingAt > 4000) {
          await this.sendTypingAction(chatId);
          lastTypingAt = Date.now();
        }
        await this.handleEvent(chatId, event, finalChunks);
      }
    } catch (err: any) {
      console.error('[Telegram] agent-stream error:', err.message);
      await this.sendText(chatId, `Agent stream failed: ${err.message}`);
      // Drop the conversation so the next message restarts cleanly
      this.stateStore.clearConversation(chatId);
      return;
    }

    // If the completion summary wasn't already surfaced as a TextEvent,
    // send the accumulated final chunks (some personas emit only TextEvents,
    // some emit only a CompletionEvent.summary).
    if (finalChunks.length === 0) {
      await this.sendText(chatId, '_(no text response)_');
    }
  }

  /**
   * Translate a single agent event into Telegram output. Text events are sent
   * directly. Completion events with a summary are sent as a final reply.
   * Tool-call events are suppressed by default (verbose chat would flood the
   * user) but logged for ops.
   */
  private async handleEvent(chatId: string, event: AgentEvent, accumulated: string[]): Promise<void> {
    switch (event.type) {
      case 'thinking':
        // skip — too chatty
        break;
      case 'tool_call':
        console.log(`[Telegram] tool_call: ${event.toolName}`);
        break;
      case 'tool_result':
        console.log(`[Telegram] tool_result: ${event.toolName} (${event.durationMs ?? '?'}ms)`);
        break;
      case 'text':
        if (event.text && event.text.trim().length > 0) {
          accumulated.push(event.text);
          await this.sendText(chatId, event.text);
        }
        break;
      case 'completion':
        if (event.summary && event.summary.trim().length > 0 && accumulated.length === 0) {
          // No text was streamed mid-flight; surface the completion summary
          await this.sendText(chatId, event.summary);
        }
        console.log(
          `[Telegram] completion: success=${event.success} iterations=${event.iterationCount} tools=${event.toolCallCount}`,
        );
        break;
      case 'error':
        await this.sendText(chatId, `Error: ${event.message ?? event.error ?? 'unknown'}`);
        break;
    }
  }

  async start(): Promise<void> {
    console.log('[Telegram] Starting bot with long polling...');
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
      try {
        const escaped = escapeMarkdownV2(chunk);
        await this.bot.api.sendMessage(Number(chatId), escaped, { parse_mode: 'MarkdownV2' });
      } catch {
        await this.bot.api.sendMessage(Number(chatId), chunk);
      }
    }
  }

  async sendTypingAction(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), 'typing');
    } catch {
      // best-effort
    }
  }
}
