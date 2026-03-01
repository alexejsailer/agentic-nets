import { Command } from 'commander';
import {
  loadConfig, saveConfig, getActiveProfile, getConfigFilePath, ensureConfigDir,
  type AgetnticOSConfig, type ProfileConfig,
} from '../config/config.js';
import { outputJson, outputSuccess, outputError, outputTable, isJsonMode } from '../render/output.js';
import { createInterface } from 'node:readline';

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Configuration management');

  config
    .command('init')
    .description('Interactive setup wizard')
    .action(async () => {
      ensureConfigDir();

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise(resolve => rl.question(q, resolve));

      try {
        const profileName = (await ask('Profile name [local]: ')) || 'local';
        const gatewayUrl = (await ask('Gateway URL [http://localhost:8083]: ')) || 'http://localhost:8083';
        const modelId = (await ask('Default model ID [default]: ')) || 'default';
        const provider = (await ask('Default LLM provider (claude/ollama/claude-code/codex) [claude]: ')) || 'claude';
        const role = (await ask('Default agent role (r/rw/rwx/rwxh) [rw]: ')) || 'rw';

        const profile: ProfileConfig = {
          gateway_url: gatewayUrl,
          model_id: modelId,
          session_id: '',
          client_id: 'agenticos-admin',
          default_provider: provider,
          default_role: role,
          anthropic: { api_key: '${ANTHROPIC_API_KEY}', model: 'claude-sonnet-4-5-20250929' },
          ollama: { base_url: 'http://localhost:11434', model: 'llama3.2' },
          claude_code: { binary: 'claude', model: 'sonnet' },
          codex: { binary: 'codex', model: 'o3' },
        };

        const cfg = loadConfig();
        cfg.profiles[profileName] = profile;
        cfg.active_profile = profileName;
        saveConfig(cfg);

        outputSuccess(`Configuration saved to ${getConfigFilePath()}`);
        outputSuccess(`Active profile: ${profileName}`);
      } finally {
        rl.close();
      }
    });

  config
    .command('show')
    .description('Show current configuration')
    .action(() => {
      const cfg = loadConfig();
      const profile = getActiveProfile(cfg);
      if (isJsonMode()) {
        outputJson({ active_profile: cfg.active_profile, profile });
        return;
      }
      console.log(`Config file: ${getConfigFilePath()}`);
      console.log(`Active profile: ${cfg.active_profile}`);
      console.log();
      outputTable(
        ['Key', 'Value'],
        [
          ['gateway_url', profile.gateway_url],
          ['model_id', profile.model_id],
          ['session_id', profile.session_id || '(not set)'],
          ['default_provider', profile.default_provider],
          ['default_role', profile.default_role],
          ['client_id', profile.client_id],
        ],
      );
    });

  config
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'Config key (e.g., gateway_url, model_id, session_id)')
    .argument('<value>', 'Config value')
    .action((key: string, value: string) => {
      const cfg = loadConfig();
      const profile = getActiveProfile(cfg);
      if (key in profile) {
        (profile as any)[key] = value;
        cfg.profiles[cfg.active_profile] = profile;
        saveConfig(cfg);
        outputSuccess(`Set ${key} = ${value}`);
      } else {
        outputError(`Unknown config key: ${key}`);
      }
    });

  config
    .command('use')
    .description('Switch active profile')
    .argument('<profile>', 'Profile name')
    .action((profileName: string) => {
      const cfg = loadConfig();
      if (!cfg.profiles[profileName]) {
        outputError(`Profile '${profileName}' not found. Available: ${Object.keys(cfg.profiles).join(', ')}`);
        return;
      }
      cfg.active_profile = profileName;
      saveConfig(cfg);
      outputSuccess(`Switched to profile: ${profileName}`);
    });
}
