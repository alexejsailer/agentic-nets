import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { MasterApi } from '../gateway/master-api.js';
import { acquireToken } from '../gateway/auth.js';
import { outputJson, outputSuccess, outputDim, outputInfo, outputTable, isJsonMode, createSpinner, outputError } from '../render/output.js';

/**
 * Issue a single authenticated HTTP call against an arbitrary gateway URL,
 * bypassing {@link GatewayClient}'s profile/token-store machinery. Used by
 * `package transfer` so the target gateway's credentials never have to be
 * persisted to the local profile.
 */
async function directJson(
  method: string,
  url: string,
  bearerToken: string,
  body?: any,
): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${url} failed (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function registerPackageCommand(
  program: Command,
  getContext: () => { client: GatewayClient; modelId: string; sessionId: string },
): void {
  const pkg = program.command('package').description('Agentic-Net package registry operations');

  pkg
    .command('create')
    .description('Create a package from a workspace-net, or from the whole session when netId is omitted')
    .argument('[netId]', 'Net ID to package (omit to bundle every net in the session)')
    .requiredOption('--name <name>', 'Package name')
    .requiredOption('--version <version>', 'Semver version (e.g., 1.0.0)')
    .option('--scope <scope>', 'Package scope: designtime (structure only), runtime (+ inscriptions), complete (+ tokens)', 'runtime')
    .option('--description <desc>', 'Package description')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--readme <text>', 'Readme text')
    .option('--session <sessionId>', 'Session ID')
    .action(async (netId: string | undefined, opts: any) => {
      const { client, modelId, sessionId } = getContext();
      const api = new MasterApi(client);
      const sessionBundle = !netId;
      const spinner = createSpinner(sessionBundle
        ? 'Creating session bundle...'
        : 'Creating package...');
      spinner.start();
      try {
        const result = await api.createPackage({
          name: opts.name,
          version: opts.version,
          scope: opts.scope,
          description: opts.description,
          tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : undefined,
          readme: opts.readme,
          source: {
            modelId,
            sessionId: opts.session || sessionId,
            netId: sessionBundle ? undefined : netId,
          },
        });
        spinner.stop();
        if (isJsonMode()) {
          outputJson(result);
        } else if (sessionBundle) {
          const netCount = Array.isArray(result?.nets) ? result.nets.length : 0;
          outputSuccess(`Created session bundle: ${opts.name}@${opts.version} (${opts.scope}, ${netCount} nets)`);
        } else {
          outputSuccess(`Created package: ${opts.name}@${opts.version} (${opts.scope})`);
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
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
        process.exit(1);
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
            outputInfo('No packages found.');
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
        process.exit(1);
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
          if (isJsonMode()) { outputJson(result); } else { outputDim(JSON.stringify(result, null, 2)); }
        } else {
          const result = await api.getPackageInfo(name);
          spinner.stop();
          if (isJsonMode()) {
            outputJson(result);
          } else {
            outputDim(JSON.stringify(result, null, 2));
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
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
        process.exit(1);
      }
    });

  pkg
    .command('transfer')
    .description('Copy a published package from one gateway to another (e.g., dev → staging) in one shot')
    .argument('<name>', 'Package name')
    .requiredOption('--version <v>', 'Version to transfer')
    .option('--from-gateway <url>', 'Source gateway URL (default: current profile)')
    .option('--from-client-id <id>', 'Source client_id', 'agenticos-admin')
    .option('--from-secret <s>',
      'Source client secret (default: env AGENTICOS_ADMIN_SECRET; ignored when --from-gateway unset)')
    .requiredOption('--to-gateway <url>', 'Target gateway URL')
    .option('--to-client-id <id>', 'Target client_id', 'agenticos-admin')
    .requiredOption('--to-secret <s>', 'Target client secret')
    .option('--import-session <model:session>',
      'After upload, import into <targetModelId>:<targetSessionId> on the target')
    .action(async (name: string, opts: any) => {
      const { client } = getContext();
      const spinner = createSpinner(`Transferring ${name}@${opts.version}...`);
      spinner.start();
      try {
        // ---- 1. Fetch package JSON from the source.
        spinner.text = `Fetching ${name}@${opts.version} from source...`;
        let pkgJson: any;
        if (opts.fromGateway) {
          const token = await acquireToken(
            opts.fromGateway,
            opts.fromClientId,
            opts.fromSecret || process.env.AGENTICOS_ADMIN_SECRET || '',
          );
          pkgJson = await directJson(
            'GET',
            `${opts.fromGateway}/api/packages/${name}/versions/${opts.version}`,
            token.access_token,
          );
        } else {
          const api = new MasterApi(client);
          pkgJson = await api.getPackageVersion(name, opts.version);
        }

        // ---- 2. Authenticate against the target and upload.
        spinner.text = `Uploading to ${opts.toGateway}...`;
        const toToken = await acquireToken(opts.toGateway, opts.toClientId, opts.toSecret);
        await directJson(
          'PUT',
          `${opts.toGateway}/api/packages/${name}/versions/${opts.version}`,
          toToken.access_token,
          pkgJson,
        );

        // ---- 3. Optional: chain the import on the target.
        let imported: any = null;
        if (opts.importSession) {
          const [targetModelId, targetSessionId] = String(opts.importSession).split(':');
          if (!targetModelId || !targetSessionId) {
            throw new Error('--import-session must be <modelId>:<sessionId>');
          }
          spinner.text = `Importing into ${targetModelId}:${targetSessionId}...`;
          imported = await directJson(
            'POST',
            `${opts.toGateway}/api/packages/${name}/versions/${opts.version}/import`,
            toToken.access_token,
            { targetModelId, targetSessionId },
          );
        }

        spinner.stop();
        if (isJsonMode()) {
          outputJson({ transferred: true, name, version: opts.version, imported });
        } else {
          outputSuccess(`Transferred ${name}@${opts.version} → ${opts.toGateway}`);
          if (imported) {
            outputSuccess(
              `Imported: ${imported.placesCreated} places, ${imported.transitionsCreated} transitions, ` +
                `${imported.inscriptionsStored} inscriptions, ${imported.tokensCreated} tokens`,
            );
          } else {
            outputDim('Tip: use --import-session <modelId>:<sessionId> to also install on the target.');
          }
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
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
            outputInfo('No packages published yet.');
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
        process.exit(1);
      }
    });
}
