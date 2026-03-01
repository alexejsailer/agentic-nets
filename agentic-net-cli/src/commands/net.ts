import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { outputJson, outputSuccess, outputTable, isJsonMode, createSpinner } from '../render/output.js';

export function registerNetCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const net = program.command('net').description('Petri net operations');

  net
    .command('create')
    .description('Create a new Petri net')
    .argument('<netId>', 'Net ID')
    .option('--name <name>', 'Human-readable name')
    .option('--session <sessionId>', 'Session ID')
    .option('--description <desc>', 'Description')
    .action(async (netId: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Creating net...');
      spinner.start();
      try {
        const result = await api.createNet({
          modelId,
          sessionId: opts.session || sessionId,
          netId,
          name: opts.name || netId,
          description: opts.description,
        });
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputSuccess(`Created net: ${netId}`); }
      } catch (err: any) { spinner.fail(err.message); }
    });

  net
    .command('list')
    .description('List nets in a session')
    .option('--session <sessionId>', 'Session ID')
    .action(async (opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Listing nets...');
      spinner.start();
      try {
        const result = await api.listNets(modelId, opts.session || sessionId);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else if (Array.isArray(result)) {
          outputTable(['Net ID', 'Name'], result.map((n: any) => [n.netId || n.id, n.name || '']));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err: any) { spinner.fail(err.message); }
    });

  net
    .command('export')
    .description('Export a net')
    .argument('<netId>', 'Net ID')
    .option('--format <fmt>', 'Export format (pnml|json)', 'json')
    .option('--session <sessionId>', 'Session ID')
    .action(async (netId: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Exporting net...');
      spinner.start();
      try {
        const result = await api.exportNet(netId, modelId, opts.session || sessionId);
        spinner.stop();
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) { spinner.fail(err.message); }
    });

  net
    .command('import')
    .description('Import a net from file')
    .argument('<file>', 'PNML/JSON file path')
    .action(async (file: string) => {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(file, 'utf-8');
      const { client, modelId } = getContext();
      const spinner = createSpinner('Importing net...');
      spinner.start();
      try {
        const result = await client.masterApi('POST', '/pnml', {
          pnml: JSON.parse(content),
          modelId,
        });
        spinner.stop();
        if (isJsonMode()) { outputJson(result); } else { outputSuccess('Net imported successfully'); }
      } catch (err: any) { spinner.fail(err.message); }
    });
}
