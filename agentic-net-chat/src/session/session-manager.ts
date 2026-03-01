import type { LlmMessage, LlmProvider } from '@agenticos/cli/llm/provider';
import type { ToolSchema } from '@agenticos/cli/agent/tools';
import type { ProfileConfig, ModelTier } from '@agenticos/cli/config/config';
import { ToolExecutor, type ToolResult } from '@agenticos/cli/agent/tool-executor';
import { agentLoop } from '@agenticos/cli/agent/runtime';
import { createLlmProvider } from '@agenticos/cli/commands/llm-factory';
import type { MessageSender } from '../channel/types.js';

const CHARS_PER_TOKEN = 4;
const AUTO_COMPACT_TOKENS = 30_000;
const AUTO_COMPACT_CHARS = AUTO_COMPACT_TOKENS * CHARS_PER_TOKEN;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const TYPING_REFRESH_MS = 4_000;
const TELEGRAM_LOOP_LIMITS = {
  maxIterations: 50,
  maxToolCalls: 50,
  maxThinkCalls: 3,
  maxConsecutiveSameToolCalls: 5,
};
const DIRECT_LOCAL_MAX_ITERATIONS = 8;
const DIRECT_LOCAL_MAX_ITERATIONS_HARD_CAP = 12;
const EXECUTION_VERB_RE = /\b(execute|run|fire|trigger|start)\b/i;
const TRANSITION_LABEL_HINTS: Array<{ pattern: RegExp; transitionId: string }> = [
  { pattern: /\bextract\s*(?:&|and)?\s*score(?:\s+content)?\b/i, transitionId: 't-extract-and-score' },
  { pattern: /\benrich(?:\s+with)?\s+metadata\b/i, transitionId: 't-enrich-metadata' },
  { pattern: /\broute\s+by(?:\s+relevance)?\s+score\b/i, transitionId: 't-route-by-score' },
  { pattern: /\bdiscover(?:\s*&?\s*)?dedup\s+urls\b/i, transitionId: 't-discover-links' },
  { pattern: /\bscrape\s+url\b/i, transitionId: 't-scrape' },
];

const SUPPORTED_PROVIDERS = ['claude', 'anthropic', 'openai', 'ollama', 'claude-code', 'codex'];

export interface UserOverrides {
  provider?: string;
  tier?: ModelTier;
  apiKeys?: Record<string, string>;
}

interface Session {
  history: LlmMessage[];
  turnCount: number;
  processing: boolean;
  queue: Array<{ text: string; sender: MessageSender }>;
  lastActivity: number;
  overrides: UserOverrides;
}

export interface SessionInfo {
  modelId: string;
  sessionId: string;
  turnCount: number;
  messageCount: number;
  estimatedTokens: number;
}

export interface CompactResult {
  estimatedTokens: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private evictionTimer: ReturnType<typeof setInterval>;

  constructor(
    private defaultLlm: LlmProvider,
    private toolExecutor: ToolExecutor,
    private systemPrompt: string,
    private toolSchemas: ToolSchema[],
    private modelId: string,
    private sessionPrefix: string,
    private profile: ProfileConfig,
    private defaultProviderName: string,
  ) {
    // Evict stale sessions every 30 minutes
    this.evictionTimer = setInterval(() => this.evictStaleSessions(), 30 * 60 * 1000);
  }

