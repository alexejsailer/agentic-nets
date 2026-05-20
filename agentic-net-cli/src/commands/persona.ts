import { Command } from 'commander';
import { createInterface } from 'node:readline';
import type { GatewayClient } from '../gateway/client.js';
import { PersonaClient, type AgentEvent } from '../master/persona-client.js';
import {
  outputJson,
  outputError,
  outputInfo,
  outputSuccess,
  outputDim,
  outputTable,
  isJsonMode,
  renderToolCall,
  renderToolResult,
  renderAssistantText,
} from '../render/output.js';

/**
 * `agenticos persona ...` — call master's persona endpoints (the same ones the
 * GUI's Universal Assistant uses). Master runs the agent loop; the CLI is a thin
 * SSE consumer. Symmetric with what `agentic-net-chat` (the Telegram bot) does.
 *
 * <p>For users who want a client-side agent loop (e.g. choose the LLM provider
 * locally, control role/tools client-side), the legacy {@code agenticos chat}
 * and {@code agenticos ask} commands are unchanged.</p>
 */
export function registerPersonaCommand(
  program: Command,
  getContext: () => { client: GatewayClient; modelId: string; sessionId: string },
): void {
  const persona = program.command('persona').description('Talk to master-side personas (SSE, same agents the GUI uses)');

  // ───────────────────────── persona list ─────────────────────────
  persona
    .command('list')
    .description('List personas registered on master')
    .action(async () => {
      const { client } = getContext();
      const personaClient = new PersonaClient(client);
      try {
        const personas = await personaClient.listPersonas();
        if (isJsonMode()) {
          outputJson(personas);
          return;
        }
        outputTable(
          ['Id', 'Role', 'Tools', 'Trigger', 'Description'],
          personas.map((p) => [
            p.id,
            p.role,
            String(p.toolCount),
            p.triggerMode,
            (p.description || '').slice(0, 60),
          ]),
        );
      } catch (err: any) {
        outputError(`Failed to list personas: ${err.message}`);
        process.exit(1);
      }
    });

  // ───────────────────────── persona ask ─────────────────────────
  persona
    .command('ask')
    .description('One-shot question to a master persona — prints the reply and exits')
    .argument('<message>', 'Message to send')
    .option('--persona <id>', 'Persona id (default: domain-expert)')
    .option('--model <id>', 'Model id (override profile default)')
    .option('--session <id>', 'Operational sessionId hint for the persona')
    .option('--quiet', 'Suppress tool-call breadcrumbs; only final text')
    .action(async (message: string, opts: any) => {
      const { client, modelId: defaultModelId } = getContext();
      const personaId = opts.persona || process.env['AGENTICOS_PERSONA'] || 'domain-expert';
      const modelId = opts.model || process.env['AGENTICOS_MODEL'] || defaultModelId || 'default';
      const personaClient = new PersonaClient(client);

      try {
        const started = await personaClient.startChat(personaId, modelId, opts.session);
        if (!opts.quiet && started.domainBootstrap === 'created') {
          outputDim(`(persona memory bootstrapped for ${modelId})`);
        }

        let finalText = '';
        let sawText = false;
        for await (const event of personaClient.streamAgent(
          personaId,
          modelId,
          started.conversationId,
          message,
        )) {
          handleEvent(event, {
            quiet: !!opts.quiet,
            onText: (t) => {
              sawText = true;
              finalText += t;
              renderAssistantText(t);
            },
            onCompletionSummary: (s) => {
              if (!sawText && s) {
                finalText = s;
                renderAssistantText(s);
              }
            },
          });
        }

        if (isJsonMode()) {
          outputJson({ personaId, modelId, conversationId: started.conversationId, response: finalText });
        }
      } catch (err: any) {
        outputError(`persona ask failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ───────────────────────── persona chat ─────────────────────────
  persona
    .command('chat')
    .description('Interactive chat with a master-side persona (SSE)')
    .option('--persona <id>', 'Persona id (default: domain-expert)')
    .option('--model <id>', 'Model id (override profile default)')
    .option('--session <id>', 'Operational sessionId hint for the persona')
    .option('--quiet', 'Suppress tool-call breadcrumbs')
    .action(async (opts: any) => {
      const { client, modelId: defaultModelId } = getContext();
      let personaId: string = opts.persona || process.env['AGENTICOS_PERSONA'] || 'domain-expert';
      let modelId: string = opts.model || process.env['AGENTICOS_MODEL'] || defaultModelId || 'default';
      const sessionHint: string | undefined = opts.session;
      const quiet: boolean = !!opts.quiet;

      const personaClient = new PersonaClient(client);
      let conversationId: string | null = null;
      let processing = false;

      outputInfo(`AgenticNetOS persona chat | persona=${personaId} | model=${modelId}`);
      outputInfo('Master runs the agent loop. Type a message, or:');
      outputInfo('  /personas    /persona <id>    /model <id>    /context    /clear    /quit');
      console.log();

      // Auto-detect TTY mode: interactive line-editor when stdout is a TTY,
      // plain line-reader when stdin is piped. Explicitly resume stdin in
      // the piped case so readline isn't racing against the parseAsync hook.
      if (!process.stdin.isTTY) {
        process.stdin.resume();
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const prompt = () => {
        if (processing) return; // wait for current turn
        if ((rl as any).closed) return; // /quit may have closed rl during a turn
        rl.setPrompt('> ');
        rl.prompt();
      };

      rl.on('SIGINT', () => {
        console.log('\nBye!');
        rl.close();
        // Hard-exit on Ctrl+C — abandon any in-flight SSE stream.
        process.exit(0);
      });

      rl.on('close', () => {
        // Let the event loop drain naturally so queued 'line' handler
        // microtasks (and any buffered stdout) get to run. Node exits
        // automatically once there's nothing left to do. Calling
        // process.exit(0) here kills pending microtasks — bad when
        // stdin is piped (test harness, scripted input).
      });

      rl.on('line', async (raw: string) => {
        const input = raw.trim();
        if (!input) { prompt(); return; }

        // Slash commands
        if (input === '/quit' || input === '/exit' || input === '/q') {
          rl.close();
          return;
        }
        if (input === '/help') {
          console.log(`
Commands:
  /personas       List personas registered on master
  /persona <id>   Switch persona (resets conversation)
  /model <id>     Switch model (resets conversation)
  /context        Show current persona, model, conversation id
  /clear          Drop the conversation id — next message starts fresh
  /quit           Exit
Anything else is sent to the persona's agent loop on master.
`);
          prompt();
          return;
        }
        if (input === '/personas') {
          try {
            const personas = await personaClient.listPersonas();
            outputTable(
              ['Id', 'Role', 'Tools', 'Description'],
              personas.map((p) => [p.id, p.role, String(p.toolCount), (p.description || '').slice(0, 60)]),
            );
          } catch (err: any) {
            outputError(`Failed to list personas: ${err.message}`);
          }
          prompt();
          return;
        }
        if (input.startsWith('/persona')) {
          const newId = input.slice('/persona'.length).trim();
          if (!newId) {
            console.log(`Current persona: ${personaId}`);
          } else {
            personaId = newId;
            conversationId = null;
            outputSuccess(`Persona set to ${personaId}. Conversation reset.`);
          }
          prompt();
          return;
        }
        if (input.startsWith('/model')) {
          const newId = input.slice('/model'.length).trim();
          if (!newId) {
            console.log(`Current model: ${modelId}`);
          } else {
            modelId = newId;
            conversationId = null;
            outputSuccess(`Model set to ${modelId}. Conversation reset.`);
          }
          prompt();
          return;
        }
        if (input === '/context') {
          console.log(`Persona:       ${personaId}`);
          console.log(`Model:         ${modelId}`);
          console.log(`Conversation:  ${conversationId ?? '(not started)'}`);
          prompt();
          return;
        }
        if (input === '/clear') {
          conversationId = null;
          outputSuccess('Conversation cleared. Next message starts fresh.');
          prompt();
          return;
        }

        // Agent turn
        processing = true;
        try {
          if (!conversationId) {
            const started = await personaClient.startChat(personaId, modelId, sessionHint);
            conversationId = started.conversationId;
            if (started.domainBootstrap === 'created') {
              outputDim(`(persona memory bootstrapped for ${modelId})`);
            }
          }

          let sawText = false;
          for await (const event of personaClient.streamAgent(
            personaId,
            modelId,
            conversationId,
            input,
          )) {
            handleEvent(event, {
              quiet,
              onText: (t) => { sawText = true; renderAssistantText(t); },
              onCompletionSummary: (s) => {
                if (!sawText && s) renderAssistantText(s);
              },
            });
          }
        } catch (err: any) {
          outputError(`agent-stream failed: ${err.message}`);
          conversationId = null; // restart cleanly on next turn
        } finally {
          processing = false;
          console.log();
          prompt();
        }
      });

      // Kick off the first prompt only AFTER all listeners are registered,
      // so piped stdin (test harness) doesn't lose its first line to a
      // missing 'line' handler. Skip the visual prompt entirely when stdin
      // isn't a TTY — scripted/piped input doesn't need it and rl.prompt()
      // in non-TTY mode interacts oddly with stdin readiness.
      if (process.stdin.isTTY) prompt();
    });
}

/** Dispatch a single AgentEvent into terminal rendering. */
function handleEvent(
  event: AgentEvent,
  cb: {
    quiet: boolean;
    onText: (text: string) => void;
    onCompletionSummary: (summary: string | undefined) => void;
  },
): void {
  switch (event.type) {
    case 'thinking':
      // Don't render — too chatty for terminal. Stays consistent with Telegram bot.
      break;
    case 'tool_call':
      if (!cb.quiet) renderToolCall(event.toolName || '?', event.params);
      break;
    case 'tool_result':
      if (!cb.quiet) renderToolResult(event.toolName || '?', event.result);
      break;
    case 'text':
      if (event.text && event.text.trim().length > 0) cb.onText(event.text);
      break;
    case 'completion':
      cb.onCompletionSummary(event.summary);
      if (!cb.quiet) {
        outputDim(`(completion: success=${event.success} iterations=${event.iterationCount} tools=${event.toolCallCount})`);
      }
      break;
    case 'error':
      outputError(`error: ${event.message ?? event.error ?? 'unknown'}`);
      break;
  }
}
