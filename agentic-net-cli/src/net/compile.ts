/**
 * Compact net source -> full compiled net (PNML JSON + runtime inscriptions).
 *
 * The compact source is what a human (or an agent) actually authors: transitions with
 * alias->place reads/writes, templates, prompts. Everything mechanical is DERIVED here:
 * arcs (one per read/write), a deterministic serpentine layout, preset/postset
 * boilerplate (`FROM $ LIMIT 1`, `take FIRST`, `consume true`, hosts), default emits
 * (map: one per write alias; http: raw/err success-error pair), mode, metadata.
 *
 * Shared by: the MCP server's `install_net` tool (inline sources over the wire),
 * the capabilities repo tooling, and a future `agenticos net install` CLI command.
 * Pure function - no filesystem, no network; charters are passed as strings.
 *
 * Contract reference: agentic-nets/capabilities/CONTRACT.md section B1a. The output
 * shape was proven by rebuilding a live-verified pack and getting deep-equal
 * inscriptions (place-inspector, 2026-08-29).
 */

export interface CompactRead {
  place: string;
  arcql?: string;
  take?: string;
  consume?: boolean;
  optional?: boolean;
  ttl?: number;
}

export interface CompactWrite {
  place: string;
  capacity?: number;
}

export interface CompactTransition {
  id: string;
  kind: 'map' | 'http' | 'agent';
  label: string;
  description?: string;
  reads?: Record<string, string | CompactRead>;
  writes?: Record<string, string | CompactWrite>;
  /** map: the template object (interpolation reference: agenticnets://docs/interpolation) */
  template?: Record<string, unknown>;
  /** http: method/url/timeoutMs; `${master}` in the url is substituted at compile time */
  http?: { method?: string; url: string; timeoutMs?: number };
  /** agent: decision-only persona step; prompt via `nl` inline or `charter` key into charters */
  agent?: {
    role?: string;
    tier?: string;
    maxIterations?: number;
    requireWritesTo?: string[];
    nl?: string;
    charter?: string;
  };
  /** emit overrides; `from` defaults to @response. Omit for kind defaults. */
  emit?: Array<{ to: string; from?: string; when?: string }>;
}

export interface CompactNetSource {
  net: string;
  description?: string;
  /** session the inscriptions' metadata points at (default `agent-<net>`) */
  session?: string;
  /** model baked into hosts + agent modelId (installers re-normalize to the target) */
  model?: string;
  nodeHost?: string;
  master?: string;
  /** optional labels for auto-collected places: id -> label or {label} */
  places?: Record<string, string | { label?: string }>;
  transitions: CompactTransition[];
}

export interface CompiledNet {
  net: {
    id: string;
    description: string;
    places: Record<string, { id: string; label: string; x: number; y: number; tokens: 0 }>;
    transitions: Record<string, { id: string; label: string; x: number; y: number }>;
    arcs: Record<string, { id: string; source: string; target: string; weight: 1 }>;
  };
  inscriptions: Array<Record<string, unknown>>;
}

export interface CompileOptions {
  /** charter-name -> markdown content, resolving CompactTransition.agent.charter */
  charters?: Record<string, string>;
  /** override the source's session (metadata + agent action.sessionId) */
  session?: string;
}

const norm = <T extends { place: string }>(v: string | T): T =>
  (typeof v === 'string' ? ({ place: v } as T) : v);

export function compileNet(src: CompactNetSource, opts: CompileOptions = {}): CompiledNet {
  const netId = src.net;
  if (!netId) throw new Error('compact source needs a "net" id');
  const model = src.model ?? 'default';
  const host = `${model}@${src.nodeHost ?? 'agentic-net-node:8080'}`;
  const master = src.master ?? 'http://agentic-net-master:8082';
  const session = opts.session ?? src.session ?? `agent-${netId}`;
  const placeMeta = src.places ?? {};

  const placeOrder: string[] = [];
  const notePlace = (id: string) => {
    if (!placeOrder.includes(id)) placeOrder.push(id);
  };

  const arcs: CompiledNet['net']['arcs'] = {};
  let arcN = 0;
  const arc = (source: string, target: string) => {
    const id = `a-${netId}-${String(++arcN).padStart(2, '0')}`;
    arcs[id] = { id, source, target, weight: 1 };
  };

  const inscriptions = (src.transitions ?? []).map((t) => {
    const presets: Record<string, unknown> = {};
    const postsets: Record<string, unknown> = {};
    for (const [alias, rv] of Object.entries(t.reads ?? {})) {
      const r = norm<CompactRead>(rv);
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
      const w = norm<CompactWrite>(wv);
      notePlace(w.place);
      arc(t.id, w.place);
      postsets[alias] = { placeId: w.place, host, ...(w.capacity ? { capacity: w.capacity } : {}) };
    }

    let action: Record<string, unknown>;
    let emit = t.emit?.map((e) => ({ from: '@response', ...e }));
    if (t.kind === 'map') {
      if (!t.template) throw new Error(`${t.id}: kind map needs a template`);
      action = { type: 'map', template: t.template };
      emit ??= Object.keys(postsets).map((a) => ({ to: a, from: '@response' }));
    } else if (t.kind === 'http') {
      if (!t.http?.url) throw new Error(`${t.id}: kind http needs http.url`);
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
      const nl = ag.charter ? opts.charters?.[ag.charter]?.replace(/\n$/, '') : ag.nl;
      if (!nl) {
        throw new Error(
          `${t.id}: agent needs a prompt — either agent.nl inline or agent.charter resolving into the provided charters map`,
        );
      }
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
      throw new Error(`${t.id}: unsupported kind '${(t as any).kind}' (map|http|agent)`);
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

  // Deterministic serpentine layout: declaration order, 6 per row.
  const placed = new Map<string, { x: number; y: number }>();
  let slot = 0;
  const COLS = 6,
    DX = 220,
    DY = 170;
  const put = (id: string) => {
    if (placed.has(id)) return;
    const row = Math.floor(slot / COLS);
    const colRaw = slot % COLS;
    const col = row % 2 === 0 ? colRaw : COLS - 1 - colRaw;
    placed.set(id, { x: 100 + col * DX, y: 100 + row * DY });
    slot++;
  };
  for (const t of src.transitions ?? []) {
    for (const rv of Object.values(t.reads ?? {})) put(norm<CompactRead>(rv).place);
    put(t.id);
    for (const wv of Object.values(t.writes ?? {})) put(norm<CompactWrite>(wv).place);
  }

  const places: CompiledNet['net']['places'] = {};
  for (const id of placeOrder) {
    const meta = typeof placeMeta[id] === 'string' ? { label: placeMeta[id] as string } : (placeMeta[id] as { label?: string } | undefined) ?? {};
    places[id] = { id, label: meta.label ?? id, ...placed.get(id)!, tokens: 0 };
  }
  const transitions: CompiledNet['net']['transitions'] = {};
  for (const t of src.transitions ?? []) {
    transitions[t.id] = { id: t.id, label: t.label, ...placed.get(t.id)! };
  }

  return {
    net: { id: netId, description: src.description ?? '', places, transitions, arcs },
    inscriptions,
  };
}
