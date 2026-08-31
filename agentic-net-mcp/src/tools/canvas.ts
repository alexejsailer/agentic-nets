/**
 * Canvas-vs-runtime classification, shared by sync_net and the net_overview drift notice.
 *
 * Shared-place partitioning means one big runtime can be drawn across several small
 * designtime nets: the runtime is model-wide, the nets are views a human reads. So a shape
 * whose backing transition is HOMED in another net (inscription metadata.netId) is a view
 * element, not drift. Only a shape with no runtime anywhere in the model is stale, and only
 * a transition homed HERE but not drawn counts as runtimeWithoutShape.
 */

/** transitionId -> home netId (inscription metadata.netId), from a LIST_ALL_INSCRIPTIONS row set. */
export function runtimeHomeMap(rows: any[]): Map<string, string | null> {
  const home = new Map<string, string | null>();
  for (const r of rows ?? []) {
    const id = r?.transitionId ?? r?.id;
    if (!id) continue;
    let ins = r?.inscription;
    if (typeof ins === 'string') { try { ins = JSON.parse(ins); } catch { ins = null; } }
    home.set(String(id), ins?.metadata?.netId ?? null);
  }
  return home;
}

export function classifyCanvas(
  shapeIds: string[],
  runtimeHome: Map<string, string | null>,
  netId: string,
): {
  staleShapes: string[];
  viewShapes: Record<string, string>;
  viewOf: string[];
  netRole: 'empty' | 'canonical' | 'view' | 'hybrid';
  undrawn: string[];
} {
  const staleShapes = shapeIds.filter((t) => !runtimeHome.has(t));
  const viewShapes: Record<string, string> = {};
  let owned = 0;
  for (const t of shapeIds) {
    const home = runtimeHome.get(t);
    if (home === undefined) continue; // stale, counted above
    if (home && home !== netId) viewShapes[t] = home;
    else owned++;
  }
  const viewOf = [...new Set(Object.values(viewShapes))];
  const drawn = new Set(shapeIds);
  const undrawn = [...runtimeHome.entries()]
    .filter(([id, home]) => home === netId && !drawn.has(id))
    .map(([id]) => id);
  const netRole = shapeIds.length === 0
    ? 'empty' as const
    : viewOf.length === 0
      ? 'canonical' as const
      : owned === 0 && staleShapes.length === 0 ? 'view' as const : 'hybrid' as const;
  return { staleShapes, viewShapes, viewOf, netRole, undrawn };
}
