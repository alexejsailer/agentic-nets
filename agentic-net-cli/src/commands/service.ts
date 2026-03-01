import { Command } from 'commander';
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { outputSuccess, outputError, outputTable, outputInfo } from '../render/output.js';

const AGENTICOS_DIR = join(process.cwd(), '..');
const AGENTICOS_SCRIPT = join(AGENTICOS_DIR, 'agenticos.sh');

function findAgenticosScript(): string {
  // Try a few locations
  const candidates = [
    join(process.cwd(), 'agenticos.sh'),
    AGENTICOS_SCRIPT,
    join(process.env['HOME'] || '', 'Developer/AgetnticOS/agenticos.sh'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('agenticos.sh not found. Run from AgetnticOS project root or set AGENTICOS_DIR.');
}

export function registerServiceCommand(program: Command): void {
  const service = program.command('service').description('AgetnticOS service management');

  service
    .command('status')
    .description('Show service status')
    .action(() => {
      try {
        const script = findAgenticosScript();
        execSync(`bash ${script} status`, { stdio: 'inherit' });
      } catch (err: any) {
        outputError(`Failed to get status: ${err.message}`);
      }
    });

  service
    .command('start')
    .description('Start services')
    .argument('[services...]', 'Services to start (node, master, executor, agent)')
    .action((services: string[]) => {
      try {
        const script = findAgenticosScript();
        const args = services.length > 0 ? services.join(' ') : '';
        execSync(`bash ${script} start ${args}`, { stdio: 'inherit' });
      } catch (err: any) {
        outputError(`Failed to start: ${err.message}`);
      }
    });

  service
    .command('stop')
    .description('Stop services')
    .argument('[services...]', 'Services to stop')
    .action((services: string[]) => {
      try {
        const script = findAgenticosScript();
        const args = services.length > 0 ? services.join(' ') : '';
        execSync(`bash ${script} stop ${args}`, { stdio: 'inherit' });
      } catch (err: any) {
        outputError(`Failed to stop: ${err.message}`);
      }
    });

  service
    .command('logs')
    .description('Tail service logs')
    .argument('<service>', 'Service name (node, master, executor, agent)')
    .action((svc: string) => {
      try {
        const script = findAgenticosScript();
        // Use spawn for streaming logs
        const proc = spawn('bash', [script, 'logs', svc], { stdio: 'inherit' });
        proc.on('error', (err) => outputError(`Failed to tail logs: ${err.message}`));
      } catch (err: any) {
        outputError(`Failed to get logs: ${err.message}`);
      }
    });
}
