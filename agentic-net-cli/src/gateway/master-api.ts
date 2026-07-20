import { GatewayClient } from './client.js';

/** Master-proxied API calls (routes through /api/** → master :8082). */
export class MasterApi {
  constructor(private client: GatewayClient) {}

  // ---- Health ----
  async health(): Promise<any> {
    return this.client.masterApi('GET', '/health');
  }

  // ---- Designtime API ----
  async createNet(params: {
    modelId: string;
    sessionId: string;
    netId: string;
    name?: string;
    description?: string;
  }): Promise<any> {
    return this.client.masterApi('POST', '/designtime/nets', params);
  }

  async listNets(modelId: string, sessionId: string): Promise<any> {
    return this.client.masterApi('GET', '/designtime/nets', undefined, { modelId, sessionId });
  }

  async getNet(netId: string, modelId: string, sessionId: string): Promise<any> {
    return this.client.masterApi('GET', `/designtime/nets/${netId}`, undefined, { modelId, sessionId });
  }

  async exportNet(netId: string, modelId: string, sessionId: string): Promise<any> {
    return this.client.masterApi('GET', `/designtime/nets/${netId}/export`, undefined, { modelId, sessionId });
  }

  async createPlace(netId: string, params: {
    modelId: string;
    sessionId: string;
    placeId: string;
    label?: string;
    x?: number;
    y?: number;
    tokens?: number;
  }): Promise<any> {
    return this.client.masterApi('POST', `/designtime/nets/${netId}/places`, params);
  }

  async createTransition(netId: string, params: {
    modelId: string;
    sessionId: string;
    transitionId: string;
    label?: string;
    x?: number;
    y?: number;
  }): Promise<any> {
    return this.client.masterApi('POST', `/designtime/nets/${netId}/transitions`, params);
  }

  async createArc(netId: string, params: {
    modelId: string;
    sessionId: string;
    arcId: string;
    sourceId: string;
    targetId: string;
  }): Promise<any> {
    return this.client.masterApi('POST', `/designtime/nets/${netId}/arcs`, params);
  }

  // ---- Transition lifecycle ----
  async listTransitions(): Promise<any> {
    return this.client.masterApi('GET', '/transitions');
  }

  async getTransition(id: string): Promise<any> {
    return this.client.masterApi('GET', `/transitions/${id}`);
  }

  async startTransition(id: string, modelId: string): Promise<any> {
    return this.client.masterApi('POST', `/transitions/${id}/start`, { modelId });
  }

  async stopTransition(id: string, modelId: string): Promise<any> {
    return this.client.masterApi('POST', `/transitions/${id}/stop`, { modelId });
  }

  async fireOnce(id: string, modelId: string): Promise<any> {
    return this.client.masterApi('POST', `/transitions/${id}/fireOnce`, { modelId });
  }

  /** Deregister a RUNTIME transition entirely (inscription, status, assignment, metrics). */
  async deleteTransition(id: string, modelId: string): Promise<any> {
    return this.client.masterApi('DELETE', `/runtime/transitions/${id}`, undefined, { modelId });
  }

  // ---- Transition credentials (vault-backed; see /transitions/{id}/credentials on master) ----
  /** Store credentials for a transition. Vault-backed when the master has AGENTICOS_VAULT_URL. */
  async setTransitionCredentials(id: string, modelId: string, credentials: Record<string, string>): Promise<any> {
    return this.client.masterApi('POST', `/transitions/${id}/credentials`, credentials, { modelId });
  }

  /** Read credential KEY NAMES + storage backend (plaintext only behind the server reveal gate). */
  async getTransitionCredentials(id: string, modelId: string): Promise<any> {
    return this.client.masterApi('GET', `/transitions/${id}/credentials`, undefined, { modelId });
  }

  /** Revoke a transition's stored credentials (vault entry or legacy encrypted leaf). */
  async deleteTransitionCredentials(id: string, modelId: string): Promise<any> {
    return this.client.masterApi('DELETE', `/transitions/${id}/credentials`, undefined, { modelId });
  }

  async assignTransition(params: {
    modelId: string;
    transitionId: string;
    agentId: string;
    inscription: any;
    credentials?: any;
  }): Promise<any> {
    return this.client.masterApi('POST', '/transitions/assign', params);
  }

  // ---- Executors ----
  /** List registered command executors (ONLINE/STALE, allowedModels). */
  async listExecutors(activeOnly = true, modelId?: string): Promise<any> {
    return this.client.masterApi('GET', '/executors', undefined, {
      activeOnly: String(activeOnly),
      ...(modelId ? { modelId } : {}),
    });
  }

