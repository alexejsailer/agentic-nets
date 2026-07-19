import { describe, expect, it, vi } from 'vitest';
import { resolveModel, scopeFromConfig, wrapTool, ScopeError } from '../src/scope.js';

const scope = scopeFromConfig({ models: ['m1', 'm2'] });

describe('resolveModel', () => {
  it('defaults to the first allowlisted model', () => {
    expect(resolveModel(scope, undefined)).toBe('m1');
    expect(resolveModel(scope, '')).toBe('m1');
  });

  it('passes through allowlisted models', () => {
    expect(resolveModel(scope, 'm2')).toBe('m2');
  });

  it('rejects out-of-allowlist models', () => {
    expect(() => resolveModel(scope, 'other')).toThrow(ScopeError);
  });
});

describe('wrapTool', () => {
  it('injects the resolved model, echoes the effective scope, and returns text content', async () => {
    const handler = vi.fn(async (model: string) => ({ got: model }));
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, handler);
    const res = await wrapped({});
    expect(handler).toHaveBeenCalledWith('m1', {});
    expect(res.isError).toBeUndefined();
    // Scope echo: responses that don't state their model context get it stamped
    // in-band, so a session/model-scoped answer can never read as a global one.
    expect(JSON.parse(res.content[0].text)).toEqual({ got: 'm1', scope: { model: 'm1' } });
  });

  it('never overrides a handler that already states its model context', async () => {
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, async (model: string) => ({ model, x: 1 }));
    const res = await wrapped({});
    expect(JSON.parse(res.content[0].text)).toEqual({ model: 'm1', x: 1 });
  });

  it('rejects a SMUGGLED out-of-allowlist model even if the schema had no model param', async () => {
    const handler = vi.fn();
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, handler);
    const res = await wrapped({ model: 'evil' });
    expect(handler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.code).toBe('MODEL_NOT_ALLOWED');
    expect(body.allowedModels).toEqual(['m1', 'm2']);
  });

  it('rejects mutators in readonly mode BEFORE the handler runs', async () => {
    const handler = vi.fn();
    const wrapped = wrapTool(scope, 'readonly', { name: 'memory_write', mutates: true }, handler);
    const res = await wrapped({ text: 'x' });
    expect(handler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe('READONLY_MODE');
  });

  it('allows readers in readonly mode', async () => {
    const wrapped = wrapTool(scope, 'readonly', { name: 'memory_recall', mutates: false }, async () => 'ok');
    const res = await wrapped({});
    expect(res.isError).toBeUndefined();
  });

  it('maps GatewayError to a tool-level error with status', async () => {
    const err = Object.assign(new Error('Gateway 503: down'), { name: 'GatewayError', status: 503, body: 'down' });
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, async () => {
      throw err;
    });
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.code).toBe('GATEWAY_ERROR');
    expect(body.status).toBe(503);
    expect(body.error).toBe('down');
  });

  it('gives an empty-body 404 an actionable hint instead of a bare status', async () => {
    const err = Object.assign(new Error('Gateway 404: '), { name: 'GatewayError', status: 404, body: '' });
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, async () => {
      throw err;
    });
    const res = await wrapped({});
    const body = JSON.parse(res.content[0].text);
    expect(body.error).toMatch(/not found/i);
    expect(body.error).not.toBe('');
  });

  it('hints at readonly/ArcQL when a 403 has no body', async () => {
    const err = Object.assign(new Error('Gateway 403: '), { name: 'GatewayError', status: 403, body: '' });
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, async () => {
      throw err;
    });
    const res = await wrapped({});
    const body = JSON.parse(res.content[0].text);
    expect(body.error).toMatch(/forbidden/i);
    expect(body.suggestion).toMatch(/readonly/i);
  });

  it('names the failing layer and the attempted path when the error carries one', async () => {
    const err = Object.assign(new Error('Gateway 404 (GET /node-api/admin/models): '), {
      name: 'GatewayError',
      status: 404,
      body: '',
      path: 'GET /node-api/admin/models',
    });
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, async () => {
      throw err;
    });
    const res = await wrapped({ model: 'm2' });
    const body = JSON.parse(res.content[0].text);
    expect(body.layer).toBe('node');
    expect(body.attempted).toBe('GET /node-api/admin/models');
    expect(body.suggestion).toMatch(/create_model|list_models/i);
  });
});
