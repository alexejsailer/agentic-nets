import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputSuccess, outputError, outputInfo, outputDim, outputTable, isJsonMode, createSpinner } from '../render/output.js';

export function registerTransitionCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const transition = program.command('transition').description('Transition operations');

  transition
    .command('create')
    .description('Create a transition in a net')
    .argument('<transitionId>', 'Transition ID (e.g., t-process)')
    .option('--net <netId>', 'Net ID', 'default')
    .option('--label <label>', 'Display label')
    .option('--x <n>', 'X coordinate', '200')
    .option('--y <n>', 'Y coordinate', '150')
    .action(async (transitionId: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Creating transition...');
      spinner.start();
      try {
        const result = await api.createTransition(opts.net, {
          modelId,
          sessionId,
          transitionId,
          label: opts.label || transitionId,
          x: parseInt(opts.x),
          y: parseInt(opts.y),
        });
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputSuccess(`Created transition: ${transitionId}`);
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  transition
    .command('list')
    .description('List all transitions')
    .action(async () => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Listing transitions...');
      spinner.start();
      try {
        const children = await api.getChildren(modelId, 'root/workspace/transitions');
        spinner.stop();
        if (isJsonMode()) {
          outputJson(children);
        } else {
          outputTable(
            ['Name', 'ID', 'Type'],
            children.map((c: any) => [c.name, c.id, c.type || 'Node']),
          );
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  transition
    .command('get')
    .description('Get transition details')
    .argument('<id>', 'Transition ID')
    .action(async (id: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Getting transition...');
      spinner.start();
      try {
        const children = await api.getChildren(modelId, `root/workspace/transitions/${id}`);
        const inscriptionLeaf = children.find((c: any) => c.name === 'inscription');
        let inscription = null;
        if (inscriptionLeaf?.properties?.value) {
          try { inscription = JSON.parse(inscriptionLeaf.properties.value); } catch { inscription = inscriptionLeaf.properties.value; }
        }
        spinner.stop();
        if (isJsonMode()) {
          outputJson({ transitionId: id, inscription, children });
        } else {
          outputInfo(`Transition: ${id}`);
          if (inscription) {
            outputInfo('Inscription:');
            outputDim(JSON.stringify(inscription, null, 2));
          } else {
            outputDim('No inscription configured.');
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  transition
    .command('start')
    .description('Start a transition')
    .argument('<id>', 'Transition ID')
    .action(async (id: string) => {
      const { client, modelId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Starting transition...');
      spinner.start();
      try {
        const result = await api.startTransition(id, modelId);
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputSuccess(`Started transition: ${id}`); }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  transition
    .command('stop')
    .description('Stop a transition')
    .argument('<id>', 'Transition ID')
    .action(async (id: string) => {
      const { client, modelId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Stopping transition...');
      spinner.start();
      try {
        const result = await api.stopTransition(id, modelId);
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputSuccess(`Stopped transition: ${id}`); }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  transition
    .command('fire')
    .description('Fire a transition once (synchronous)')
    .argument('<id>', 'Transition ID')
    .action(async (id: string) => {
      const { client, modelId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Firing transition...');
      spinner.start();
      try {
        const result = await api.fireOnce(id, modelId);
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputSuccess(`Fired transition: ${id}`); outputDim(JSON.stringify(result, null, 2)); }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  transition
    .command('lanes')
    .description('List llm/agent lanes and whether THIS client could serve them')
    .option('--all', 'Every AI lane whatever its status (not just ones marked external)')
    .option('--stopped', 'Also include stopped lanes in the narrow view')
    .action(async (opts: any) => {
      const { client, modelId } = getContext();
      const api = new MasterApi(client);
      try {
        const res = await api.listAiLanes(modelId, { includeAll: opts.all, includeStopped: opts.stopped });
        if (isJsonMode()) { outputJson(res); return; }
        const provider = res.provider ?? {};
        outputInfo(`provider: ${provider.name} (${provider.status}) — master can fire AI lanes: ${provider.canFireAiLanes}`);
        const rows = (res.transitions ?? []).map((t: any) => [
          t.transitionId, t.kind, String(t.status), String(t.ready),
          t.servable ? 'YES' : 'no', String(t.servableReason ?? ''),
        ]);
        if (!rows.length) { outputDim('No lanes listed. Try --all when master has no provider.'); return; }
        outputTable(['transition', 'kind', 'status', 'ready', 'servable', 'reason'], rows);
        if (!opts.all && provider.canFireAiLanes === false) {
          outputDim('master has no provider — re-run with --all to see every lane you could run');
        }
      } catch (err: any) { outputError(err.message); process.exit(1); }
    });

  transition
    .command('serve')
    .description('Serve AI lanes with THIS CLI\'s LLM (master keeps binding, emit rules and accounting)')
    .argument('[id]', 'Serve one transition; omit to serve every servable llm lane')
    .option('--provider <name>', 'LLM provider (claude|openai|ollama|claude-code|codex)')
    .option('--tier <tier>', 'Model tier (high|medium|low)')
    .option('--dry-run', 'Show what would be served without calling the LLM or completing')
    .action(async (id: string | undefined, opts: any) => {
      const { client, modelId } = getContext();
      const api = new MasterApi(client);
      const { loadConfig, getActiveProfile, resolveProfile } = await import('../config/config.js');
      const { createLlmProvider } = await import('./llm-factory.js');

      let targets: any[];
      try {
        const res = await api.listAiLanes(modelId, { includeAll: true });
        targets = (res.transitions ?? []).filter((t: any) =>
          id ? t.transitionId === id : t.servable === true && t.kind === 'llm' && t.ready === true);
        if (!id) {
          // An agent lane needs the authorized tool loop, which is the MCP client's job — say so
          // rather than silently serving only half of what the roster showed.
          const agents = (res.transitions ?? []).filter((t: any) => t.servable && t.kind === 'agent' && t.ready);
          if (agents.length) {
            outputDim(`skipping ${agents.length} agent lane(s) — they need the authorized tool loop; serve those from an MCP client`);
          }
        }
      } catch (err: any) { outputError(err.message); process.exit(1); return; }

      // Every exit path reports something: in JSON mode outputInfo/outputSuccess are silent, so a
      // scripted caller would otherwise get an empty stdout and no way to tell success from a no-op.
      if (!targets.length) {
        if (isJsonMode()) { outputJson({ served: 0, candidates: 0, results: [] }); } else { outputInfo('Nothing to serve.'); }
        return;
      }
      if (opts.dryRun) {
        const ids = targets.map((t) => t.transitionId);
        if (isJsonMode()) { outputJson({ dryRun: true, candidates: ids.length, transitions: ids }); }
        else { outputInfo(`Would serve ${ids.length} lane(s): ${ids.join(', ')}`); }
        return;
      }

      let llm;
      try {
        const profile = resolveProfile(getActiveProfile(loadConfig()));
        llm = createLlmProvider(opts.provider || profile.default_provider, profile, opts.tier);
      } catch (err: any) { outputError(err.message); process.exit(1); return; }

      let served = 0;
      const results: Array<Record<string, any>> = [];
      for (const lane of targets) {
        const tid = lane.transitionId;
        const spinner = createSpinner(`Serving ${tid}...`);
        spinner.start();
        let fireId: string | undefined;
        try {
          const prepared = await api.prepareExternalFire(tid, modelId);
          if (!prepared?.ready) {
            spinner.stop();
            results.push({ transitionId: tid, served: false, reason: prepared?.reason ?? 'not ready' });
            outputDim(`${tid}: ${prepared?.reason ?? 'not ready'}`);
            continue;
          }
          fireId = prepared.fireId;
          if (prepared.kind !== 'llm') {
            await api.abandonExternalFire(tid, modelId, fireId!);
            spinner.stop();
            results.push({ transitionId: tid, served: false, reason: `kind=${prepared.kind} needs the tool loop` });
            outputDim(`${tid}: kind=${prepared.kind} needs the tool loop — abandoned, inputs preserved`);
            continue;
          }
          const answer = await llm.chat(
            prepared.systemPrompt || 'You are executing one step of a workflow. Answer exactly as instructed.',
            [{ role: 'user', content: [{ type: 'text', text: String(prepared.prompt ?? prepared.nl ?? '') }] }],
            [],
          );
          const text = answer.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
          const done = await api.completeExternalFire(tid, modelId, fireId!, {
            response: text, worker: 'agentic-net-cli', model: llm.name,
          });
          spinner.stop();
          served++;
          results.push({
            transitionId: tid, served: true,
            produced: done.produced ?? 0, toPlaces: done.toPlaces ?? [], consumed: done.consumed ?? 0,
          });
          outputSuccess(`${tid}: emitted ${done.produced ?? 0} → ${(done.toPlaces ?? []).join(', ') || 'postsets'}`);
        } catch (err: any) {
          spinner.stop();
          // Never leave a lease dangling: an abandoned fire preserves the inputs for a retry,
          // whereas a stranded lease blocks the lane until the 30-minute TTL expires.
          if (fireId) { await api.abandonExternalFire(tid, modelId, fireId).catch(() => undefined); }
          results.push({ transitionId: tid, served: false, error: err.message });
          outputError(`${tid}: ${err.message}`);
        }
      }
      if (isJsonMode()) { outputJson({ served, candidates: targets.length, results }); }
      else { outputInfo(`Served ${served}/${targets.length} lane(s).`); }
    });

  transition
    .command('status')
    .description('Get transition status')
    .argument('<id>', 'Transition ID')
    .action(async (id: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Getting status...');
      spinner.start();
      try {
        const children = await api.getChildren(modelId, `root/workspace/transitions/${id}`);
        const status = children.find((c: any) => c.name === 'status');
        const deployedAt = children.find((c: any) => c.name === 'deployedAt');
        const agent = children.find((c: any) => c.name === 'assignedAgent');
        spinner.stop();
        if (isJsonMode()) {
          outputJson({
            transitionId: id,
            status: status?.properties?.value || 'unknown',
            deployedAt: deployedAt?.properties?.value,
            assignedAgent: agent?.properties?.value,
          });
        } else {
          outputTable(
            ['Property', 'Value'],
            [
              ['Transition', id],
              ['Status', status?.properties?.value || 'unknown'],
              ['Deployed At', deployedAt?.properties?.value || 'N/A'],
              ['Agent', agent?.properties?.value || 'N/A'],
            ],
          );
        }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });
}
