/**
 * Multi-tenant contexts. In tenancy mode every HTTP request carries a tenant key as its bearer;
 * this module turns a key into THAT tenant's AppContext: its own gateway client (signed in with
 * its key, token in memory), its own model allowlist (the models the gateway lists for it), its
 * own external-fire state. Nothing is shared between tenants except the code.
 *
 * The gateway is the fence: a tenant token reaches only <tenant>-* models whatever this process
 * does. The allowlist here keeps a tenant's client from even trying.
 */
import { createHash } from 'node:crypto';
import type { McpConfig } from './config.js';
import { AppContext } from './context.js';
import { log } from './logger.js';

const KEY = /^ant_([a-z][a-z0-9]{2,23})_[0-9a-f]{32}$/;
/** How long a tenant's context is reused before its model list is read again. */
const TTL_MS = 5 * 60_000;
const MAX_CONTEXTS = 500;

interface Entry {
  ctx: AppContext;
  at: number;
}

export class TenantKeyError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

export function tenantOfKey(key: string): string | null {
  const m = KEY.exec(key.trim());
  return m ? m[1] : null;
}

export class TenantContexts {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<AppContext>>();

  constructor(private readonly base: McpConfig) {}

  /** The tenant's context for this bearer value, building it on first use. */
  async resolve(authorization: string | undefined): Promise<AppContext> {
    const key = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const tenant = tenantOfKey(key);
    if (!tenant) {
      throw new TenantKeyError('A tenant key (ant_<tenant>_<32 hex>) is required as the bearer token.');
    }
    const id = createHash('sha256').update(key).digest('hex');
    const hit = this.entries.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.ctx;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const build = this.build(tenant, key)
      .then((ctx) => {
        this.entries.set(id, { ctx, at: Date.now() });
        if (this.entries.size > MAX_CONTEXTS) {
          const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) this.entries.delete(oldest[0]);
        }
        return ctx;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, build);
    return build;
  }

  private async build(tenant: string, key: string): Promise<AppContext> {
    const probe = new AppContext({ ...this.base, tenant, tenantKey: key, models: [`${tenant}-main`] });
    let models: string[];
    try {
      const list: any = await probe.client.masterApi('GET', '/admin/models');
      models = (Array.isArray(list) ? list : []).map((m: any) => String(m.modelId ?? m.id))
        .filter((m: string) => m.startsWith(`${tenant}-`));
    } catch (err: any) {
      const status = err?.status ?? 0;
      if (status === 401 || String(err?.message ?? '').includes('Authentication failed')) {
        throw new TenantKeyError('This tenant key was not accepted (unknown, rotated or disabled).');
      }
      throw new TenantKeyError(`The platform could not be reached for tenant '${tenant}': ${err?.message ?? err}`, 503);
    }
    if (models.length === 0 && this.base.tenancyAutoModel) {
      const first = `${tenant}-main`;
      try {
        await probe.client.masterApi('POST', '/admin/models', {
          modelId: first,
          name: `${tenant} main`,
          description: `First model of tenant '${tenant}', created on its first MCP connection`,
        });
        models = [first];
        log.info(`[tenancy] created ${first} for a new tenant`);
      } catch (err: any) {
        log.warn(`[tenancy] could not create ${first}: ${err?.message ?? err}`);
      }
    }
    if (models.length === 0) models = [`${tenant}-main`];
    // Default model first: the oldest-named "main" when present, else the first listed.
    models.sort((a, b) => (a === `${tenant}-main` ? -1 : b === `${tenant}-main` ? 1 : a.localeCompare(b)));
    return new AppContext({ ...this.base, tenant, tenantKey: key, models, session: this.base.session });
  }

  /** Forget a tenant's cached context (e.g. after it was rotated); the next request builds it again. */
  forget(authorization: string): void {
    const key = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    this.entries.delete(createHash('sha256').update(key).digest('hex'));
  }
}
