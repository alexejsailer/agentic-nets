/**
 * Deterministic incremental layout for MCP-built nets.
 *
 * Field report: MCP-created nets were "very bad" on the canvas — every add_place landed on
 * (100,100), add_transition wrote a 60px-pitch vertical cluster at x=200 for EVERY call (all
 * transitions stacked on one point), and the designtime POST is an upsert, so referencing an
 * already-positioned place silently reset its coordinates and label.
 *
 * This ports the designer agent's spacing spec into code instead of prose:
 * - 200px horizontal / 180px vertical center-to-center pitch, origin (100,100)
 * - pipelines read left-to-right as place → transition → place along a spine
 * - branch/error places go on the row(s) below their transition
 * - an element that already has a position is NEVER moved
 *
 * No LLM, no external library: layout quality comes from following the spine of what already
 * exists in the net, which the designtime GET returns in one call.
 */

export const COL = 200;
export const ROW = 180;
export const ORIGIN_X = 100;
export const ORIGIN_Y = 100;
/** Closer than this on both axes reads as overlap (60px element + ~20px label + margin). */
const CLEARANCE = 120;

export interface ElementPos {
  id: string;
  x?: number | null;
  y?: number | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface TransitionPlan {
  transition: Point;
  /** Positions ONLY for elements that do not exist yet — existing ones are never moved. */
  places: Map<string, Point>;
}

export class NetLayout {
  private readonly pos = new Map<string, Point>();

  constructor(existing: Iterable<ElementPos> = []) {
    for (const e of existing) {
      if (e.id && Number.isFinite(e.x as number) && Number.isFinite(e.y as number)) {
        this.pos.set(e.id, { x: Number(e.x), y: Number(e.y) });
      }
    }
  }

  has(id: string): boolean {
    return this.pos.has(id);
  }

  get(id: string): Point | undefined {
    return this.pos.get(id);
  }

  private occupied(x: number, y: number): boolean {
    for (const p of this.pos.values()) {
      if (Math.abs(p.x - x) < CLEARANCE && Math.abs(p.y - y) < CLEARANCE) return true;
    }
    return false;
  }

  /** Claim (x,y), sliding DOWN row by row until the slot is free. */
  private claim(id: string, x: number, y: number): Point {
    let yy = y;
    while (this.occupied(x, yy)) yy += ROW;
    const p = { x, y: yy };
    this.pos.set(id, p);
    return p;
  }

  /** Next free grid slot, scanning left-to-right then row by row (standalone add_place). */
  nextSlot(id: string): Point {
    for (let r = 0; r < 200; r++) {
      for (let c = 0; c < 8; c++) {
        const x = ORIGIN_X + c * COL;
        const y = ORIGIN_Y + r * ROW;
        if (!this.occupied(x, y)) {
          const p = { x, y };
          this.pos.set(id, p);
          return p;
        }
      }
    }
    return this.claim(id, ORIGIN_X, ORIGIN_Y); // unreachable in practice
  }

  /** A fresh chain starts at the left margin, on the first row below everything placed so far. */
  private rowStart(id: string): Point {
    let maxY = ORIGIN_Y - ROW;
    for (const p of this.pos.values()) maxY = Math.max(maxY, p.y);
    return this.claim(id, ORIGIN_X, maxY + ROW === ORIGIN_Y ? ORIGIN_Y : maxY + ROW);
  }

  /**
   * Plan a transition and its endpoint places. Explicit (x,y) anchors the transition; places
   * around it still get proper pitch. Without explicit coords the transition continues the
   * spine of its input place: transition at input.x + COL, output at input.x + 2*COL.
   */
  planTransition(spec: {
    transitionId: string;
    inputPlace: string;
    outputPlace?: string;
    branchPlaces?: string[];
    x?: number;
    y?: number;
  }): TransitionPlan {
    const places = new Map<string, Point>();
    const explicit = spec.x != null && spec.y != null;

    let input = this.get(spec.inputPlace);
    if (!input) {
      input = explicit
        ? this.claim(spec.inputPlace, (spec.x as number) - COL, spec.y as number)
        : this.rowStart(spec.inputPlace);
      places.set(spec.inputPlace, input);
    }

    const transition = explicit
      ? this.claim(spec.transitionId, spec.x as number, spec.y as number)
      : this.claim(spec.transitionId, input.x + COL, input.y);

    if (spec.outputPlace && !this.has(spec.outputPlace)) {
      places.set(spec.outputPlace, this.claim(spec.outputPlace, transition.x + COL, transition.y));
    }
    for (const bp of spec.branchPlaces ?? []) {
      if (!bp || this.has(bp) || places.has(bp)) continue;
      // Branches fan out on the rows below the main output.
      places.set(bp, this.claim(bp, transition.x + COL, transition.y + ROW));
    }
    return { transition, places };
  }
}

// ---------------------------------------------------------------------------------------------
// Whole-net serpentine relayout (the layout_net tool).
//
// Field lesson (2026-08-26, token-janitor): a 21-element pipeline laid out on one row was
// 4,100px wide with arcs spanning the whole canvas; nets built via the NATIVE tools had no
// designtime places at all. This computes a fresh layout for an EXISTING net from its arc graph:
//
// - the flow spine (elements with both producers and consumers) runs left→right and FOLDS
//   serpentine every SPINE_PER_ROW elements, so long pipelines stay ~2,000px wide;
// - pure-source config/hub places sit on a band between the rows they serve, centered under
//   their consumers;
// - pure sinks (audit/output places nothing consumes) get their own row below everything;
// - collisions bump right until free.
// ---------------------------------------------------------------------------------------------

export const SPINE_PER_ROW = 10;
export const ROW_GAP = 280;
export const BAND_OFFSET = 140;

export interface NetElement {
  id: string;
  type: 'place' | 'transition';
}

export interface NetArc {
  source: string;
  target: string;
}

/** Deterministic serpentine layout. Returns ONLY elements whose position should change. */
export function serpentineLayout(
  elements: NetElement[],
  arcs: NetArc[],
  current: Map<string, Point> = new Map(),
): Map<string, Point> {
  const ids = new Set(elements.map((e) => e.id));
  const inbound = new Map<string, string[]>();
  const outbound = new Map<string, string[]>();
  for (const id of ids) {
    inbound.set(id, []);
    outbound.set(id, []);
  }
  for (const a of arcs) {
    if (!ids.has(a.source) || !ids.has(a.target)) continue;
    outbound.get(a.source)!.push(a.target);
    inbound.get(a.target)!.push(a.source);
  }

  // Longest-path layering from sources; cycles cut by a visiting set so ctx-style
  // self-refreshing hubs cannot loop the walk.
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const preds = inbound.get(id) ?? [];
    const l = preds.length === 0 ? 0 : Math.max(...preds.map((p) => layerOf(p))) + 1;
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const e of elements) layerOf(e.id);

