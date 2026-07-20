/**
 * Node-tree helpers shared by the memory tools and the template executor:
 * idempotent container walks and link-edge discovery straight from the
 * canonical inscription leaves (version-independent — no master endpoint
 * needed to read the knowledge graph).
 */
import type { AppContext } from './context.js';

export const ROOT_ID = '00000000-0000-0000-0000-000000000001';

async function resolveId(ctx: AppContext, model: string, path: string): Promise<string | null> {
  if (path === 'root') return ROOT_ID;
  const parts = path.split('/');
  const name = parts.pop()!;
  const parentPath = parts.join('/');
  const kids = ((await ctx.node.getChildren(model, parentPath).catch(() => [])) ?? []) as any[];
  const hit = kids.find((c: any) => c.name === name);
  return hit?.id ?? null;
}

/** Ensure one child node exists under a path (list → create → done). */
export async function ensureChild(ctx: AppContext, model: string, parentPath: string, name: string): Promise<void> {
  const kids = ((await ctx.node.getChildren(model, parentPath).catch(() => [])) ?? []) as any[];
  if (kids.find((c: any) => c.name === name)) return;
  const parentId = await resolveId(ctx, model, parentPath);
  if (!parentId) throw new Error(`cannot resolve tree path '${parentPath}'`);
  await ctx.node.executeEvents(model, [{ eventType: 'createNode', parentId, name, id: 'auto' }]);
}

/** Ensure the runtime places container chain exists (virgin models have no tree). */
export async function ensurePlacesContainer(ctx: AppContext, model: string): Promise<void> {
  await ensureChild(ctx, model, 'root', 'workspace');
  await ensureChild(ctx, model, 'root/workspace', 'places');
}

export interface LinkEdge {
  from: string;
  to: string;
  label: string;
  /** Typed edge semantics (what TARGET is to SOURCE); "relates" when the link carries none. */
  relation: string;
  transitionId: string;
}

/**
 * Discover ALL link edges of a model by reading the canonical inscription
 * leaves under root/workspace/transitions — works on every engine version.
 */
export async function discoverLinkEdges(ctx: AppContext, model: string): Promise<LinkEdge[]> {
  const transitions = ((await ctx.node.getChildren(model, 'root/workspace/transitions').catch(() => [])) ?? []) as any[];
  const edges: LinkEdge[] = [];
  for (const t of transitions) {
    if (!t?.name) continue;
    const kids = ((await ctx.node
      .getChildren(model, `root/workspace/transitions/${t.name}`)
      .catch(() => [])) ?? []) as any[];
    const leaf = kids.find((c: any) => c.name === 'inscription');
    const value = leaf?.properties?.value ?? leaf?.value;
    if (!value) continue;
    try {
      const ins = JSON.parse(value);
      if (ins.kind !== 'link') continue;
      const from = Object.values<any>(ins.presets ?? {})[0]?.placeId;
      const to = Object.values<any>(ins.postsets ?? {})[0]?.placeId;
      if (from && to) {
        edges.push({
          from,
          to,
          label: ins.label ?? t.name,
          relation: typeof ins.relation === 'string' && ins.relation ? ins.relation : 'relates',
          transitionId: t.name,
        });
      }
    } catch {
      /* non-JSON inscription — skip */
    }
  }
  return edges;
}
