import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputSuccess, outputError, outputTable, isJsonMode, createSpinner } from '../render/output.js';

export function registerPlaceCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const place = program.command('place').description('Place operations');

  place
    .command('create')
    .description('Create a place in a net')
    .argument('<placeId>', 'Place ID (e.g., p-input)')
    .option('--net <netId>', 'Net ID', 'default')
    .option('--label <label>', 'Display label')
    .option('--tokens <n>', 'Initial token count', '0')
    .option('--x <n>', 'X coordinate', '100')
    .option('--y <n>', 'Y coordinate', '150')
    .action(async (placeId: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Creating place...');
      spinner.start();
      try {
        const result = await api.createPlace(opts.net, {
          modelId,
          sessionId,
          placeId,
          label: opts.label || placeId,
          x: parseInt(opts.x),
          y: parseInt(opts.y),
          tokens: parseInt(opts.tokens),
        });
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputSuccess(`Created place: ${placeId}`);
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  place
    .command('list')
    .description('List all runtime places')
    .action(async () => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Listing places...');
      spinner.start();
      try {
        const children = await api.getChildren(modelId, 'root/workspace/places');
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

  place
    .command('get')
    .description('Get place details')
    .argument('<placeId>', 'Place ID or path')
    .action(async (placeId: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Getting place info...');
      spinner.start();
      try {
        const path = placeId.includes('/') ? placeId : `root/workspace/places/${placeId}`;
        const children = await api.getChildren(modelId, path);
        spinner.stop();
        if (isJsonMode()) {
          outputJson({ placeId, tokenCount: children.length, tokens: children });
        } else {
          console.log(`Place: ${placeId}`);
          console.log(`Tokens: ${children.length}`);
          if (children.length > 0) {
            outputTable(
              ['Name', 'ID', 'Type'],
              children.map((c: any) => [c.name, c.id, c.type || 'Leaf']),
            );
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  place
    .command('delete')
    .description('Delete a place')
    .argument('<placeId>', 'Place ID')
    .action(async (placeId: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Deleting place...');
      spinner.start();
      try {
        const path = `root/workspace/places/${placeId}`;
        const info = await api.resolve(modelId, path);
        if (info?.id) {
          await api.executeEvents(modelId, [{ eventType: 'deleteNode', id: info.id }]);
        }
        spinner.stop();
        outputSuccess(`Deleted place: ${placeId}`);
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });
}
