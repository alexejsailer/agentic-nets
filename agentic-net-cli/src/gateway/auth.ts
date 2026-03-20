import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getTokensDir, ensureConfigDir } from '../config/config.js';

export interface StoredToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  acquired_at: number; // epoch ms
}

class TokenStore {
  getToken(profile: string): StoredToken | null {
    const file = this.tokenFile(profile);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as StoredToken;
    } catch (err: any) {
      console.error(`[auth] Failed to read token file ${file}: ${err.message}`);
      return null;
    }
  }

  saveToken(profile: string, token: StoredToken): void {
    ensureConfigDir();
    writeFileSync(this.tokenFile(profile), JSON.stringify(token, null, 2), 'utf-8');
  }

  removeToken(profile: string): void {
    const file = this.tokenFile(profile);
    if (existsSync(file)) {
      const { unlinkSync } = require('node:fs');
      unlinkSync(file);
    }
  }

  isExpired(profile: string): boolean {
    const token = this.getToken(profile);
    if (!token) return true;
    const expiresAt = token.acquired_at + token.expires_in * 1000;
    return Date.now() > expiresAt - 30_000; // 30s buffer
  }

  private tokenFile(profile: string): string {
    return join(getTokensDir(), `${profile}.json`);
  }
}

let _store: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!_store) {
    _store = new TokenStore();
  }
  return _store;
}

export async function acquireToken(
  gatewayUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<StoredToken> {
  const res = await fetch(`${gatewayUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`Authentication failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; token_type: string; expires_in: number };
  return {
    access_token: data.access_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    acquired_at: Date.now(),
  };
}
