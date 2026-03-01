import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { outputJson, outputSuccess, outputTable, isJsonMode, createSpinner, outputError } from '../render/output.js';

export function registerPackageCommand(
  program: Command,
  getContext: () => { client: GatewayClient; modelId: string; sessionId: string },
): void {
  const pkg = program.command('package').description('Agentic-Net package registry operations');

  pkg
    .command('create')
    .description('Create a package from a workspace-net')
    .argument('<netId>', 'Net ID to package')
    .requiredOption('--name <name>', 'Package name')
    .requiredOption('--version <version>', 'Semver version (e.g., 1.0.0)')
    .option('--scope <scope>', 'Package scope: designtime, runtime, complete', 'runtime')
    .option('--description <desc>', 'Package description')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--readme <text>', 'Readme text')
    .option('--session <sessionId>', 'Session ID')
    .action(async (netId: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Creating package...');
      spinner.start();
      try {
        const result = await api.createPackage({
          name: opts.name,
          version: opts.version,
          scope: opts.scope,
          description: opts.description,
          tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : undefined,
          readme: opts.readme,
          source: { modelId, sessionId: opts.session || sessionId, netId },
        });
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputSuccess(`Created package: ${opts.name}@${opts.version} (${opts.scope})`);
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  pkg
    .command('publish')
    .description('Publish a local package to the shared registry')
    .argument('<name>', 'Package name')
    .requiredOption('--version <version>', 'Version to publish')
    .action(async (name: string, opts: any) => {
      const { client, modelId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Publishing package...');
      spinner.start();
      try {
        const result = await api.publishPackage(name, opts.version, modelId);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputSuccess(`Published ${name}@${opts.version} to registry`);
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  pkg
    .command('search')
    .description('Search published packages')
    .argument('[query]', 'Search query')
    .option('--tags <tags>', 'Filter by comma-separated tags')
    .option('--limit <n>', 'Max results', '20')
    .action(async (query: string | undefined, opts: any) => {
      const { client } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Searching packages...');
      spinner.start();
      try {
        const result = await api.searchPackages(query, opts.tags, parseInt(opts.limit));
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          const packages = result.packages || [];
          if (packages.length === 0) {
            console.log('No packages found.');
          } else {
            outputTable(
              ['Name', 'Version', 'Description', 'Tags', 'Scope'],
              packages.map((p: any) => [
                p.name || '',
                p.latestVersion || '',
                (p.description || '').substring(0, 50),
                (p.tags || []).join(', '),
                p.scope || '',
              ]),
            );
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  pkg
    .command('info')
    .description('Get package details')
    .argument('<name>', 'Package name')
    .option('--version <version>', 'Specific version')
    .action(async (name: string, opts: any) => {
      const { client } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Fetching package info...');
      spinner.start();
      try {
        if (opts.version) {
          const result = await api.getPackageVersion(name, opts.version);
          spinner.stop();
          console.log(JSON.stringify(result, null, 2));
        } else {
          const result = await api.getPackageInfo(name);
          spinner.stop();
          if (isJsonMode()) {
            outputJson(result);
          } else {
            console.log(JSON.stringify(result, null, 2));
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  pkg
    .command('install')
    .description('Import a published package into your session')
    .argument('<name>', 'Package name')
    .option('--version <version>', 'Version to install (default: latest)')
    .option('--session <sessionId>', 'Target session ID')
    .action(async (name: string, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Installing package...');
      spinner.start();
      try {
        let version = opts.version;
        if (!version) {
          const versions = await api.listPackageVersions(name);
          const vList = versions.versions || [];
          if (vList.length === 0) {
            spinner.fail(`No versions found for package: ${name}`);
            return;
          }
          version = vList[vList.length - 1];
        }

        const result = await api.importPackage(name, version, modelId, opts.session || sessionId);
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          outputSuccess(
            `Installed ${name}@${version}: ${result.placesCreated} places, ` +
              `${result.transitionsCreated} transitions, ${result.inscriptionsStored} inscriptions, ` +
              `${result.tokensCreated} tokens`,
          );
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });

  pkg
    .command('list')
    .description('List all published packages')
    .option('--limit <n>', 'Max results', '50')
    .action(async (opts: any) => {
      const { client } = getContext();
      const api = new MasterApi(client);
      const spinner = createSpinner('Listing packages...');
      spinner.start();
      try {
        const result = await api.searchPackages(undefined, undefined, parseInt(opts.limit));
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else {
          const packages = result.packages || [];
          if (packages.length === 0) {
            console.log('No packages published yet.');
          } else {
            outputTable(
              ['Name', 'Version', 'Description', 'Tags'],
              packages.map((p: any) => [
                p.name || '',
                p.latestVersion || '',
                (p.description || '').substring(0, 60),
                (p.tags || []).join(', '),
              ]),
            );
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
      }
    });
}
