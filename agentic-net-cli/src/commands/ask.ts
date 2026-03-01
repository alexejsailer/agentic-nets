import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { loadConfig, getActiveProfile, resolveProfile } from '../config/config.js';
import { parseRole } from '../agent/roles.js';
import { getToolSchemas, buildSystemPrompt } from '../agent/prompts.js';
import { ToolExecutor } from '../agent/tool-executor.js';
import { agentLoop } from '../agent/runtime.js';
import { createLlmProvider } from './llm-factory.js';
import {
  renderThinking, renderToolCall, renderToolResult, renderAssistantText,
  outputError, outputJson, isJsonMode,
} from '../render/output.js';

const ASK_LOOP_LIMITS = {
  maxIterations: 30,
  maxToolCalls: 24,
  maxThinkCalls: 3,
  maxConsecutiveSameToolCalls: 2,
};

export function registerAskCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  program
    .command('ask')
    .description('Single-shot agent query')
    .argument('<message>', 'Message for the agent')
    .option('--provider <name>', 'LLM provider (claude|openai|ollama|claude-code|codex)')
    .option('--tier <tier>', 'Model tier (high|medium|low)')
    .option('--role <role>', 'Agent role (r|rw|rwx|rwxh)')
    .option('--quiet', 'Only show final output')
    .option('--stdin', 'Read message from stdin')
    .action(async (message: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const cfg = loadConfig();
      const profile = resolveProfile(getActiveProfile(cfg));

      const providerName = opts.provider || profile.default_provider;
      const role = parseRole(opts.role || profile.default_role);

      let llm;
      try {
        llm = createLlmProvider(providerName, profile, opts.tier);
      } catch (err: any) {
        outputError(err.message);
        process.exit(1);
      }

      // Handle stdin input
      let userMessage = message;
      if (opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        userMessage = Buffer.concat(chunks).toString('utf-8').trim();
      }

      const toolExecutor = new ToolExecutor(client, modelId, sessionId, undefined, llm);
      const systemPrompt = buildSystemPrompt({ role, modelId, sessionId, task: userMessage });
      const toolSchemas = getToolSchemas(role);

      const results: any[] = [];
      let finalText = '';
      let sawAssistantText = false;

      try {
        for await (const event of agentLoop(
          llm,
          toolExecutor,
          systemPrompt,
          userMessage,
          toolSchemas,
          undefined,
          ASK_LOOP_LIMITS,
        )) {
          switch (event.type) {
            case 'text':
              sawAssistantText = true;
              finalText += (event.content || '') + '\n';
              if (!opts.quiet) renderAssistantText(event.content || '');
              break;
            case 'thinking':
              if (!opts.quiet) renderThinking(event.content || '');
              break;
            case 'tool_call':
              if (!opts.quiet) renderToolCall(event.tool || '', event.input);
              break;
            case 'tool_result':
              results.push({ tool: event.tool, result: event.result });
              if (!opts.quiet) renderToolResult(event.tool || '', event.result);
              break;
            case 'done':
              if (!sawAssistantText) {
                finalText += (event.content || '') + '\n';
              }
              break;
            case 'fail':
              outputError(event.content || 'Task failed');
              process.exit(1);
              break;
            case 'error':
              outputError(event.content || 'Unknown error');
              process.exit(1);
              break;
          }
        }
      } catch (err: any) {
        outputError(`Error: ${err.message}`);
        process.exit(1);
      }

      if (opts.quiet && isJsonMode()) {
        outputJson({ text: finalText.trim(), results });
      } else if (opts.quiet) {
        console.log(finalText.trim());
      }
    });
}
