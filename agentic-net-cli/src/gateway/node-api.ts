import { GatewayClient } from './client.js';

/** Node-proxied API calls (routes through /node-api/** → node :8080). */
export class NodeApi {
  constructor(private client: GatewayClient) {}

  // ---- Tree operations ----
  async getChildren(modelId: string, path: string): Promise<any[]> {
    return this.client.nodeApi('GET', `/models/${modelId}/path/${path}/children`);
  }

  async getTreeJson(modelId: string, path: string): Promise<any> {
    return this.client.nodeApi('GET', `/models/${modelId}/tree/json`, undefined, {
      path,
    });
  }

  async resolve(modelId: string, path: string): Promise<any> {
    // Resolve path to element by querying parent's children and finding by name
    const parts = path.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');
    const children = await this.getChildren(modelId, parentPath);
    const found = children.find((c: any) => c.name === name);
    if (!found) {
      throw new Error(`Element '${name}' not found at path '${path}'`);
    }
    return found;
  }

  // ---- Events API ----
  async executeEvents(modelId: string, events: any[]): Promise<any> {
    return this.client.nodeApi('POST', `/events/execute/${modelId}`, { events });
  }

  // ---- ArcQL ----
  async queryTokens(
    modelId: string,
    parentPath: string,
    query: string,
    format: string = 'json_with_meta',
    options?: { fields?: string[]; maxValueLength?: number },
  ): Promise<any> {
    // Resolve path to UUID — ArcQL controller expects parentId (UUID), not a path string.
    const resolved = await this.resolve(modelId, parentPath);
    const parentId = resolved.id;

    const body: Record<string, any> = { parentId, query, format };
    if (options?.fields?.length) body.fields = options.fields;
    if (options?.maxValueLength != null) body.maxValueLength = options.maxValueLength;
    return this.client.nodeApi('POST', `/arcql/query/${modelId}`, body);
  }

  // ---- Leaves ----
  async getLeafProperties(modelId: string, path: string): Promise<any> {
    // Get leaf by querying parent children and finding by name
    const parts = path.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');
    const children = await this.getChildren(modelId, parentPath);
    return children.find((c: any) => c.name === name);
  }

  // ---- Delete operations ----
  async deleteLeaf(modelId: string, id: string, parentId: string): Promise<any> {
    return this.client.nodeApi('DELETE', `/models/${modelId}/leaves/${id}`, undefined, { parentId });
  }

  async deleteNode(modelId: string, id: string, parentId: string): Promise<any> {
    return this.client.nodeApi('DELETE', `/models/${modelId}/nodes/${id}`, undefined, { parentId });
  }

  // ---- Model ----
  async getModelVersion(modelId: string): Promise<any> {
    return this.client.nodeApi('GET', `/models/${modelId}/version`);
  }

  // ---- Children count ----
  async getChildrenCount(modelId: string, path: string): Promise<number> {
    try {
      const result = await this.client.nodeApi('GET', `/models/${modelId}/path/${path}/children/count`);
      return typeof result === 'number' ? result : (result as any).count ?? 0;
    } catch {
      // Some gateway/node combinations do not expose /children/count; fall back.
      const children = await this.getChildren(modelId, path);
      return Array.isArray(children) ? children.length : 0;
    }
  }
}