  private getOrCreateSession(chatId: string): Session {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        history: [],
        turnCount: 0,
        processing: false,
        queue: [],
        lastActivity: Date.now(),
        overrides: {},
      };
      this.sessions.set(chatId, session);
    }
    session.lastActivity = Date.now();
    return session;
  }

  private getSessionId(chatId: string): string {
    return `${this.sessionPrefix}-${chatId}`;
  }

  private getLlmForSession(chatId: string): LlmProvider {
    const session = this.sessions.get(chatId);
    if (!session) return this.defaultLlm;

    const overrides = session.overrides;
    const hasOverrides = overrides.provider || overrides.tier || (overrides.apiKeys && Object.keys(overrides.apiKeys).length > 0);
    if (!hasOverrides) return this.defaultLlm;

    // Build a patched profile with overrides
    const providerName = overrides.provider || this.defaultProviderName;
    const patchedProfile: ProfileConfig = { ...this.profile };

    // Apply API key overrides
    if (overrides.apiKeys) {
      if (overrides.apiKeys['anthropic'] || overrides.apiKeys['claude']) {
        patchedProfile.anthropic = { ...patchedProfile.anthropic, api_key: overrides.apiKeys['anthropic'] || overrides.apiKeys['claude'] };
      }
      if (overrides.apiKeys['openai']) {
        patchedProfile.openai = { ...patchedProfile.openai, api_key: overrides.apiKeys['openai'] };
      }
    }

    try {
      return createLlmProvider(providerName, patchedProfile, overrides.tier);
    } catch {
      // Fall back to default on error
      return this.defaultLlm;
    }
  }

  setProvider(chatId: string, provider: string): void {
    const session = this.getOrCreateSession(chatId);
    session.overrides.provider = provider;
  }

  setTier(chatId: string, tier: ModelTier): void {
    const session = this.getOrCreateSession(chatId);
    session.overrides.tier = tier;
  }

  setApiKey(chatId: string, provider: string, key: string): void {
    const session = this.getOrCreateSession(chatId);
    if (!session.overrides.apiKeys) session.overrides.apiKeys = {};
    session.overrides.apiKeys[provider] = key;
  }

  getUserOverrides(chatId: string): UserOverrides {
    const session = this.sessions.get(chatId);
    return session?.overrides ?? {};
  }

  async handleMessage(chatId: string, text: string, sender: MessageSender): Promise<void> {
    const session = this.getOrCreateSession(chatId);

    // If already processing, queue the message
    if (session.processing) {
      session.queue.push({ text, sender });
      return;
    }

    session.processing = true;

    try {
      await this.processMessage(chatId, session, text, sender);
    } finally {
      session.processing = false;

      // Process queued messages
      const next = session.queue.shift();
      if (next) {
        // Use setImmediate to avoid stack buildup
        setImmediate(() => this.handleMessage(chatId, next.text, next.sender));
      }
    }
  }

  private async processMessage(
    chatId: string,
    session: Session,
    text: string,
    sender: MessageSender,
  ): Promise<void> {
    session.turnCount++;
    const scopedExecutor = this.toolExecutor.fork({ sessionId: this.getSessionId(chatId) });
    const llm = this.getLlmForSession(chatId);

    // Start typing indicator with periodic refresh
    let typingActive = true;
    const refreshTyping = async () => {
      while (typingActive) {
        await sender.sendTypingAction(chatId);
        await new Promise(r => setTimeout(r, TYPING_REFRESH_MS));
      }
    };
    const typingPromise = refreshTyping();

    try {
      const directExecution = parseTransitionExecutionIntent(text);
      if (directExecution) {
        const directResult = await runTransitionExecutionStack(scopedExecutor, directExecution);

        typingActive = false;
        await typingPromise;

        await sender.sendText(chatId, formatTransitionExecutionResult(directResult));
        return;
      }

      const textParts: string[] = [];
      const toolSummaries: string[] = [];

      // Wire sub-agent progress to Telegram (scoped per-chat executor to avoid callback races).
      scopedExecutor.onProgress = (event) => {
        const prefix = '[sub-agent] ';
        switch (event.type) {
          case 'tool_call':
            sender.sendText(chatId, `${prefix}${event.tool}(${JSON.stringify(event.input || {}).slice(0, 100)})`).catch(() => {});
            break;
          case 'done':
            sender.sendText(chatId, `${prefix}Done: ${(event.content || '').slice(0, 300)}`).catch(() => {});
            break;
          case 'fail':
          case 'error':
            sender.sendText(chatId, `${prefix}${event.type}: ${(event.content || '').slice(0, 300)}`).catch(() => {});
            break;
        }
      };

      for await (const event of agentLoop(
        llm,
        scopedExecutor,
        this.systemPrompt,
        text,
        this.toolSchemas,
        session.history,
        TELEGRAM_LOOP_LIMITS,
      )) {
        switch (event.type) {
          case 'text':
            if (event.content) textParts.push(event.content);
            console.log(`  [text] ${event.content?.slice(0, 120)}`);
            break;
          case 'tool_call':
            toolSummaries.push(`> ${event.tool}(${summarizeInput(event.input)})`);
            console.log(`  [tool] ${event.tool}(${summarizeInput(event.input)})`);
            break;
          case 'tool_result':
            console.log(`  [result] ${JSON.stringify(event.result).slice(0, 120)}`);
            break;
          case 'done':
            if (event.content && textParts.length === 0) textParts.push(event.content);
            if (event.messages) session.history = event.messages;
            console.log(`  [DONE]`);
            break;
          case 'fail':
            if (event.content) textParts.push(`Failed: ${event.content}`);
            if (event.messages) session.history = event.messages;
            console.log(`  [FAIL] ${event.content?.slice(0, 200)}`);
            break;
          case 'error':
            if (event.content) textParts.push(`Error: ${event.content}`);
            if (event.messages) session.history = event.messages;
            console.log(`  [ERROR] ${event.content?.slice(0, 200)}`);
            break;
        }
      }

      // Stop typing
      typingActive = false;
      await typingPromise;

      // Build response
      const parts: string[] = [];

      if (toolSummaries.length > 0) {
        parts.push(toolSummaries.join('\n'));
      }

      if (textParts.length > 0) {
        parts.push(textParts.join('\n'));
      }

      const response = parts.join('\n\n') || 'Done (no output).';
      await sender.sendText(chatId, response);

      // Auto-compact if history is too large
      const historyChars = JSON.stringify(session.history).length;
      if (historyChars > AUTO_COMPACT_CHARS) {
        try {
          session.history = await this.doCompact(session.history, llm);
          await sender.sendText(chatId, `_[Auto-compacted to ~${this.estimateTokens(session.history)} tokens]_`);
        } catch {
          // Non-fatal
        }
      }
    } catch (err: any) {
      typingActive = false;
      await typingPromise;
      const errMsg = err.message || String(err);
      // If the LLM provider crashed (E2BIG, exit code), auto-compact to recover
      if (errMsg.includes('E2BIG') || errMsg.includes('exited with code')) {
        try {
          if (session.history.length > 2) {
            session.history = await this.doCompact(session.history, llm);
            await sender.sendText(chatId, `Error: ${errMsg}\n\n[Auto-compacted session to recover. Please retry.]`);
            return;
          }
        } catch {
          // compact also failed, clear session
          session.history = [];
          session.turnCount = 0;
        }
      }
      await sender.sendText(chatId, `Error: ${errMsg}`);
    }
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId);
  }

  getSessionInfo(chatId: string): SessionInfo {
    const session = this.sessions.get(chatId);
    return {
      modelId: this.modelId,
      sessionId: this.getSessionId(chatId),
      turnCount: session?.turnCount ?? 0,
      messageCount: session?.history.length ?? 0,
      estimatedTokens: session ? this.estimateTokens(session.history) : 0,
    };
  }

  async compactSession(chatId: string): Promise<CompactResult> {
    const session = this.sessions.get(chatId);
    if (!session || session.history.length === 0) {
      return { estimatedTokens: 0 };
    }

    const llm = this.getLlmForSession(chatId);
    session.history = await this.doCompact(session.history, llm);
    return { estimatedTokens: this.estimateTokens(session.history) };
  }

  private async doCompact(history: LlmMessage[], llm: LlmProvider): Promise<LlmMessage[]> {
    const summaryRequest = `Summarize our conversation so far in a concise paragraph. Focus on:
- What the user asked for
- What tools were used and their results
- Current state of the model (any changes made)
- Any important context for continuing the conversation
Keep it under 300 words.`;

    const response = await llm.chat(
      this.systemPrompt,
      [
        ...history,
        { role: 'user', content: [{ type: 'text', text: summaryRequest }] },
      ],
      [],
    );

    const summaryText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('\n');

    return [
      {
        role: 'user',
        content: [{ type: 'text', text: `[Previous conversation summary]\n${summaryText}` }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood. I have the context from our previous conversation. What would you like to do next?' }],
      },
    ];
  }

  private estimateTokens(messages: LlmMessage[]): number {
    return Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN);
  }

  private evictStaleSessions(): void {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS && !session.processing) {
        this.sessions.delete(chatId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.evictionTimer);
  }

  static get supportedProviders(): string[] {
    return SUPPORTED_PROVIDERS;
  }
}

