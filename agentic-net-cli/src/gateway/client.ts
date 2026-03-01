import { readFileSync, existsSync } from 'node:fs';
import { getTokenStore, acquireToken } from './auth.js';

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Gateway ${status}: ${body}`);
    this.name = 'GatewayError';
  }
}

export interface GatewayClientOptions {
  gatewayUrl: string;
  profileName: string;
  clientId?: string;
}

/**
 * AgetnticOS gateway client. All traffic goes through the gateway.
 * JWT is auto-acquired when AGENTICOS_ADMIN_SECRET env var is set.
 */
export class GatewayClient {
  private gatewayUrl: string;
  private profileName: string;
  private clientId: string;

  constructor(opts: GatewayClientOptions) {
    this.gatewayUrl = opts.gatewayUrl;
    this.profileName = opts.profileName;
    this.clientId = opts.clientId ?? 'agenticos-admin';
  }

  /** Call master APIs via gateway: /api/... */
  async masterApi<T = any>(method: string, path: string, body?: any, query?: Record<string, string>): Promise<T> {
    return this.request<T>(method, `${this.gatewayUrl}/api${path}`, body, query);
  }

  /** Call node APIs via gateway: /node-api/... */
  async nodeApi<T = any>(method: string, path: string, body?: any, query?: Record<string, string>): Promise<T> {
    return this.request<T>(method, `${this.gatewayUrl}/node-api${path}`, body, query);
  }

  /** Direct call to any URL (no gateway prefix, no auth). */
  async directCall<T = any>(method: string, url: string, body?: any, headers?: Record<string, string>): Promise<T> {
    const res = await fetch(url, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    });
    if (!res.ok) {
      throw new GatewayError(res.status, await res.text());
    }
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** Ensure a valid JWT is available, auto-acquiring if AGENTICOS_ADMIN_SECRET is set. */
  private async ensureAuth(): Promise<string | null> {
    const tokenStore = getTokenStore();
    const existing = tokenStore.getToken(this.profileName);
    if (existing && !tokenStore.isExpired(this.profileName)) {
      return existing.access_token;
    }

    // Auto-acquire token if secret is available (env var or file)
    let secret = process.env.AGENTICOS_ADMIN_SECRET;
    if (!secret) {
      const secretFile = process.env.AGENTICOS_GATEWAY_SECRET_FILE;
      if (secretFile && existsSync(secretFile)) {
        try {
          secret = readFileSync(secretFile, 'utf-8').trim();
        } catch {
          // Ignore file read errors
        }
      }
    }
    if (secret) {
      try {
        const token = await acquireToken(this.gatewayUrl, this.clientId, secret);
        tokenStore.saveToken(this.profileName, token);
        return token.access_token;
      } catch {
        return existing?.access_token ?? null;
      }
    }

    // Return stale token if exists (let gateway reject it)
    return existing?.access_token ?? null;
  }

  private async request<T>(
    method: string,
    url: string,
    body?: any,
    query?: Record<string, string>,
  ): Promise<T> {
    if (query) {
      const params = new URLSearchParams(query);
      url += (url.includes('?') ? '&' : '?') + params.toString();
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const accessToken = await this.ensureAuth();
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const res = await fetch(url, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers,
    });

    if (res.status === 401) {
      throw new GatewayError(401, 'Unauthorized. Set AGENTICOS_ADMIN_SECRET env var or run `agenticos auth login`.');
    }

    if (!res.ok) {
      const errorBody = await res.text();
      throw new GatewayError(res.status, errorBody);
    }

    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}
