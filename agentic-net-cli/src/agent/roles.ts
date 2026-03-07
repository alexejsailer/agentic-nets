import { AgentTool } from './tools.js';

/**
 * Unix-like permission model for agent access control.
 * R=read, W=write, X=execute, H=http.
 */
export interface AgentRole {
  read: boolean;
  write: boolean;
  execute: boolean;
  http: boolean;
}

// Named constants
export const READ_ONLY: AgentRole = { read: true, write: false, execute: false, http: false };
export const READ_WRITE: AgentRole = { read: true, write: true, execute: false, http: false };
export const READ_WRITE_EXECUTE: AgentRole = { read: true, write: true, execute: true, http: false };
export const FULL: AgentRole = { read: true, write: true, execute: true, http: true };

// Tool groupings
const READ_TOOLS = new Set<AgentTool>([
  'QUERY_TOKENS', 'LIST_PLACES', 'GET_PLACE_INFO', 'GET_PLACE_CONNECTIONS', 'GET_TRANSITION', 'VERIFY_RUNTIME_BINDINGS',
  'GET_NET_STRUCTURE', 'VERIFY_NET', 'EXPORT_PNML',
  'LIST_ALL_SESSIONS', 'LIST_ALL_INSCRIPTIONS', 'LIST_SESSION_NETS',
  'EXTRACT_TOKEN_CONTENT',
  'REGISTRY_LIST_IMAGES', 'REGISTRY_GET_IMAGE_INFO',
  'DRY_RUN_TRANSITION',
  'VERIFY_INSCRIPTION', 'DIAGNOSE_TRANSITION',
]);

const WRITE_TOOLS = new Set<AgentTool>([
  'CREATE_TOKEN', 'DELETE_TOKEN', 'CREATE_RUNTIME_PLACE',
  'CREATE_NET', 'DELETE_NET',
  'CREATE_PLACE', 'CREATE_TRANSITION', 'CREATE_ARC',
  'DELETE_PLACE', 'DELETE_ARC', 'SET_INSCRIPTION', 'EMIT_MEMORY', 'NET_DOCTOR', 'ADAPT_INSCRIPTIONS',
]);

const EXECUTE_TOOLS = new Set<AgentTool>([
  'DEPLOY_TRANSITION', 'START_TRANSITION', 'STOP_TRANSITION', 'FIRE_ONCE', 'EXECUTE_TRANSITION', 'EXECUTE_TRANSITION_SMART',
  'DOCKER_RUN', 'DOCKER_STOP', 'DOCKER_LIST', 'DOCKER_LOGS',
]);

const CONTROL_TOOLS = new Set<AgentTool>(['THINK', 'DONE', 'FAIL']);

export function getAvailableTools(role: AgentRole): Set<AgentTool> {
  const tools = new Set<AgentTool>(CONTROL_TOOLS);
  if (role.read) READ_TOOLS.forEach(t => tools.add(t));
  if (role.write) WRITE_TOOLS.forEach(t => tools.add(t));
  if (role.execute) EXECUTE_TOOLS.forEach(t => tools.add(t));
  if (role.http) tools.add('HTTP_CALL');
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
  ].join('');
}

export function parseRole(value: string): AgentRole {
  if (!value || !value.trim()) return READ_WRITE;
  const v = value.trim().toLowerCase();

  // Explicit 4-char format
  if (v.length === 4 && /^[r\-][w\-][x\-][h\-]$/.test(v)) {
    return {
      read: v[0] === 'r',
      write: v[1] === 'w',
      execute: v[2] === 'x',
      http: v[3] === 'h',
    };
  }

  // Short forms
  switch (v) {
    case 'r': return READ_ONLY;
    case 'rw': return READ_WRITE;
    case 'rwx': return READ_WRITE_EXECUTE;
    case 'rwxh': return FULL;
    default:
      throw new Error(`Invalid role '${value}'. Use rwxh flags (r, rw, rwx, rwxh or rw--).`);
  }
}
