import type { NodeApi } from '../gateway/node-api.js';
import type { AgentTool } from './tools.js';
import { CATALOG_CONSTANTS } from './capabilities.js';
import { PLACE_PARAMS, LINK_PARAMS, canonicalPlaceId, targetKindIfKnown } from './tool-targets.js';

export interface ExecutionFrame {
  modelId: string;
  sessionId: string;
  transitionId: string;
  netId?: string;
  agentInstanceId: string;
  taskId?: string;
  correlationId?: string;
  capabilityProfile: string;
}

export interface ContextStoreSlice {
  role: string;
  placeId: string;
  query: string;
  items: unknown[];
  truncated: boolean;
}

export interface ContextSlice {
  name: string;
  version?: string;
  scope: string;
  access: string;
  sessionId: string;
  stores: ContextStoreSlice[];
}

export interface ContextCapsule {
  executionFrame: ExecutionFrame;
  contexts: ContextSlice[];
  budget: { maxChars: number; usedChars: number; truncated: boolean };
  warnings: string[];
  protectedPlaceIds: string[];
}

interface Requirement {
  name: string;
  version?: string;
  scope?: string;
  access: string;
  required: boolean;
  stores?: string[];
  query?: string;
  maxItems?: number;
}

interface InstalledContext {
  sessionId: string;
  manifest: any;
  version?: string;
  scopeOwnerId?: string;
}

interface ContextSelection { match: InstalledContext; requirement: Requirement }

// Shared with the master resolver through the synced capability catalog.
const BUDGET = CATALOG_CONSTANTS.contextBudget;
const HIERARCHY = CATALOG_CONSTANTS.hierarchy;
const SCOPE_RANK: string[] = CATALOG_CONSTANTS.scopeRank;

