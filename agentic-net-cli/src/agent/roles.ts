import { AgentTool } from './tools.js';

/**
 * Unix-like permission model for agent access control.
 * R=read, W=write, X=execute, H=http, D=docker.
 *
 * D mirrors the master's dedicated docker capability: spawning tool containers
 * is a deliberate grant ('rwxhd'), not a side effect of read/execute. Plain
 * 'rwxh' does NOT include the docker/registry tools.
 */
export interface AgentRole {
  read: boolean;
  write: boolean;
  execute: boolean;
  http: boolean;
  docker: boolean;
  /** S mirrors the master's scripts flag: registering catalog script artifacts. */
  scripts: boolean;
}

// Named constants
export const READ_ONLY: AgentRole = { read: true, write: false, execute: false, http: false, docker: false, scripts: false };
export const READ_WRITE: AgentRole = { read: true, write: true, execute: false, http: false, docker: false, scripts: false };
export const READ_WRITE_EXECUTE: AgentRole = { read: true, write: true, execute: true, http: false, docker: false, scripts: false };
/** Everything, including docker — the deliberate top grant (used by the MCP native catalog). */
export const FULL: AgentRole = { read: true, write: true, execute: true, http: true, docker: true, scripts: true };

// Tool groupings
const READ_TOOLS = new Set<AgentTool>([
  'QUERY_TOKENS', 'LIST_PLACES', 'GET_PLACE_INFO', 'GET_PLACE_CONNECTIONS', 'GET_TRANSITION', 'VERIFY_RUNTIME_BINDINGS',
  'GET_NET_STRUCTURE', 'VERIFY_NET', 'EXPORT_PNML',
  'LIST_ALL_SESSIONS', 'LIST_ALL_INSCRIPTIONS', 'LIST_SESSION_NETS',
  'EXTRACT_TOKEN_CONTENT', 'EXTRACT_RAW_DATA', 'INSPECT_TOKEN_SIZE',
  'GET_LINKED_PLACES', 'FIND_SHARED_PLACES', 'LIST_EXECUTORS',
  'GET_SESSION_OVERVIEW', 'GET_NET_OVERVIEW', 'FIND_NET_NEIGHBORS',
  'LIST_SESSIONS_BY_TAG', 'LIST_TOOL_NETS', 'DESCRIBE_TOOL_NET',
  'PACKAGE_SEARCH',
  'AGENT_HUB_SEARCH', 'DESCRIBE_AGENT_TEMPLATE', 'LIST_AGENT_SESSIONS',
  'HUB_CATALOG', 'HUB_REMOTE_LIST',
  'DRY_RUN_TRANSITION',
  'VERIFY_INSCRIPTION', 'DIAGNOSE_TRANSITION',
  // Master-parity read/observability tools (event line, knowledge, model snapshot,
  // place navigation, tool-net library health) — routed through the master executor.
  'DESCRIBE_PLACE', 'OBSERVE_MODEL',
  'SEARCH_KNOWLEDGE', 'READ_BLOB_TEXT',
  'QUERY_EVENTS', 'GET_EVENT_FACETS', 'GET_EVENT_TRAIL',
  'TOOLNET_HEALTH', 'TOOLNET_CANDIDATES', 'AWAIT_TOKEN',
  'LIST_TRANSITION_CREDENTIALS',
]);

const WRITE_TOOLS = new Set<AgentTool>([
  'CREATE_TOKEN', 'DELETE_TOKEN', 'CREATE_RUNTIME_PLACE',
  'CREATE_SESSION', 'CREATE_NET', 'DELETE_NET', 'DELETE_TRANSITION',
  'CREATE_PLACE', 'CREATE_TRANSITION', 'CREATE_ARC',
  'DELETE_PLACE', 'DELETE_ARC', 'SET_INSCRIPTION', 'EMIT_MEMORY', 'NET_DOCTOR', 'ADAPT_INSCRIPTIONS',
  'SET_TRANSITION_CREDENTIALS', 'DELETE_TRANSITION_CREDENTIALS',
  'PACKAGE_PUBLISH', 'PACKAGE_INSTALL',
  'INSTALL_AGENT_TEMPLATE',
  'HUB_PUBLISH', 'HUB_INSTALL', 'HUB_UNPUBLISH', 'HUB_REMOTE_ADD', 'HUB_REMOTE_REMOVE',
  'TAG_SESSION', 'REGISTER_TOOL_NET', 'SCAFFOLD_TOOL_NET',
  'PROMOTE_TOOL_NET',
]);

