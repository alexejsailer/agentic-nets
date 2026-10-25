/**
 * Model Explorer reader: the model-wide designtime catalogue master builds for the Explorer page.
 *
 * One GET, readonly-safe. It is the only MCP view of the HIERARCHY of nets: a net's depth comes
 * from subnet refinement, where a transition (or place) of a parent net is refined by a child net
 * whose port places carry the SAME ids as the parent's preset/postset places. The abstract element
 * has no inscription and never fires; the runtime stays flat. Everything here is designtime data.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { wrapTool } from '../scope.js';

const TOP_SHARED = 10;

function cataloguePath(model: string): string {
  const m = encodeURIComponent(model);
  // The model is carried twice on purpose: in the path (what the endpoint reads) and as a query
  // param (what a gateway without the /api/explorer model-path pattern needs for routing).
  return `/explorer/${m}/catalogue?modelId=${m}`;
}

function matches(net: any, query: string): boolean {
  const q = query.toLowerCase();
  const tags: unknown[] = Array.isArray(net?.tags) ? net.tags : [];
  return [net?.key, net?.title, net?.description, net?.domain, net?.responsible, ...tags]
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

/** Organization and execution fields, only when the master sends them (older masters do not). */
function organizationOf(net: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (typeof net?.domain === 'string' && net.domain) out.domain = net.domain;
  if (typeof net?.responsible === 'string' && net.responsible) out.responsible = net.responsible;
  if (Array.isArray(net?.tags) && net.tags.length) out.tags = net.tags;
  if (typeof net?.execution?.state === 'string') out.execution = net.execution.state;
  return out;
}