/** Resolve the same bounded installed-context contract used by master-side agent fires. */
export async function resolveContextCapsule(
  nodeApi: NodeApi,
  frame: ExecutionFrame,
  action: Record<string, any>,
): Promise<ContextCapsule> {
  const effectiveFrame = await resolveOwningAgentFrame(nodeApi, frame);
  const warnings: string[] = [];
  const explicit = Array.isArray(action.contextBindings) ? action.contextBindings as Requirement[] : [];
  const agentManifest = await readLeafJson(nodeApi, effectiveFrame.modelId,
    effectiveFrame.sessionId, 'agent-manifest');
  const declared = Array.isArray(agentManifest?.contexts) ? agentManifest.contexts as Requirement[] : [];
  const requirements = mergeRequirements(declared, explicit);
  const installed = await listInstalledContexts(nodeApi, effectiveFrame.modelId);
  const protectedPlaceIds = [...new Set(installed.flatMap(item => item.manifest.stores || [])
    .map((store: any) => normalizePlace(store.placeId)).filter(Boolean))] as string[];

  const maxChars = clamp(Number(action.contextBudget?.maxChars
    || action.maxContextTokens * BUDGET.charsPerToken)
    || BUDGET.defaultMaxChars, BUDGET.minChars, BUDGET.maxChars);
  const maxItemsPerStore = clamp(Number(action.contextBudget?.maxItemsPerStore
    || BUDGET.defaultMaxItemsPerStore), BUDGET.minItemsPerStore, BUDGET.maxItemsPerStore);
  const maxValueLength = clamp(Number(action.contextBudget?.maxValueLength
    || BUDGET.defaultMaxValueLength), BUDGET.minValueLength, BUDGET.maxValueLength);
  let usedChars = 0;
  let truncated = false;
  const contexts: ContextSlice[] = [];
  const selections: ContextSelection[] = [];

  for (const requirement of requirements) {
    const matches = installed
      .filter(item => requirement.name === '*' || item.manifest.name === requirement.name)
      .filter(item => scopeMatches(effectiveFrame, requirement.scope,
        item.manifest.scope, item.scopeOwnerId))
      .filter(item => versionMatches(requirement.version, item.version))
      .sort((a, b) => scopeRank(a.manifest.scope) - scopeRank(b.manifest.scope)
        || String(a.sessionId).localeCompare(String(b.sessionId)));
    if (!matches.length) {
      if (requirement.required) {
        throw new Error(`Required context '${requirement.name}' version=${requirement.version || '*'} scope=${requirement.scope || 'nearest'} is not installed`);
      }
      continue;
    }
    const chosen = requirement.name === '*' ? matches : matches.slice(0, 1);
    for (const match of chosen) selections.push({ match, requirement });
  }

  const expanded = await expandHierarchy(nodeApi, effectiveFrame.modelId, installed, selections);
  for (const { match, requirement } of expanded) {
    const stores: ContextStoreSlice[] = [];
    const wanted = new Set(requirement.stores || []);
    // Distinguish read ERRORS from legitimately empty stores: a required context
    // whose every consulted store failed to read is "installed but unreadable".
    let readAttempts = 0;
    let readErrors = 0;
    for (const store of match.manifest.stores || []) {
      if (wanted.size && !wanted.has(store.role)) continue;
      const maxItems = Math.min(maxItemsPerStore,
        clamp(Number(requirement.maxItems || BUDGET.defaultMaxItemsPerStore),
          BUDGET.minItemsPerStore, BUDGET.maxItemsPerStore));
      const query = boundedQuery(requirement.query, maxItems);
      let items: unknown[] = [];
      let storeTruncated = false;
      readAttempts++;
      try {
        const result = await nodeApi.queryTokens(effectiveFrame.modelId,
          `root/workspace/places/${store.placeId}`, query, 'json_with_meta', { maxValueLength });
        const candidates = Array.isArray(result?.results) ? result.results.slice(0, maxItems) : [];
        for (const item of candidates) {
          const cost = JSON.stringify(item).length;
          if (usedChars + cost > maxChars) {
            storeTruncated = true;
            truncated = true;
            break;
          }
          items.push(item);
          usedChars += cost;
        }
      } catch (err: any) {
        readErrors++;
        warnings.push(`Could not read context store ${store.placeId}: ${err.message || err}`);
      }
      stores.push({ role: store.role, placeId: store.placeId, query, items, truncated: storeTruncated });
    }
    if (requirement.required && readAttempts > 0 && readErrors === readAttempts) {
      throw new Error(`Required context '${match.manifest.name}' is installed but unreadable: `
        + `all ${readAttempts} consulted stores failed to read`);
    }
    contexts.push({
      name: match.manifest.name,
      version: match.version,
      scope: match.manifest.scope || 'model',
      access: requirement.access || 'read',
      sessionId: match.sessionId,
      stores,
    });
  }

  return { executionFrame: effectiveFrame, contexts,
    budget: { maxChars, usedChars, truncated }, warnings, protectedPlaceIds };
}

async function resolveOwningAgentFrame(nodeApi: NodeApi,
  frame: ExecutionFrame): Promise<ExecutionFrame> {
  const owns = (manifest: any) => Array.isArray(manifest?.startPlan)
    && manifest.startPlan.includes(frame.transitionId)
    || Array.isArray(manifest?.personas)
    && manifest.personas.some((persona: any) => persona?.transitionId === frame.transitionId);
  const current = await readLeafJson(nodeApi, frame.modelId, frame.sessionId, 'agent-manifest');
  if (owns(current)) return frame;
  let sessions: any[] = [];
  try { sessions = await nodeApi.getChildren(frame.modelId, 'root/workspace/sessions'); } catch { return frame; }
  for (const session of sessions.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const manifest = await readLeafJson(nodeApi, frame.modelId, session.name, 'agent-manifest');
    if (owns(manifest)) return { ...frame, sessionId: session.name,
      agentInstanceId: frame.agentInstanceId === frame.sessionId ? session.name : frame.agentInstanceId };
  }
  return frame;
}

