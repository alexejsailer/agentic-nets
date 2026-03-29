import { loadConfig, getActiveProfile, resolveProfile } from '@agenticos/cli/config/config';
import { GatewayClient } from '@agenticos/cli/gateway/client';
import { ToolExecutor } from '@agenticos/cli/agent/tool-executor';
import { buildSystemPrompt, getToolSchemas } from '@agenticos/cli/agent/prompts';
import { parseRole } from '@agenticos/cli/agent/roles';
import { createLlmProvider, createHelperLlm } from '@agenticos/cli/commands/llm-factory';
import { loadChatConfig } from './config.js';
import { SessionManager } from './session/session-manager.js';
import { TelegramChannel } from './channel/telegram/telegram-channel.js';

export async function startChatBridge(): Promise<void> {
  // Load AgenticNetOS CLI config
  const cliConfig = loadConfig();
  const profile = resolveProfile(getActiveProfile(cliConfig));

  // Load chat-specific config
  const chatConfig = loadChatConfig();

  if (!chatConfig.telegram?.bot_token) {
    console.error(
      'No Telegram bot token configured.\n\n' +
      'Set TELEGRAM_BOT_TOKEN environment variable, or add to ~/.agenticos/config.yaml:\n\n' +
      '  chat:\n' +
      '    telegram:\n' +
      '      bot_token: ${TELEGRAM_BOT_TOKEN}\n' +
      '      allowed_user_ids: ["YOUR_USER_ID"]\n',
    );
    process.exit(1);
  }

  const tgConfig = chatConfig.telegram;

  // Create LLM provider (from CLI profile)
  const providerName = profile.default_provider;
  const llm = createLlmProvider(providerName, profile);

  const profileName = cliConfig.active_profile || 'local';

  // Create gateway client (auto-acquires JWT via AGENTICOS_ADMIN_SECRET)
  const client = new GatewayClient({
    gatewayUrl: profile.gateway_url,
    profileName,
    clientId: profile.client_id,
  });

  // Create agent tools (from CLI profile)
  const modelId = profile.model_id ?? 'default';
  const role = parseRole(profile.default_role);
  const sessionId = `${tgConfig.session_prefix}-shared`;
  const helperLlm = createHelperLlm(profile);
  const toolExecutor = new ToolExecutor(client, modelId, sessionId, helperLlm, llm);
  const systemPrompt = buildSystemPrompt({ role, modelId, sessionId });
  const toolSchemas = getToolSchemas(role);

  // Create session manager
  const sessionManager = new SessionManager(
    llm,
    toolExecutor,
    systemPrompt,
    toolSchemas,
    modelId,
    tgConfig.session_prefix,
    profile,
    providerName,
  );

  // Create and start Telegram channel
  const telegram = new TelegramChannel(
    tgConfig.bot_token,
    { allowedUserIds: tgConfig.allowed_user_ids },
    sessionManager,
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await telegram.stop();
    sessionManager.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`AgenticNetOS Chat Bridge`);
  console.log(`  Gateway:  ${profile.gateway_url}`);
  console.log(`  Provider: ${providerName}`);
  console.log(`  Model:    ${modelId}`);
  console.log(`  Role:     ${profile.default_role}`);
  console.log(`  Allowed:  ${tgConfig.allowed_user_ids.length > 0 ? tgConfig.allowed_user_ids.join(', ') : '(any)'}`);
  console.log();

  await telegram.start();
}
