#!/usr/bin/env node
/**
 * pack.mjs — capability pack lifecycle tooling (CONTRACT.md Part C5, first implementation).
 *
 * Talks to any AgenticNetOS installation through its MCP HTTP endpoint (stateless
 * streamable HTTP, bearer auth) — the same surface every MCP client uses, so this
 * works against staging, a server compose, or the Desktop app without extra APIs.
 *
 *   build     — compile compact nets/*.net.json sources -> full .pnml.json + .inscriptions.json
 *               (arcs derived from reads/writes, deterministic auto-layout, boilerplate defaults,
 *                charters read from markdown files, ${master} substituted)
 *   export    — running session -> pack directory (nets/, seeds/, manifest.runtime.json)
 *   install   — pack directory  -> a session in ANY --model (symbolic-id remap via --suffix;
 *               hosts + agent modelId normalized to the target model)
 *   uninstall — stop + deregister the pack's transitions, delete its nets, untag the session
 *   verify    — run verify/smoke.json against an installed pack
 *
 * Env:  AGENTICOS_MCP_URL   e.g. https://host/mcp or http://127.0.0.1:8091/mcp
 *       AGENTICOS_MCP_TOKEN bearer token
 *
 * Examples:
 *   node pack.mjs build   --dir capabilities/place-inspector
 *   node pack.mjs install --dir capabilities/place-inspector --model default --session agent-place-inspector
 *   node pack.mjs verify  --dir capabilities/place-inspector --model default
 *   node pack.mjs export  --dir capabilities/token-janitor --model default --session agent-token-janitor
 *   node pack.mjs uninstall --dir capabilities/place-inspector --model default --session agent-place-inspector
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ---------------------------------------------------------------- MCP client
const MCP_URL = process.env.AGENTICOS_MCP_URL;
const MCP_TOKEN = process.env.AGENTICOS_MCP_TOKEN;
let rpcId = 0;

async function callTool(name, args, { retries = 2 } = {}) {
  if (!MCP_URL || !MCP_TOKEN) throw new Error('Set AGENTICOS_MCP_URL and AGENTICOS_MCP_TOKEN (not needed for build)');
  const payload = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(MCP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MCP_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      let msg;
      if (text.trimStart().startsWith('{')) {
        msg = JSON.parse(text);
      } else {
        // SSE frame(s): take the last data: line carrying our response
        const datas = text.split('\n').filter((l) => l.startsWith('data:'));
        msg = JSON.parse(datas[datas.length - 1].slice(5));
      }
      if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error).slice(0, 400)}`);
      const result = msg.result ?? {};
      const inner =
        result.structuredContent ??
        (() => {
          const t = result.content?.find((c) => c.type === 'text')?.text ?? '';
          try { return JSON.parse(t); } catch { return { _text: t }; }
        })();
      if (result.isError) throw new Error(`${name} tool error: ${JSON.stringify(inner).slice(0, 500)}`);
      return inner;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------------- helpers
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}
const stable = (obj) => JSON.stringify(sortKeys(obj), null, 2) + '\n';
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const log = (...a) => console.log('[pack]', ...a);

/** Collect every symbolic id owned by the pack from its pnml files. */
function packIds(dir) {
  const ids = new Set();
  const netsDir = join(dir, 'nets');
  for (const f of readdirSync(netsDir).filter((f) => f.endsWith('.pnml.json'))) {
    const net = JSON.parse(readFileSync(join(netsDir, f), 'utf8')).net;
    ids.add(net.id);
    for (const p of Object.keys(net.places ?? {})) ids.add(p);
    for (const t of Object.keys(net.transitions ?? {})) ids.add(t);
  }
  return ids;
}

/** Serialize-replace every pack id with id+suffix (longest ids first, word-bounded). */
function remap(value, ids, suffix) {
  if (!suffix) return value;
  let s = JSON.stringify(value);
  for (const id of [...ids].sort((a, b) => b.length - a.length)) {
    s = s.replaceAll(new RegExp(`${id.replace(/[.*+?^${'{'}}()|[\\]\\\\]/g, '\\$&')}(?![\\w-])`, 'g'), `${id}${suffix}`);
  }
  return JSON.parse(s);
}

