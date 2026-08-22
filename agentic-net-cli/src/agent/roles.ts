import { AgentTool } from './tools.js';

/**
 * Canonical AgenticOS capability flags. The slot order is identical to master:
 * R=read, W=write, X=execute, H=http, L=logs, U=inhabitant/await,
 * D=docker, C=coordinate personas, T=consume tool-nets, S=publish scripts,
 * M=call external MCP servers declared in the inscription's action.mcp.
 *
 * New security policies should use exact named capability profiles; this compact
 * role remains the backwards-compatible coarse upper bound.
 */
export interface AgentRole {
  read: boolean;
  write: boolean;
  execute: boolean;
  http: boolean;
  logs: boolean;
  user: boolean;
  docker: boolean;
  coordinate: boolean;
  tooling: boolean;
  scripts: boolean;
  mcp: boolean;
}

const role = (
  read = false, write = false, execute = false, http = false, logs = false,
  user = false, docker = false, coordinate = false, tooling = false, scripts = false,
  mcp = false,
): AgentRole => ({ read, write, execute, http, logs, user, docker, coordinate, tooling, scripts, mcp });

export const READ_ONLY = role(true);
export const READ_WRITE = role(true, true);
export const READ_WRITE_EXECUTE = role(true, true, true);
/**
 * Every capability flag enabled (`rwxhludcts`). Mirrors master's AgentRole.ALL —
 * which deliberately does NOT include the m (MCP) flag: external MCP reach is
 * explicit-only via the 11-char positional form (`rwxhludctsm`).
 */
export const ALL = role(true, true, true, true, true, true, true, true, true, true);
/**
 * @deprecated Historical CLI name for the all-flags role. Master's FULL is the
 * narrower `rwxh-` role, so this name is misleading across runtimes — use {@link ALL}.
 */
export const FULL = ALL;

const READ_TOOLS = new Set<AgentTool>([
  'QUERY_TOKENS', 'LIST_PLACES', 'GET_PLACE_INFO', 'GET_PLACE_CONNECTIONS',
  'GET_TRANSITION', 'VERIFY_RUNTIME_BINDINGS', 'GET_NET_STRUCTURE', 'VERIFY_NET',
  'EXPORT_PNML', 'LIST_ALL_SESSIONS', 'LIST_ALL_INSCRIPTIONS', 'LIST_SESSION_NETS',
  'EXTRACT_TOKEN_CONTENT', 'EXTRACT_RAW_DATA', 'INSPECT_TOKEN_SIZE',
  'GET_LINKED_PLACES', 'DESCRIBE_PLACE', 'FIND_SHARED_PLACES',
  'GET_SESSION_OVERVIEW', 'GET_NET_OVERVIEW', 'FIND_NET_NEIGHBORS',
  'LIST_SESSIONS_BY_TAG', 'PACKAGE_SEARCH',
  'AGENT_HUB_SEARCH', 'DESCRIBE_AGENT_TEMPLATE', 'LIST_AGENT_SESSIONS',
  'CONTEXT_HUB_SEARCH', 'DESCRIBE_CONTEXT_TEMPLATE', 'LIST_CONTEXTS', 'GET_CONTEXT_TREE',
  'LIST_APPLICATIONS', 'DESCRIBE_APPLICATION',
  'APPLICATION_HUB_SEARCH', 'DESCRIBE_APPLICATION_TEMPLATE',
  'HUB_CATALOG', 'HUB_REMOTE_LIST', 'DRY_RUN_TRANSITION',
  'VERIFY_INSCRIPTION', 'DIAGNOSE_TRANSITION', 'OBSERVE_MODEL', 'LIST_EXECUTORS',
  'SEARCH_KNOWLEDGE', 'READ_BLOB_TEXT', 'LIST_TRANSITION_CREDENTIALS',
]);

