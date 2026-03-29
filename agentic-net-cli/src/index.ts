import { Command } from 'commander';
import { loadConfig, getActiveProfile, resolveProfile } from './config/config.js';
import { GatewayClient } from './gateway/client.js';
import { setOutputFormat, setNoColor, type OutputFormat } from './render/output.js';

// Command registrations
import { registerConfigCommand } from './commands/config.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerPlaceCommand } from './commands/place.js';
import { registerTokenCommand } from './commands/token.js';
import { registerTransitionCommand } from './commands/transition.js';
import { registerInscriptionCommand } from './commands/inscription.js';
import { registerArcCommand } from './commands/arc.js';
import { registerNetCommand } from './commands/net.js';
import { registerSessionCommand } from './commands/session.js';
import { registerTreeCommand } from './commands/tree.js';
import { registerChatCommand } from './commands/chat.js';
import { registerAskCommand } from './commands/ask.js';
import { registerServiceCommand } from './commands/service.js';
import { registerVersionCommand } from './commands/version.js';
import { registerPackageCommand } from './commands/package.js';
import { registerChronicleCommand } from './commands/chronicle.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agenticos')
    .description('AgenticNetOS CLI — Intelligent Petri net modeling from the command line')
    .version('0.1.0')
    .option('--gateway <url>', 'Override gateway URL')
    .option('--model <modelId>', 'Override model ID')
    .option('--session <sessionId>', 'Override session ID')
    .option('--profile <name>', 'Config profile name')
    .option('--output <format>', 'Output format (text|json)')
    .option('--no-color', 'Disable colors')
    .option('--verbose', 'Debug logging');

  // Apply global options
  program.hook('preAction', (thisCommand) => {
    const globalOpts = thisCommand.opts();
    if (globalOpts.output) {
      setOutputFormat(globalOpts.output as OutputFormat);
    } else if (!process.stdout.isTTY) {
      setOutputFormat('json');
    }
    if (globalOpts.color === false) {
      setNoColor(true);
    }
  });

  // Lazy context factory — creates GatewayClient from config + CLI overrides
  const getContext = () => {
    const globalOpts = program.opts();
    const cfg = loadConfig();

    // Profile override
    if (globalOpts.profile && cfg.profiles[globalOpts.profile]) {
      cfg.active_profile = globalOpts.profile;
    }

    const profile = resolveProfile(getActiveProfile(cfg));
    const gatewayUrl = globalOpts.gateway || profile.gateway_url;
    const modelId = globalOpts.model || profile.model_id;
    const sessionId = globalOpts.session || profile.session_id;

    const client = new GatewayClient({
      gatewayUrl,
      profileName: cfg.active_profile,
      clientId: profile.client_id,
    });

    return { client, modelId, sessionId, profile, cfg };
  };

  // Register all commands
  registerConfigCommand(program);
  registerAuthCommand(program);
  registerPlaceCommand(program, getContext);
  registerTokenCommand(program, getContext);
  registerTransitionCommand(program, getContext);
  registerInscriptionCommand(program, getContext);
  registerArcCommand(program, getContext);
  registerNetCommand(program, getContext);
  registerSessionCommand(program, getContext);
  registerTreeCommand(program, getContext);
  registerChatCommand(program, getContext);
  registerAskCommand(program, getContext);
  registerPackageCommand(program, getContext);
  registerChronicleCommand(program, getContext);
  registerServiceCommand(program);
  registerVersionCommand(program);

  return program;
}