// ---------------------------------------------------------------- build
/**
 * Compact source (nets/<net>.net.json) -> full compiled pair. The source declares
 * transitions with alias->place reads/writes; everything else is derived:
 * arcs, layout, preset/postset boilerplate, default emits, metadata, hosts.
 */
function compileNet(dir, srcPath) {
  const src = JSON.parse(readFileSync(srcPath, 'utf8'));
  const netId = src.net;
  const model = src.model ?? 'default';
  const host = `${model}@${src.nodeHost ?? 'agentic-net-node:8080'}`;
  const master = src.master ?? 'http://agentic-net-master:8082';
  const session = src.session ?? `agent-${basename(dir)}`;
  const placeMeta = src.places ?? {};
  const placeOrder = [];
  const notePlace = (id) => { if (!placeOrder.includes(id)) placeOrder.push(id); };
  const norm = (v) => (typeof v === 'string' ? { place: v } : v);

  const arcs = {};
  let arcN = 0;
  const arc = (source, target) => {
    const id = `a-${netId}-${String(++arcN).padStart(2, '0')}`;
    arcs[id] = { id, source, target, weight: 1 };
  };

  const inscriptions = (src.transitions ?? []).map((t) => {
    const presets = {}, postsets = {};
    for (const [alias, rv] of Object.entries(t.reads ?? {})) {
      const r = norm(rv);
      notePlace(r.place);
      arc(r.place, t.id);
      presets[alias] = {
        placeId: r.place,
        host,
        arcql: r.arcql ?? 'FROM $ LIMIT 1',
        take: r.take ?? 'FIRST',
        consume: r.consume ?? true,
        optional: r.optional ?? false,
        ...(r.ttl ? { reservationTtlMs: r.ttl } : {}),
      };
    }
    for (const [alias, wv] of Object.entries(t.writes ?? {})) {
      const w = norm(wv);
      notePlace(w.place);
      arc(t.id, w.place);
      postsets[alias] = { placeId: w.place, host, ...(w.capacity ? { capacity: w.capacity } : {}) };
    }

    let action;
    let emit = t.emit?.map((e) => ({ from: '@response', ...e }));
    if (t.kind === 'map') {
      action = { type: 'map', template: t.template };
      emit ??= Object.keys(postsets).map((a) => ({ to: a, from: '@response' }));
    } else if (t.kind === 'http') {
      action = {
        type: 'http',
        method: t.http.method ?? 'GET',
        url: t.http.url.replaceAll('${master}', master),
        timeoutMs: t.http.timeoutMs ?? 60000,
      };
      emit ??= [
        ...(postsets.raw ? [{ to: 'raw', from: '@response.json', when: 'success' }] : []),
        ...(postsets.err ? [{ to: 'err', from: '@response', when: 'error' }] : []),
      ];
    } else if (t.kind === 'agent') {
      const ag = t.agent ?? {};
      const nl = ag.charter
        ? readFileSync(join(dir, ag.charter), 'utf8').replace(/\n$/, '')
        : ag.nl;
      action = {
        type: 'agent',
        modelId: model,
        role: ag.role ?? 'rw',
        maxIterations: ag.maxIterations ?? 12,
        autoEmit: false,
        ...(ag.tier ? { tier: ag.tier } : {}),
        sessionId: session,
        ...(ag.requireWritesTo ? { requireWritesTo: ag.requireWritesTo } : {}),
        nl,
      };
      emit ??= [];
    } else {
      throw new Error(`${t.id}: unsupported kind '${t.kind}' in compact source (map|http|agent)`);
    }

    return {
      id: t.id,
      kind: t.kind,
      label: t.label,
      ...(t.description ? { description: t.description } : {}),
      ...(t.kind === 'agent' ? { role: t.agent?.role ?? 'rw' } : {}),
      presets,
      postsets,
      action,
      emit,
      mode: 'SINGLE',
      metadata: { sessionId: session, netId },
    };
  });

  // Deterministic serpentine layout: transitions in declaration order along a grid,
  // each preceded by its (not yet placed) read places and followed by write places.
  const placed = new Map();
  let slot = 0;
  const COLS = 6, DX = 220, DY = 170;
  const put = (id) => {
    if (placed.has(id)) return;
    const row = Math.floor(slot / COLS);
    const colRaw = slot % COLS;
    const col = row % 2 === 0 ? colRaw : COLS - 1 - colRaw; // serpentine
    placed.set(id, { x: 100 + col * DX, y: 100 + row * DY });
    slot++;
  };
  for (const t of src.transitions ?? []) {
    for (const rv of Object.values(t.reads ?? {})) put(norm(rv).place);
    put(t.id);
    for (const wv of Object.values(t.writes ?? {})) put(norm(wv).place);
  }

  const places = {};
  for (const id of placeOrder) {
    const meta = typeof placeMeta[id] === 'string' ? { label: placeMeta[id] } : placeMeta[id] ?? {};
    places[id] = { id, label: meta.label ?? id, ...placed.get(id), tokens: 0 };
  }
  const transitions = {};
  for (const t of src.transitions ?? []) {
    transitions[t.id] = { id: t.id, label: t.label, ...placed.get(t.id) };
  }

  return { net: { id: netId, description: src.description ?? '', places, transitions, arcs }, inscriptions };
}

