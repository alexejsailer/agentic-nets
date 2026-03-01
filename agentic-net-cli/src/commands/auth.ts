import { Command } from 'commander';
import { loadConfig, getActiveProfile, resolveProfile } from '../config/config.js';
import { acquireToken, getTokenStore } from '../gateway/auth.js';
import { outputJson, outputSuccess, outputError, outputTable, isJsonMode, createSpinner } from '../render/output.js';
import { createInterface } from 'node:readline';

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Authentication management');

  auth
    .command('login')
    .description('Acquire JWT from gateway')
    .action(async () => {
      const cfg = loadConfig();
      const profile = resolveProfile(getActiveProfile(cfg));

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise(resolve => rl.question(q, resolve));

      try {
        const clientId = (await ask(`Client ID [${profile.client_id}]: `)) || profile.client_id;
        const clientSecret = await ask('Client Secret: ');

        if (!clientSecret) {
          outputError('Client secret is required.');
          return;
        }

        const spinner = createSpinner('Authenticating...');
        spinner.start();

        try {
          const token = await acquireToken(profile.gateway_url, clientId, clientSecret);
          const store = getTokenStore();
          store.saveToken(cfg.active_profile, token);
          spinner.succeed('Authenticated successfully');

          if (isJsonMode()) {
            outputJson({
              token_type: token.token_type,
              expires_in: token.expires_in,
            });
          }
        } catch (err: any) {
          spinner.fail(`Authentication failed: ${err.message}`);
        }
      } finally {
        rl.close();
      }
    });

  auth
    .command('status')
    .description('Show token validity')
    .action(() => {
      const cfg = loadConfig();
      const store = getTokenStore();
      const token = store.getToken(cfg.active_profile);

      if (!token) {
        if (isJsonMode()) {
          outputJson({ authenticated: false });
        } else {
          outputError('Not authenticated. Run `agenticos auth login`.');
        }
        return;
      }

      const expired = store.isExpired(cfg.active_profile);
      const expiresAt = new Date(token.acquired_at + token.expires_in * 1000);

      if (isJsonMode()) {
        outputJson({
          authenticated: true,
          expired,
          token_type: token.token_type,
          expires_at: expiresAt.toISOString(),
        });
      } else {
        outputTable(
          ['Property', 'Value'],
          [
            ['Status', expired ? 'EXPIRED' : 'Valid'],
            ['Type', token.token_type],
            ['Expires', expiresAt.toISOString()],
            ['Profile', cfg.active_profile],
          ],
        );
      }
    });

  auth
    .command('logout')
    .description('Clear stored token')
    .action(() => {
      const cfg = loadConfig();
      const store = getTokenStore();
      store.removeToken(cfg.active_profile);
      outputSuccess(`Token cleared for profile: ${cfg.active_profile}`);
    });
}
