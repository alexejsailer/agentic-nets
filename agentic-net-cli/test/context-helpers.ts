import type { ExecutionFrame } from '../src/agent/context.js';

/** One installed context for the stub node tree. */
export interface StubContext {
  sessionId: string;
  manifest: Record<string, any>;
  origin?: Record<string, any>;
}

/** One kind=link transition for hierarchy tests. */
export interface StubLink {
  transitionId: string;
  relation: string;
  from: string;
  to: string;
  relationSpec?: Record<string, any>;
}

export interface StubOptions {
  contexts?: StubContext[];
  links?: StubLink[];
  /** placeId → token list returned by queryTokens ({results}); a function may throw. */
  tokens?: Record<string, unknown[] | (() => unknown[])>;
  /** Captures every queryTokens invocation for assertions. */
  queries?: Array<{ parentPath: string; query: string; opts: any }>;
  /** agent-manifest of the frame session so resolveOwningAgentFrame stays put. */
  agentManifest?: Record<string, any>;
}

export const FRAME: ExecutionFrame = {
  modelId: 'm1',
  sessionId: 'agent-s1',
  transitionId: 't1',
  agentInstanceId: 'agent-s1',
  taskId: 'task-1',
  correlationId: 'corr-1',
  capabilityProfile: 'token-worker',
};

/** Minimal in-memory NodeApi twin covering exactly what resolveContextCapsule reads. */
export function stubNodeApi(options: StubOptions): any {
  const contexts = options.contexts ?? [];
  const links = options.links ?? [];
  const manifestLeaf = (value: unknown) => ({ properties: { value: JSON.stringify(value) } });
  const agentManifest = options.agentManifest
    ?? { startPlan: [FRAME.transitionId], personas: [] };

  return {
    async getChildren(_modelId: string, path: string): Promise<any[]> {
      if (path === 'root/workspace/sessions') {
        return [{ name: FRAME.sessionId }, ...contexts.map(c => ({ name: c.sessionId }))];
      }
      if (path === `root/workspace/sessions/${FRAME.sessionId}`) {
        return [{ name: 'agent-manifest', ...manifestLeaf(agentManifest) }];
      }
      for (const context of contexts) {
        if (path === `root/workspace/sessions/${context.sessionId}`) {
          const leaves: any[] = [{ name: 'context-manifest', ...manifestLeaf(context.manifest) }];
          if (context.origin) leaves.push({ name: 'context-origin', ...manifestLeaf(context.origin) });
          return leaves;
        }
      }
      if (path === 'root/workspace/transitions') {
        return links.map(link => ({ name: link.transitionId }));
      }
      for (const link of links) {
        if (path === `root/workspace/transitions/${link.transitionId}`) {
          return [{ name: 'inscription', ...manifestLeaf({
            id: link.transitionId,
            kind: 'link',
            relation: link.relation,
            relationSpec: link.relationSpec,
            presets: { a: { placeId: link.from } },
            postsets: { b: { placeId: link.to } },
          }) }];
        }
      }
      return [];
    },
    async queryTokens(_modelId: string, parentPath: string, query: string,
      _format: string, opts: any): Promise<any> {
      options.queries?.push({ parentPath, query, opts });
      const placeId = parentPath.replace('root/workspace/places/', '');
      const source = options.tokens?.[placeId];
      if (typeof source === 'function') return { results: source() };
      return { results: source ?? [] };
    },
  };
}

/** A context manifest with one knowledge store. */
export function manifest(name: string, scope: string, placeId: string,
  hierarchy?: Record<string, any>): Record<string, any> {
  return {
    name,
    scope,
    stores: [{ role: 'knowledge', placeId }],
    ...(hierarchy ? { hierarchy } : {}),
  };
}