async function cmdBuild(a) {
  const { dir } = a;
  const netsDir = join(dir, 'nets');
  const sources = readdirSync(netsDir).filter((f) => f.endsWith('.net.json'));
  if (!sources.length) throw new Error(`no nets/*.net.json compact sources in ${dir}`);
  for (const f of sources) {
    const { net, inscriptions } = compileNet(dir, join(netsDir, f));
    writeFileSync(join(netsDir, `${net.id}.pnml.json`), stable({ net }));
    writeFileSync(join(netsDir, `${net.id}.inscriptions.json`), stable(inscriptions));
    log(`built ${net.id}: ${Object.keys(net.places).length}p/${Object.keys(net.transitions).length}t/${Object.keys(net.arcs).length}a + ${inscriptions.length} inscriptions (from ${f})`);
  }
  log('build complete');
}

// ---------------------------------------------------------------- uninstall
async function cmdUninstall(a) {
  const { dir, model, session } = a;
  const suffix = a.suffix ?? '';
  const ids = packIds(dir);
  const netsDir = join(dir, 'nets');
  const sfx = (id) => `${id}${suffix}`;

  for (const f of readdirSync(netsDir).filter((f) => f.endsWith('.inscriptions.json'))) {
    for (const i of JSON.parse(readFileSync(join(netsDir, f), 'utf8'))) {
      const tid = ids.has(i.id) || suffix === '' ? sfx(i.id) : i.id;
      if (i.kind !== 'link') await callTool('STOP_TRANSITION', { transitionId: tid, model }).catch(() => {});
      await callTool('DELETE_TRANSITION', { transitionId: tid, model }).catch(() => {});
    }
  }
  for (const f of readdirSync(netsDir).filter((f) => f.endsWith('.pnml.json'))) {
    const netId = sfx(JSON.parse(readFileSync(join(netsDir, f), 'utf8')).net.id);
    await callTool('DELETE_NET', { netId, sessionId: session, deleteTransitions: true, model }).catch((e) =>
      log(`  WARN delete_net ${netId}: ${e.message.slice(0, 80)}`));
    log(`  deleted net ${netId}`);
  }
  await callTool('TAG_SESSION', { sessionId: session, tags: ['agents', 'capability-pack'], mode: 'remove', model });
  log(`  untagged ${session} (runtime places and the session node remain; tokens are untouched)`);
  log('uninstall complete');
}

