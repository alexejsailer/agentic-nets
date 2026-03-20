import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputSuccess, outputError, outputDim, isJsonMode, createSpinner } from '../render/output.js';

export function registerArcCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const arc = program.command('arc').description('Arc operations');

  arc
    .command('create')
    .description('Create an arc connecting a place and transition')
    .requiredOption('--source <id>', 'Source element ID')
    .requiredOption('--target <id>', 'Target element ID')
    .option('--net <netId>', 'Net ID', 'default')
    .option('--id <arcId>', 'Arc ID')
    .action(async (opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const arcId = opts.id || `a-${Date.now()}`;
      const spinner = createSpinner('Creating arc...');
      spinner.start();
      try {
        const result = await api.createArc(opts.net, {
          modelId,
          sessionId,
          arcId,
          sourceId: opts.source,
          targetId: opts.target,
        });
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputSuccess(`Created arc: ${opts.source} → ${opts.target}`); }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  arc
    .command('list')
    .description('List arcs in a net')
    .option('--net <netId>', 'Net ID', 'default')
    .action(async (opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Listing arcs...');
      spinner.start();
      try {
        const result = await api.getNet(opts.net, modelId, sessionId);
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputDim(JSON.stringify(result, null, 2)); }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  arc
    .command('delete')
    .description('Delete an arc')
    .argument('<arcId>', 'Arc ID')
    .option('--net <netId>', 'Net ID', 'default')
    .action(async (arcId: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Deleting arc...');
      spinner.start();
      try {
        const arcsPath = `root/workspace/sessions/${sessionId}/workspace-nets/${opts.net}/pnml/net/arcs`;
        const children = await api.getChildren(modelId, arcsPath);
        const arcNode = children.find((c: any) => c.name === arcId);
        if (!arcNode) {
          spinner.stop();
          outputError(`Arc '${arcId}' not found in net '${opts.net}'`);
          return;
        }

        await api.deleteNode(modelId, arcNode.id, arcNode.parentId);
        spinner.stop();
        if (isJsonMode()) {
          outputJson({ deleted: arcId, netId: opts.net });
        } else {
          outputSuccess(`Deleted arc: ${arcId} from net ${opts.net}`);
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });
}