export function authorizeContextPlace(
  capsule: ContextCapsule,
  tool: AgentTool,
  params: Record<string, any>,
): string | undefined {
  // Dispatch on the catalog classification (twin of ContextCapsule.authorizePlace);
  // structural tools without a determinable place target are the capability policy's
  // concern, ordinary workflow places stay governed by resourceScopes.
  const kind = targetKindIfKnown(tool);
  if (kind === 'contextSession') {
    return authorizeContextSession(capsule, params?.sessionId, true);
  }
  if (kind === 'link') {
    if (params?.sessionId) {
      const sessionDenial = authorizeContextSession(capsule, params.sessionId, true);
      if (sessionDenial) return sessionDenial;
    }
    for (const key of LINK_PARAMS) {
      const denial = authorizeOneContextPlace(capsule, params?.[key], true);
      if (denial) return denial;
    }
    return undefined;
  }
  if (kind !== 'read' && kind !== 'write') return undefined;
  for (const key of PLACE_PARAMS) {
    const value = params?.[key];
    if (typeof value === 'string' && value.trim()) {
      return authorizeOneContextPlace(capsule, value, kind === 'write');
    }
  }
  return authorizeOneContextPlace(capsule, undefined, kind === 'write');
}

function authorizeOneContextPlace(capsule: ContextCapsule, rawPlace: unknown,
  write: boolean): string | undefined {
  const place = normalizePlace(rawPlace);
  if (!place || !capsule.protectedPlaceIds.includes(place)) return undefined;
  const bound = capsule.contexts.filter(context => context.stores
    .some(store => normalizePlace(store.placeId) === place));
  if (!bound.length) return `context place '${place}' is protected but not bound to this execution frame`;
  if (write && !bound.some(context => context.access === 'write' || context.access === 'read-write')) {
    return `context place '${place}' is bound read-only`;
  }
  return undefined;
}

function authorizeContextSession(capsule: ContextCapsule, rawSession: unknown,
  write: boolean): string | undefined {
  const sessionId = typeof rawSession === 'string' ? rawSession.trim() : '';
  if (!sessionId) return 'context sessionId is required by this execution frame';
  const bound = capsule.contexts.filter(context => context.sessionId === sessionId);
  if (!bound.length) return `context session '${sessionId}' is not bound to this execution frame`;
  if (write && !bound.some(context => context.access === 'write' || context.access === 'read-write')) {
    return `context session '${sessionId}' was bound read-only`;
  }
  return undefined;
}

async function listInstalledContexts(nodeApi: NodeApi, modelId: string): Promise<InstalledContext[]> {
  let sessions: any[] = [];
  try { sessions = await nodeApi.getChildren(modelId, 'root/workspace/sessions'); } catch { return []; }
  const results: any[] = [];
  for (const session of sessions) {
    const manifest = await readLeafJson(nodeApi, modelId, session.name, 'context-manifest');
    if (!manifest) continue;
    const origin = await readLeafJson(nodeApi, modelId, session.name, 'context-origin');
    // Legacy agent-authored contexts carry the literal 'authored'; new stamps are semver.
    const version = origin?.version === 'authored' ? '1.0.0' : origin?.version;
    results.push({ sessionId: session.name, manifest, version,
      scopeOwnerId: origin?.scopeOwnerId });
  }
  return results;
}

