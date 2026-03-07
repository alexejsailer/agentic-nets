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

  async assignTransition(params: {
    modelId: string;
    transitionId: string;
    agentId: string;
    inscription: any;
    credentials?: any;
  }): Promise<any> {
    return this.client.masterApi('POST', '/transitions/assign', params);
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
    source: { modelId: string; sessionId: string; netId: string };
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

  async importPackage(name: string, version: string, targetModelId: string, targetSessionId: string): Promise<any> {
    return this.client.masterApi('POST', `/packages/${name}/versions/${version}/import`, {
      targetModelId,
      targetSessionId,
    });
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
