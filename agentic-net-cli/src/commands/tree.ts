import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputInfo, outputDim, outputTable, isJsonMode, createSpinner } from '../render/output.js';

export function registerTreeCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const tree = program.command('tree').description('Tree operations');

  tree
    .command('get')
    .description('Get tree structure at path')
    .argument('<path>', 'Tree path (e.g., root/workspace/sessions)')
    .action(async (path: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Getting tree...');
      spinner.start();
      try {
        const result = await api.getTreeJson(modelId, path);
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputDim(JSON.stringify(result, null, 2)); }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  tree
    .command('children')
    .description('List children at path')
    .argument('<path>', 'Tree path')
    .action(async (path: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Getting children...');
      spinner.start();
      try {
        const children = await api.getChildren(modelId, path);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(children);
        } else {
          outputTable(
            ['Name', 'ID', 'Type', 'Properties'],
            children.map((c: any) => [
              c.name,
              c.id,
              c.type || '',
              c.properties ? JSON.stringify(c.properties).slice(0, 60) : '',
            ]),
          );
        }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  tree
    .command('resolve')
    .description('Resolve path to UUID')
    .argument('<path>', 'Tree path')
    .action(async (path: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Resolving path...');
      spinner.start();
      try {
        const result = await api.resolve(modelId, path);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputInfo(`Path: ${path}`);
          outputInfo(`UUID: ${result?.id || result}`);
        }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });
}