const WRITE_TOOLS = new Set<AgentTool>([
  'CREATE_TOKEN', 'DELETE_TOKEN', 'CREATE_RUNTIME_PLACE',
  'CREATE_SESSION', 'CREATE_NET', 'DELETE_NET', 'DELETE_TRANSITION',
  'CREATE_PLACE', 'CREATE_TRANSITION', 'CREATE_ARC', 'DELETE_PLACE', 'DELETE_ARC',
  'SET_INSCRIPTION', 'EMIT_MEMORY', 'NET_DOCTOR', 'ADAPT_INSCRIPTIONS',
  'SET_TRANSITION_CREDENTIALS', 'DELETE_TRANSITION_CREDENTIALS',
  'PACKAGE_PUBLISH', 'PACKAGE_INSTALL', 'INSTALL_AGENT_TEMPLATE',
  'INSTALL_CONTEXT_TEMPLATE', 'ATTACH_CONTEXT', 'LINK_PLACES', 'CREATE_CONTEXT',
  'CONTEXT_ADD_STORE', 'HUB_PUBLISH', 'HUB_INSTALL', 'HUB_UNPUBLISH',
  'APPLICATION_ACTION',
  'INSTALL_APPLICATION_TEMPLATE',
  'HUB_REMOTE_ADD', 'HUB_REMOTE_REMOVE', 'TAG_SESSION', 'REGISTER_TOOL_NET',
  'SCAFFOLD_TOOL_NET', 'PROMOTE_TOOL_NET',
]);

const EXECUTE_TOOLS = new Set<AgentTool>([
  'DEPLOY_TRANSITION', 'START_TRANSITION', 'STOP_TRANSITION', 'FIRE_ONCE',
  'EXECUTE_TRANSITION', 'EXECUTE_TRANSITION_SMART',
  'START_AGENT_SESSION', 'STOP_AGENT_SESSION', 'START_CONTEXT', 'STOP_CONTEXT',
]);

const HTTP_TOOLS = new Set<AgentTool>([
  'HTTP_CALL', 'TOOL_CATALOG_REGISTER_HTTP', 'TOOL_CATALOG_SEARCH', 'TOOL_CATALOG_GET',
]);

const LOGS_TOOLS = new Set<AgentTool>(['QUERY_EVENTS', 'GET_EVENT_FACETS', 'GET_EVENT_TRAIL']);
const USER_TOOLS = new Set<AgentTool>(['AWAIT_TOKEN']);

const DOCKER_TOOLS = new Set<AgentTool>([
  'REGISTRY_LIST_IMAGES', 'REGISTRY_GET_IMAGE_INFO', 'TOOL_CATALOG_SEARCH',
  'TOOL_CATALOG_GET', 'TOOL_CATALOG_IMPORT_IMAGE', 'DOCKER_RUN', 'DOCKER_STOP',
  'DOCKER_LIST', 'DOCKER_LOGS', 'WRAP_DOCKER_TOOL',
]);

const COORDINATION_TOOLS = new Set<AgentTool>([
  'INVOKE_PERSONA', 'DELEGATE_TASK', 'COLLECT_RESULTS',
]);

const TOOLING_TOOLS = new Set<AgentTool>([
  'LIST_TOOL_NETS', 'DESCRIBE_TOOL_NET', 'INVOKE_TOOL_NET', 'TOOLNET_HEALTH',
  'TOOLNET_CANDIDATES', 'TOOL_CATALOG_SEARCH', 'TOOL_CATALOG_GET',
]);

const SCRIPT_TOOLS = new Set<AgentTool>([
  'TOOL_CATALOG_REGISTER_SCRIPT', 'TOOL_CATALOG_SEARCH', 'TOOL_CATALOG_GET',
]);

/**
 * MCP tools (M flag): MCP_CALL against the servers declared in the inscription's
 * action.mcp. The declaration is the allowlist — the flag alone reaches nothing.
 * Executed only by the master engine; the CLI runtime advertises but cannot serve it.
 */
const MCP_TOOLS = new Set<AgentTool>(['MCP_CALL']);

const CONTROL_TOOLS = new Set<AgentTool>(['THINK', 'DONE', 'FAIL']);

