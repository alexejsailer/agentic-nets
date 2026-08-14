/**
 * Lease introspection — turn the raw `_lock` property into an honest, readable answer.
 *
 * A lease is `{"owner": "<transitionId>", "expiresAt": <epochMs>}` written INTO the token by the
 * reservation CAS (docs/leases). Binding hides foreign-leased tokens, but query_tokens shows
 * them — so without this annotation, "visible" reads as "available" and clients delete tokens
 * that in-flight fires still hold (that exact mistake motivated this file).
 */
export interface LeaseInfo {
  owner: string;
  expiresInMs: number;
}

/** The unexpired lease on a token, else null. Reads every shape the platform emits. */
export function leaseOf(token: any): LeaseInfo | null {
  const raw =
    token?.properties?._lock ??
    token?._meta?.properties?._lock ??
    token?.data?._lock ??
    token?._lock;
  if (raw == null || raw === '') return null;
  try {
    const lock = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const expiresAt = Number(lock?.expiresAt ?? 0);
    const remaining = expiresAt - Date.now();
    if (!lock?.owner || remaining <= 0) return null; // expired = free (next CAS claims it)
    return { owner: String(lock.owner), expiresInMs: remaining };
  } catch {
    return null;
  }
}

/** Annotate result rows in place and summarize. rows[i] must correspond to rawTokens[i]. */
export function annotateLeases(rawTokens: any[], rows: any[]): { leasedCount: number } {
  let leasedCount = 0;
  rawTokens.forEach((t, i) => {
    const lease = leaseOf(t);
    if (lease && rows[i] && typeof rows[i] === 'object') {
      rows[i].leased = { owner: lease.owner, expiresInMs: lease.expiresInMs };
      leasedCount++;
    }
  });
  return { leasedCount };
}

export const LEASED_NOTE =
  'leased tokens are IN FLIGHT: a fire holds them (binding hides them from everyone else). ' +
  'They are not queued and not stuck — and deleting one breaks the holder’s consumption. See docs/leases.';