const EXECUTE_TOOLS = new Set<AgentTool>([
  'DEPLOY_TRANSITION', 'START_TRANSITION', 'STOP_TRANSITION', 'FIRE_ONCE', 'EXECUTE_TRANSITION', 'EXECUTE_TRANSITION_SMART',
  'START_AGENT_SESSION', 'STOP_AGENT_SESSION',
  'INVOKE_TOOL_NET',
  // Master-parity coordination tools (delegate to / invoke personas, collect results) —
  // routed through the master executor.
  'INVOKE_PERSONA', 'DELEGATE_TASK', 'COLLECT_RESULTS',
]);

// Container/registry tools require the dedicated D grant (mirrors master's D flag).
// Clean split (S era): d = containers, h = external HTTP services, s = scripts —
// catalog search/get ride along with every binding-type flag.
const DOCKER_TOOLS = new Set<AgentTool>([
  'REGISTRY_LIST_IMAGES', 'REGISTRY_GET_IMAGE_INFO',
  'TOOL_CATALOG_SEARCH', 'TOOL_CATALOG_GET',
  'TOOL_CATALOG_IMPORT_IMAGE',
  'DOCKER_RUN', 'DOCKER_STOP', 'DOCKER_LIST', 'DOCKER_LOGS',
  'WRAP_DOCKER_TOOL',
]);

const HTTP_TOOLS = new Set<AgentTool>([
  'HTTP_CALL', 'TOOL_CATALOG_REGISTER_HTTP',
  'TOOL_CATALOG_SEARCH', 'TOOL_CATALOG_GET',
]);

const SCRIPT_TOOLS = new Set<AgentTool>([
  'TOOL_CATALOG_REGISTER_SCRIPT',
  'TOOL_CATALOG_SEARCH', 'TOOL_CATALOG_GET',
]);

const CONTROL_TOOLS = new Set<AgentTool>(['THINK', 'DONE', 'FAIL']);

export function getAvailableTools(role: AgentRole): Set<AgentTool> {
  const tools = new Set<AgentTool>(CONTROL_TOOLS);
  if (role.read) READ_TOOLS.forEach(t => tools.add(t));
  if (role.write) WRITE_TOOLS.forEach(t => tools.add(t));
  if (role.execute) EXECUTE_TOOLS.forEach(t => tools.add(t));
  if (role.http) HTTP_TOOLS.forEach(t => tools.add(t));
  if (role.docker) DOCKER_TOOLS.forEach(t => tools.add(t));
  if (role.scripts) SCRIPT_TOOLS.forEach(t => tools.add(t));
  return tools;
}

export function allowsTool(role: AgentRole, tool: AgentTool): boolean {
  return getAvailableTools(role).has(tool);
}

export function roleToString(role: AgentRole): string {
  return [
    role.read ? 'r' : '-',
    role.write ? 'w' : '-',
    role.execute ? 'x' : '-',
    role.http ? 'h' : '-',
    role.docker ? 'd' : '-',
    role.scripts ? 's' : '-',
  ].join('');
}

export function parseRole(value: string): AgentRole {
  if (!value || !value.trim()) return READ_WRITE;
  const v = value.trim().toLowerCase();

  // Explicit 4-, 5- or 6-char format (5th slot = docker, 6th = scripts)
  if (/^[r\-][w\-][x\-][h\-][d\-]?[s\-]?$/.test(v) && v.length >= 4 && v.length <= 6) {
    return {
      read: v[0] === 'r',
      write: v[1] === 'w',
      execute: v[2] === 'x',
      http: v[3] === 'h',
      docker: v[4] === 'd',
      scripts: v[5] === 's',
    };
  }

  // Short forms. Note: 'rwxh' deliberately does NOT include docker — spawning
  // containers is its own grant ('rwxhd'), matching the master's D flag.
  switch (v) {
    case 'r': return READ_ONLY;
    case 'rw': return READ_WRITE;
    case 'rwx': return READ_WRITE_EXECUTE;
    case 'rwxh': return { read: true, write: true, execute: true, http: true, docker: false, scripts: false };
    case 'rwxhd': return { read: true, write: true, execute: true, http: true, docker: true, scripts: false };
    case 'rwxhds': return FULL;
    default:
      throw new Error(`Invalid role '${value}'. Use rwxhds flags (r, rw, rwx, rwxh, rwxhd, rwxhds or rw---).`);
  }
}
