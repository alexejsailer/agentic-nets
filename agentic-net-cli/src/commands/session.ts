import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { NodeApi } from '../gateway/node-api.js';
import { loadConfig, saveConfig, getActiveProfile } from '../config/config.js';
import { outputJson, outputSuccess, outputError, outputTable, isJsonMode, createSpinner } from '../render/output.js';

export function registerSessionCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const session = program.command('session').description('Session management');

  session
    .command('create')
    .description('Create a new session')
    .option('--name <name>', 'Session name')
    .option('--nl <text>', 'Initial natural language text')
    .action(async (opts: any) => {
      const { client, modelId } = getContext();
      const api = new MasterApi(client);
      const sessionId = opts.name || `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
      // Extract userId from modelId (user-{userId} pattern)
      const userId = modelId.startsWith('user-') ? modelId.slice(5) : modelId;
      const spinner = createSpinner('Creating session...');
      spinner.start();
      try {
        const result = await api.createSession(userId, sessionId, {
          naturalLanguageText: opts.nl || '',
          description: `Created by agenticos CLI`,
        });
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputSuccess(`Created session: ${sessionId}`);
          console.log(`Use: agenticos session use ${sessionId}`);
        }
      } catch (err: any) { spinner.fail(err.message); }
    });

  session
    .command('list')
    .description('List all sessions')
    .action(async () => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Listing sessions...');
      spinner.start();
      try {
        const children = await api.getChildren(modelId, 'root/workspace/sessions');
        spinner.stop();
        if (isJsonMode()) {
          outputJson(children);
        } else {
          outputTable(
            ['Session ID', 'UUID'],
            children.map((c: any) => [c.name, c.id]),
          );
        }
      } catch (err: any) { spinner.fail(err.message); }
    });

  session
    .command('use')
    .description('Set default session')
    .argument('<sessionId>', 'Session ID')
    .action((sessionId: string) => {
      const cfg = loadConfig();
      const profile = getActiveProfile(cfg);
      profile.session_id = sessionId;
      cfg.profiles[cfg.active_profile] = profile;
      saveConfig(cfg);
      outputSuccess(`Default session set to: ${sessionId}`);
    });
}
