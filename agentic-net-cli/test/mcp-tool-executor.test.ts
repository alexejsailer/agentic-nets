import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../src/agent/tool-executor.js';

type Call = { method: string; path: string; body?: any };

function executorWithRecorder(response: any = { success: true, result: { content: ['ok'] } }) {
  const calls: Call[] = [];
  const client = {
    masterApi: async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      return response;
    },
  };
  return {
    executor: new ToolExecutor(client as any, 'm1', 's1'),
    calls,
  };
}

describe('transition-scoped MCP_CALL', () => {
  it('refuses an unscoped call without contacting master', async () => {
    const { executor, calls } = executorWithRecorder();

    const result = await executor.execute('MCP_CALL', { server: 'docs', tool: 'search' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/transition-scoped/);
    expect(calls).toHaveLength(0);
  });

  it('carries the transition and session context to the master executor', async () => {
    const { executor, calls } = executorWithRecorder();
    const scoped = executor.fork({ sessionId: 's-fire', transitionId: 't-agent' });

    const result = await scoped.execute('MCP_CALL', {
      server: 'docs', tool: 'search', args: { query: 'polling' }, timeoutMs: 2_000,
    });

    expect(result).toEqual({ success: true, data: { content: ['ok'] } });
    expect(calls).toEqual([{
      method: 'POST',
      path: '/agent/tools/MCP_CALL/execute',
      body: {
        modelId: 'm1',
        sessionId: 's-fire',
        transitionId: 't-agent',
        params: {
          server: 'docs', tool: 'search', args: { query: 'polling' }, timeoutMs: 2_000,
        },
      },
    }]);
  });
});
