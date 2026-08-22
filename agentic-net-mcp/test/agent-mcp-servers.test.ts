import { describe, expect, it } from 'vitest';
import { buildInscription, hasMcpFlag, resolveAgentRole, withMcpFlag, withoutMcpFlag } from '../src/inscriptions.js';
import { describeSelf, selfUrlFor, SELF_CREDENTIAL_KEY } from '../src/tools/mcp-servers.js';
import type { McpConfig } from '../src/config.js';

function config(over: Partial<McpConfig> = {}): McpConfig {
  return {
    gatewayUrl: 'http://localhost:0',
    models: ['m1'],
    mode: 'rw',
    session: 'mcp',
    nodeHost: 'localhost:8080',
    transport: 'stdio',
    httpPort: 8091,
    llmProvider: 'claude-code',
    llmTier: 'medium',
    allowModelCreate: false,
    persistedModels: [],
    allowlistPath: '/tmp/agenticnets-test-allowlist.json',
    persistAllowlist: false,
    ...over,
  };
}

/** describeSelf only reads ctx.config, so a bare object is a faithful stand-in for AppContext. */
const ctxWith = (over: Partial<McpConfig> = {}) => ({ config: config(over) }) as any;

describe('the m flag is added where a declaration implies it', () => {
  it('pads every accepted short/positional form to eleven slots with m last', () => {
    // The engine's 11-slot regex demands each letter in its own position, so padding is only
    // correct because every accepted form is a prefix over the same rwxhludctsm order.
    expect(withMcpFlag('r')).toBe('r---------m');
    expect(withMcpFlag('rw')).toBe('rw--------m');
    expect(withMcpFlag('rwxhl')).toBe('rwxhl-----m');
    expect(withMcpFlag('rw--')).toBe('rw--------m');
    expect(withMcpFlag('r--hl')).toBe('r--hl-----m');
    expect(withMcpFlag('rwxhlud-ts')).toBe('rwxhlud-tsm');
    expect(withMcpFlag(undefined)).toBe('rw--------m');
  });

  it('is idempotent on a role that already grants MCP', () => {
    expect(withMcpFlag('r---------m')).toBe('r---------m');
    expect(hasMcpFlag('r---------m')).toBe(true);
    // 10 chars is the pre-MCP positional form — it must NOT read as granting m.
    expect(hasMcpFlag('rwxhlud-ts')).toBe(false);
    expect(hasMcpFlag('rw')).toBe(false);
  });

  it('round-trips: detaching the last server leaves the role it started with', () => {
    // attach/remove must be a true inverse, or a detached lane keeps advertising external reach.
    for (const role of ['rw--l-----', 'rwxhlud-ts', 'r---------']) {
      expect(withoutMcpFlag(withMcpFlag(role))).toBe(role);
    }
    // Short forms normalise to their positional equivalent, which is the same capability set.
    expect(withoutMcpFlag(withMcpFlag('rw'))).toBe('rw--------');
    // A role that never had the flag is returned untouched.
    expect(withoutMcpFlag('rwxhl---t')).toBe('rwxhl---t');
  });

  it('leaves the role alone when nothing is declared', () => {
    expect(resolveAgentRole('rw', undefined)).toBe('rw');
    expect(resolveAgentRole('rw', [])).toBe('rw');
  });

  it('grants the flag when servers are declared', () => {
    expect(resolveAgentRole('rwxh', [{ name: 's', url: 'http://x/mcp' }])).toBe('rwxh------m');
    expect(resolveAgentRole(undefined, [{ name: 's', url: 'http://x/mcp' }])).toBe('rw--------m');
  });

  it('rejects an explicit denial alongside a declaration instead of picking a side', () => {
    expect(() => resolveAgentRole('rwxh-------', [{ name: 's', url: 'http://x/mcp' }])).toThrow(
      /explicitly denies MCP/,
    );
  });
});

describe('buildAgentInscription carries MCP through', () => {
  const base = { id: 't-a', host: 'm@h:8080', inputPlace: 'p-in', outputPlace: 'p-out' } as const;

  it('a declared server arrives with a role that can actually call it', () => {
    const ins: any = buildInscription('agent', {
      ...base,
      role: 'rwxh',
      mcp: [{ name: 'tools', url: 'https://tools.example.com/mcp', auth: { credentialKey: 'TOOLS_TOKEN' } }],
    });
    expect(ins.action.role).toBe('rwxh------m');
    // The root-level copy is decorative but must never contradict the one master reads.
    expect(ins.role).toBe(ins.action.role);
    expect(ins.action.mcp).toHaveLength(1);
    expect(ins.action.mcp[0].auth.credentialKey).toBe('TOOLS_TOKEN');
  });

  it('an agent without MCP keeps its exact role', () => {
    const ins: any = buildInscription('agent', { ...base, role: 'rwxhl---t' });
    expect(ins.action.role).toBe('rwxhl---t');
    expect(ins.action.mcp).toBeUndefined();
  });

  it('still refuses an inline secret in the auth block', () => {
    expect(() =>
      buildInscription('agent', {
        ...base,
        mcp: [{ name: 'tools', url: 'https://tools.example.com/mcp', auth: { credentialKey: 'K', token: 'sk-live' } }],
      }),
    ).toThrow(/inline secret/);
  });
});

describe('describing this server as something an agent can be given', () => {
  it('a stdio process says it cannot be handed over, and why', () => {
    const self = describeSelf(ctxWith({ transport: 'stdio' }));
    expect(self.attachable).toBe(false);
    expect(self.reason).toMatch(/stdio/);
    expect(self.url).toBeUndefined();
  });

  it('an http process returns a declaration that is ready to use', () => {
    const self = describeSelf(ctxWith({ transport: 'http', httpToken: 'secret-token', models: ['m1', 'm2'] }));
    expect(self.attachable).toBe(true);
    expect(self.declaration).toEqual({
      name: 'agenticnets',
      url: 'http://127.0.0.1:8091/mcp',
      auth: { type: 'bearer', credentialKey: SELF_CREDENTIAL_KEY },
    });
    expect(self.role).toBe('r---------m');
    // The scope surprise has to be stated: writes land in the TARGET server's session/allowlist.
    expect(self.reach.models).toEqual(['m1', 'm2']);
    expect(self.reach.session).toBe('mcp');
  });

  it('never leaks the bearer token into the description', () => {
    const self = describeSelf(ctxWith({ transport: 'http', httpToken: 'secret-token' }));
    expect(JSON.stringify(self)).not.toContain('secret-token');
  });

  it('honours an operator-pinned URL for the master-cannot-reach-loopback case', () => {
    const cfg = config({ transport: 'http', httpToken: 't', selfUrl: 'http://agentic-net-mcp:8091/mcp' });
    expect(selfUrlFor(cfg)).toBe('http://agentic-net-mcp:8091/mcp');
    expect(describeSelf({ config: cfg } as any).urlNote).toMatch(/pinned/);
  });
});
