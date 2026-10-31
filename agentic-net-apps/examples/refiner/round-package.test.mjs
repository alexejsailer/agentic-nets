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
test('a round consumes its frozen task and receives phase-specific MCP tools through the granted lane', () => {
  const build = net.inscriptions['t-refiner-round-build'];
  assert.deepEqual(Object.keys(build.presets), ['input']);
  assert.equal(build.action.template.args.toolId, 'headless-agent');
  const env = build.action.template.args.env;
  assert.ok(env.HA_PROFILE_B64 && env.HA_RESULT_KEY);
  assert.equal(env.HA_MCP_TOOLS, '${input.data.mcpTools}');
  assert.equal(Object.keys(env).some(k => /TOKEN/.test(k)), false);
  assert.equal(manifest.application.mcp.urlKey, 'AGENTICNETS_MCP_URL');
  assert.ok(manifest.application.mcp.allowTools.includes('focus_round_apply'));
  assert.ok(manifest.application.mcp.lanes.some(l => l.transitionId === 't-refiner-round-run'));
  assert.equal(env.HA_CONTEXT_JSON, undefined);
  assert.deepEqual(build.action.template.args.argv, ['run-context']);
  assert.equal(build.action.template.args.input, '${input.data.contextJson}');
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
  assert.equal(manifest.application.agentProtocol.guidedRounds.scopeSelection, 'agent');
  assert.match(p.text, /Never ask the person to select a net/);
  assert.equal(manifest.application.agentProtocol.guidedRounds.questionDelivery, 'batch');
  assert.equal(manifest.application.agentProtocol.guidedRounds.questionsPerRun, 10);
  assert.match(p.text, /questions:\[\.\.\.\]/);
  assert.match(p.text, /Exactly one option is recommended/);
  assert.match(p.text, /without another agent call per answer/);
});
test('ten cards are required and implementation uses separate explicit write profiles', () => {
  assert.equal(manifest.application.agentProtocol.guidedRounds.minQuestions, 10);
  assert.deepEqual(manifest.application.agentProtocol.guidedRounds.completionActions, ['refine', 'implement']);
  const profiles=net.tokens['p-refiner-coders'];
  for(const id of ['claude-code-implement','codex-implement']) {
    const p=profiles.find(p=>p.profileId===id);assert.equal(p.mode,'write');assert.equal(p.mcp,false);assert.equal(p._seed,true);
  }
  assert.match(profiles.find(p=>p.profileId==='claude-code-implement').allowedTools,/Write/);
  assert.ok(profiles.find(p=>p.profileId==='codex-implement').command.includes('workspace-write'));
});
