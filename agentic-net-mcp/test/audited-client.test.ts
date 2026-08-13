/**
 * AuditedGatewayClient — node event execution must travel via master's events
 * proxy (which publishes to the model event line), while every other node
 * call keeps its direct /node-api route. Guards the event_trail provenance
 * contract for all mutating MCP tools.
 */
import { describe, it, expect } from 'vitest';
import { AuditedGatewayClient } from '../src/context.js';

interface RecordedRequest {
  method: string;
  url: string;
  body?: any;
}

function clientWithRecorder(): { client: AuditedGatewayClient; calls: RecordedRequest[] } {
  const client = new AuditedGatewayClient({
    gatewayUrl: 'http://gw.test:8083',
    profileName: 'test',
  }, 'mcp-test-session');
  const calls: RecordedRequest[] = [];
  // request() is the single private transport method both masterApi and
  // nodeApi delegate to — stubbing it keeps the test fully hermetic.
  (client as any).request = async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    return { success: true };
  };
  return { client, calls };
}

describe('AuditedGatewayClient', () => {
  it('reroutes POST /events/execute/{modelId} through the master events proxy', async () => {
    const { client, calls } = clientWithRecorder();
    const body = { events: [{ eventType: 'createLeaf', parentId: 'p', name: 'token-1' }] };

    await client.nodeApi('POST', '/events/execute/claude-memory', body);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gw.test:8083/api/proxy/events/claude-memory/execute');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      ...body,
      options: { sessionId: 'mcp-test-session', source: 'mcp' },
    });
  });

  it('preserves explicit causal metadata while adding MCP session provenance', async () => {
    const { client, calls } = clientWithRecorder();

    await client.nodeApi('POST', '/events/execute/m1', {
      events: [{ eventType: 'createLeaf' }],
      options: { correlationId: 'fire-7', transitionId: 't-worker' },
    });

    expect(calls[0].body.options).toEqual({
      correlationId: 'fire-7',
      transitionId: 't-worker',
      sessionId: 'mcp-test-session',
      source: 'mcp',
    });
  });

  it('leaves non-event node calls on the direct /node-api route', async () => {
    const { client, calls } = clientWithRecorder();

    await client.nodeApi('GET', '/models/claude-memory/version');
    await client.nodeApi('POST', '/arcql/query/claude-memory', { query: 'FROM $' });

    expect(calls.map((c) => c.url)).toEqual([
      'http://gw.test:8083/node-api/models/claude-memory/version',
      'http://gw.test:8083/node-api/arcql/query/claude-memory',
    ]);
  });

  it('does not reroute GET on the events path or nested event paths', async () => {
    const { client, calls } = clientWithRecorder();

    await client.nodeApi('GET', '/events/execute/claude-memory');
    await client.nodeApi('POST', '/events/execute/claude-memory/extra');

    expect(calls.map((c) => c.url)).toEqual([
      'http://gw.test:8083/node-api/events/execute/claude-memory',
      'http://gw.test:8083/node-api/events/execute/claude-memory/extra',
    ]);
  });

  it('keeps master API calls untouched', async () => {
    const { client, calls } = clientWithRecorder();

    await client.masterApi('GET', '/event-line/claude-memory');

    expect(calls[0].url).toBe('http://gw.test:8083/api/event-line/claude-memory');
  });
});
