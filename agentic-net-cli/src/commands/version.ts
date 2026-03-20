import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outputInfo } from '../render/output.js';

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Show CLI version')
    .action(() => {
      try {
        // Try to read from package.json
        const pkgPath = join(process.cwd(), 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        outputInfo(`agenticos ${pkg.version}`);
      } catch {
        outputInfo('agenticos 0.1.0');
      }
    });
}
