/**
 * Prompts an application brings with it (docs/plans/explorer-architecture-fit-2026-10-15.md,
 * Phase 2 item 6). An application's manifest may declare `agentProtocol.prompts`:
 *
 *   { "name": "structure-pass", "title": "...", "description": "...",
 *     "arguments": [{ "name": "scope", "description": "...", "required": false }],
 *     "requiresTools": ["refine_model", "curate_model"],
 *     "text": "Run a structure pass{{#model}} in model \"{{model}}\"{{/model}} on ..." }
 *
 * The server reads them from the NetHub catalog (the `default` model, always loaded; probing
 * every allowed model would load cataloged ones) and registers a prompt only where every tool it
 * names is registered, so a method's prompts appear exactly when its tools do. A built-in prompt
 * of the same name wins; the application's prompt is then registered as `<application>-<name>`.
 *
 * Templates: `{{name}}` is the argument's value, `{{#name}}...{{/name}}` is kept only when the
 * argument is given, `{{^name}}...{{/name}}` only when it is not, and `{{#name=~regex}}...{{/name}}`
 * (or `{{^name=~regex}}`) only when the value matches (does not match) the regular expression.
 * Sections of the same name do not nest. Every prompt gets an optional `model` argument.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { log } from './logger.js';

export interface AppPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface AppPrompt {
  application: string;
  name: string;
  title?: string;
  description?: string;
  arguments: AppPromptArgument[];
  requiresTools: string[];
  text: string;
}

/** Applications whose prompts this server now carries itself (refinement-prompts.ts): their catalog copies are not registered again. */
const RETIRED_INTO_CORE = new Set(['refiner']);

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const ARG = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** A template larger than this is refused (the knowledge pack keeps its documents near 8 KB too). */
const MAX_TEXT = 16384;

