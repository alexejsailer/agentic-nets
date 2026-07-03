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
  it('injects the resolved model and returns text content', async () => {
    const handler = vi.fn(async (model: string) => ({ got: model }));
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, handler);
    const res = await wrapped({});
    expect(handler).toHaveBeenCalledWith('m1', {});
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ got: 'm1' });
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
    const err = Object.assign(new Error('Gateway 503: down'), { name: 'GatewayError', status: 503 });
    const wrapped = wrapTool(scope, 'rw', { name: 't', mutates: false }, async () => {
      throw err;
    });
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.code).toBe('GATEWAY_ERROR');
    expect(body.status).toBe(503);
  });
});
