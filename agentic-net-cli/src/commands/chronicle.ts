import { Command } from 'commander';
import type { GatewayClient } from '../gateway/client.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputSuccess, outputError, outputInfo, outputTable, isJsonMode, createSpinner } from '../render/output.js';

const CHRONICLE_BASE = 'root/workspace/sessions';

function chroniclePath(sessionId: string, ...parts: string[]): string {
  return [CHRONICLE_BASE, sessionId, 'chronicle', ...parts].join('/');
}

export function registerChronicleCommand(
  program: Command,
  getContext: () => { client: GatewayClient; modelId: string; sessionId: string },
): void {
  const chronicle = program.command('chronicle').description('Session Chronicle — recording, analysis, and reporting');

  // ---- status ----
  chronicle
    .command('status')
    .description('Show chronicle status for the current session')
    .action(async () => {
      const { client, modelId, sessionId } = getContext();
      if (!sessionId) { outputError('No session set. Use: agenticos session use <sessionId>'); process.exit(1); }
      const node = new NodeApi(client);
      const spinner = createSpinner('Checking chronicle status...');
      spinner.start();
      try {
        const configPath = chroniclePath(sessionId, 'config');
        const children = await node.getChildren(modelId, configPath);

        const statusLeaf = children.find((c: any) => c.name === 'status');
        const lastRunLeaf = children.find((c: any) => c.name === 'last-run');
        const settingsLeaf = children.find((c: any) => c.name === 'settings');

        const status = statusLeaf?.properties?.value ?? 'not initialized';
        const lastRun = lastRunLeaf?.properties?.value ?? 'never';
        const settings = settingsLeaf?.properties?.value ?? '{}';

        // Count entries
        let entryCount = 0;
        try {
          const entriesPath = chroniclePath(sessionId, 'entries');
          const partitions = await node.getChildren(modelId, entriesPath);
          for (const partition of partitions) {
            const partitionChildren = await node.getChildren(modelId, `${entriesPath}/${partition.name}`);
            entryCount += partitionChildren.length;
          }
        } catch { /* entries may not exist yet */ }

        spinner.stop();
        if (isJsonMode()) {
          outputJson({ sessionId, status, lastRun, entryCount, settings: JSON.parse(settings) });
        } else {
          outputInfo(`Session:  ${sessionId}`);
          outputInfo(`Status:   ${status}`);
          outputInfo(`Last run: ${lastRun}`);
          outputInfo(`Entries:  ${entryCount}`);
          if (status === 'not initialized') {
            outputInfo('');
            outputInfo('Chronicle not yet initialized for this session.');
            outputInfo('Use the Chronicle persona in the Universal Assistant to bootstrap it,');
            outputInfo('or ask: "Initialize chronicle and record current state"');
          }
        }
      } catch (err: any) {
        spinner.stop();
        if (err.message?.includes('not found') || err.message?.includes('404') || err.message?.includes('400')) {
          if (isJsonMode()) {
            outputJson({ sessionId, status: 'not initialized', entryCount: 0 });
          } else {
            outputInfo(`Session:  ${sessionId}`);
            outputInfo('Status:   not initialized');
            outputInfo('');
            outputInfo('Chronicle not yet initialized for this session.');
            outputInfo('Use the Chronicle persona in the Universal Assistant to bootstrap it.');
          }
        } else {
          outputError(err.message);
          process.exit(1);
        }
      }
    });

  // ---- entries ----
  chronicle
    .command('entries')
    .description('List recent chronicle entries')
    .option('-n, --limit <n>', 'Number of entries to show', '10')
    .option('--type <type>', 'Filter by type (observation, analysis, alert, goal-check, error-digest, milestone)')
    .option('--net <netId>', 'Filter by net scope')
    .option('--since <date>', 'Entries after date (YYYY-MM-DD)')
    .action(async (opts: any) => {
      const { client, modelId, sessionId } = getContext();
      if (!sessionId) { outputError('No session set.'); process.exit(1); }
      const node = new NodeApi(client);
      const spinner = createSpinner('Fetching chronicle entries...');
      spinner.start();
      try {
        const entriesPath = chroniclePath(sessionId, 'entries');
        const partitions = await node.getChildren(modelId, entriesPath);

        // Sort partitions by name (date) descending
        const sortedPartitions = partitions
          .map((p: any) => p.name)
          .filter((name: string) => !opts.since || name >= opts.since)
          .sort((a: string, b: string) => b.localeCompare(a));

        const allEntries: any[] = [];
        const limit = parseInt(opts.limit, 10);

        for (const partitionName of sortedPartitions) {
          if (allEntries.length >= limit) break;
          const partitionPath = `${entriesPath}/${partitionName}`;
          const entries = await node.getChildren(modelId, partitionPath);

          for (const entry of entries) {
            const props = entry.properties || {};
            // Apply filters
            if (opts.type && props.type !== opts.type) continue;
            if (opts.net && props.scopeId !== opts.net) continue;
            allEntries.push({
              id: props.id || entry.name,
              timestamp: props.timestamp || '',
              type: props.type || '?',
              scope: props.scopeId || props.scope || '',
              summary: props.summary || '',
              metrics: props.metrics || '',
            });
          }
        }

        // Sort by timestamp descending, take limit
        allEntries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const limited = allEntries.slice(0, limit);

        spinner.stop();
        if (isJsonMode()) {
          outputJson(limited);
        } else if (limited.length === 0) {
          outputInfo('No chronicle entries found.');
          if (!opts.since && !opts.type && !opts.net) {
            outputInfo('Chronicle may not be initialized yet.');
          }
        } else {
          outputTable(
            ['Timestamp', 'Type', 'Scope', 'Summary'],
            limited.map(e => [
              e.timestamp.slice(0, 19).replace('T', ' '),
              e.type,
              e.scope,
              e.summary.length > 60 ? e.summary.slice(0, 57) + '...' : e.summary,
            ]),
          );
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  // ---- report ----
  chronicle
    .command('report')
    .description('Show or generate a chronicle report')
    .option('--scope <scope>', 'Report scope: daily, weekly, custom', 'daily')
    .option('--date <date>', 'Report date (YYYY-MM-DD or YYYY-Www)', new Date().toISOString().slice(0, 10))
    .option('--generate', 'Generate a new report (requires Chronicle persona)')
    .action(async (opts: any) => {
      const { client, modelId, sessionId } = getContext();
      if (!sessionId) { outputError('No session set.'); process.exit(1); }
      const node = new NodeApi(client);
      const spinner = createSpinner('Fetching report...');
      spinner.start();
      try {
        const reportPath = chroniclePath(sessionId, 'reports', opts.scope, opts.date);
        const report = await node.getLeafProperties(modelId, reportPath);
        spinner.stop();
        if (report?.properties?.value) {
          if (isJsonMode()) {
            outputJson({ scope: opts.scope, date: opts.date, content: report.properties.value });
          } else {
            console.log(report.properties.value);
          }
        } else {
          outputInfo(`No ${opts.scope} report found for ${opts.date}.`);
          outputInfo('Use the Chronicle persona to generate: "Generate a daily report for today"');
        }
      } catch (err: any) {
        spinner.stop();
        outputInfo(`No ${opts.scope} report found for ${opts.date}.`);
        outputInfo('Use the Chronicle persona to generate one.');
      }
    });

  // ---- ask ----
  chronicle
    .command('ask')
    .description('Ask a question about session history')
    .argument('<question...>', 'Your question')
    .action(async (questionParts: string[]) => {
      const { client, modelId, sessionId } = getContext();
      if (!sessionId) { outputError('No session set.'); process.exit(1); }
      const question = questionParts.join(' ');
      const master = new MasterApi(client);
      const spinner = createSpinner('Thinking...');
      spinner.start();
      try {
        // Start a chronicle persona conversation
        const startResult = await client.masterApi('POST', `/assistant/p/chronicle/${modelId}/chat/start`, {
          sessionId,
          userMessage: question,
        });
        const conversationId = startResult.conversationId;

        // Stream the agent response
        spinner.stop();
        const response = await client.masterApi('POST', `/assistant/p/chronicle/${modelId}/chat/${conversationId}/agent-stream`, {
          userMessage: question,
          sessionId,
        });

        // Display the text response
        if (typeof response === 'string') {
          console.log(response);
        } else if (response?.text) {
          console.log(response.text);
        } else if (isJsonMode()) {
          outputJson(response);
        } else {
          outputInfo('Chronicle agent completed. Check the GUI for full conversation.');
        }
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  // ---- indexes ----
  chronicle
    .command('indexes')
    .description('Show current chronicle index snapshots')
    .action(async () => {
      const { client, modelId, sessionId } = getContext();
      if (!sessionId) { outputError('No session set.'); process.exit(1); }
      const node = new NodeApi(client);
      const spinner = createSpinner('Fetching indexes...');
      spinner.start();
      try {
        const indexPath = chroniclePath(sessionId, 'indexes');
        const children = await node.getChildren(modelId, indexPath);
        spinner.stop();
        if (isJsonMode()) {
          const indexes: Record<string, any> = {};
          for (const child of children) {
            indexes[child.name] = child.properties?.value
              ? JSON.parse(child.properties.value)
              : child.properties;
          }
          outputJson(indexes);
        } else {
          for (const child of children) {
            outputInfo(`\n--- ${child.name} ---`);
            const value = child.properties?.value;
            if (value) {
              try {
                const parsed = JSON.parse(value);
                console.log(JSON.stringify(parsed, null, 2));
              } catch {
                console.log(value);
              }
            } else {
              console.log(JSON.stringify(child.properties || {}, null, 2));
            }
          }
        }
      } catch (err: any) {
        spinner.stop();
        outputInfo('No chronicle indexes found. Chronicle may not be initialized.');
      }
    });
}