// ---------------------------------------------------------------- export
async function cmdExport(a) {
  const { dir, model, session } = a;
  mkdirSync(join(dir, 'nets'), { recursive: true });
  mkdirSync(join(dir, 'seeds'), { recursive: true });

  const netsRes = await callTool('LIST_SESSION_NETS', { sessionId: session, model });
  const netIds = (Array.isArray(netsRes) ? netsRes : netsRes?.nets ?? netsRes?.data?.nets ?? netsRes?.data ?? [])
    .map((n) => (typeof n === 'string' ? n : n?.netId ?? n?.name))
    .filter(Boolean);
  if (!netIds.length) throw new Error(`no nets found in session '${session}'`);
  log(`exporting ${netIds.length} nets from ${model}/${session}: ${netIds.join(', ')}`);

  const allPlaceIds = new Set();
  for (const netId of netIds) {
    const pnml = await callTool('EXPORT_PNML', { netId, sessionId: session, model });
    const net = pnml.net ?? pnml;
    writeFileSync(join(dir, 'nets', `${netId}.pnml.json`), stable({ net }));
    for (const p of Object.keys(net.places ?? {})) allPlaceIds.add(p);
    log(`  ${netId}.pnml.json (${Object.keys(net.places ?? {}).length}p/${Object.keys(net.transitions ?? {}).length}t)`);
  }

  const insc = await callTool('LIST_ALL_INSCRIPTIONS', { includeContent: true, limit: 500, model });
  const rows = insc.transitions ?? [];
  const byNet = new Map(netIds.map((n) => [n, []]));
  const links = [];
  for (const row of rows) {
    const i = row.inscription ?? {};
    const netId = i.metadata?.netId;
    if (netId && byNet.has(netId)) { byNet.get(netId).push(row); continue; }
    if (i.kind === 'link') {
      const placeRefs = [
        ...Object.values(i.presets ?? {}).map((p) => p.placeId),
        ...Object.values(i.postsets ?? {}).map((p) => p.placeId),
      ];
      if (placeRefs.some((p) => allPlaceIds.has(p))) links.push(row);
    }
  }
  for (const [netId, list] of byNet) {
    list.sort((x, y) => x.transitionId.localeCompare(y.transitionId));
    writeFileSync(
      join(dir, 'nets', `${netId}.inscriptions.json`),
      stable(list.map((r) => r.inscription)),
    );
    log(`  ${netId}.inscriptions.json (${list.length} inscriptions)`);
  }
  if (links.length) {
    writeFileSync(join(dir, 'nets', 'session-links.inscriptions.json'), stable(links.map((r) => r.inscription)));
    log(`  session-links.inscriptions.json (${links.length} links)`);
  }

  // Runtime manifest — the `agent-manifest` leaf on the session node (the registry contract).
  try {
    const sq = await callTool('query_tokens', {
      model,
      place: `root/workspace/sessions/${session}`,
      maxValueLength: 200000,
    });
    const leaf = (sq.results ?? []).find((r) => (r._meta?.name ?? r.name) === 'agent-manifest');
    if (!leaf) throw new Error('agent-manifest leaf not found on session node');
    const raw = leaf.data?.value ?? leaf.data;
    const manifest = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // sessionId is install-time provenance (derivable from --session) — strip it so
    // authored files and export round-trips compare byte-clean.
    delete manifest.sessionId;
    writeFileSync(join(dir, 'manifest.runtime.json'), stable(manifest));
    log('  manifest.runtime.json');
  } catch (e) {
    log(`  WARN: manifest export failed (${e.message.slice(0, 120)})`);
  }

  // Config/knowledge seeds: policy, config, charter, capabilities, routing places.
  for (const place of [...allPlaceIds].filter((p) => /-(policy|config|charter|capabilities|routing-knowledge)$/.test(p))) {
    const q = await callTool('query_tokens', { model, place, maxValueLength: 100000 });
    const tokens = (q.results ?? []).map((r) => r.data).filter((d) => d && typeof d === 'object');
    if (tokens.length) {
      writeFileSync(join(dir, 'seeds', `${place}.json`), stable(tokens));
      log(`  seeds/${place}.json (${tokens.length} tokens)`);
    }
  }
  log('export complete');
}

