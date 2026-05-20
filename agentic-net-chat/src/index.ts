import { loadConfig, getActiveProfile, resolveProfile } from '@agenticos/cli/config/config';
import { GatewayClient } from '@agenticos/cli/gateway/client';
import { loadChatConfig } from './config.js';
import { PersonaClient } from './master/persona-client.js';
import { ChatStateStore } from './chat-state.js';
import { TelegramChannel } from './channel/telegram/telegram-channel.js';

/**
 * Entry point — start the Telegram bridge that relays user messages to master's
 * persona endpoints (the same endpoints the GUI uses). The bot does not run a
 * local agent loop; master is the agent runtime.
 *
 * <p>Defaults: persona = {@code domain-expert} (the generalist memory layer
 * that auto-bootstraps per model), model = {@code AGENTICOS_MODEL} env var or
 * {@code default}. Users can override per chat with {@code /persona} and
 * {@code /model} commands.</p>
 */
export async function startChatBridge(): Promise<void> {
  const cliConfig = loadConfig();
  const profile = resolveProfile(getActiveProfile(cliConfig));
  const chatConfig = loadChatConfig();

  if (!chatConfig.telegram?.bot_token) {
    console.log(
      'Telegram bot not configured — idling.\n\n' +
      'Set TELEGRAM_BOT_TOKEN environment variable, or add to ~/.agenticos/config.yaml:\n\n' +
      '  chat:\n' +
      '    telegram:\n' +
      '      bot_token: ${TELEGRAM_BOT_TOKEN}\n' +
      '      allowed_user_ids: ["YOUR_USER_ID"]\n\n' +
      'Container will stay alive so the operator can fix the config and restart, ' +
      'instead of restart-looping under "restart: unless-stopped".',
    );
    await new Promise<void>(() => { /* idle forever */ });
    return;
  }

  const tgConfig = chatConfig.telegram;

  const profileName = cliConfig.active_profile || 'local';
  const gateway = new GatewayClient({
    gatewayUrl: profile.gateway_url,
    profileName,
    clientId: profile.client_id,
  });

  const personaClient = new PersonaClient(gateway);

  const defaultPersona = process.env['AGENTICOS_PERSONA'] ?? 'domain-expert';
  const defaultModelId = process.env['AGENTICOS_MODEL'] ?? profile.model_id ?? 'default';

  const stateStore = new ChatStateStore({
    persona: defaultPersona,
    modelId: defaultModelId,
  });

  const telegram = new TelegramChannel(
    tgConfig.bot_token,
    { allowedUserIds: tgConfig.allowed_user_ids },
    personaClient,
    stateStore,
  );

  const shutdown = async () => {
    console.log('\nShutting down...');
    await telegram.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('AgenticNetOS Chat Bridge (master-persona mode)');
  console.log(`  Gateway:  ${profile.gateway_url}`);
  console.log(`  Persona:  ${defaultPersona}`);
  console.log(`  Model:    ${defaultModelId}`);
  console.log(`  Allowed:  ${tgConfig.allowed_user_ids.length > 0 ? tgConfig.allowed_user_ids.join(', ') : '(any)'}`);
  console.log();

  await telegram.start();
}
