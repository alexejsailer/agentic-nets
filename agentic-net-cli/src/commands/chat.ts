import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import type { LlmMessage, LlmProvider } from '../llm/provider.js';
import { loadConfig, getActiveProfile, resolveProfile } from '../config/config.js';
import { parseRole } from '../agent/roles.js';
import { getToolSchemas, buildSystemPrompt } from '../agent/prompts.js';
import { ToolExecutor } from '../agent/tool-executor.js';
import { agentLoop } from '../agent/runtime.js';
import { createLlmProvider, createHelperLlm } from './llm-factory.js';
import {
  renderThinking, renderToolCall, renderToolResult, renderAssistantText,
  outputError, outputInfo, outputSuccess, outputDim,
} from '../render/output.js';

// Bracketed paste escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Rough token estimate: 1 token ≈ 4 chars */
const CHARS_PER_TOKEN = 4;
const AUTO_COMPACT_TOKENS = 30_000;
const AUTO_COMPACT_CHARS = AUTO_COMPACT_TOKENS * CHARS_PER_TOKEN;
const CHAT_LOOP_LIMITS = {
  maxIterations: 40,
  maxToolCalls: 30,
  maxThinkCalls: 4,
  maxConsecutiveSameToolCalls: 2,
};

export function registerChatCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  program
    .command('chat')
    .description('Interactive agent REPL with persistent conversation')
    .option('--provider <name>', 'LLM provider (claude|openai|ollama|claude-code|codex)')
    .option('--tier <tier>', 'Model tier (high|medium|low)')
    .option('--role <role>', 'Agent role (r|rw|rwx|rwxh)')
    .action(async (opts: any) => {
      const ctx = getContext();
      const client = ctx.client;
      const modelId = ctx.modelId;
      const sessionId = ctx.sessionId || 'system/alive';
      const cfg = loadConfig();
      const profile = resolveProfile(getActiveProfile(cfg));

      const providerName = opts.provider || profile.default_provider;
      const role = parseRole(opts.role || profile.default_role);

      let llm: LlmProvider;
      try {
        llm = createLlmProvider(providerName, profile, opts.tier);
      } catch (err: any) {
        outputError(err.message);
        process.exit(1);
      }

      const helperLlm = createHelperLlm(profile);
      const toolExecutor = new ToolExecutor(client, modelId, sessionId, helperLlm, llm);
      const systemPrompt = buildSystemPrompt({ role, modelId, sessionId });
      const toolSchemas = getToolSchemas(role);

      // Wire sub-agent progress reporting
      toolExecutor.onProgress = (event) => {
        const prefix = '\x1b[2m[sub-agent]\x1b[0m ';
        switch (event.type) {
          case 'tool_call':
            process.stdout.write(`${prefix}${event.tool}(${JSON.stringify(event.input || {}).slice(0, 120)})\n`);
            break;
          case 'tool_result':
            process.stdout.write(`${prefix}  → ${JSON.stringify(event.result).slice(0, 200)}\n`);
            break;
          case 'text':
            if (event.content) process.stdout.write(`${prefix}${event.content.slice(0, 200)}\n`);
            break;
          case 'done':
            process.stdout.write(`${prefix}DONE: ${(event.content || '').slice(0, 200)}\n`);
            break;
          case 'fail':
          case 'error':
            process.stdout.write(`${prefix}${event.type.toUpperCase()}: ${(event.content || '').slice(0, 200)}\n`);
            break;
        }
      };

      // Persistent conversation history across turns
      let history: LlmMessage[] = [];
      let turnCount = 0;
      let processing = false;

      // Input state
      let lineBuffer = '';       // current typed/pasted content
      let isPasting = false;     // inside bracketed paste sequence

      outputInfo(`AgenticNetOS Agent | Model: ${modelId} | Session: ${sessionId || 'auto'} | Provider: ${providerName}`);
      outputInfo('Type your request, or /help for commands.\n');

      const prompt = '> ';
      process.stdout.write(prompt);

      // Enable bracketed paste mode so terminal wraps pastes in escape sequences
      process.stdout.write('\x1b[?2004h');

      // Raw mode: we handle every keypress ourselves
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');

      function writePrompt() {
        process.stdout.write('\n' + prompt);
        lineBuffer = '';
      }

      function submit() {
        const input = lineBuffer.trim();
        lineBuffer = '';
        if (!input) { writePrompt(); return; }
        process.stdout.write('\n');
        handleInput(input);
      }

      process.stdin.on('data', (data: string) => {
        // Check for bracketed paste sequences anywhere in the chunk
        // Terminal may send: \x1b[200~ <pasted content> \x1b[201~
        // Sometimes split across multiple data events, sometimes in one chunk
        let remaining = data;

        while (remaining.length > 0) {
          if (isPasting) {
            // Look for paste-end sequence
            const endIdx = remaining.indexOf(PASTE_END);
            if (endIdx !== -1) {
              // Paste content before the end marker
              const pasteContent = remaining.slice(0, endIdx);
              lineBuffer += pasteContent;
              remaining = remaining.slice(endIdx + PASTE_END.length);
              isPasting = false;
              // Show pasted content (replace newlines with visible indicator)
              const displayLines = pasteContent.split('\n');
              for (let i = 0; i < displayLines.length; i++) {
                if (i > 0) process.stdout.write('\n  ');
                process.stdout.write(displayLines[i]);
              }
            } else {
              // Still pasting, buffer everything
              lineBuffer += remaining;
              const displayLines = remaining.split('\n');
              for (let i = 0; i < displayLines.length; i++) {
                if (i > 0) process.stdout.write('\n  ');
                process.stdout.write(displayLines[i]);
              }
              remaining = '';
            }
          } else {
            // Check for paste-start sequence
            const startIdx = remaining.indexOf(PASTE_START);
            if (startIdx !== -1) {
              // Handle any typed chars before paste start
              const before = remaining.slice(0, startIdx);
              if (before.length > 0) {
                handleTypedChars(before);
              }
              isPasting = true;
              remaining = remaining.slice(startIdx + PASTE_START.length);
            } else {
              // Normal typed input
              handleTypedChars(remaining);
              remaining = '';
            }
          }
        }
      });

      function handleTypedChars(chars: string) {
        for (let i = 0; i < chars.length; i++) {
          const ch = chars[i];
          const code = ch.charCodeAt(0);

          // Ctrl+C → exit
          if (code === 3) {
            cleanup();
            process.exit(0);
          }

          // Ctrl+D → exit (on empty line) or submit (with content)
          if (code === 4) {
            if (lineBuffer.length === 0) {
              cleanup();
              process.exit(0);
            } else {
              submit();
            }
            continue;
          }

          // Enter (CR or LF) → submit
          if (code === 13 || code === 10) {
            submit();
            continue;
          }

          // Backspace / DEL
          if (code === 127 || code === 8) {
            if (lineBuffer.length > 0) {
              lineBuffer = lineBuffer.slice(0, -1);
              // Erase character on screen: move back, write space, move back
              process.stdout.write('\b \b');
            }
            continue;
          }

          // Ctrl+U → clear line
          if (code === 21) {
            // Erase the visible line
            const len = lineBuffer.length;
            process.stdout.write('\b \b'.repeat(len));
            lineBuffer = '';
            continue;
          }

          // Skip other control chars and escape sequences
          if (code < 32 && code !== 9) continue; // allow tab (9)
          if (ch === '\x1b') {
            // Consume escape sequences (arrow keys etc.) — skip until end of sequence
            while (i + 1 < chars.length && chars[i + 1] >= '@' && chars[i + 1] <= '~') {
              i++;
              break;
            }
            // Also skip CSI sequences like \x1b[A
            if (i + 1 < chars.length && chars[i + 1] === '[') {
              i++; // skip [
              while (i + 1 < chars.length) {
                i++;
                if (chars[i] >= '@' && chars[i] <= '~') break;
              }
            }
            continue;
          }

          // Regular character — echo and buffer
          lineBuffer += ch;
          process.stdout.write(ch);
        }
      }

      function cleanup() {
        // Disable bracketed paste mode and restore terminal
        process.stdout.write('\x1b[?2004l');
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log('\nBye!');
      }

      async function handleInput(input: string): Promise<void> {

        // ---- Slash commands ----

        if (input === '/quit' || input === '/exit' || input === '/q') {
          cleanup();
          process.exit(0);
        }

        if (input === '/help') {
          console.log(`
Commands:
  /quit, /exit, /q  Exit chat
  /help             Show this help
  /context          Show current context
  /history          Show conversation stats
  /compact          Summarize conversation to save context
  /clear            Clear conversation history (fresh start)

Anything else is sent to the agent as a task.
The agent remembers previous turns until you /clear or /compact.
Paste multi-line text — it will be buffered and sent as one message.
`);
          writePrompt();
          return;
        }

        if (input === '/context') {
          console.log(`Model:    ${modelId}`);
          console.log(`Session:  ${sessionId || 'auto'}`);
          console.log(`Provider: ${providerName}`);
          console.log(`Role:     ${opts.role || profile.default_role}`);
          console.log(`Turns:    ${turnCount}`);
          console.log(`History:  ${history.length} messages (~${estimateTokens(history)} tokens)`);
          writePrompt();
          return;
        }

        if (input === '/history') {
          const tokens = estimateTokens(history);
          console.log(`Conversation: ${turnCount} turns, ${history.length} messages, ~${tokens} tokens`);
          if (tokens > AUTO_COMPACT_TOKENS * 0.7) {
            outputInfo('Tip: Run /compact to summarize and free up context space.');
          }
          writePrompt();
          return;
        }

        if (input === '/compact') {
          if (history.length === 0) {
            outputInfo('Nothing to compact.');
            writePrompt();
            return;
          }
          outputInfo('Compacting conversation...');
          try {
            history = await compactHistory(llm, systemPrompt, history);
            outputSuccess(`Compacted to ~${estimateTokens(history)} tokens. Conversation continues with summary.`);
          } catch (err: any) {
            outputError(`Compact failed: ${err.message}`);
          }
          writePrompt();
          return;
        }

        if (input === '/clear') {
          history = [];
          turnCount = 0;
          outputSuccess('Conversation cleared. Starting fresh.');
          writePrompt();
          return;
        }

        // ---- Agent turn ----

        if (processing) {
          outputDim('[Busy — waiting for current turn to finish]');
          writePrompt();
          return;
        }
        processing = true;
        turnCount++;

        try {
          let sawAssistantText = false;
          for await (const event of agentLoop(
            llm,
            toolExecutor,
            systemPrompt,
            input,
            toolSchemas,
            history,
            CHAT_LOOP_LIMITS,
          )) {
            switch (event.type) {
              case 'text':
                sawAssistantText = true;
                renderAssistantText(event.content || '');
                break;
              case 'thinking':
                renderThinking(event.content || '');
                break;
              case 'tool_call':
                renderToolCall(event.tool || '', event.input);
                break;
              case 'tool_result':
                renderToolResult(event.tool || '', event.result);
                break;
              case 'done':
                if (event.content && !sawAssistantText) outputSuccess(event.content);
                if (event.messages) history = event.messages;
                break;
              case 'fail':
                outputError(event.content || 'Task failed');
                if (event.messages) history = event.messages;
                break;
              case 'error':
                outputError(event.content || 'Unknown error');
                if (event.messages) history = event.messages;
                break;
            }
          }
        } catch (err: any) {
          outputError(`Error: ${err.message}`);
        } finally {
          processing = false;
        }

        // Auto-compact when history gets large
        const historyChars = JSON.stringify(history).length;
        if (historyChars > AUTO_COMPACT_CHARS) {
          outputDim(`\n[Auto-compacting: ~${Math.round(historyChars / CHARS_PER_TOKEN)} tokens exceeds ${AUTO_COMPACT_TOKENS} limit]`);
          try {
            history = await compactHistory(llm, systemPrompt, history);
            outputDim(`[Compacted to ~${estimateTokens(history)} tokens]`);
          } catch {
            // Non-fatal: just continue with full history
          }
        }

        writePrompt();
      }
    });
}

/**
 * Compact conversation history by asking the LLM to summarize it.
 * Replaces the full history with a compact summary exchange.
 */
async function compactHistory(
  llm: LlmProvider,
  systemPrompt: string,
  history: LlmMessage[],
): Promise<LlmMessage[]> {
  const summaryRequest = `Summarize our conversation so far in a concise paragraph. Focus on:
- What the user asked for
- What tools were used and their results
- Current state of the model (any changes made)
- Any important context for continuing the conversation
Keep it under 300 words.`;

  const response = await llm.chat(
    systemPrompt,
    [
      ...history,
      { role: 'user', content: [{ type: 'text', text: summaryRequest }] },
    ],
    [], // no tools for summary
  );

  const summaryText = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('\n');

  // Replace history with compact summary
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

/** Estimate token count from message history. */
function estimateTokens(messages: LlmMessage[]): number {
  const chars = JSON.stringify(messages).length;
  return Math.round(chars / CHARS_PER_TOKEN);
}
