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
    'work-persona-kanban',
    {
      title: 'Work the Persona Kanban queue',
      description: 'Discover the installed board, claim one eligible task, and follow its audited lifecycle',
      argsSchema: {
        persona: z.string().optional().describe('Stable Persona id used for assignee/actor fields'),
        application: z.string().optional().describe('Installed app name or session id (default persona-kanban)'),
      },
    },
    ({ persona, application }) => {
      const worker = persona || 'choose a stable id matching your Persona charter';
      const app = application || 'persona-kanban';
      return userMessage(
        `Work one eligible task from the installed Persona Kanban application "${app}" as ${worker}. ` +
          `First call application_list and application_describe; read agentProtocol and resolve the cards store role to its current placeId. ` +
          `Query that place for kind=="kanban-task", status=="ready", archived!="true", selecting only work that is unassigned or assigned to your exact Persona id. ` +
          `Re-read immediately before application_action claimTask. If none is eligible, report that and stop without manufacturing work. ` +
          `If one is eligible, claim it with your stable id, do the described work with the tools and boundaries in your charter, addComment with meaningful progress/evidence, ` +
          `then requestReview with a concise result and verification evidence. Do not self-approve; an independent reviewer calls approveTask. ` +
          `After every action re-query the card and verify its state. On a blocker, addComment and either updateTask blockedReason or releaseTask so work is not silently held.`,
      );
    },
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
    'design-persona-team',
    {
      title: 'Design a persona or specialist team',
      description: 'Turn a goal into named specialists, context playbooks, safe hand-offs, and an honest execution backend',
      argsSchema: {
        goal: z.string().describe('The outcome the persona or team should own'),
        team: z.string().optional().describe('Optional requested roles or team constraints'),
      },
    },
    ({ goal, team }) =>
      userMessage(
        `Design a persona-first Agentic-Net for this outcome: "${goal}"${team ? `. Team context: "${team}"` : ''}. ` +
          `First read agenticnets://docs/personas and call readiness/llm_health. Explain the proposed named specialist(s), ` +
          `each charter, inbox/output, domain context, boundaries, and hand-offs in plain language. Choose the reasoning ` +
          `backend honestly: server provider when health is READY/ONLINE; CLI-backed agent (Claude Code or Codex) for unattended Desktop ` +
          `Lite when available; connected-client otherwise. Keep routing/review deterministic, use typed link transitions ` +
          `for context/playbook relationships, add a journal/feedback loop, and describe what could later crystallize into ` +
          `a tool-net. After showing that compact design, build it unless an important safety/domain choice needs my answer.`,
      ),
  );

  server.registerPrompt(
    'start-safe-product-team',
    {
      title: 'Start a Safe Product Team',
      description:
        'Deploy a worked persona-first product team with repository context, review gates, and Protocol reporting',
      argsSchema: {
        product: z.string().describe('What the team should build or improve'),
        repository: z
          .string()
          .optional()
          .describe('Repository URL or executor-visible working directory; omitted means configure before execution'),
        execution: z
          .enum(['auto', 'server', 'claude-code', 'codex', 'connected-client'])
          .optional()
          .describe('Reasoning backend for the resident personas (default auto after readiness)'),
      },
    },
    ({ product, repository, execution }) =>
      userMessage(
        `Start the Agentic-Nets Safe Product Team for this product outcome: "${product}". ` +
          `${repository ? `Repository/context root: "${repository}". ` : 'No repository was supplied: stage the team, but do not grant execution or invent a path; ask me for the repository contract before the first real task. '}` +
          `First read agenticnets://docs/safe-product-team and call readiness/llm_health. ` +
          `Choose one honest persona backend${execution ? ` (requested: "${execution}")` : ''}; say whether it runs while disconnected. ` +
          `If the selected backend is a healthy server provider, prefer the versioned NetHub agent package: hub_search kind agent ` +
          `for "safe-product-team", inspect it with hub_show, then hub_install latest into the current product model. It is singleton per ` +
          `model so p-protocol stays canonical, and it installs STOPPED ` +
          `and reasoning-only; populate its required p-spt-product-context schema, inspect the conservative charter/safety policy, verify, ` +
          `and only after configuration use START_AGENT_SESSION when exposed, or start_transition on its returned startPlan in order. ` +
          `Do not add command/repository execution authority unless ` +
          `I separately request a reviewed adapter. Do not also build an ad-hoc team when that package path succeeds. ` +
          `For CLI-backed or connected-client execution, deploy the token-free dev-team template as the deterministic backlog/WIP/review ` +
          `backbone and compose the personas around it. Ensure shared places for repository registry, product context, decisions, lessons, ` +
          `structured status, and p-protocol. Repository tokens must name ` +
          `repoUrl or workingDir, defaultBranch, build/test commands, allowed write scope, and push/deploy policy; never store credentials. ` +
          `Create the core resident personas STOPPED first: Product Manager, Architect, Developer, Reviewer/QA, Release Guardian, and ` +
          `Chronicle. Product Manager is the only user inbox; Developer is the only default code writer and its charter forbids commit, ` +
          `push, and deploy; Reviewer returns ` +
          `approved|needs-work|blocked; Release Guardian requires an explicit approval token before commit/push/deploy; Chronicle ` +
          `summarizes evidence but never changes product state. Use reason capability unless a role genuinely needs tools, and least privilege ` +
          `for execute roles. Wire place-to-place hand-offs with deterministic transitions and preserve a single _correlationId/storyId ` +
          `through every stage. Every persona must write a concise milestone to p-protocol and a machine-readable status token; the normal ` +
          `event trail remains the complete low-level history. Add feedback and lessons places, but require review before promoting a lesson ` +
          `into context or crystallizing repeated successful steps into a tool-net. Verify every inscription, smoke-test one harmless story, ` +
          `then arm only the lanes whose backend and prerequisites are ready: use set_external for connected-client lanes, and ` +
          `start_transition only for server- or CLI-backed resident lanes. Finish with protocol_write summarizing what was created, the ` +
          `selected backend, repository readiness, stopped/started lanes, first inbox, approval boundary, and how to pause the model.`,
      ),
  );

  server.registerPrompt(
    'review-current-model',
    {
      title: 'Review the current model',
      description:
        'Run a domain-neutral evidence review of the current model, its nets, processes, safety, and optimization opportunities',
      argsSchema: {
        scope: z
          .enum(['model', 'session', 'net', 'transition', 'correlation'])
          .optional()
          .describe('Review scope (default model)'),
        target: z.string().optional().describe('Session, net, transition, or correlation id for a narrow scope'),
        question: z.string().optional().describe('Optional domain-specific review question'),
      },
    },
    ({ scope, target, question }) =>
      userMessage(
        `Review the current Agentic-Nets ${scope ?? 'model'}${target ? ` target "${target}"` : ''}` +
          `${question ? ` with this focus: "${question}"` : ''}. Read agenticnets://docs/model-steward, then call readiness and llm_health. ` +
          `If a server LLM is healthy, use the built-in NetHub model-steward agent: hub_search {kind:"agent",search:"model-steward"}, ` +
          `hub_show it, install latest only if it is not already installed, keep the install STOPPED while inspecting its advisory-only ` +
          `charter, then use START_AGENT_SESSION when exposed (otherwise arm the returned startPlan dependency-first with start_transition) ` +
          `and write one correlated request to p-ms-inbox. Read p-ms-reports and p-ms-findings. ` +
          `If no server provider is healthy, do NOT claim that the installed agent ran: perform the same review interactively with ` +
          `net_stats, net_overview, query_tokens, scheduler_status, list_executors, usage_report, and event_trail. In either path, separate ` +
          `observed facts from inference; assess flow/backpressure, correctness/error handling, authority/safety, observability/provenance, ` +
          `cost/efficiency, context quality, resilience, and crystallization candidates. Produce strengths as well as risks, cite evidence, ` +
          `recommend the smallest reviewable changes, apply nothing, and finish with protocol_write summarizing the review and limitations.`,
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
          `Call readiness first. If this is Claude Code/Codex connected to Desktop on the same machine, propose its matching explicit CLI execution so the persona can run unattended; otherwise use execution:"auto". Then call spawn_persona (name ${name ? `"${name}"` : 'a short id you choose'}, role as above; pick capability ` +
          `"reason" unless it clearly needs to run commands, then "execute"; tier "high" if it needs strong reasoning). ` +
          `Then give it a first concrete task with memory_write place:"p-<name>-task", wait a few seconds, and show me its ` +
          `output with query_tokens on p-<name>-output. Report the selected executionBackend and say clearly whether it ` +
          `runs unattended or only while a client is connected.`,
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
          `these provider-backed llm/agent transitions are fired by a connected client; CLI-backed persona agents remain master-owned. Nothing has run the listed external work ` +
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