  // ---- Sessions ----
  async createSession(userId: string, sessionId: string, params: {
    naturalLanguageText?: string;
    description?: string;
  }): Promise<any> {
    return this.client.masterApi('POST', `/sessions/${userId}/${sessionId}/nl`, params);
  }

  async listSessions(userId: string): Promise<any> {
    // List sessions by querying node path
    return this.client.masterApi('GET', `/sessions/${userId}`);
  }

  // ---- Package Registry ----
  async createPackage(params: {
    name: string;
    version: string;
    scope: string;
    description?: string;
    tags?: string[];
    readme?: string;
    // Omit source.netId to build a session bundle (all nets in the session).
    source: { modelId: string; sessionId: string; netId?: string };
  }): Promise<any> {
    return this.client.masterApi('POST', '/packages', params);
  }

  async publishPackage(name: string, version: string, modelId: string): Promise<any> {
    return this.client.masterApi('POST', `/packages/${name}/versions/${version}/publish`, { modelId });
  }

  async searchPackages(query?: string, tags?: string, limit?: number, offset?: number): Promise<any> {
    const params: Record<string, string> = {};
    if (query) params.search = query;
    if (tags) params.tags = tags;
    if (limit) params.limit = String(limit);
    if (offset) params.offset = String(offset);
    return this.client.masterApi('GET', '/packages', undefined, params);
  }

  async getPackageInfo(name: string): Promise<any> {
    return this.client.masterApi('GET', `/packages/${name}`);
  }

  async listPackageVersions(name: string): Promise<any> {
    return this.client.masterApi('GET', `/packages/${name}/versions`);
  }

  async getPackageVersion(name: string, version: string): Promise<any> {
    return this.client.masterApi('GET', `/packages/${name}/versions/${version}`);
  }

  /**
   * Upload a pre-built package JSON into the registry. Idempotent upsert — used
   * by `package transfer` to push a package fetched from another master into
   * this one.
   */
  async uploadPackage(name: string, version: string, pkg: any): Promise<any> {
    return this.client.masterApi('PUT', `/packages/${name}/versions/${version}`, pkg);
  }

  async importPackage(name: string, version: string, targetModelId: string, targetSessionId: string): Promise<any> {
    return this.client.masterApi('POST', `/packages/${name}/versions/${version}/import`, {
      targetModelId,
      targetSessionId,
    });
  }

  // ---- NetHub (/api/hub) ----
  async hubPublish(params: {
    kind?: string; // net | session | model | toolnet | tool | catalog | blob | agent | context
    name: string;
    version: string;
    description?: string;
    tags?: string[];
    readme?: string;
    visibility?: string; // public | private
    tokens?: string; // none | config | all
    configPlaces?: string[];
    source: {
      modelId?: string;
      sessionId?: string;
      netId?: string;
      toolId?: string; // kind=tool
      catalogScope?: string; // kind=catalog: global | local
      blobUrns?: string[]; // kind=blob
    };
  }): Promise<any> {
    return this.client.masterApi('POST', '/hub/publish', params);
  }

  async hubCatalog(params?: { kind?: string; search?: string; tags?: string; limit?: number; offset?: number }): Promise<any> {
    const q: Record<string, string> = {};
    if (params?.kind) q.kind = params.kind;
    if (params?.search) q.search = params.search;
    if (params?.tags) q.tags = params.tags;
    if (params?.limit) q.limit = String(params.limit);
    if (params?.offset) q.offset = String(params.offset);
    return this.client.masterApi('GET', '/hub/catalog', undefined, q);
  }

  async hubArtifact(name: string, version: string): Promise<any> {
    return this.client.masterApi('GET', `/hub/artifacts/${name}/versions/${version}`);
  }

  async hubVersions(name: string): Promise<any> {
    return this.client.masterApi('GET', `/hub/artifacts/${name}/versions`);
  }

  async hubUnpublish(name: string, version: string): Promise<any> {
    return this.client.masterApi('DELETE', `/hub/artifacts/${name}/versions/${version}`);
  }

  async hubInstall(params: {
    source?: string; // "local" | remote name
    name: string;
    version: string;
    targetModelId?: string;
    targetSessionId?: string;
    mode?: string; // model-kind: CREATE_NEW | REPLACE
  }): Promise<any> {
    return this.client.masterApi('POST', '/hub/install', params);
  }

  async hubListRemotes(): Promise<any> {
    return this.client.masterApi('GET', '/hub/remotes');
  }

  async hubAddRemote(name: string, url: string): Promise<any> {
    return this.client.masterApi('POST', '/hub/remotes', { name, url });
  }

  async hubRemoveRemote(name: string): Promise<any> {
    return this.client.masterApi('DELETE', `/hub/remotes/${name}`);
  }

