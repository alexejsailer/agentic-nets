/**
 * Prompts an application brings in its manifest (src/app-prompts.ts), tested with the real Focus
 * manifest (agentic-net-apps/examples/refiner): they register only where the tools they name are
 * registered, render their arguments, and keep the old prompts' branches through pattern sections.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import { appPromptCache, promptsOfManifest, renderTemplate } from '../src/app-prompts.js';
import type { McpConfig } from '../src/config.js';

const FOCUS = JSON.parse(readFileSync(new URL('../../agentic-net-apps/examples/refiner/agenticos.app.json', import.meta.url), 'utf8'));
const METHOD = ['structure-pass', 'ground-model', 'refinement-pass', 'implement-from-model', 'question-round'];

function config(over: Partial<McpConfig> = {}): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0', models: ['m1'], mode: 'rw', session: 'mcp', nodeHost: 'localhost:8080',
    transport: 'stdio', httpPort: 0, llmProvider: 'claude-code', llmTier: 'medium', allowModelCreate: false,
    persistedModels: [], allowlistPath: '/tmp/agenticnets-test-allowlist.json', persistAllowlist: false, ...over,
  };
}

async function client(over: Partial<McpConfig> = {}) {
  const server = createServer(new AppContext(config(over)));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(b), c.connect(a)]);
  return c;
}

const text = async (c: Client, name: string, args: Record<string, string>) =>
  ((await c.getPrompt({ name, arguments: args })) as any).messages[0].content.text as string;

afterEach(() => appPromptCache.reset());

describe('templates', () => {
  it('fills values, keeps sections by presence or by pattern, and drops unknown values', () => {
    const t = 'A{{#x}} x={{x}}{{/x}}{{^x}} no x{{/x}}{{#y=~^d:}} focus {{y}}{{/y}}{{^y=~^d:}} plain{{/y}} {{z}}.';
    expect(renderTemplate(t, { x: '1', y: 'd:a' })).toBe('A x=1 focus d:a .');
    expect(renderTemplate(t, { y: 'rules' })).toBe('A no x plain .');
    expect(renderTemplate(t, {})).toBe('A no x plain .');
  });

  it('skips a malformed prompt and the reserved model argument', () => {
    const prompts = promptsOfManifest('x', { agentProtocol: { prompts: [
      { name: 'Bad', text: 'x' }, { name: 'ok', text: '', arguments: [] },
      { name: 'good', text: 'Hi {{who}}', arguments: [{ name: 'who' }, { name: 'model' }] }] } });
    expect(prompts.map((p) => p.name)).toEqual(['good']);
    expect(prompts[0].arguments.map((a) => a.name)).toEqual(['who']);
  });
});

describe('the refinement prompts are built in', () => {
  it('appear with the refinement tools and render the old branches; the retired catalog copy adds nothing', async () => {
    appPromptCache.set(promptsOfManifest('refiner', FOCUS.application));
    const c = await client({ nativeTools: 'curated' });
    const names = (await c.listPrompts()).prompts.map((p) => p.name);
    for (const n of METHOD) expect(names).toContain(n);

    const focus = await text(c, 'refinement-pass', { scope: 'domain:intake' });
    expect(focus).toContain('focus_digest { scope:"domain:intake"}');
    expect(focus).toContain('focus_scope {scope:"domain:intake"}');
    expect(focus).toMatch(/passScope/);
    expect(focus).toContain('at most 5 new questions');
    const plain = await text(c, 'refinement-pass', { scope: 'rules' });
    expect(plain).not.toContain('focus_scope');
    expect(plain).toContain('focus_digest { level:"rules"}');
    expect(await text(c, 'refinement-pass', {})).toContain('at most 10 new questions');

    const structure = await text(c, 'structure-pass', { scope: 'domain:intake', model: 'm1' });
    expect(structure).toContain('refine_model { scope:"domain:intake", for:"model"}');
    expect(structure).toContain('focus:<focus_scope');
    expect(structure).toContain(' in model "m1" (pass model:"m1" on every call)');
    expect(await text(c, 'structure-pass', { scope: 'svc::net' })).toContain('refine_model { net:"svc::net", for:"model"}');
    expect(await text(c, 'structure-pass', {})).toContain('scope:"structure:model"');

    expect(await text(c, 'ground-model', { policy: 'sources-win' })).not.toContain('could be a regression');
    expect(await text(c, 'ground-model', {})).toContain('could be a regression');
    expect(await text(c, 'question-round', { scope: 's::n', persona: 'reviewer' })).toContain('refine_model { net:"s::n", direction:"both"}');
    expect(await text(c, 'implement-from-model', { net: 's::n' })).toContain('Implement s::n from its definition');
  });

  it('readonly lacks the tools they write with', async () => {
    appPromptCache.set(promptsOfManifest('refiner', FOCUS.application));
    const ro = (await (await client({ mode: 'readonly' })).listPrompts()).prompts.map((p) => p.name);
    for (const n of METHOD) expect(ro).not.toContain(n);
  });

  it('a built-in prompt keeps its name; the application prompt gets its prefix', async () => {
    appPromptCache.set(promptsOfManifest('kit', { agentProtocol: { prompts: [{ name: 'debug-net', text: 'kit debugging {{net}}', arguments: [{ name: 'net' }] }] } }));
    const c = await client({ nativeTools: 'curated' });
    const names = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(names).toContain('debug-net');
    expect(names).toContain('kit-debug-net');
    expect(await text(c, 'kit-debug-net', { net: 'x' })).toBe('kit debugging x');
  });

  it('registers late when the hub answers after the client connected', async () => {
    const c = await client({ nativeTools: 'curated' });
    expect((await c.listPrompts()).prompts.map((p) => p.name)).not.toContain('late-round');
    appPromptCache.set(promptsOfManifest('kit', { agentProtocol: { prompts: [{ name: 'late-round', text: 'late {{scope}}', requiresTools: ['refine_model'], arguments: [{ name: 'scope' }] }] } }));
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toContain('late-round');
  });
});
