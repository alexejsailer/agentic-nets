import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Show CLI version')
    .action(() => {
      try {
        // Try to read from package.json
        const pkgPath = join(process.cwd(), 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        console.log(`agenticos ${pkg.version}`);
      } catch {
        console.log('agenticos 0.1.0');
      }
    });
}