async function expandHierarchy(nodeApi: NodeApi, modelId: string,
  installed: InstalledContext[], selected: ContextSelection[]): Promise<ContextSelection[]> {
  if (!selected.length) return selected;
  const edges = await scanHierarchyEdges(nodeApi, modelId);
  const bySession = new Map(installed.map(item => [item.sessionId, item]));
  const sessionByPlace = new Map<string, string>();
  for (const item of installed) {
    for (const store of item.manifest.stores || []) {
      const place = normalizePlace(store.placeId);
      if (place) sessionByPlace.set(place, item.sessionId);
    }
  }
  const result: ContextSelection[] = [];
  const emitted = new Set<string>();
  const add = (items: ContextSelection[]) => {
    for (const item of items) {
      if (!emitted.has(item.match.sessionId)) {
        emitted.add(item.match.sessionId);
        result.push(item);
        continue;
      }
      if (item.requirement.access === 'write' || item.requirement.access === 'read-write') {
        const index = result.findIndex(existing => existing.match.sessionId === item.match.sessionId);
        if (index >= 0 && result[index].requirement.access !== 'write'
          && result[index].requirement.access !== 'read-write') result[index] = item;
      }
    }
  };
  for (const local of selected) {
    const hierarchy = local.match.manifest.hierarchy || {};
    const readPolicy = hierarchy.readPolicy || 'local-first';
    const resolution = hierarchy.resolution || 'nearest';
    const parents = readPolicy === 'local-only' || resolution === 'explicit' ? []
      : ancestorSelections(local, bySession, sessionByPlace, edges,
        resolution === 'merge' ? HIERARCHY.mergeDepth : HIERARCHY.nearestDepth);
    if (readPolicy === 'parent-first') add([...parents].reverse());
    add([local]);
    if (readPolicy !== 'parent-first') add(parents);
  }
  return result;
}

interface HierarchyEdge { from: string; to: string; directionality: string; transitionId: string }

function ancestorSelections(local: ContextSelection,
  bySession: Map<string, InstalledContext>, sessionByPlace: Map<string, string>,
  edges: HierarchyEdge[], maxDepth: number): ContextSelection[] {
  const result: ContextSelection[] = [];
  let frontier = [local];
  const seen = new Set([local.match.sessionId]);
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: ContextSelection[] = [];
    for (const child of frontier) {
      const hierarchy = child.match.manifest.hierarchy || {};
      if (hierarchy.readPolicy === 'local-only' || hierarchy.resolution === 'explicit') continue;
      const childPlaces = new Set((child.match.manifest.stores || [])
        .map((store: any) => normalizePlace(store.placeId)).filter(Boolean));
      for (const edge of edges) {
        let parentPlace: string | undefined;
        if (edge.directionality === 'child-to-parent' && childPlaces.has(edge.from)) parentPlace = edge.to;
        else if (edge.directionality === 'parent-to-child' && childPlaces.has(edge.to)) parentPlace = edge.from;
        const parentSession = parentPlace ? sessionByPlace.get(parentPlace) : undefined;
        const parent = parentSession ? bySession.get(parentSession) : undefined;
        if (!parent || seen.has(parent.sessionId)) continue;
        seen.add(parent.sessionId);
        const inherited: ContextSelection = {
          match: parent,
          requirement: { ...child.requirement, name: parent.manifest.name,
            scope: parent.manifest.scope, access: 'read', required: false },
        };
        result.push(inherited);
        next.push(inherited);
      }
    }
    frontier = next;
  }
  return result;
}

async function scanHierarchyEdges(nodeApi: NodeApi, modelId: string): Promise<HierarchyEdge[]> {
  let transitions: any[] = [];
  try { transitions = await nodeApi.getChildren(modelId, 'root/workspace/transitions'); } catch { return []; }
  const edges: HierarchyEdge[] = [];
  for (const transition of transitions.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const inscription = await readJsonLeafAtPath(nodeApi, modelId,
      `root/workspace/transitions/${transition.name}`, 'inscription');
    if (!inscription || inscription.kind !== 'link') continue;
    const relation = String(inscription.relation || 'relates');
    const semantics = hierarchySemantics(relation, inscription.relationSpec);
    if (!semantics.hierarchical) continue;
    const from = firstPlaceId(inscription.presets);
    const to = firstPlaceId(inscription.postsets);
    if (from && to) edges.push({ from, to, directionality: semantics.directionality,
      transitionId: String(inscription.id || transition.name) });
  }
  return edges.sort((a, b) => a.transitionId.localeCompare(b.transitionId));
}

