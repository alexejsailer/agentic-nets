/**
 * TemplateExecutor — TS port of the proven python builder flow
 * (core/scripts deploy-*-net.py): ensure session tree → designtime elements →
 * runtime places → assign + designtime inscription leaf → seed-if-empty →
 * start. Idempotent: designtime 409/422 collisions are recorded as `skipped`.
 */
import type { AppContext } from '../context.js';
import { persistInscriptionLeaf } from '../inscriptions.js';
import { ensureChild } from '../tree.js';
import { validateBlueprint, type TemplateBlueprint } from './types.js';

export interface DeployReport {
  template: string;
  model: string;
  netId: string;
  created: string[];
  skipped: string[];
  seeded: string[];
  started: string[];
}

function substituteParams(json: string, params: Record<string, string>): string {
  return json.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (whole, key) => (key in params ? params[key] : whole));
}

function isDuplicate(err: any): boolean {
  return err?.name === 'GatewayError' && (err.status === 409 || err.status === 422 || err.status === 400);
}

export class TemplateExecutor {
  constructor(
    private readonly ctx: AppContext,
    private readonly model: string,
  ) {}

  async deploy(blueprint: TemplateBlueprint, params: Record<string, string> = {}): Promise<DeployReport> {
    // Resolve ${param} against defaults + caller params, then re-validate the
    // concrete blueprint (validation must see the final cron strings etc.).
    const defaults: Record<string, string> = {};
    for (const [k, spec] of Object.entries(blueprint.params ?? {})) {
      if (spec.default !== undefined) defaults[k] = spec.default;
    }
    const merged = { ...defaults, ...params };
    const bp: TemplateBlueprint = JSON.parse(substituteParams(JSON.stringify(blueprint), merged));
    validateBlueprint(bp);

    const report: DeployReport = {
      template: bp.id,
      model: this.model,
      netId: bp.net.netId,
      created: [],
      skipped: [],
      seeded: [],
      started: [],
    };
    const { ctx, model } = this;
    const session = ctx.config.session;
    const host = ctx.hostFor(model);

    await this.ensureSessionTree();

    const tryCreate = async (label: string, fn: () => Promise<any>) => {
      try {
        await fn();
        report.created.push(label);
      } catch (err) {
        if (isDuplicate(err)) report.skipped.push(label);
        else throw err;
      }
    };

    // 1. Designtime structure
    await tryCreate(`net:${bp.net.netId}`, () =>
      ctx.master.createNet({ modelId: model, sessionId: session, netId: bp.net.netId, name: bp.net.name }),
    );
    for (const p of bp.places) {
      await tryCreate(`place:${p.placeId}`, () =>
        ctx.master.createPlace(bp.net.netId, {
          modelId: model,
          sessionId: session,
          placeId: p.placeId,
          label: p.label,
          x: p.x,
          y: p.y,
          tokens: 0,
        }),
      );
    }
    for (const t of bp.transitions) {
      await tryCreate(`transition:${t.transitionId}`, () =>
        ctx.master.createTransition(bp.net.netId, {
          modelId: model,
          sessionId: session,
          transitionId: t.transitionId,
          label: t.label,
          x: t.x,
          y: t.y,
        }),
      );
    }
    for (const a of bp.arcs) {
      await tryCreate(`arc:${a.arcId}`, () =>
        ctx.master.createArc(bp.net.netId, {
          modelId: model,
          sessionId: session,
          arcId: a.arcId,
          sourceId: a.sourceId,
          targetId: a.targetId,
        }),
      );
    }

    // 2. Runtime places (presets only resolve against existing runtime containers)
    for (const p of bp.places) {
      const res = await ctx.executorFor(model).execute('CREATE_RUNTIME_PLACE', { placeId: p.placeId });
      if (!res.success) throw new Error(`runtime place ${p.placeId}: ${res.error}`);
    }

    // 3. Assign inscriptions (host injected) + persist designtime leaves
    for (const t of bp.transitions) {
      const inscription = this.withHost(t.inscription, host, t.transitionId);
      await ctx.master.assignTransition({
        modelId: model,
        transitionId: t.transitionId,
        agentId: t.agentId,
        inscription,
        credentials: {},
      });
      await persistInscriptionLeaf(ctx, model, bp.net.netId, t.transitionId, inscription);
    }

    // 4. Seed tokens — only into EMPTY places (re-deploys never duplicate seeds)
    for (const seed of bp.seedTokens ?? []) {
      const count = await ctx.node
        .getChildrenCount(model, `root/workspace/places/${seed.placeId}`)
        .catch(() => 0);
      if (count > 0) {
        report.skipped.push(`seed:${seed.placeId}`);
        continue;
      }
      const res = await ctx.executorFor(model).execute('CREATE_TOKEN', {
        placePath: `root/workspace/places/${seed.placeId}`,
        name: seed.name,
        data: seed.data,
      });
      if (!res.success) throw new Error(`seed ${seed.placeId}: ${res.error}`);
      report.seeded.push(seed.placeId);
    }

    // 5. Start (assign stopped everything; links stay unstarted by contract)
    for (const t of bp.transitions) {
      if (!t.start) continue;
      await ctx.master.startTransition(t.transitionId, model);
      report.started.push(t.transitionId);
    }

    return report;
  }

  /** Inject host into every preset/postset lacking one; pin inscription.id. */
  private withHost(inscription: Record<string, any>, host: string, transitionId: string): Record<string, any> {
    const ins = JSON.parse(JSON.stringify(inscription));
    ins.id = transitionId;
    for (const group of ['presets', 'postsets']) {
      for (const entry of Object.values<any>(ins[group] ?? {})) {
        if (!entry.host) entry.host = host;
      }
    }
    return ins;
  }

  /** Port of ensure_named_child: walk/create the session + places containers. */
  private async ensureSessionTree(): Promise<void> {
    const { ctx, model } = this;
    await ensureChild(ctx, model, 'root', 'workspace');
    await ensureChild(ctx, model, 'root/workspace', 'sessions');
    await ensureChild(ctx, model, 'root/workspace/sessions', ctx.config.session);
    await ensureChild(ctx, model, `root/workspace/sessions/${ctx.config.session}`, 'workspace-nets');
    await ensureChild(ctx, model, 'root/workspace', 'places');
  }
}
