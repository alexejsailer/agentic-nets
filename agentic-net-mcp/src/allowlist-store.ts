/**
 * Durable half of the model allowlist.
 *
 * The allowlist was session-scoped: `create_model` granted access for THIS connection only, and the
 * next session saw the model with `allowed: false`. For a product whose thesis is unattended
 * autonomy that is the wrong lifetime — you could mint a model, arm scheduled lanes that spend
 * tokens overnight, disconnect, and then be unable to inspect, retune or `pause_model` the thing you
 * started. The management plane has to outlive the session that created the work.
 *
 * Deliberately NOT stored server-side: the allowlist is an in-process guard against client/LLM
 * mistakes and prompt injection, not authorization (the gateway credential is not model-scoped —
 * see the README's scoping-honesty note). Keeping it next to the client that enforces it matches
 * what it actually is, and keeps a compromised model on the server from editing its own guard rail.
 *
 * Every write fails soft. A read-only filesystem or a container without a writable home must never
 * break a session — it just means the grant stays session-scoped, and the caller is told so.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PersistResult {
  persisted: boolean;
  path: string;
  /** Present when persistence was attempted and failed — surfaced to the caller, never thrown. */
  error?: string;
}

export interface AllowlistStore {
  /** Absolute path of the backing file (reported to callers so pruning is a discoverable edit). */
  readonly path: string;
  /** False when persistence is switched off (AGENTICOS_PERSIST_ALLOWLIST=false). */
  readonly enabled: boolean;
  read(): string[];
  add(modelId: string): PersistResult;
}

interface StoreFile {
  models?: string[];
  updatedAt?: string;
}

export function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  // `~/.agenticnets` already hosts hooks.env, so this joins an established location rather than
  // inventing one.
  const dir = env.AGENTICOS_STATE_DIR?.trim() || join(homedir(), '.agenticnets');
  return join(dir, 'allowlist.json');
}

export function createAllowlistStore(env: NodeJS.ProcessEnv = process.env): AllowlistStore {
  return createAllowlistStoreAt(
    resolveStatePath(env),
    env.AGENTICOS_PERSIST_ALLOWLIST !== 'false',
  );
}

export function createAllowlistStoreAt(path: string, enabled = true): AllowlistStore {

  const read = (): string[] => {
    if (!enabled || !existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
      const models = Array.isArray(parsed?.models) ? parsed.models : [];
      // A corrupt or hand-edited file must not take the server down, and must not silently
      // widen the allowlist with junk — keep only well-formed ids.
      return models.filter((m): m is string => typeof m === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(m));
    } catch {
      return [];
    }
  };

  const add = (modelId: string): PersistResult => {
    if (!enabled) {
      return { persisted: false, path, error: 'persistence disabled (AGENTICOS_PERSIST_ALLOWLIST=false)' };
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(modelId)) {
      return { persisted: false, path, error: 'invalid model id' };
    }
    const lockPath = `${path}.lock`;
    let locked = false;
    let tempPath: string | undefined;
    try {
      mkdirSync(dirname(path), { recursive: true });
      for (let attempt = 0; attempt < 100 && !locked; attempt++) {
        try {
          mkdirSync(lockPath);
          locked = true;
        } catch (err: any) {
          if (err?.code !== 'EEXIST') throw err;
          // A killed writer must not wedge persistence forever.
          try {
            if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
              rmSync(lockPath, { recursive: true, force: true });
              continue;
            }
          } catch {
            // It disappeared between EEXIST and stat; retry.
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      if (!locked) throw new Error('timed out acquiring allowlist write lock');

      // Re-read under the lock so two MCP processes cannot overwrite one another's grants.
      const current = read();
      if (current.includes(modelId)) return { persisted: true, path };
      const next: StoreFile = { models: [...current, modelId], updatedAt: new Date().toISOString() };
      tempPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      writeFileSync(tempPath, JSON.stringify(next, null, 1) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tempPath, path);
      tempPath = undefined;
      return { persisted: true, path };
    } catch (err: any) {
      return { persisted: false, path, error: String(err?.message ?? err).slice(0, 160) };
    } finally {
      if (tempPath) {
        try { unlinkSync(tempPath); } catch { /* best effort */ }
      }
      if (locked) {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  };

  return { path, enabled, read, add };
}