// ---------------------------------------------------------------- install
async function cmdInstall(a) {
  const { dir, model } = a;
  const session = a.session;
  const suffix = a.suffix ?? '';
  const ids = packIds(dir);
  const netsDir = join(dir, 'nets');
  const pnmls = readdirSync(netsDir).filter((f) => f.endsWith('.pnml.json'));

  log(`installing into ${model}/${session} (suffix '${suffix}')`);
  await callTool('CREATE_SESSION', { sessionId: session, naturalLanguageText: `pack install of ${basename(dir)}`, model })
    .catch((e) => log(`  session exists or create failed (${e.message.slice(0, 80)}) — continuing`));

  const started = [];
  for (const f of pnmls) {
    const net = remap(JSON.parse(readFileSync(join(netsDir, f), 'utf8')).net, ids, suffix);
    await callTool('CREATE_NET', { netId: net.id, name: net.id, sessionId: session, model });
    for (const p of Object.values(net.places ?? {})) {
      await callTool('CREATE_PLACE', { netId: net.id, placeId: p.id, label: p.label, x: p.x, y: p.y, sessionId: session, model });
      await callTool('CREATE_RUNTIME_PLACE', { placeId: p.id, model });
    }
    for (const t of Object.values(net.transitions ?? {})) {
      await callTool('CREATE_TRANSITION', { netId: net.id, transitionId: t.id, label: t.label, x: t.x, y: t.y, sessionId: session, model });
    }
    for (const arc of Object.values(net.arcs ?? {})) {
      await callTool('CREATE_ARC', { netId: net.id, arcId: arc.id, sourceId: arc.source, targetId: arc.target, sessionId: session, model });
    }
    log(`  net ${net.id}: ${Object.keys(net.places ?? {}).length}p/${Object.keys(net.transitions ?? {}).length}t/${Object.keys(net.arcs ?? {}).length}a`);
  }

  const inscFiles = readdirSync(netsDir).filter((f) => f.endsWith('.inscriptions.json'));
  for (const f of inscFiles) {
    for (const raw of JSON.parse(readFileSync(join(netsDir, f), 'utf8'))) {
      const i = remap(raw, ids, suffix);
      if (i.metadata?.sessionId) i.metadata.sessionId = session;
      if (i.action?.sessionId) i.action.sessionId = session;
      // Normalize to the TARGET model: preset/postset hosts ("<model>@<node-host>") and the
      // agent's modelId, so the same compiled files inject into any --model.
      const nodeHost = a['node-host'] ?? 'agentic-net-node:8080';
      for (const set of [i.presets ?? {}, i.postsets ?? {}])
        for (const slot of Object.values(set))
          if (slot.host) slot.host = `${model}@${nodeHost}`;
      if (i.action?.type === 'agent') i.action.modelId = model;
      await callTool('SET_INSCRIPTION', { transitionId: i.id, inscription: i, model });
      if (i.kind !== 'link') started.push(i.id);
    }
    log(`  inscriptions from ${f}`);
  }

  const seedsDir = join(dir, 'seeds');
  if (existsSync(seedsDir)) {
    for (const f of readdirSync(seedsDir).filter((f) => f.endsWith('.json') && f.startsWith('p-'))) {
      const place = remap(basename(f, '.json'), ids, suffix);
      // Never blind-reseed (CONTRACT C4): a reinstall/upgrade must not duplicate config tokens.
      const existing = await callTool('query_tokens', { model, place, arcql: 'FROM $ LIMIT 1' }).catch(() => null);
      if (existing?.results?.length) { log(`  ${place} already seeded — skipping`); continue; }
      const tokens = JSON.parse(readFileSync(join(seedsDir, f), 'utf8'));
      await callTool('add_tokens', { model, place, tokens });
      log(`  seeded ${place} (${tokens.length})`);
    }
  }

  const manifestPath = join(dir, 'manifest.runtime.json');
  if (existsSync(manifestPath)) {
    const manifest = remap(JSON.parse(readFileSync(manifestPath, 'utf8')), ids, suffix);
    manifest.sessionId = session;
    if (a.name) { manifest.name = a.name; manifest.displayName = a.name; }
    delete manifest.armed; delete manifest.transitions; delete manifest.configReady;
    // The leaf survives uninstall — replace, don't blind-create (422 on an existing child).
    await callTool('DELETE_TOKEN', {
      placePath: `root/workspace/sessions/${session}`,
      tokenName: 'agent-manifest',
      model,
    }).catch(() => {});
    // Live shape: the leaf stores the manifest as a JSON STRING under `value`.
    await callTool('CREATE_TOKEN', {
      placePath: `root/workspace/sessions/${session}`,
      name: 'agent-manifest',
      data: { value: JSON.stringify(manifest) },
      model,
    });
    log('  agent-manifest written');
  }

  await callTool('TAG_SESSION', { sessionId: session, tags: ['agents', 'capability-pack'], mode: 'add', model });

  for (const t of started) await callTool('START_TRANSITION', { transitionId: t, model });
  log(`  started ${started.length} transitions`);
  log('install complete');
}