  const isSource = (id: string) => (inbound.get(id) ?? []).length === 0;
  const isSink = (id: string) => (outbound.get(id) ?? []).length === 0;
  // A hub reads AND is written across ≥3 arcs (the shared-context shape) — band, not spine.
  const isHub = (e: NetElement) =>
    e.type === 'place' &&
    !isSource(e.id) &&
    !isSink(e.id) &&
    (inbound.get(e.id)!.length + outbound.get(e.id)!.length) >= 4;

  const spine = elements
    .filter((e) => {
      if (e.type === 'transition') return true;
      return !isSink(e.id) && !isHub(e) && !(isSource(e.id) && layerMinOfConsumers(e.id) > 0);
    })
    .sort((a, b) => (layer.get(a.id)! - layer.get(b.id)!) || a.id.localeCompare(b.id));

  function layerMinOfConsumers(id: string): number {
    const consumers = outbound.get(id) ?? [];
    if (!consumers.length) return 0;
    return Math.min(...consumers.map((c) => layer.get(c) ?? 0));
  }

  const out = new Map<string, Point>();
  const occupied = new Set<string>();
  const key = (p: Point) => `${p.x}:${p.y}`;
  const claim = (p: Point): Point => {
    let q = { ...p };
    while (occupied.has(key(q))) q = { x: q.x + COL, y: q.y };
    occupied.add(key(q));
    return q;
  };

  // 1. Spine, serpentine.
  const spineRowY = (row: number) => ORIGIN_Y + row * ROW_GAP;
  spine.forEach((e, i) => {
    const row = Math.floor(i / SPINE_PER_ROW);
    const col = i % SPINE_PER_ROW;
    const x = row % 2 === 0 ? ORIGIN_X + col * COL : ORIGIN_X + (SPINE_PER_ROW - 1 - col) * COL;
    out.set(e.id, claim({ x, y: spineRowY(row) }));
  });

  const avgXOf = (neighbors: string[]): number => {
    const xs = neighbors.map((n) => out.get(n)?.x).filter((x): x is number => Number.isFinite(x as number));
    if (!xs.length) return ORIGIN_X;
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    return ORIGIN_X + Math.round((avg - ORIGIN_X) / COL) * COL;
  };
  const rowYOf = (neighbors: string[]): number => {
    const ys = neighbors.map((n) => out.get(n)?.y).filter((y): y is number => Number.isFinite(y as number));
    return ys.length ? Math.max(...ys) : ORIGIN_Y;
  };

  // 2. Bands: config sources feeding mid-net + hubs, centered under their neighbors.
  for (const e of elements) {
    if (out.has(e.id)) continue;
    if (e.type !== 'place') continue;
    const neighbors = [...inbound.get(e.id)!, ...outbound.get(e.id)!];
    if (isHub(e) || (isSource(e.id) && !isSink(e.id))) {
      out.set(e.id, claim({ x: avgXOf(neighbors), y: rowYOf(neighbors) + BAND_OFFSET }));
    }
  }

  // 3. Sinks row, below everything placed so far.
  const maxY = Math.max(ORIGIN_Y, ...[...out.values()].map((p) => p.y));
  for (const e of elements) {
    if (out.has(e.id)) continue;
    const neighbors = [...inbound.get(e.id)!, ...outbound.get(e.id)!];
    out.set(e.id, claim({ x: avgXOf(neighbors), y: maxY + ROW_GAP - (BAND_OFFSET / 2) }));
  }

  // Only report moves — an element already exactly in place is not a change.
  for (const [id, p] of out) {
    const cur = current.get(id);
    if (cur && cur.x === p.x && cur.y === p.y) out.delete(id);
  }
  return out;
}
