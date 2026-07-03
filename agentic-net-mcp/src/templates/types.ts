/**
 * Template blueprints — host- and model-agnostic JSON descriptions of a
 * deployable net. The executor injects `host` into presets/postsets, applies
 * `${param}` substitution, and runs the proven deploy flow.
 */
export interface BlueprintPlace {
  placeId: string;
  label: string;
  x: number;
  y: number;
}

export interface BlueprintTransition {
  transitionId: string;
  label: string;
  x: number;
  y: number;
  /** 'agentic-net-master' | 'agentic-net-executor-default' */
  agentId: string;
  /** Link transitions MUST be false (they never fire); scheduled ones MUST be true. */
  start: boolean;
  inscription: Record<string, any>;
}

export interface BlueprintArc {
  arcId: string;
  sourceId: string;
  targetId: string;
}

export interface TemplateBlueprint {
  id: string;
  name: string;
  description: string;
  version: string;
  params?: Record<string, { description: string; default?: string }>;
  net: { netId: string; name: string };
  places: BlueprintPlace[];
  transitions: BlueprintTransition[];
  arcs: BlueprintArc[];
  seedTokens?: Array<{ placeId: string; name?: string; data: Record<string, any> }>;
  tags?: string[];
}

export class BlueprintError extends Error {}

const CRON_FIELDS = 6;

/**
 * Validate a blueprint's structural invariants — including the engine gotchas
 * that only surface at runtime (empty preset arcql = 400-spam on status polls;
 * started link transitions; unstarted schedules that never tick).
 */
export function validateBlueprint(bp: TemplateBlueprint): void {
  const fail = (msg: string) => {
    throw new BlueprintError(`[${bp.id ?? '?'}] ${msg}`);
  };
  if (!bp.id || !bp.net?.netId) fail('id and net.netId are required');

  const placeIds = new Set<string>();
  for (const p of bp.places ?? []) {
    if (placeIds.has(p.placeId)) fail(`duplicate placeId ${p.placeId}`);
    placeIds.add(p.placeId);
  }
  const transitionIds = new Set<string>();
  for (const t of bp.transitions ?? []) {
    if (transitionIds.has(t.transitionId)) fail(`duplicate transitionId ${t.transitionId}`);
    transitionIds.add(t.transitionId);
    const ins = t.inscription ?? {};
    if (ins.id && ins.id !== t.transitionId) fail(`${t.transitionId}: inscription.id mismatch`);

    for (const [key, pre] of Object.entries<any>(ins.presets ?? {})) {
      if (!pre.placeId) fail(`${t.transitionId}: preset '${key}' missing placeId`);
      if (!pre.arcql || !String(pre.arcql).trim()) {
        fail(`${t.transitionId}: preset '${key}' has empty arcql (would 400-spam execution-status polls)`);
      }
    }
    for (const [key, post] of Object.entries<any>(ins.postsets ?? {})) {
      if (!post.placeId) fail(`${t.transitionId}: postset '${key}' missing placeId`);
    }

    if (ins.kind === 'link') {
      if (t.start) fail(`${t.transitionId}: kind:link must have start:false (links never fire)`);
      if (ins.action) fail(`${t.transitionId}: kind:link must not carry an action`);
    } else {
      if (!ins.action) fail(`${t.transitionId}: non-link inscription needs an action`);
      if (!Array.isArray(ins.emit) || ins.emit.length === 0) fail(`${t.transitionId}: needs at least one emit rule`);
      if (!ins.mode) fail(`${t.transitionId}: needs mode (SINGLE/FOREACH)`);
    }

    const cron = ins.schedule?.cron;
    // Unresolved ${param} placeholders are validated again post-substitution at deploy time.
    if (cron && !/\$\{[^}]+\}/.test(String(cron)) && String(cron).trim().split(/\s+/).length !== CRON_FIELDS) {
      fail(`${t.transitionId}: schedule.cron must have ${CRON_FIELDS} fields, got '${cron}'`);
    }
    if ((ins.schedule?.cron || ins.schedule?.intervalMs) && !t.start && ins.kind !== 'link') {
      fail(`${t.transitionId}: scheduled transitions must have start:true or they never tick`);
    }
  }

  for (const a of bp.arcs ?? []) {
    const known = (id: string) => placeIds.has(id) || transitionIds.has(id);
    if (!known(a.sourceId)) fail(`arc ${a.arcId}: unknown sourceId ${a.sourceId}`);
    if (!known(a.targetId)) fail(`arc ${a.arcId}: unknown targetId ${a.targetId}`);
  }

  for (const s of bp.seedTokens ?? []) {
    if (!placeIds.has(s.placeId)) fail(`seedToken targets unknown place ${s.placeId}`);
  }
}