/** Render a template: sections first, left to right, then values. */
export function renderTemplate(text: string, values: Record<string, string | undefined>): string {
  const given = (k: string) => {
    const v = values[k];
    return v != null && String(v).trim() !== '';
  };
  const holds = (k: string, pattern: string | undefined) => {
    if (pattern === undefined) return given(k);
    if (!given(k)) return false;
    try {
      return new RegExp(pattern).test(String(values[k]).trim());
    } catch {
      return false;
    }
  };
  let out = text;
  for (let guard = 0; guard < 256; guard++) {
    const m = /\{\{([#^])([A-Za-z][A-Za-z0-9_]*)(?:=~([^}]*))?\}\}([\s\S]*?)\{\{\/\2\}\}/.exec(out);
    if (!m) break;
    const keep = m[1] === '#' ? holds(m[2], m[3]) : !holds(m[2], m[3]);
    out = out.slice(0, m.index) + (keep ? m[4] : '') + out.slice(m.index + m[0].length);
  }
  return out.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, k: string) => (given(k) ? String(values[k]).trim() : ''));
}

/** The valid prompts an application manifest declares; anything malformed is skipped with a log line. */
export function promptsOfManifest(application: string, manifest: any): AppPrompt[] {
  const declared = manifest?.agentProtocol?.prompts;
  if (!Array.isArray(declared)) return [];
  const out: AppPrompt[] = [];
  for (const p of declared) {
    const name = String(p?.name ?? '');
    const text = typeof p?.text === 'string' ? p.text : '';
    if (!NAME.test(name) || !text.trim() || text.length > MAX_TEXT) {
      log.warn(`[app-prompts] ${application}: prompt '${name}' skipped (name a-z0-9-, text 1..${MAX_TEXT} chars)`);
      continue;
    }
    const args: AppPromptArgument[] = (Array.isArray(p.arguments) ? p.arguments : [])
      .filter((a: any) => ARG.test(String(a?.name ?? '')) && a.name !== 'model')
      .map((a: any) => ({ name: String(a.name), description: a.description ? String(a.description) : undefined, required: a.required === true }));
    out.push({
      application,
      name,
      title: p.title ? String(p.title) : undefined,
      description: p.description ? String(p.description) : undefined,
      arguments: args,
      requiresTools: (Array.isArray(p.requiresTools) ? p.requiresTools : []).map(String),
      text,
    });
  }
  return out;
}

/** Every application prompt in the NetHub catalog (latest version of each application). */
export async function loadAppPrompts(ctx: AppContext): Promise<AppPrompt[]> {
  const catalog: any = await ctx.master.get('/hub/catalog?kind=application&limit=200');
  const artifacts: any[] = Array.isArray(catalog?.artifacts) ? catalog.artifacts : [];
  const out: AppPrompt[] = [];
  for (const a of artifacts) {
    const name = String(a?.name ?? '');
    const version = String(a?.latestVersion ?? '');
    if (!name || !version) continue;
    try {
      const doc: any = await ctx.master.get(`/hub/artifacts/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`);
      out.push(...promptsOfManifest(name, doc?.applicationManifest));
    } catch (err: any) {
      log.warn(`[app-prompts] ${name}@${version} unreadable: ${err?.message ?? err}`);
    }
  }
  return out;
}

type Listener = (prompts: AppPrompt[]) => void;

/** The process-wide cache: one hub read serves every server (HTTP builds one per request). */
class AppPromptCache {
  prompts: AppPrompt[] | null = null;
  private readonly listeners = new Set<Listener>();

  set(prompts: AppPrompt[]): void {
    this.prompts = prompts;
    for (const l of [...this.listeners]) l(prompts);
  }

  /** Call back now when loaded, and again whenever the cache changes, until the returned stop. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.prompts) listener(this.prompts);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.prompts = null;
    this.listeners.clear();
  }
}

export const appPromptCache = new AppPromptCache();

let refreshing = false;

/** Load once at process start, retry with backoff until the hub answers, then refresh every 10 minutes. */
export function startAppPromptRefresh(ctx: AppContext): void {
  if (refreshing) return;
  refreshing = true;
  const delays = [5_000, 15_000, 30_000, 60_000];
  let attempt = 0;
  const run = async () => {
    let next = 600_000;
    try {
      const prompts = await loadAppPrompts(ctx);
      const before = JSON.stringify(appPromptCache.prompts);
      if (before !== JSON.stringify(prompts)) {
        appPromptCache.set(prompts);
        log.info(`[app-prompts] ${prompts.length} application prompt(s): ${prompts.map((p) => `${p.application}/${p.name}`).join(', ') || 'none'}`);
      }
      attempt = 0;
    } catch (err: any) {
      next = delays[Math.min(attempt++, delays.length - 1)];
      log.warn(`[app-prompts] hub not readable yet (${err?.message ?? err}); retry in ${next / 1000} s`);
    }
    const timer = setTimeout(run, next);
    timer.unref?.();
  };
  void run();
}

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** Register the cached application prompts on this server, now and whenever the cache changes. */
export function registerAppPrompts(server: McpServer, _ctx: AppContext): void {
  const registered = new Set<string>();
  const stop = appPromptCache.subscribe((prompts) => {
    const tools = new Set(Object.keys((server as any)._registeredTools ?? {}));
    for (const p of prompts) {
      const key = `${p.application}/${p.name}`;
      if (registered.has(key) || RETIRED_INTO_CORE.has(p.application)) continue;
      if (!p.requiresTools.every((t) => tools.has(t))) continue;
      const existing = new Set(Object.keys((server as any)._registeredPrompts ?? {}));
      const name = existing.has(p.name) ? `${p.application}-${p.name}` : p.name;
      if (existing.has(name)) continue;
      const argsSchema: Record<string, z.ZodTypeAny> = {};
      for (const a of p.arguments) {
        const base = z.string().describe(a.description ?? a.name);
        argsSchema[a.name] = a.required ? base : base.optional();
      }
      argsSchema.model = z.string().optional().describe('Target model when this connection allows several');
      server.registerPrompt(
        name,
        {
          title: p.title ?? name,
          description: `${p.description ?? p.title ?? name} (from the ${p.application} application)`,
          argsSchema: argsSchema as any,
        },
        ((args: Record<string, string | undefined>) => userMessage(renderTemplate(p.text, args ?? {}))) as any,
      );
      registered.add(key);
    }
  });
  const close = server.close.bind(server);
  server.close = async () => {
    stop();
    return close();
  };
}