export function getAvailableTools(r: AgentRole): Set<AgentTool> {
  const tools = new Set<AgentTool>(CONTROL_TOOLS);
  if (r.read) READ_TOOLS.forEach(t => tools.add(t));
  if (r.write) WRITE_TOOLS.forEach(t => tools.add(t));
  if (r.execute) EXECUTE_TOOLS.forEach(t => tools.add(t));
  if (r.http) HTTP_TOOLS.forEach(t => tools.add(t));
  if (r.logs) LOGS_TOOLS.forEach(t => tools.add(t));
  if (r.user) USER_TOOLS.forEach(t => tools.add(t));
  if (r.docker) DOCKER_TOOLS.forEach(t => tools.add(t));
  if (r.coordinate) COORDINATION_TOOLS.forEach(t => tools.add(t));
  if (r.tooling) TOOLING_TOOLS.forEach(t => tools.add(t));
  if (r.scripts) SCRIPT_TOOLS.forEach(t => tools.add(t));
  if (r.mcp) MCP_TOOLS.forEach(t => tools.add(t));
  return tools;
}

export function allowsTool(r: AgentRole, tool: AgentTool): boolean {
  return getAvailableTools(r).has(tool);
}

/** Shortest canonical positional representation preserving every enabled flag. */
export function roleToString(r: AgentRole): string {
  const chars = [
    r.read ? 'r' : '-', r.write ? 'w' : '-', r.execute ? 'x' : '-',
    r.http ? 'h' : '-', r.logs ? 'l' : '-', r.user ? 'u' : '-',
    r.docker ? 'd' : '-', r.coordinate ? 'c' : '-', r.tooling ? 't' : '-',
    r.scripts ? 's' : '-', r.mcp ? 'm' : '-',
  ];
  let last = 4;
  if (r.user) last = Math.max(last, 5);
  if (r.docker) last = Math.max(last, 6);
  if (r.coordinate) last = Math.max(last, 7);
  if (r.tooling) last = Math.max(last, 8);
  if (r.scripts) last = Math.max(last, 9);
  if (r.mcp) last = 10;
  return chars.slice(0, last + 1).join('');
}

export function parseRole(value: string): AgentRole {
  if (!value || !value.trim()) return READ_WRITE;
  const v = value.trim().toLowerCase();

  const slots = ['r', 'w', 'x', 'h', 'l', 'u', 'd', 'c', 't', 's', 'm'];
  if (v.length >= 4 && v.length <= 11) {
    const valid = [...v].every((ch, i) => ch === '-' || ch === slots[i]);
    if (valid) {
      return role(
        v[0] === 'r', v[1] === 'w', v[2] === 'x', v[3] === 'h',
        v[4] === 'l', v[5] === 'u', v[6] === 'd', v[7] === 'c',
        v[8] === 't', v[9] === 's', v[10] === 'm',
      );
    }
  }

  // Deprecated CLI-only rwxhds layout (D and S occupied slots 5 and 6).
  // Parse the full positional family, not only rwxhd/rwxhds, so saved custom
  // roles such as r---d- and rwxh-s remain valid after adopting rwxhludcts.
  if (v.length >= 4 && v.length <= 6
    && /^[r-][w-][x-][h-](?:[d-])?(?:[s-])?$/.test(v)) {
    return role(v[0] === 'r', v[1] === 'w', v[2] === 'x', v[3] === 'h',
      false, false, v[4] === 'd', false, false, v[5] === 's');
  }

  switch (v) {
    case 'r': return READ_ONLY;
    case 'rw': return READ_WRITE;
    case 'rwx': return READ_WRITE_EXECUTE;
    case 'rwxh': return role(true, true, true, true);
    case 'rwxhl': return role(true, true, true, true, true);
    case 'rwxhlu': return role(true, true, true, true, true, true);
    case 'rwxhlud': return role(true, true, true, true, true, true, true);
    case 'rwxhludc': return role(true, true, true, true, true, true, true, true);
    case 'rwxhludct': return role(true, true, true, true, true, true, true, true, true);
    case 'rwxhludcts': return ALL;
    default:
      throw new Error(`Invalid role '${value}'. Use canonical rwxhludcts positional flags.`);
  }
}
