import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for the local agent loop's HTTP_CALL: the URL is LLM/token-influenced, so refuse the
 * cloud-metadata/link-local range always and loopback/private targets unless the operator opted in
 * with AGENTICOS_ALLOW_PRIVATE_HTTP=true. Mirrors master's SsrfGuard.
 */
export class SsrfBlockedError extends Error {}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
    || p[0] === 127 || p[0] === 0;
}
function isMetadataV4(ip: string): boolean {
  return ip.startsWith('169.254.') || ip === '0.0.0.0';
}
function classifyV6(ip: string): 'metadata' | 'private' | null {
  const h = ip.toLowerCase();
  if (h.startsWith('fe80:') || h === '::') return 'metadata';
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return 'private';
  const m = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isMetadataV4(m[1]) ? 'metadata' : isPrivateV4(m[1]) ? 'private' : null;
  return null;
}
function classify(ip: string): 'metadata' | 'private' | null {
  if (isIP(ip) === 4) return isMetadataV4(ip) ? 'metadata' : isPrivateV4(ip) ? 'private' : null;
  if (isIP(ip) === 6) return classifyV6(ip);
  return null;
}

export async function assertNotSsrf(rawUrl: string): Promise<void> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new SsrfBlockedError(`HTTP_CALL refused: invalid URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`HTTP_CALL refused: only http/https targets are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfBlockedError('HTTP_CALL refused: target has no host');
  const allowPrivate = process.env['AGENTICOS_ALLOW_PRIVATE_HTTP']?.toLowerCase() === 'true';
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (host === 'localhost' || host.endsWith('.localhost')) addresses = ['127.0.0.1'];
  else {
    try { addresses = (await lookup(host, { all: true })).map((a) => a.address); }
    catch { throw new SsrfBlockedError(`HTTP_CALL refused: cannot resolve host ${host}`); }
  }
  for (const ip of addresses) {
    const kind = classify(ip);
    if (kind === 'metadata') throw new SsrfBlockedError(`HTTP_CALL refused: link-local/metadata target ${host} -> ${ip}`);
    if (kind === 'private' && !allowPrivate) {
      throw new SsrfBlockedError(`HTTP_CALL refused: private/loopback target ${host} -> ${ip} (set AGENTICOS_ALLOW_PRIVATE_HTTP=true to permit)`);
    }
  }
}
