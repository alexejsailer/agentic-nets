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

/**
 * Elements that stand for a SUBNET, or that are marked design-only. A transition (or place) refined
 * by another net carries either
 * an inline `subnet: {net}` page or the designtime attributes `subnetSession` / `subnetNet` that
 * reference a persistent workspace net. Such an element is abstract by design: it has no
 * inscription and never fires, and the runtime stays flat because the child's port places reuse
 * the parent's place ids. It must never be mistaken for a stale shape, or sync_net would delete
 * the hierarchy as drift.
 */
export function isAbstractElement(entry: any): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.subnet && typeof entry.subnet === 'object') return true;
  // A design-only element describes structure (a level of a model, a module of code) and is never
  // meant to fire: the attribute `designOnly: "true"` says so explicitly, so a hierarchy of design
  // nets whose lowest level has no inscriptions is not drift either.
  if (entry.designOnly === true || entry.designOnly === 'true') return true;
  const session = entry.subnetSession;
  const net = entry.subnetNet;
  return typeof session === 'string' && session.trim() !== ''
    && typeof net === 'string' && net.trim() !== '';
}

/** Ids of the abstract elements in a PNML element map (`net.transitions` or `net.places`). */
export function abstractElementIds(elements: Record<string, any> | undefined | null): string[] {
  return Object.entries(elements ?? {})
    .filter(([, entry]) => isAbstractElement(entry))
    .map(([id]) => id);
}

export function classifyCanvas(
  shapeIds: string[],
  runtimeHome: Map<string, string | null>,
  netId: string,
  abstractIds: Iterable<string> = [],
): {
  staleShapes: string[];
  abstractShapes: string[];
  viewShapes: Record<string, string>;
  viewOf: string[];
  netRole: 'empty' | 'canonical' | 'view' | 'hybrid';
  undrawn: string[];
} {
  const abstractSet = new Set(abstractIds);
  const abstractShapes = shapeIds.filter((t) => abstractSet.has(t));
  const staleShapes = shapeIds.filter((t) => !runtimeHome.has(t) && !abstractSet.has(t));
  const viewShapes: Record<string, string> = {};
  let owned = 0;
  for (const t of shapeIds) {
    if (abstractSet.has(t)) { owned++; continue; } // abstract: belongs to this canvas, never fires
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
  return { staleShapes, abstractShapes, viewShapes, viewOf, netRole, undrawn };
}
