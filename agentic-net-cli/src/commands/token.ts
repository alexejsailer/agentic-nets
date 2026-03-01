import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputSuccess, outputError, outputTable, isJsonMode, createSpinner } from '../render/output.js';

export function registerTokenCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const token = program.command('token').description('Token operations');

  token
    .command('create')
    .description('Create a token in a place')
    .argument('<placeId>', 'Place ID or path')
    .option('--name <name>', 'Token name')
    .option('--data <json>', 'Token data as JSON string')
    .action(async (placeId: string, opts: any) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Creating token...');
      spinner.start();
      try {
        const path = placeId.includes('/') ? placeId : `root/workspace/places/${placeId}`;
        const parentInfo = await api.resolve(modelId, path);
        const parentId = parentInfo?.id || parentInfo;

        const tokenName = opts.name || `token-${Date.now()}`;
        const properties: Record<string, string> = {};
        if (opts.data) {
          const data = JSON.parse(opts.data);
          for (const [key, val] of Object.entries(data)) {
            properties[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
          }
        }

        const result = await api.executeEvents(modelId, [{
          eventType: 'createLeaf',
          parentId,
          id: 'auto',
          name: tokenName,
          properties,
        }]);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputSuccess(`Created token: ${tokenName} in ${placeId}`);
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  token
    .command('query')
    .description('Query tokens using ArcQL')
    .argument('<arcql>', 'ArcQL query (e.g., FROM $ WHERE $.status=="active")')
    .option('--place <placeId>', 'Place ID or path')
    .action(async (arcql: string, opts: any) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Querying tokens...');
      spinner.start();
      try {
        const place = opts.place || 'root/workspace/places';
        const path = place.includes('/') ? place : `root/workspace/places/${place}`;
        const result = await api.queryTokens(modelId, path, arcql);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          if (Array.isArray(result) && result.length > 0) {
            console.log(`Found ${result.length} token(s):`);
            for (const token of result) {
              console.log(JSON.stringify(token, null, 2));
            }
          } else {
            console.log('No tokens found.');
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  token
    .command('list')
    .description('List tokens in a place')
    .argument('<placeId>', 'Place ID or path')
    .action(async (placeId: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Listing tokens...');
      spinner.start();
      try {
        const path = placeId.includes('/') ? placeId : `root/workspace/places/${placeId}`;
        const children = await api.getChildren(modelId, path);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(children);
        } else {
          if (children.length === 0) {
            console.log('No tokens found.');
          } else {
            outputTable(
              ['Name', 'ID', 'Properties'],
              children.map((c: any) => [
                c.name,
                c.id,
                c.properties ? JSON.stringify(c.properties).slice(0, 80) : '',
              ]),
            );
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  token
    .command('delete')
    .description('Delete a token by name from a place')
    .argument('<placeId>', 'Place ID or path')
    .argument('<tokenName>', 'Token name')
    .action(async (placeId: string, tokenName: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Deleting token...');
      spinner.start();
      try {
        const path = placeId.includes('/') ? placeId : `root/workspace/places/${placeId}`;
        const children = await api.getChildren(modelId, path);
        const token = children.find((c: any) => c.name === tokenName);
        if (!token) {
          spinner.fail(`Token '${tokenName}' not found in ${placeId}`);
          return;
        }
        await api.deleteLeaf(modelId, token.id, token.parentId);
        spinner.stop();
        outputSuccess(`Deleted token: ${tokenName} from ${placeId}`);
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });
}
