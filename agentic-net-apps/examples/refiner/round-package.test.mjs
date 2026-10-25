import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const manifest = read('agenticos.app.json');
const net = read('runtime/session.package.json').nets[0];
test('guided rounds retain the existing review and add persistent role-based stores and guarded actions', () => {
  const roles = new Map(manifest.application.stores.map(s => [s.role, s.placeId]));
  for (const r of ['requests', 'runs', 'rounds', 'round-jobs', 'round-commands', 'round-raw', 'round-results']) {
    assert.ok(roles.has(r)); assert.ok(net.net.net.places[roles.get(r)]);
  }
  for (const name of ['createRound', 'dispatchRound']) {
    const a = manifest.application.actions.find(a => a.name === name);
    assert.equal(a.guard.exists, false); assert.ok(manifest.application.permissions.actions.includes(name));
  }
  assert.ok(net.inscriptions['t-refiner-pass']); assert.ok(net.inscriptions['t-refiner-coder-run']);
});
test('a round consumes only its frozen task and never passes MCP access to the CLI', () => {
  const build = net.inscriptions['t-refiner-round-build'];
  assert.deepEqual(Object.keys(build.presets), ['input']);
  assert.equal(build.action.template.args.toolId, 'headless-agent');
  const env = build.action.template.args.env;
  assert.ok(env.HA_CONTEXT_JSON && env.HA_PROFILE_B64 && env.HA_RESULT_KEY);
  assert.equal(Object.keys(env).some(k => /MCP|TOKEN/.test(k)), false);
  assert.ok(net.inscriptions['t-refiner-round-run']); assert.ok(net.inscriptions['t-refiner-round-shape'].action.template.requestId);
});
test('both providers and the round policy are editable upgrade-safe seeds', () => {
  const profiles = net.tokens['p-refiner-coders'];
  for (const id of ['claude-code-read-only', 'codex-read-only']) {
    const p = profiles.find(p => p.profileId === id); assert.equal(p.mode, 'read-only'); assert.equal(p._seed, true);
  }
  const p = net.tokens['p-refiner-prompts'].find(p => p.promptId === 'guided-round');
  assert.equal(p._seed, true); assert.match(p.text, /sealed answers/); assert.match(p.text, /FOCUS_ROUND_RESULT/);
  assert.equal(manifest.application.agentProtocol.guidedRounds.maxQuestions, 10);
});