// ---------------------------------------------------------------- verify
async function cmdVerify(a) {
  const { dir, model } = a;
  const suffix = a.suffix ?? '';
  const ids = suffix ? packIds(dir) : new Set();
  const spec = JSON.parse(readFileSync(join(dir, 'verify', 'smoke.json'), 'utf8'));
  const runId = `smoke-${Date.now().toString(36)}`;
  const vars = spec.vars ?? {};
  const sub = (s, caseId) =>
    String(s).replaceAll('${caseId}', caseId).replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`);
  const subDeep = (v, caseId) =>
    JSON.parse(JSON.stringify(v).replace(/\$\{caseId\}/g, caseId).replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`));
  const mapPlace = (p) => (ids.has(p) ? `${p}${suffix}` : p);

  let failures = 0;
  for (const [idx, c] of (spec.cases ?? []).entries()) {
    const caseId = `${runId}-${idx + 1}`;
    process.stdout.write(`case ${c.name} ... `);
    try {
      if (c.seed) {
        await callTool('add_tokens', {
          model: sub(c.seed.model ?? model, caseId),
          place: mapPlace(sub(c.seed.place, caseId)),
          tokens: subDeep(c.seed.tokens, caseId),
        });
      }
      await callTool('add_tokens', {
        model,
        place: mapPlace(sub(c.inject.place, caseId)),
        tokens: [subDeep(c.inject.token, caseId)],
      });
      const awaitPlace = mapPlace(sub(c.await.place, caseId));
      const deadline = Date.now() + (c.timeoutSec ?? 120) * 1000;
      let found = null;
      while (Date.now() < deadline && !found) {
        await new Promise((r) => setTimeout(r, 3000));
        const q = await callTool('query_tokens', {
          model,
          place: awaitPlace,
          arcql: `FROM $ WHERE $.requestId=="${caseId}" LIMIT 5`,
          maxValueLength: 5000,
        });
        found = (q.results ?? [])[0]?.data ?? null;
      }
      if (!found) throw new Error(`timeout awaiting ${awaitPlace}`);
      // "*" asserts presence (non-empty) without pinning the value — for counts on
      // shared places that accumulate across runs, and for sampled content.
      const mismatches = Object.entries(c.expect ?? {}).filter(([k, v]) =>
        v === '*' ? found[k] == null || String(found[k]) === '' : String(found[k]) !== String(v),
      );
      if (mismatches.length) {
        throw new Error(
          'expect mismatch: ' + mismatches.map(([k, v]) => `${k}=${JSON.stringify(found[k])} (wanted ${JSON.stringify(v)})`).join(', '),
        );
      }
      console.log('PASS');
    } catch (e) {
      failures++;
      console.log(`FAIL — ${e.message.slice(0, 300)}`);
    }
  }
  console.log(failures === 0 ? `\nsmoke: ALL ${spec.cases.length} PASS` : `\nsmoke: ${failures}/${spec.cases.length} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- main
const a = parseArgs(process.argv.slice(2));
const cmd = a._[0];
const needsSession = ['export', 'install', 'uninstall'].includes(cmd);
if (!a.dir || (cmd !== 'build' && !a.model) || (needsSession && !a.session)) {
  console.error('usage: pack.mjs build|export|install|uninstall|verify --dir <packDir> [--model <model>] [--session <id>] [--suffix <sfx>] [--name <pack-name>] [--node-host <host:port>]');
  process.exit(2);
}
({ build: cmdBuild, export: cmdExport, install: cmdInstall, uninstall: cmdUninstall, verify: cmdVerify }[cmd] ?? (() => { console.error(`unknown command ${cmd}`); process.exit(2); }))(a)
  .catch((e) => { console.error('[pack] FATAL:', e.message); process.exit(1); });
