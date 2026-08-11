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