function hierarchySemantics(relation: string, spec: any): { hierarchical: boolean; directionality: string } {
  if (spec?.hierarchical === true) return { hierarchical: true,
    directionality: spec.directionality || 'directed' };
  const childToParent = new Set(HIERARCHY.childToParentRelations);
  const parentToChild = new Set(HIERARCHY.parentToChildRelations);
  if (childToParent.has(relation)) return { hierarchical: true, directionality: 'child-to-parent' };
  if (parentToChild.has(relation)) return { hierarchical: true, directionality: 'parent-to-child' };
  return { hierarchical: false, directionality: 'directed' };
}

function firstPlaceId(raw: any): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  for (const value of Object.values(raw) as any[]) {
    const place = normalizePlace(value?.placeId);
    if (place) return place;
  }
  return undefined;
}

async function readJsonLeafAtPath(nodeApi: NodeApi, modelId: string,
  path: string, leaf: string): Promise<any | undefined> {
  try {
    const children = await nodeApi.getChildren(modelId, path);
    const found = children.find((child: any) => child.name === leaf);
    const raw = found?.properties?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch { return undefined; }
}

async function readLeafJson(nodeApi: NodeApi, modelId: string, sessionId: string, leaf: string): Promise<any | undefined> {
  return readJsonLeafAtPath(nodeApi, modelId, `root/workspace/sessions/${sessionId}`, leaf);
}

function mergeRequirements(declared: Requirement[], explicit: Requirement[]): Requirement[] {
  const merged = new Map<string, Requirement>();
  for (const item of [...declared, ...explicit]) {
    if (item?.name) merged.set(`${item.name}|${item.scope || 'nearest'}`, {
      ...item, access: item.access || 'read', required: item.required === true,
    });
  }
  return [...merged.values()];
}

/** Exact, wildcard, caret and tilde constraints — behavior pinned by the catalog's semverCases. */
export function versionMatches(constraint?: string, actual?: string): boolean {
  if (!constraint || constraint === '*') return true;
  if (!actual) return false;
  const want = parseVersion(constraint.replace(/^[~^]/, ''));
  const have = parseVersion(actual);
  if (!want || !have) return constraint === actual;
  if (constraint.startsWith('^')) {
    if (compare(have, want) < 0) return false;
    if (want[0] > 0) return have[0] === want[0];
    if (want[1] > 0) return have[0] === 0 && have[1] === want[1];
    return have[0] === 0 && have[1] === 0 && have[2] === want[2];
  }
  if (constraint.startsWith('~')) return have[0] === want[0] && have[1] === want[1] && compare(have, want) >= 0;
  return compare(have, want) === 0;
}

function parseVersion(value: string): number[] | undefined {
  const parts = value.split(/[-+]/, 1)[0].split('.').map(Number);
  return parts.some(Number.isNaN) ? undefined : [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function scopeRank(scope?: string): number {
  const rank = SCOPE_RANK.indexOf(scope || '');
  return rank < 0 ? 99 : rank;
}

function scopeMatches(frame: ExecutionFrame, requested: string | undefined,
  actualValue: string | undefined, owner: string | undefined): boolean {
  const actual = actualValue || 'model';
  if (requested && requested !== 'nearest' && requested !== actual) return false;
  const expected = actual === 'task' ? frame.taskId
    : actual === 'agent' ? frame.agentInstanceId
      : actual === 'session' ? frame.sessionId
        : actual === 'model' ? frame.modelId : undefined;
  if (actual === 'model' && !owner) return true;
  return !!expected && expected === owner;
}

function boundedQuery(value: string | undefined, limit: number): string {
  const query = value?.trim() || 'FROM $';
  return /\sLIMIT\s/i.test(query) ? query : `${query} LIMIT ${limit}`;
}

function normalizePlace(value: unknown): string | undefined {
  return canonicalPlaceId(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
