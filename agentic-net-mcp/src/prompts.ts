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
          `transition statuses; net_stats for what is running / erroring / consuming LLM; query_tokens on the input places ` +
          `of anything suspicious (is a token waiting? is its shape what the inscription expects?); event_trail filtered by ` +
          `the transition id for the last fire's story; verify_inscription / dry_run_transition / diagnose_transition on the ` +
          `stuck transition. Then propose the fix — and if safe (fire_once with preserveRunning, start_transition, or set_schedule), apply and verify.`,
      ),
  );

  server.registerPrompt(
    'spawn-worker',
    {
      title: 'Spawn an autonomous worker persona',
      description: 'Stand up a self-driving persona net and give it a first task',
      argsSchema: {
        role: z.string().describe('What the worker is responsible for'),
        name: z.string().optional().describe('Short id (default derived from the role)'),
      },
    },
    ({ role, name }) =>
      userMessage(
        `Spawn an autonomous worker persona on Agentic-Nets for this responsibility: "${role}". ` +
          `Call spawn_persona (name ${name ? `"${name}"` : 'a short id you choose'}, role as above; pick capability ` +
          `"reason" unless it clearly needs to run commands, then "execute"; tier "high" if it needs strong reasoning). ` +
          `Then give it a first concrete task with memory_write place:"p-<name>-task", wait a few seconds, and show me its ` +
          `output with query_tokens on p-<name>-output. Explain that it now runs server-side in parallel and I can add more tasks anytime.`,
      ),
  );

  server.registerPrompt(
    'work-external-fires',
    {
      title: 'Run the AI lanes waiting for me',
      description:
        'Serve the llm/agent transitions that only run while a client is connected (no server-side LLM configured)',
      argsSchema: {},
    },
    () =>
      userMessage(
        `Work the Agentic-Nets AI lanes that are waiting for this session. Call list_external_fires: ` +
          `these llm/agent transitions are fired by a connected client, never by master, so nothing has run them ` +
          `while I was away. For EACH one with ready:true, call prepare_external_fire {transitionId}, reason as the ` +
          `host model over the returned prompt (llm) or nl instruction and allowedTools (agent), and hand the answer ` +
          `back with complete_external_fire — success:false or abandon_external_fire if you cannot do it, so the inputs ` +
          `are preserved. Then summarize what you processed and what is left. Finally, if any of these lanes carry a ` +
          `schedule, tell me they will not fire unattended and what my two options are.`,
      ),
  );

  server.registerPrompt(
    'monitor-personas',
    {
      title: 'Monitor running personas & nets',
      description: 'Give a live cockpit view of what is running, consuming LLM, or erroring',
      argsSchema: {},
    },
    () =>
      userMessage(
        `Give me a live status of my Agentic-Nets: call net_stats and summarize which transitions are RUNNING vs ` +
          `stopped/error, which are consuming LLM (calls/errors/avgMs), any recent errors, and the tool-net library. ` +
          `For anything erroring, drill in with event_trail and diagnose_transition and tell me what is wrong and the fix — ` +
          `using only the API, no logs.`,
      ),
  );
}
