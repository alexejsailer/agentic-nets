/**
 * MCP prompts — recipe entry points a user can invoke by name from their client.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';

/** A focus scope expression (one feature across its levels) as the prompts accept it: domain:, tag:, net:, or several. */
function isFocusScope(scope?: string): boolean {
  return !!scope && /^(domain|tag|net|any):/.test(scope.split(',')[0].trim());
}

/** The look-around step every scoped pass runs before it asks: gaps, neighbours, other features. */
function lookAround(scope: string): string {
  return `Look around ${scope} before asking anything: focus_scope {scope:"${scope}"} lists its nets per level, the nets around it with how each connects, and the gaps (levels its chain passes without a net of its own). `
    + `For each open gap decide from the sources and from the other features on that level (the gap's examples): the scope needs its own net there (update_net_definition {action:"create"} on that level, domain and tags of the scope, the parent element its chain passes, status draft), the level is covered by a net in its chain (curate_model {action:"confirm", subjectKey: the gap's subjectKey, notes:"covered by <net>: <why>"}), or it is not needed (confirm with notes "not needed: <why>"); only when neither the sources nor the neighbours settle it, ask the person on the gap's subjectKey. `
    + `For each neighbour with cards (parent, child, depends-on and its inverse, explains, references, shares-place) read its definition and open decisions: a change or an open question there that affects the scope becomes a flag on the scope's net (level-above-changed / level-below-changed / unclear) or a question with the neighbour as evidence. `
    + `Derive from the other features: what they have that the scope lacks on the same level (acceptance criteria, error states, rules, a place they share, a child net they refine) is a candidate gap; raise it with evidence from both sides, never silently copy it.`;
}

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** Prompts that drive the review method's tools; registered only with AGENTICOS_REVIEW_TOOLS. */
export const REVIEW_PROMPTS = new Set(['structure-pass', 'ground-model', 'refinement-pass', 'question-round', 'implement-from-model']);

