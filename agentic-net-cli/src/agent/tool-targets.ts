import catalog from './capability-profiles.json';

/**
 * Per-tool resource-target classification from the shared capability catalog —
 * the TypeScript twin of master's AgentToolTargets. The authorize gates dispatch
 * on this classification, and test/catalog.test.ts pins that every tool in the
 * role registry is classified in exactly one group, so a new tool cannot ship
 * without deciding its enforcement semantics.
 */
export type TargetKind = 'read' | 'write' | 'link' | 'contextSession' | 'structural' | 'ambient';

const GROUPS: Array<[TargetKind, string[]]> = [
  ['read', catalog.toolTargets.read],
  ['write', catalog.toolTargets.write],
  ['link', catalog.toolTargets.link],
  ['contextSession', catalog.toolTargets.contextSession],
  ['structural', catalog.toolTargets.structural],
  ['ambient', catalog.toolTargets.ambient],
];

const KINDS = new Map<string, TargetKind>();
for (const [kind, names] of GROUPS) {
  for (const name of names) {
    const previous = KINDS.get(name);
    if (previous) throw new Error(`tool '${name}' is classified in both ${previous} and ${kind}`);
    KINDS.set(name, kind);
  }
}

/** Ordered parameter names carrying the single place target of read/write tools. */
export const PLACE_PARAMS: string[] = catalog.toolTargets.placeParams;
/** Parameter names carrying the endpoints of link tools. */
export const LINK_PARAMS: string[] = catalog.toolTargets.linkParams;

/**
 * Classification lookup. Unknown names fail CLOSED as 'structural' — an
 * unclassified tool is a catalog bug (pinned by tests) and must not slip past a
 * place-scoped policy.
 */
export function targetKind(tool: string): TargetKind {
  return KINDS.get(tool) ?? 'structural';
}

/** Lookup that distinguishes genuinely unknown names (for the capsule gate). */
export function targetKindIfKnown(tool: string): TargetKind | undefined {
  return KINDS.get(tool);
}

/**
 * Canonical place identity shared by every enforcement gate (twin of
 * AgentToolTargets.canonicalPlaceId). Runtime places are flat per-model ids under
 * `root/workspace/places/<placeId>` — those (and bare ids) canonicalize to the
 * placeId. Any OTHER path keeps its full normalized form, so a place in a
 * different tree can never collide with a protected or scoped runtime place
 * sharing its basename.
 */
export function canonicalPlaceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^\/+/, '');
  if (!normalized) return undefined;
  for (const prefix of ['root/workspace/places/', 'workspace/places/']) {
    if (normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length);
      const slash = rest.indexOf('/');
      return slash < 0 ? rest : rest.slice(0, slash);
    }
  }
  return normalized;
}
