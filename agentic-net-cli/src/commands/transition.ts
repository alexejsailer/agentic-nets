import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputSuccess, outputError, outputTable, isJsonMode, createSpinner } from '../render/output.js';

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
          console.log(`Transition: ${id}`);
          if (inscription) {
            console.log('Inscription:');
            console.log(JSON.stringify(inscription, null, 2));
          } else {
            console.log('No inscription configured.');
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
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
      } catch (err: any) { spinner.fail(err.message); }
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
      } catch (err: any) { spinner.fail(err.message); }
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
        if (isJsonMode()) { outputJson(result); } else { outputSuccess(`Fired transition: ${id}`); console.log(JSON.stringify(result, null, 2)); }
      } catch (err: any) { spinner.fail(err.message); }
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
      } catch (err: any) { spinner.fail(err.message); }
    });
}