function organizationSuffix(net: any): string {
  const o = organizationOf(net);
  const parts: string[] = [];
  if (o.domain) parts.push(`domain ${o.domain}`);
  if (o.responsible) parts.push(`responsible ${o.responsible}`);
  if (o.tags) parts.push(`tags ${o.tags.join('/')}`);
  if (o.execution) parts.push(`execution ${o.execution}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

function degree(place: any): number {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return n(place?.drawnIn) + n(place?.readers) + n(place?.writers);
}

/** Indented hierarchy lines: roots at depth 0, each child under its parent via the refining element. */
export function hierarchyLines(catalogue: any): string[] {
  const nets: any[] = Array.isArray(catalogue?.nets) ? catalogue.nets : [];
  const byKey = new Map<string, any>(nets.map((n) => [String(n?.key ?? ''), n]));
  const edges: any[] = Array.isArray(catalogue?.hierarchy) ? catalogue.hierarchy : [];
  const parentOf = new Map<string, any>();
  for (const e of edges) {
    if (e?.childKey) parentOf.set(String(e.childKey), e);
  }
  const children = new Map<string, string[]>();
  for (const n of nets) {
    const key = String(n?.key ?? '');
    const edge = parentOf.get(key);
    const parentKey = edge?.parent?.sessionId && edge?.parent?.netId
      ? `${edge.parent.sessionId}::${edge.parent.netId}`
      : typeof edge?.parent === 'string' ? edge.parent : null;
    const bucket = parentKey && byKey.has(parentKey) ? parentKey : '';
    if (!children.has(bucket)) children.set(bucket, []);
    children.get(bucket)!.push(key);
  }
  const out: string[] = [];
  const visit = (key: string, depth: number, seen: Set<string>) => {
    if (seen.has(key)) return;
    seen.add(key);
    const net = byKey.get(key);
    const edge = parentOf.get(key);
    const via = edge?.elementId ? `, via ${edge.elementId}` : '';
    const verified = edge?.verified ? `, ${edge.verified}` : '';
    const status = net?.definitionStatus && net.definitionStatus !== 'realized'
      ? `, definition ${net.definitionStatus}` : '';
    out.push(`${'  '.repeat(depth)}${key} (depth ${net?.depth ?? depth}${via}${verified}${status}${organizationSuffix(net)})`);
    for (const child of children.get(key) ?? []) visit(child, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const root of children.get('') ?? []) visit(root, 0, seen);
  // Nets whose parent is unknown to the catalogue still get listed, never silently dropped.
  for (const n of nets) visit(String(n?.key ?? ''), 0, seen);
  return out;
}

/** `fromKey relation toKey` per explicit relation, "(missing)" when the target net is gone. */
export function relationLines(catalogue: any, keys?: Set<string>): string[] {
  const all: any[] = Array.isArray(catalogue?.relations) ? catalogue.relations : [];
  return all
    .filter((r) => typeof r?.fromKey === 'string' && typeof r?.relation === 'string')
    .filter((r) => !keys || keys.has(r.fromKey) || keys.has(String(r?.toKey ?? '')))
    .map((r) => `${r.fromKey} ${r.relation} ${r?.toKey ?? '?'}${r?.resolved === false ? ' (missing)' : ''}`);
}

export function summarize(catalogue: any, query?: string): any {
  const allNets: any[] = Array.isArray(catalogue?.nets) ? catalogue.nets : [];
  const nets = query ? allNets.filter((n) => matches(n, query)) : allNets;
  const places: any[] = Array.isArray(catalogue?.places) ? catalogue.places : [];
  const topSharedPlaces = places
    .filter((p) => p?.shared === true || (Array.isArray(p?.drawnIn) && p.drawnIn.length > 1))
    .sort((a, b) => degree(b) - degree(a))
    .slice(0, TOP_SHARED)
    .map((p) => ({
      placeId: p?.ref?.placeId ?? p?.placeId,
      label: p?.label,
      drawnIn: Array.isArray(p?.drawnIn) ? p.drawnIn.length : 0,
      readers: Array.isArray(p?.readers) ? p.readers.length : 0,
      writers: Array.isArray(p?.writers) ? p.writers.length : 0,
    }));
  return {
    modelId: catalogue?.modelId,
    stats: catalogue?.stats ?? {},
    levels: Array.isArray(catalogue?.levels) ? catalogue.levels : [],
    hierarchy: hierarchyLines(query ? { ...catalogue, nets } : catalogue),
    // Explicit relations (explains, depends-on, references); older masters send none.
    ...(Array.isArray(catalogue?.relations)
      ? { relations: relationLines(catalogue, query ? new Set(nets.map((n) => String(n?.key ?? ''))) : undefined) }
      : {}),
    nets: nets.map((n) => ({
      key: n?.key,
      title: n?.title,
      depth: n?.depth,
      placeCount: n?.placeCount,
      transitionCount: n?.transitionCount,
      inscribedTransitionCount: n?.inscribedTransitionCount,
      definitionStatus: n?.definitionStatus,
      ...organizationOf(n),
    })),
    ...(query ? { query, matched: nets.length, total: allNets.length } : {}),
    topSharedPlaces,
    warnings: Array.isArray(catalogue?.warnings) ? catalogue.warnings : [],
  };
}

export function registerExplorerReaders(server: McpServer, ctx: AppContext): void {
  const { scope, config } = ctx;
  const modelParam: Record<string, z.ZodTypeAny> = scope.multiModel
    ? { model: z.string().optional().describe(`Target model. One of: ${scope.allowed.join(', ')} (default ${scope.defaultModel})`) }
    : {};

  server.registerTool(
    'explore_model',
    {
      title: 'Explore a model as a hierarchy of nets',
      description:
        'Model-wide designtime catalogue: every net across every session with its qualified identity `session::netId` (two sessions may each own a net called main; the key tells them apart), its depth in the abstraction hierarchy, its interface (input/output/internal places), shared places with inscription-derived readers and writers, and natural-language definitions that have no topology yet. '
        + 'Depth comes from subnet refinement: a transition (or place) of a parent net is refined by a child net whose port places carry the SAME ids as the parent\'s preset/postset places, so the runtime stays flat and the abstract element never fires (it carries no inscription). '
        + 'Nets carry organization (domain, responsible, tags; set with update_net_definition action:"organize") and an execution state read from the existing transition statuses (none, running, partial, stopped, error). '
        + 'Explicit relations between nets (explains, depends-on, references; set with action:"relate") appear as lines "from relation to", marked (missing) when the target is gone. '
        + 'detail:"summary" (default) returns counts, levels, the hierarchy as indented lines, a compact net list and the most shared places; detail:"full" returns the whole document. query filters nets by key, title, description, domain, responsible or tags. Read-only; nothing here touches runtime state.',
      inputSchema: {
        detail: z.enum(['summary', 'full']).default('summary'),
        query: z.string().optional().describe('Substring filter on net key, title, description, domain, responsible or tags'),
        ...modelParam,
      },
    },
    wrapTool(scope, config.mode, { name: 'explore_model', mutates: false }, async (model, args) => {
      let catalogue: any;
      try {
        catalogue = await ctx.master.get(cataloguePath(model));
      } catch (err: any) {
        if (err?.status === 404) {
          return {
            available: false,
            model,
            hint: 'master without /api/explorer: this master predates the Model Explorer read model; upgrade master or use net_overview per net',
          };
        }
        throw err;
      }
      if (args.detail === 'full') {
        if (!args.query) return catalogue;
        const nets = (Array.isArray(catalogue?.nets) ? catalogue.nets : []).filter((n: any) => matches(n, args.query!));
        return { ...catalogue, nets, query: args.query, matched: nets.length };
      }
      return summarize(catalogue, args.query);
    }),
  );
}