function summarizeInput(input?: Record<string, any>): string {
  if (!input) return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  if (keys.length <= 2) {
    return keys.map(k => {
      const v = input[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 40 ? `${k}:${s.slice(0, 37)}...` : `${k}:${s}`;
    }).join(', ');
  }
  return keys.join(', ');
}

interface TransitionExecutionIntent {
  transitionId: string;
  params: Record<string, any>;
}

interface TransitionExecutionStackResult {
  transitionId: string;
  requestedMode: string;
  actionType: string;
  preflightOk: boolean;
  executionParams: Record<string, any>;
  transitionResult: ToolResult;
  preflightResult: ToolResult;
  executionResult: ToolResult;
}

function parseTransitionExecutionIntent(text: string): TransitionExecutionIntent | null {
  if (!text || !EXECUTION_VERB_RE.test(text)) {
    return null;
  }

  const transitionId = extractTransitionId(text) || inferTransitionIdByLabel(text);
  if (!transitionId) {
    return null;
  }

  const lower = text.toLowerCase();
  let mode: 'auto' | 'local' | 'master' = 'auto';
  if (/\b(local|locally|within cli|in cli)\b/i.test(lower)) {
    mode = 'local';
  } else if (/\b(master|fire once|fire_once)\b/i.test(lower)) {
    mode = 'master';
  }

  const iterMatch = text.match(/\bmaxIterations\s*[:=]\s*(\d+)\b/i);
  const maxIterations = iterMatch ? Number(iterMatch[1]) : undefined;

  const params: Record<string, any> = { transitionId, mode };
  const requestedIterations = Number.isFinite(maxIterations) && maxIterations! > 0
    ? Math.floor(maxIterations!)
    : DIRECT_LOCAL_MAX_ITERATIONS;
  params.maxIterations = Math.min(DIRECT_LOCAL_MAX_ITERATIONS_HARD_CAP, Math.max(1, requestedIterations));

  return { transitionId, params };
}

function extractTransitionId(text: string): string | null {
  const patterns = [
    /\btransitionId\s*[:=]\s*["']?([A-Za-z0-9._:-]+)["']?/i,
    /"id"\s*:\s*"([A-Za-z0-9._:-]+)"/i,
    /\btransition\s*["'`]?([A-Za-z0-9._:-]+)["'`]?\b/i,
    /\b(t-[A-Za-z0-9._:-]+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function inferTransitionIdByLabel(text: string): string | null {
  for (const hint of TRANSITION_LABEL_HINTS) {
    if (hint.pattern.test(text)) {
      return hint.transitionId;
    }
  }
  return null;
}

async function runTransitionExecutionStack(
  scopedExecutor: ToolExecutor,
  intent: TransitionExecutionIntent,
): Promise<TransitionExecutionStackResult> {
  const transitionId = intent.transitionId;
  const requestedMode = String(intent.params.mode || 'auto');

  const transitionResult = await scopedExecutor.execute('GET_TRANSITION', { transitionId });
  const actionType = transitionResult.success
    ? String((transitionResult.data as any)?.inscription?.action?.type || 'pass').toLowerCase()
    : 'unknown';

  const executionParams: Record<string, any> = { ...intent.params };
  if ((actionType === 'agent' || actionType === 'llm') && executionParams.mode === 'master') {
    return {
      transitionId,
      requestedMode,
      actionType,
      preflightOk: false,
      executionParams,
      transitionResult,
      preflightResult: { success: false, error: 'Skipped (invalid mode for action type).' },
      executionResult: {
        success: false,
        error: `Mode 'master' is not allowed for action.type='${actionType}'. Use mode 'auto' or 'local'.`,
      },
    };
  }

  const preflightResult = await scopedExecutor.execute('VERIFY_RUNTIME_BINDINGS', { transitionId });
  const preflightOk = !!(preflightResult.success && (preflightResult.data as any)?.ok);
  if (!preflightOk) {
    return {
      transitionId,
      requestedMode,
      actionType,
      preflightOk: false,
      executionParams,
      transitionResult,
      preflightResult,
      executionResult: {
        success: false,
        error: 'Preflight failed; execution skipped.',
      },
    };
  }

  const executionResult = await scopedExecutor.execute('EXECUTE_TRANSITION_SMART', executionParams);
  return {
    transitionId,
    requestedMode,
    actionType,
    preflightOk: true,
    executionParams,
    transitionResult,
    preflightResult,
    executionResult,
  };
}

function formatTransitionExecutionResult(result: TransitionExecutionStackResult): string {
  if (!result.transitionResult.success) {
    return `Execution failed for \`${result.transitionId}\`: ${result.transitionResult.error || 'Could not load transition.'}`;
  }

  const lines: string[] = [
    `Executed transition \`${result.transitionId}\``,
    `Stack: plan-lite -> verify-runtime-bindings -> execute`,
    `Requested mode: ${result.requestedMode} | Action: ${result.actionType}`,
    `Preflight: ${result.preflightOk ? 'ok' : 'failed'}`,
  ];

  if (!result.executionResult.success) {
    lines.push(`Execution failed: ${result.executionResult.error || 'unknown error'}`);
    if ((result.executionResult.error || '').toLowerCase().includes('maximum iterations')) {
      lines.push('No manual token fallback was applied.');
      lines.push('Try: maxIterations=12, or simplify/clarify the transition inscription prompt.');
    }
    return lines.join('\n');
  }

  const data = result.executionResult.data || {};
  const executionMode = data.executionMode || result.requestedMode;
  const summary = data.summary ? `Summary: ${String(data.summary).slice(0, 600)}` : '';
  const emitted = typeof data.emittedTokens === 'number' ? data.emittedTokens : '-';
  const consumed = typeof data.consumedTokens === 'number' ? data.consumedTokens : '-';
  const iterations = typeof data.iterationsUsed === 'number' ? data.iterationsUsed : '-';
  const maxIterations = result.executionParams.maxIterations ?? '-';

  lines.push(`Effective mode: ${executionMode}`);
  lines.push(`Iterations: ${iterations}/${maxIterations} | Emitted: ${emitted} | Consumed: ${consumed}`);
  if (summary) lines.push(summary);
  return lines.join('\n');
}
