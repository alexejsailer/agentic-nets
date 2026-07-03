/**
 * MCP prompts — recipe entry points a user can invoke by name from their client.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer, ctx: AppContext): void {
  server.registerPrompt(
    'setup-working-memory',
    { title: 'Set up my working memory', description: 'Deploy the working-memory template and demonstrate the write/recall loop', argsSchema: {} },
    () =>
      userMessage(
        `Set up my persistent working memory on Agentic-Nets: call deploy_template with template "working-memory", ` +
          `then store one memory about what we are working on right now (memory_write, place inbox), wait a moment and ` +
          `memory_recall it to show me the distilled note, and finally explain in two sentences how the always-on distiller works.`,
      ),
  );

  server.registerPrompt(
    'work-dev-team-backlog',
    { title: 'Work the dev-team backlog', description: 'Pull the next ready task from the dev-team pipeline and work it', argsSchema: {} },
    () =>
      userMessage(
        `Work the Agentic-Nets dev-team pipeline as the worker: query_tokens on p-team-task-ready; if a task is there, ` +
          `fire_once t-team-claim, do the work it describes using your own tools, write a concise result token, ` +
          `fire_once t-team-submit, and summarize what you did. If nothing is ready, check p-team-backlog and groom or ask me for tasks.`,
      ),
  );

  server.registerPrompt(
    'capture-session',
    {
      title: 'Capture this session into memory',
      description: 'Distill the current conversation into decisions and durable knowledge',
      argsSchema: { focus: z.string().optional().describe('Optional focus, e.g. "architecture choices"') },
    },
    ({ focus }) =>
      userMessage(
        `Distill our current conversation${focus ? ` (focus: ${focus})` : ''} into Agentic-Nets memory: ` +
          `each decision we made goes to place "decisions" with its why; each durable fact or lesson goes to "knowledge"; ` +
          `use memory_link where entries relate. Keep every entry self-contained. Then memory_graph to show me the result.`,
      ),
  );

  server.registerPrompt(
    'debug-net',
    {
      title: 'Debug a net',
      description: 'Structured diagnosis of a stuck or misbehaving net',
      argsSchema: { netId: z.string().optional().describe('The net to inspect (default: session overview)') },
    },
    ({ netId }) =>
      userMessage(
        `Diagnose ${netId ? `net "${netId}"` : 'my nets'} on Agentic-Nets, step by step: net_overview for structure and ` +
          `transition statuses; query_tokens on the input places of anything suspicious (is a token waiting? is its shape ` +
          `what the inscription expects?); event_trail filtered by the transition id for the last fire's story; then propose ` +
          `the fix — and if it is safe (stop/fire_once/start, or a set_schedule), apply it and verify.`,
      ),
  );
}
