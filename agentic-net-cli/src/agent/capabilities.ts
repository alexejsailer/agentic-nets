import type { AgentTool } from './tools.js';
import type { AgentRole } from './roles.js';
import { ALL, getAvailableTools } from './roles.js';
import { PLACE_PARAMS, LINK_PARAMS, canonicalPlaceId, targetKind } from './tool-targets.js';
import catalog from './capability-profiles.json';

/**
 * The catalog file is a verbatim copy of core's agent-capability-profiles.json,
 * synced by `npm run sync-tools`. Both runtimes assert the same schemaVersion so
 * a stale or hand-edited copy fails at load instead of granting drifted tools.
 */
const CATALOG_SCHEMA_VERSION = '2.0';
if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
  throw new Error(`capability-profiles.json schemaVersion is '${catalog.schemaVersion}' `
    + `but this runtime requires '${CATALOG_SCHEMA_VERSION}' — run npm run sync-tools`);
}

/** Shared resolver constants (context budget, scope ranking, hierarchy semantics). */
export const CATALOG_CONSTANTS = catalog.constants;

export interface CapabilityPolicy {
  profile: string;
  tools: Set<AgentTool>;
  /** Profile tools the role ceiling silently dropped — loud capping diagnostics. */
  cappedTools: Set<AgentTool>;
  authorize(tool: AgentTool, params: Record<string, any>, ambientSessionId?: string): string | undefined;
}

interface ProfileDefinition {
  tools: AgentTool[];
  readPlaces?: string[];
  writePlaces?: string[];
  sessions?: string[];
}

const CONTROL: AgentTool[] = ['THINK', 'DONE', 'FAIL'];
const ALL_ROLE_TOOLS = getAvailableTools(ALL);

/** Profile definitions from the synced master catalog (see CATALOG_SCHEMA_VERSION above). */
const PROFILES: Record<string, ProfileDefinition> = Object.fromEntries(
  Object.entries(catalog.profiles).map(([name, raw]) => {
    const profile = raw as { tools: string[]; resources?: {
      readPlaces?: string[]; writePlaces?: string[]; sessions?: string[];
    } };
    const tools = profile.tools.map(tool => {
      if (!ALL_ROLE_TOOLS.has(tool as AgentTool)) {
        throw new Error(`Unknown tool '${tool}' in capability profile '${name}'`);
      }
      return tool as AgentTool;
    });
    return [name, {
      tools,
      readPlaces: profile.resources?.readPlaces,
      writePlaces: profile.resources?.writePlaces,
      sessions: profile.resources?.sessions,
    } satisfies ProfileDefinition];
  }),
);

function normalizeProfile(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().toLowerCase().replaceAll('_', '-');
}

function firstParam(params: Record<string, any> | undefined, keys: string[]): unknown {
  for (const key of keys) {
    const value = params?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function intersectScope(profile: string[] | undefined, configured: string[] | undefined): string[] {
  if (!profile?.length) return configured ?? [];
  if (!configured?.length) return profile;
  return profile.filter(value => configured.includes(value));
}

function configuredScope(action: Record<string, any> | undefined, key: string, places = false): string[] | undefined {
  const raw = action?.resourceScopes?.[key];
  if (!Array.isArray(raw)) return undefined;
  return raw.map(value => places ? canonicalPlaceId(value) : String(value).trim())
    .filter((value): value is string => !!value);
}

export function resolveCapabilityPolicy(action: Record<string, any> | undefined, role: AgentRole): CapabilityPolicy {
  const roleTools = getAvailableTools(role);
  const requested = normalizeProfile(action?.capabilityProfile);
  const definition = requested ? PROFILES[requested] : undefined;
  if (requested && !definition) {
    throw new Error(`Unknown capabilityProfile '${requested}'. Known profiles: ${Object.keys(PROFILES).join(', ')}`);
  }

  let selected = new Set<AgentTool>(definition?.tools ?? roleTools);
  selected = new Set([...selected].filter(tool => roleTools.has(tool)));
  const cappedTools = new Set<AgentTool>((definition?.tools ?? [])
    .filter(tool => !roleTools.has(tool) && !CONTROL.includes(tool)));
  if (cappedTools.size) {
    console.warn(`[capabilities] profile '${requested}' declares tools the role ceiling drops: `
      + `${[...cappedTools].join(', ')} — widen the inscription's action.role or narrow the profile`);
  }

  if (Array.isArray(action?.allowedTools)) {
    const explicit = new Set<AgentTool>();
    for (const raw of action.allowedTools) {
      const name = String(raw).trim().toUpperCase() as AgentTool;
      if (!ALL_ROLE_TOOLS.has(name)) throw new Error(`Unknown action.allowedTools entry '${raw}'`);
      explicit.add(name);
    }
    selected = new Set([...selected].filter(tool => explicit.has(tool)));
  }
  CONTROL.forEach(tool => selected.add(tool));

  const readPlaces = intersectScope(definition?.readPlaces,
    configuredScope(action, 'readPlaces', true));
  const writePlaces = intersectScope(definition?.writePlaces,
    configuredScope(action, 'writePlaces', true));
  const sessions = intersectScope(definition?.sessions,
    configuredScope(action, 'sessions'));

  return {
    profile: requested ?? (action?.allowedTools ? 'explicit' : 'legacy-role'),
    tools: selected,
    cappedTools,
    authorize(tool, params, ambientSessionId?: string) {
      if (!selected.has(tool)) return `tool is not granted by profile '${requested ?? 'legacy-role'}'`;
      // Dispatch on the catalog classification — every tool is classified (pinned by
      // tests), so a mutation without a determinable place target is denied outright
      // whenever a writePlaces restriction is active instead of bypassing it.
      const kind = targetKind(tool);
      if (kind === 'read' || kind === 'write') {
        const places = kind === 'read' ? readPlaces : writePlaces;
        if (places.length) {
          const place = canonicalPlaceId(firstParam(params, PLACE_PARAMS));
          if (!place || !places.includes(place)) {
            return `${kind} access to place '${place ?? 'unknown'}' is outside resourceScopes`;
          }
        }
      } else if (kind === 'link') {
        if (writePlaces.length) {
          for (const key of LINK_PARAMS) {
            const endpoint = canonicalPlaceId(params?.[key]);
            if (endpoint && !writePlaces.includes(endpoint)) {
              return `link endpoint '${endpoint}' is outside resourceScopes`;
            }
          }
        }
      } else if (kind === 'structural') {
        if (writePlaces.length) {
          return `a place-scoped capability grant does not include structural mutations (${tool})`;
        }
      }
      const targetSession = params?.sessionId || ambientSessionId;
      if (sessions.length && (!targetSession || !sessions.includes(targetSession))) {
        return `session '${targetSession ?? 'unknown'}' is outside resourceScopes`;
      }
      return undefined;
    },
  };
}

export function knownCapabilityProfiles(): string[] {
  return Object.keys(PROFILES);
}