export function registerPrompts(server: McpServer, ctx: AppContext): void {
  // The review method's prompts (passes, question rounds) name its tools: only with AGENTICOS_REVIEW_TOOLS.
  const prompts: McpServer = ctx.config.reviewTools === true ? server : new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerPrompt') return Reflect.get(target, prop, receiver);
      return (name: string, ...rest: unknown[]) =>
        REVIEW_PROMPTS.has(name) ? undefined : (target.registerPrompt as (...a: unknown[]) => unknown).call(target, name, ...rest);
    },
  });
  prompts.registerPrompt(
    'setup-working-memory',
    { title: 'Set up my working memory', description: 'Deploy the working-memory template and demonstrate the write/recall loop', argsSchema: {} },
    () =>
      userMessage(
        `Set up my persistent working memory on Agentic-Nets: call deploy_template with template "working-memory", ` +
          `then store one memory about what we are working on right now (memory_write, place inbox), wait a moment and ` +
          `memory_recall it to show me the distilled note, and finally explain in two sentences how the always-on distiller works.`,
      ),
  );

  prompts.registerPrompt(
    'work-dev-team-backlog',
    { title: 'Work the dev-team backlog', description: 'Pull the next ready task from the dev-team pipeline and work it', argsSchema: {} },
    () =>
      userMessage(
        `Work the Agentic-Nets dev-team pipeline as the worker: query_tokens on p-team-task-ready; if a task is there, ` +
          `fire_once t-team-claim, do the work it describes using your own tools, write a concise result token, ` +
          `fire_once t-team-submit, and summarize what you did. If nothing is ready, check p-team-backlog and groom or ask me for tasks.`,
      ),
  );

  prompts.registerPrompt(
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

  prompts.registerPrompt(
    'organize-model',
    {
      title: 'Organize a model into an abstraction hierarchy',
      description: 'Read the model, propose levels, domains, parents and relations, and apply only what the person approves',
      argsSchema: {
        model: z.string().optional().describe('Target model when this connection allows several'),
        focus: z.string().optional().describe('Optional area to organize first, e.g. a session or a domain'),
      },
    },
    ({ model, focus }) => userMessage(
      `Help me organize${model ? ` model "${model}"` : ' this model'} as a hierarchy of abstractions`
      + `${focus ? `, starting with ${focus}` : ''}.\n\n`
      + '1. Read it: explore_model {detail:"full"} (nets with depth, parent, interface, domain, tags, execution; shared places with readers and writers; relations), net_levels {action:"list"}, and list_net_definitions.\n'
      + '2. Propose, do not apply yet: named levels top to bottom (the domain decides: e.g. product > service > implementation, or customer promise > process > team > tooling); a level and a domain for each net; '
      + 'which net refines which element of another net (a parent transition whose presets and postsets are the child\'s input and output ports; same place ids); explicit relations (explains, depends-on, references) where nets explain or rely on each other without refinement; '
      + 'and definitions for missing abstract nets (a higher-level net that summarizes several lower ones). Base every proposal on what you read: shared places, link relations, names and descriptions; say how sure you are.\n'
      + '3. Present it as a short table and ask me which parts to apply (an Interview question is fine when I am not in this conversation).\n'
      + '4. Apply only what I approved: net_levels {action:"save"}, update_net_definition {action:"organize"} per net, {action:"relate"} for relations, '
      + 'and {action:"create", parent} for new abstract nets (they stay definitions until someone builds them). A refinement between two existing nets is written by creating or promoting a subnet in Studio, or by a definition with a parent; never by inventing places.\n'
      + '5. Re-read explore_model and report what changed and any port mismatches the catalogue now shows. Nothing here starts, stops or deletes anything.',
    ),
  );

  prompts.registerPrompt(
    'structure-pass',
    {
      title: 'Settle the model\'s structural cards from the sources, without the person',
      description: 'Take the cards meant for the AI (nothing refines this, draft definitions, failed refinements, nets below nothing, never confirmed) and settle each by reading the sources; ask the person only what the sources cannot tell',
      argsSchema: {
        scope: z.string().optional().describe('A level id, a net key (session::net), or a focus scope (domain:<d>, tag:<t>, net:<session::net>); default: the whole model'),
        count: z.string().optional().describe('How many cards to settle this pass (default 20)'),
        model: z.string().optional().describe('Target model when this connection allows several'),
      },
    },
    ({ scope, count, model }) => {
      const on = model ? ` in model "${model}" (pass model:"${model}" on every call)` : '';
      return userMessage(
        `Run a structure pass${on} on ${scope || 'the whole model'}, ${count || '20'} cards at most. These cards are the model's own housekeeping; the person decides only what the sources cannot settle.\n\n` +
          `1. Read: refine_model {${scope ? (isFocusScope(scope) ? `scope:"${scope}"` : scope.includes('::') ? `net:"${scope}"` : `level:"${scope}"`) + ', ' : ''}for:"model"} for the structural cards${isFocusScope(scope) ? ' (they include one scope-gap card per level the scope\'s chain passes without a net of its own)' : ''}; explore_model for the hierarchy; for each card get_net_definition and read the sources the definition references (files, documents, data) yourself.\n` +
          `2. Settle each card from what you read: "nothing refines this" becomes a child definition when the sources show a step with its own inner structure (update_net_definition {action:"create"} under the parent element, status draft, interactions from the sources, references to them), a confirmation with note "known gap" when something is there you cannot describe yet, or a confirmation with note "as simple as it looks" when the step is one thing. A draft definition is filled from the sources (update_net_definition, then status ready) or deleted when nothing realizes it. A failed refinement is repaired (ports, missing target) or flagged wrong with the evidence. A net below nothing gets its parent (organize) or an explains relation, or is flagged. A never-confirmed net is confirmed at the sourceHash when its claims hold in the sources, flagged (wrong, unclear, unmeasured) with evidence when they do not.\n` +
          (isFocusScope(scope) ? `2b. ${lookAround(scope!)}\n` : '') +
          `3. Ask only what the sources cannot tell: a reason, an intent, a choice between two readings. Then curate_model {action:"ask", evidence, reasoning, options} as in a question round.\n` +
          `4. Record the pass: curate_model {action:"pass", consumedUntil: focus_digest's until, scope:"${isFocusScope(scope) ? `focus:<focus_scope's scope>` : `structure:${scope || 'model'}`}", summary, changes, questions}. Report what was settled per kind and what went to the person. Never push, never start anything on a schedule.`,
      );
    },
  );

  prompts.registerPrompt(
    'ground-model',
    {
      title: 'Extract the truth from the bottom level and check every level above',
      description: 'Walk the bottom level (code, documents, data), read its sources, and check each level above against them: confirm what holds, correct what is mechanical, ask the person where the levels and the sources disagree',
      argsSchema: {
        level: z.string().optional().describe('The bottom level id (default: the lowest level)'),
        net: z.string().optional().describe('One bottom net (session::net) instead of the whole level'),
        policy: z.string().optional().describe('sources-win: correct the levels silently where the sources clearly decide; ask: every divergence becomes a card (default ask)'),
        model: z.string().optional().describe('Target model when this connection allows several'),
      },
    },
    ({ level, net, policy, model }) => {
      const on = model ? ` in model "${model}" (pass model:"${model}" on every call)` : '';
      return userMessage(
        `Ground the model${on}: the bottom level is where the model touches the domain's own material (for software the code, for a process its documents, for a product its measurements). Extract what is true there and carry it up through every level, so the abstractions say what the material does.\n\n` +
          `1. Read: ground_model {${level ? `level:"${level}"` : ''}${net ? `${level ? ', ' : ''}net:"${net}"` : ''}} for the chains: every bottom net with the nets above it, each node with its claims (description, interactions, acceptance), its references, its definition revision and its confirmation (revision, sourceHash, when). If the model is built from a specification, run its checker and its grounding tool first (they settle the mechanical part: references exist and contain what they claim, parameters hold their values) and take their cards and flags as given.\n` +
          `2. For each chain, bottom-up: read the bottom node's referenced sources yourself. Then for every node above it compare each claim with what you read. Three outcomes. Agree: curate_model {action:"confirm", subjectKey, subjectRevision, sourceHash, notes: what was checked}. Mechanical divergence (a renamed symbol, a changed value or count, a moved file): ${policy === 'sources-win' ? 'correct the level (update_net_definition or the specification plus a rebuild), then confirm it' : 'correct the level when the sources clearly decide it (update_net_definition or the specification plus a rebuild), then confirm it; when the change could be a regression rather than the truth, treat it as a decision'}. Decision divergence (the level says the product should do X, the sources do Y, and either could be the intended one): curate_model {action:"flag", flag:"contradiction", reason, evidence} on the node, and {action:"ask", subjectKey, header:"Sources differ", evidence: [what the level claims, what the sources do, file and line], reasoning: which one you believe is intended and why, options: [{keep-level: keep the level as written, the sources must change}, {adopt-sources: the sources are right, the level changes}, {both: both need a change}], allowFreeText:true}. A chain whose upper nodes were confirmed before the bottom node (aboveConfirmedBeforeBottom) is checked first.\n` +
          `3. Never invent: a claim you cannot check against a source is flagged unmeasured, not confirmed. Carry a change down as well as up: when a level changes, the nets it refines are re-checked.\n` +
          `4. Record the pass: curate_model {action:"pass", consumedUntil: focus_digest's until, scope:"ground:${level || 'bottom'}", summary, changes: [nodes confirmed, nodes corrected], questions: [cards raised]}. Report per chain: agreed, corrected, asked. Never push.`,
      );
    },
  );

  prompts.registerPrompt(
    'refinement-pass',
    {
      title: 'Apply what the person answered, top-down, and prepare the next focus session',
      description: 'Read the digest since the last pass, revise every layer above the realization that the answers touch, resolve what is settled, raise the next questions and record the pass',
      argsSchema: {
        scope: z.string().optional().describe('A level id, a persona, a net key, or a focus scope (domain:<d>, tag:<t>, net:<session::net>: one feature across its levels) to limit the pass; default: the whole model'),
        since: z.string().optional().describe('ISO-8601 instant to start from; default: the last recorded pass'),
        model: z.string().optional().describe('Target model when this connection allows several'),
      },
    },
    ({ scope, since, model }) => {
      const on = model ? ` in model "${model}" (pass model:"${model}" on every call)` : '';
      const limit = scope ? ` limited to ${scope}` : '';
      return userMessage(
        `Run a refinement pass${on}${limit}. Focus sessions (the person answers cards in the Explorer's Focus view or here) and refinement passes (this) alternate as often as needed; implementation is a separate step later (prompt implement-from-model). The goal of a pass is the layers above the realization (the code, the process, the document, whatever the lowest level is): after it, every definition the answers touched says what the person meant, and the next focus session asks only what nobody can derive.\n\n` +
          `1. Read: focus_digest {${since ? `since:"${since}", ` : ''}${isFocusScope(scope) ? `scope:"${scope}"` : scope && !scope.includes('::') ? `level:"${scope}"` : ''}} for what was answered, confirmed, flagged, resolved and deferred since the last pass, grouped by level and subject, the person's BRIEFS (notes of noteKind brief: what they said about a subject in their own words, the planning input; derive the subject's definition from a brief, nothing invented, and carry the change down and up), plus the questions still open and the person's own questions (ownQuestions: answer each by changing the model or by asking back with curate_model {action:"ask", requestId}); an answer with intent "revise" carries the person's better wording in revisedQuestion: ask it again with supersedes; note the digest's \`until\`. explore_model for the hierarchy and the levels in order. get_net_definition for every subject in the digest (description, interactions, acceptance, references, questions, curation).\n` +
          `2. Apply top-down, level by level from the highest: for each subject, read its answers and marks together. A "right" confirms the definition as it is (nothing to change; keep the confirmation). A "partly" or "wrong" with the person's words changes the definition: revise description, interactions and acceptance with update_net_definition (or the specification file plus a rebuild when the model is spec-built; then confirm the rebuilt revision at the current sourceHash), and carry the change DOWN: every child net whose definition contradicts the new wording is revised or flagged level-above-changed, and the parent element is checked (level-below-changed when a child's answer changes what the parent claims). A request to refine here becomes a child definition (update_net_definition {action:"create"} with the parent element, status draft) with the ports the parent's element implies. Free text that is a reason nobody could derive goes into the definition's interactions or the model's context net, never lost. Resolve every flag the change settles (curate_model {action:"resolve", how:"changed"}); leave open what still needs the person.\n` +
          `3. Check: reread get_net_definition and explore_model on what you changed (or run the specification checker when the model is spec-built); the catalogue must verify every refinement you touched (ports, targets). No level lock is bypassed; nothing is started that spends quota on a schedule.\n` +
          (isFocusScope(scope) ? `3b. Stay inside the focus, but ${lookAround(scope!).replace(/^Look around/, 'look around')}\n` : '') +
          `3c. Summarize for the person: for every subject with a brief or an answer, curate_model {action:"note", noteKind:"summary", subjectKey, text} with what you understood, what you changed (revision) and what stays open, in 3 to 8 sentences; the Focus view shows it in the subject's thread. Offer analogies: what the analogous subjects on the same level decided becomes an option of the next question.\n` +
          `4. Raise the next questions about the thing itself (what it should do, which rule, which value, which trade-off), not about the nets: for every change, ask what it opens (the next lower level first), with curate_model {action:"ask", subjectKey, question, header, evidence, reasoning, options, subjectRevision}. Every card carries substance the person can argue with: evidence = what you read or measured, one item each with its finding (file and line, document, number, the person's earlier words); reasoning = why the question matters, the trade-off between the options, which one you recommend and why; options = two to four, each with a description of its consequence, exactly one recommended; allowFreeText true. A question without evidence and reasoning is not asked. Prefer decide / choose / explain kinds; at most ${scope ? '5' : '10'} new questions, the rest waits for the next pass. Deferred subjects stay untouched until their date.\n` +
          `5. Record the pass: curate_model {action:"pass", consumedUntil: the digest's until, scope${isFocusScope(scope) ? ` (exactly focus_scope's passScope, so the next digest of this focus starts after it and the whole model still sees the answers)` : ''}, summary, answers: count consumed, changes: [...], questions: [promptIds raised], by: you}. Report here: per level what changed, what was resolved, what was asked, what stays open and why; name the definitions revised by key. Never push. (Every step is a tool call; an MCP client can run the pass without this prompt and without a server-side LLM.)`,
      );
    },
  );

  prompts.registerPrompt(
    'implement-from-model',
    {
      title: 'Realize a net of the lowest layer from its definition',
      description: 'A separate step after focus and refinement: turn one confirmed lowest-layer net into work items or code through an interview here, never silently',
      argsSchema: {
        net: z.string().describe('The net to implement (session::net), normally on the lowest level above the code'),
        output: z.string().optional().describe('cards (work items in a kanban application), code (edit the referenced sources), or plan (a written plan only); default: ask'),
        model: z.string().optional().describe('Target model when this connection allows several'),
      },
    },
    ({ net, output, model }) => {
      const on = model ? ` in model "${model}" (pass model:"${model}" on every call)` : '';
      return userMessage(
        `Implement ${net}${on} from its definition. This is the step AFTER focus and refinement: the layers above the realization are done when the net and its parents are confirmed and no open flag or question remains on them; implementation starts only then and only through this interview.\n\n` +
          `1. Readiness: get_net_definition for ${net} and explore_model for its parents; review_model for its curation. If the net or a parent is unconfirmed, flagged or has open questions, stop and say what a focus session must settle first (refine_model {net:"${net}"} lists it). If the model is spec-built, name the specification entry.\n` +
          `2. Interview me, one question at a time, about what the definition leaves to the implementer: the output (${output || 'cards for a kanban application, code in the referenced sources, or a written plan'}), the boundary (which referenced sources may change, which may not), the order (which transition first), the acceptance that will be checked and how, and who reviews. Record each answer with curate_model {action:"ask", evidence, reasoning, options with descriptions and one recommended} + {action:"answer"} on subject "${net}" so the decisions and the arguments live in the model.\n` +
          `3. Produce exactly the agreed output: cards through the installed kanban application (application_action, one card per transition or per acceptance line, owner = the level's persona, the net key in the card), or code edits in the referenced sources with the net's acceptance as the test list, or a plan as a definition note. Never start a transition, a scheduled lane or a headless coder on your own; a command transition that triggers implementation is a later platform step and is not wired here.\n` +
          `4. Close the loop: confirm the net at the new sourceHash when sources changed (curate_model {action:"confirm", sourceHash}), flag the definition level-below-changed when the implementation taught something the definition did not say, and report what was produced, what was checked, what stays open.`,
      );
    },
  );

  prompts.registerPrompt(
    'question-round',
    {
      title: 'Run a question round on a level or a net',
      description: 'Check what the model claims against its sources, ask the person what only they know, and record confirmations, flags and answers',
      argsSchema: {
        scope: z.string().optional().describe('A level id (e.g. rules) or a net key (session::net); default: whatever needs the person most'),
        count: z.string().optional().describe('How many questions to ask this round (default 5)'),
        persona: z.string().optional().describe('The persona asking, when the model has one per level'),
        model: z.string().optional().describe('Target model when this connection allows several'),
      },
    },
    ({ scope, count, persona, model }) => {
      const on = model ? ` in model "${model}" (pass model:"${model}" on every call)` : '';
      const who = persona ? `as the ${persona}` : 'as the keeper of that level';
      return userMessage(
        `Run a question round${on} ${who}, on ${scope || 'what needs me most'}, ${count || '5'} questions at most. One question at a time; I answer here or in the Explorer.\n\n` +
          `1. Read: refine_model {${scope ? (scope.includes('::') ? `net:"${scope}"` : `level:"${scope}"`) + ', ' : ''}direction:"both"} for the worklist (looking down: transitions nothing refines, refinements that do not verify, definitions still open; looking up: nets below nothing; and the review: open flags, open questions, never confirmed), each item with a ready-made question; explore_model for the hierarchy; get_net_definition for the nets you will ask about (description, interactions, acceptance, references, questions already answered, curation). Never ask what an answered question already settled.\n` +
          `2. Check before asking (no LLM needed for most of it): every reference the definition names still exists and still contains what it claims; every parameter named still has that value; every transition at this level is refined below or named as a known gap; a confirmed net whose referenced sources changed since (sourceHash) is stale. If the model is built from a specification file, run its checker. Record each mechanical finding as a flag with a deterministic markId (application_action on "curation", action "flag", subjectKind net|element, subjectKey "<session>::<net>" or "<session>::<net>#<elementId>", flag, reason with the measured evidence, by = you). Resolve flags the check no longer finds (action "resolve", how "changed").\n` +
          `3. Ask only what you cannot find out: the reasons behind a rule, whether a description still describes what the person means (the code, the process, the rule, the document), a better name, whether a net is too coarse. Prefer these kinds: confirm ("the net says X, the sources do Y: right / partly / wrong / don't know"), choose (options), explain (free text, the most valuable kind), name, split-or-merge. Each question goes through curate_model {action:"ask", subjectKey, question, header, evidence, reasoning, options, subjectRevision} (the worklist's item.ask is a starting point; the subject kind and a promptId are derived) and carries substance: evidence = what you read or measured with its finding, reasoning = why it matters, the trade-off and your recommendation with the reason, options with a description each and one recommended. Show me the question here as well and wait for my answer before the next one.\n` +
          `4. Record each answer with curate_model {action:"answer", promptId, selected or text, respondedBy = the person}; add then:"confirm" (+ subjectKey, notes = their words) when the answer confirms the subject, or then:"flag" (+ flag, reason) when it refutes it. When it changes the model, change the specification and rebuild (or update_net_definition when the model is edited directly), then curate_model {action:"resolve"} the related flags. When the answer is a reason nobody could have derived, put it where the next reader finds it: the definition's interactions, a note on the confirmation, or the model's context net.\n` +
          `5. Report: what was confirmed, what was flagged, what changed, what stays open. Never push, never start anything that spends quota on a schedule. (Every step here is a tool call: an MCP client can run the whole round without this prompt and without a server-side LLM.)`,
      );
    },
  );

  prompts.registerPrompt(
    'realize-net-definition',
    {
      title: 'Realize a net definition',
      description: 'Claim a natural-language net definition, clarify it, build it stopped, verify it, and record the evidence',
      argsSchema: {
        sessionId: z.string().describe('Session of the definition net'),
        netId: z.string().describe('Net id of the definition'),
        model: z.string().optional().describe('Target model when this connection allows several'),
        owner: z.string().optional().describe('Stable builder id recorded on the lease (default: your client name)'),
      },
    },
    ({ sessionId, netId, model, owner }) => {
      const key = `${sessionId}::${netId}`;
      const who = owner || 'a stable id for yourself (client or persona name), used on every call';
      const on = model ? ` in model "${model}" (pass model:"${model}" on every call)` : '';
      return userMessage(
        `Realize the net definition ${key}${on} as ${who}. Follow the build protocol exactly; master fences every step.\n` +
          `1. Discover: get_net_definition {sessionId:"${sessionId}", netId:"${netId}"}. Read the description, interactions, proposed ports, levels, parent, acceptance and nextActions. ` +
          `If the status is draft, stop and tell me it must be marked ready. If no build is open, request one with update_net_definition {action:"request_build"} only if I asked you to build it.\n` +
          `2. Claim: claim_net_definition {action:"claim", owner, sessionId, netId}. Keep the returned leaseGeneration; pass owner and leaseGeneration on every later call. Renew with action:"renew" during long work.\n` +
          `3. Understand the surroundings: explore_model for the hierarchy, then net_overview on the parent and on the nets named in the interactions. Resolve every proposed connection to an EXACT existing place id, or decide to create a new place. Reused places keep their tokens; never reseed them.\n` +
          `4. Ask only what materially changes behaviour or connections: application_action on "interview" action "ask" with a NEW promptId each time (never reuse one), question, options (strings or {value,label,description,recommended}), multiSelect, allowFreeText, and the subject subjectKind:"net-definition", subjectKey:"${key}", subjectRevision, buildId (get_net_definition returns askWith with these filled). ` +
          `Then record_net_build {action:"checkpoint", state:"awaiting-answers", checkpoint:{...what you know so far}}; this releases the lease. Tell me which questions are open (I can answer here or in the Explorer) and stop. To resume, claim again and reread the definition and the answers. Record assumptions you made without asking in the plan.\n` +
          `5. Plan: record_net_build {action:"checkpoint", state:"planning", plan:{revision, summary, assumptions[], reusedPlaces[], topology:{places, transitions}, acceptance[]}}. The server hashes the reused places' readers and writers; if they change before you apply, apply answers boundary-changed and you re-plan.\n` +
          `6. Build: record_net_build {action:"apply", places, transitions (with full inscriptions), arcs?}. It is one atomic, validated, diff-based write into ${key}; it never starts anything. Fix validation findings and apply again; a retry after a lost response changes nothing. Checkpoint state:"building" or "verifying" as you go.\n` +
          `7. Verify according to the role: for an executable net verify_inscription and dry_run_transition on each new lane and net_overview on the result; for an explanatory or context net check references, links and navigation only, without pretending it must execute. Existing work tokens are not test inputs.\n` +
          `8. Finish: record_net_build {action:"complete", verification:{passed, evidence[]}, notes}, or {action:"fail", error, evidence} when it cannot be done. Complete starts the transitions only when the build policy says activate; otherwise the net stays stopped.\n` +
          `Rules: a 409 with code lease-lost, superseded or cancel-requested means stop and report; never build on a lost lease. After an uncertain failure, reread get_net_definition and the build before retrying, and never create a second net for the same definition. ` +
          `End with a short report: what you built, what you reused, open questions, evidence, and the build state.`,
      );
    },
  );

  prompts.registerPrompt(
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

  prompts.registerPrompt(
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

  prompts.registerPrompt(
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

  prompts.registerPrompt(
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

  prompts.registerPrompt(
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

  prompts.registerPrompt(
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

  prompts.registerPrompt(
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

  prompts.registerPrompt(
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
