import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { GatewayClient } from '../gateway/client.js';
import { NodeApi } from '../gateway/node-api.js';
import { outputJson, outputSuccess, outputError, outputInfo, outputDim, isJsonMode, createSpinner } from '../render/output.js';

export function registerInscriptionCommand(program: Command, getContext: () => { client: GatewayClient; modelId: string; sessionId: string }): void {
  const inscription = program.command('inscription').description('Inscription operations');

  inscription
    .command('get')
    .description('Get transition inscription')
    .argument('<transitionId>', 'Transition ID')
    .action(async (transitionId: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);
      const spinner = createSpinner('Getting inscription...');
      spinner.start();
      try {
        const path = `root/workspace/transitions/${transitionId}`;
        const children = await api.getChildren(modelId, path);
        const leaf = children.find((c: any) => c.name === 'inscription');
        spinner.stop();
        if (!leaf) {
          if (isJsonMode()) { outputJson(null); } else { outputInfo('No inscription found.'); }
          return;
        }
        const value = leaf.properties?.value;
        let parsed;
        try { parsed = value ? JSON.parse(value) : null; } catch { parsed = value; }
        if (isJsonMode()) {
          outputJson(parsed);
        } else {
          outputDim(JSON.stringify(parsed, null, 2));
        }
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  inscription
    .command('set')
    .description('Set transition inscription')
    .argument('<transitionId>', 'Transition ID')
    .option('--file <path>', 'Read inscription from file')
    .option('--stdin', 'Read inscription from stdin')
    .action(async (transitionId: string, opts: any) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);

      let inscriptionJson: string;
      if (opts.file) {
        inscriptionJson = readFileSync(opts.file, 'utf-8');
      } else if (opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        inscriptionJson = Buffer.concat(chunks).toString('utf-8');
      } else {
        outputError('Provide --file <path> or --stdin');
        return;
      }

      // Validate JSON
      try { JSON.parse(inscriptionJson); } catch { outputError('Invalid JSON'); return; }

      const spinner = createSpinner('Setting inscription...');
      spinner.start();
      try {
        const transitionsPath = 'root/workspace/transitions';
        const children = await api.getChildren(modelId, transitionsPath);
        const node = children.find((c: any) => c.name === transitionId);

        if (node) {
          const transChildren = await api.getChildren(modelId, `${transitionsPath}/${transitionId}`);
          const existing = transChildren.find((c: any) => c.name === 'inscription');
          if (existing) {
            await api.executeEvents(modelId, [{
              eventType: 'updateProperty',
              id: existing.id,
              parentId: node.id,
              name: 'inscription',
              properties: { value: inscriptionJson },
            }]);
          } else {
            await api.executeEvents(modelId, [{
              eventType: 'createLeaf',
              parentId: node.id,
              id: 'auto',
              name: 'inscription',
              properties: { value: inscriptionJson },
            }]);
          }
        } else {
          // Create transition node first
          const transInfo = await api.resolve(modelId, transitionsPath);
          await api.executeEvents(modelId, [
            { eventType: 'createNode', parentId: transInfo?.id || transInfo, id: 'auto', name: transitionId },
          ]);
          const updatedChildren = await api.getChildren(modelId, transitionsPath);
          const newNode = updatedChildren.find((c: any) => c.name === transitionId);
          if (newNode) {
            await api.executeEvents(modelId, [{
              eventType: 'createLeaf',
              parentId: newNode.id,
              id: 'auto',
              name: 'inscription',
              properties: { value: inscriptionJson },
            }]);
          }
        }
        spinner.stop();
        outputSuccess(`Inscription set for ${transitionId}`);
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });

  inscription
    .command('edit')
    .description('Edit inscription in $EDITOR')
    .argument('<transitionId>', 'Transition ID')
    .action(async (transitionId: string) => {
      const { client, modelId } = getContext();
      const api = new NodeApi(client);

      // Load current inscription
      let currentJson = '{}';
      try {
        const path = `root/workspace/transitions/${transitionId}`;
        const children = await api.getChildren(modelId, path);
        const leaf = children.find((c: any) => c.name === 'inscription');
        if (leaf?.properties?.value) {
          currentJson = JSON.stringify(JSON.parse(leaf.properties.value), null, 2);
        }
      } catch { /* use default */ }

      // Write to temp file
      const tmpFile = join(tmpdir(), `agenticos-inscription-${transitionId}.json`);
      writeFileSync(tmpFile, currentJson, 'utf-8');

      // Open in editor
      const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
      try {
        execSync(`${editor} ${tmpFile}`, { stdio: 'inherit' });
      } catch {
        outputError('Editor exited with error.');
        return;
      }

      // Read back and save
      const editedJson = readFileSync(tmpFile, 'utf-8');
      try { JSON.parse(editedJson); } catch { outputError('Edited file is not valid JSON.'); return; }

      // Re-use the set logic (pipe through stdin simulation)
      const spinner = createSpinner('Saving inscription...');
      spinner.start();
      try {
        const transitionsPath = 'root/workspace/transitions';
        const children = await api.getChildren(modelId, transitionsPath);
        const node = children.find((c: any) => c.name === transitionId);
        if (node) {
          const transChildren = await api.getChildren(modelId, `${transitionsPath}/${transitionId}`);
          const existing = transChildren.find((c: any) => c.name === 'inscription');
          if (existing) {
            await api.executeEvents(modelId, [{
              eventType: 'updateProperty',
              id: existing.id,
              parentId: node.id,
              name: 'inscription',
              properties: { value: editedJson },
            }]);
          } else {
            await api.executeEvents(modelId, [{
              eventType: 'createLeaf',
              parentId: node.id,
              id: 'auto',
              name: 'inscription',
              properties: { value: editedJson },
            }]);
          }
        }
        spinner.stop();
        outputSuccess(`Inscription saved for ${transitionId}`);
      } catch (err: any) { spinner.fail(err.message); process.exit(1); }
    });
}
