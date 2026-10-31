/**
 * The Explorer's refinement is part of the core since master 2.62: its routes live under
 * /api/explorer/{model}/refinement, and its marks, notes and questions are written through
 * /refinement/actions/{action}. An older master answers only the paths of the review method
 * (/curation, /worklist, /handover, the application actions of Curation and Interview), so every
 * call here tries the new route first and asks the old one only when the master has no such route.
 */
import type { AppContext } from '../context.js';

/** New sub-path -> the path an older master served the same answer at. */
const LEGACY: Record<string, string> = {
  '/review': '/curation',
  '/run': '/handover',
  '/run/config': '/handover/config',
};

function legacySub(sub: string): string {
  return LEGACY[sub] ?? sub;
}

/** Spring's own 404 body (no handler for the path): this master has no such route. */
export function routeMissing(err: any): boolean {
  if (err?.status !== 404) return false;
  const body = typeof err?.body === 'string' ? err.body : JSON.stringify(err?.body ?? '');
  return /"error"\s*:\s*"Not Found"/.test(body) && /"path"\s*:/.test(body);
}

/** `/explorer/{m}/refinement{sub}`, or the old path for an older master. */
export function refinementPath(model: string, sub: string, legacy = false): string {
  const m = encodeURIComponent(model);
  return legacy ? `/explorer/${m}${legacySub(sub)}` : `/explorer/${m}/refinement${sub}`;
}

function query(model: string, params: Record<string, string | number | boolean | undefined> = {}): Record<string, string> {
  const q: Record<string, string> = { modelId: model };
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) q[k] = String(v);
  return q;
}

/**
 * One call to a refinement route; an older master is asked at its old path. A read carries its
 * parameters in the path (as the review tools always sent them), a write as the query.
 */
export async function refinementCall(ctx: AppContext, method: 'GET' | 'POST' | 'DELETE', model: string, sub: string,
                                     body?: unknown, params: Record<string, string | number | boolean | undefined> = {}): Promise<any> {
  const q = query(model, params);
  const send = (path: string) => method === 'GET'
    ? ctx.client.masterApi(method, `${path}?${new URLSearchParams(q).toString()}`)
    : ctx.client.masterApi(method, path, body, q);
  try {
    return await send(refinementPath(model, sub));
  } catch (err: any) {
    if (!routeMissing(err)) throw err;
    return send(refinementPath(model, sub, true));
  }
}

/**
 * A mark, note, pass or question through the refinement's guarded action. An older master has no
 * such route: there the same action is the named application's (Curation or Interview), as before.
 */
export async function refinementAction(ctx: AppContext, model: string, legacyApplication: string, action: string,
                                       input: Record<string, unknown>, idempotencyKey?: string): Promise<any> {
  const q = idempotencyKey ? { idempotencyKey } : undefined;
  const m = encodeURIComponent(model);
  try {
    return await ctx.client.masterApi('POST', `/explorer/${m}/refinement/actions/${encodeURIComponent(action)}`, input, q);
  } catch (err: any) {
    if (!routeMissing(err)) throw err;
    return ctx.client.masterApi('POST',
      `/applications/${m}/${encodeURIComponent(legacyApplication)}/actions/${encodeURIComponent(action)}`, input, q);
  }
}