  async hubRemoteCatalog(remoteName: string, params?: { kind?: string; search?: string; tags?: string; limit?: number; offset?: number }): Promise<any> {
    const q: Record<string, string> = {};
    if (params?.kind) q.kind = params.kind;
    if (params?.search) q.search = params.search;
    if (params?.tags) q.tags = params.tags;
    if (params?.limit) q.limit = String(params.limit);
    if (params?.offset !== undefined) q.offset = String(params.offset);
    return this.client.masterApi('GET', `/hub/remotes/${remoteName}/catalog`, undefined, q);
  }

  // ---- Agent sessions (installed hub kind=agent templates) ----
  async agentSessions(modelId: string): Promise<any> {
    return this.client.masterApi('GET', `/installed-agents/${modelId}`);
  }

  async agentSessionDescribe(modelId: string, sessionId: string): Promise<any> {
    return this.client.masterApi('GET', `/installed-agents/${modelId}/${sessionId}`);
  }

  async agentSessionStart(modelId: string, sessionId: string, force?: boolean): Promise<any> {
    return this.client.masterApi('POST', `/installed-agents/${modelId}/${sessionId}/start`, undefined,
      force ? { force: 'true' } : undefined);
  }

  async agentSessionStop(modelId: string, sessionId: string): Promise<any> {
    return this.client.masterApi('POST', `/installed-agents/${modelId}/${sessionId}/stop`);
  }

  // ---- Context nets (installed hub kind=context templates) ----
  async contexts(modelId: string): Promise<any> {
    return this.client.masterApi('GET', `/installed-contexts/${modelId}`);
  }

  async contextDescribe(modelId: string, sessionId: string): Promise<any> {
    return this.client.masterApi('GET', `/installed-contexts/${modelId}/${sessionId}`);
  }

  async contextStart(modelId: string, sessionId: string, force?: boolean): Promise<any> {
    return this.client.masterApi('POST', `/installed-contexts/${modelId}/${sessionId}/start`, undefined,
      force ? { force: 'true' } : undefined);
  }

  async contextStop(modelId: string, sessionId: string): Promise<any> {
    return this.client.masterApi('POST', `/installed-contexts/${modelId}/${sessionId}/stop`);
  }

  async contextAttach(modelId: string, sessionId: string, attachment: string, targetPlaceId: string): Promise<any> {
    return this.client.masterApi('POST', `/installed-contexts/${modelId}/${sessionId}/attach`,
      { attachment, targetPlaceId });
  }

  async contextTree(modelId: string, opts: {
    start: string; depth?: number; direction?: string; relations?: string; includeCounts?: boolean;
  }): Promise<any> {
    const query: Record<string, string> = { start: opts.start };
    if (opts.depth !== undefined) query.depth = String(opts.depth);
    if (opts.direction) query.direction = opts.direction;
    if (opts.relations) query.relations = opts.relations;
    if (opts.includeCounts) query.includeCounts = 'true';
    return this.client.masterApi('GET', `/installed-contexts/${modelId}/tree`, undefined, query);
  }

  async contextLink(modelId: string, body: {
    from: string; to: string; relation: string; label?: string; sessionId?: string;
  }): Promise<any> {
    return this.client.masterApi('POST', `/installed-contexts/${modelId}/links`, body);
  }

  async contextCreate(modelId: string, body: Record<string, any>): Promise<any> {
    return this.client.masterApi('POST', `/installed-contexts/${modelId}/contexts`, body);
  }

  async contextAddStore(modelId: string, sessionId: string, body: Record<string, any>): Promise<any> {
    return this.client.masterApi('POST', `/installed-contexts/${modelId}/${sessionId}/stores`, body);
  }

  // ---- Transition validation ----
  async dryRunTransition(transitionId: string, modelId: string): Promise<any> {
    return this.client.masterApi('POST', `/transitions/${transitionId}/dry-run`, undefined, { modelId });
  }

  async verifyInscription(transitionId: string, modelId: string): Promise<any> {
    return this.client.masterApi('POST', `/transitions/${transitionId}/verify-inscription`, undefined, { modelId });
  }

  async diagnoseTransition(transitionId: string, modelId: string): Promise<any> {
    return this.client.masterApi('POST', `/transitions/${transitionId}/diagnose`, undefined, { modelId });
  }

  // ---- Generic HTTP helpers (used by Docker/Registry tools) ----
  async get<T = any>(path: string): Promise<T> {
    return this.client.masterApi('GET', path);
  }

  async post<T = any>(path: string, body?: any): Promise<T> {
    return this.client.masterApi('POST', path, body);
  }
}
