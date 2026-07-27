/**
 * The durable allowlist. The behaviour under test is a lifetime question, not a storage one:
 * a model minted in one session has to stay reachable — and stoppable — from the next, because
 * anything scheduled in it keeps spending tokens after the connection closes.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAllowlistStore, resolveStatePath } from '../src/allowlist-store.js';
import { loadConfig } from '../src/config.js';

let dir: string;
const envFor = (over: Record<string, string | undefined> = {}) => ({
  AGENTICOS_STATE_DIR: dir,
  AGENTICOS_MODELS: 'from-env',
  AGENTICOS_ADMIN_SECRET: 's3cret',
  ...over,
}) as NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenticnets-allowlist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('allowlist store', () => {
  it('round-trips a model id so a later session can reach it', () => {
    const store = createAllowlistStore(envFor());
    expect(store.read()).toEqual([]);
    const res = store.add('team-alpha');
    expect(res.persisted).toBe(true);
    expect(createAllowlistStore(envFor()).read()).toEqual(['team-alpha']);
  });

  it('is idempotent — re-adding does not duplicate', () => {
    const store = createAllowlistStore(envFor());
    store.add('team-alpha');
    store.add('team-alpha');
    expect(store.read()).toEqual(['team-alpha']);
  });

  it('honours AGENTICOS_PERSIST_ALLOWLIST=false without throwing', () => {
    const store = createAllowlistStore(envFor({ AGENTICOS_PERSIST_ALLOWLIST: 'false' }));
    const res = store.add('team-alpha');
    expect(res.persisted).toBe(false);
    expect(res.error).toMatch(/disabled/);
    expect(store.read()).toEqual([]);
  });

  it('fails SOFT when the file cannot be written — a session must never break over this', () => {
    // Point the store at a path whose parent is a FILE, so mkdir/write cannot succeed.
    const blocked = join(dir, 'blocker');
    writeFileSync(blocked, 'not a directory');
    const store = createAllowlistStore({ ...envFor(), AGENTICOS_STATE_DIR: join(blocked, 'nested') });
    const res = store.add('team-alpha');
    expect(res.persisted).toBe(false);
    expect(res.error).toBeTruthy();
    expect(() => store.read()).not.toThrow();
  });

  it('survives a corrupt file instead of taking the server down', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolveStatePath(envFor()), '{ this is not json');
    expect(createAllowlistStore(envFor()).read()).toEqual([]);
  });

  it('ignores malformed ids in a hand-edited file rather than widening the allowlist with junk', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolveStatePath(envFor()),
      JSON.stringify({ models: ['good-one', '../../etc/passwd', 'UPPER', '', 42, null] }),
    );
    expect(createAllowlistStore(envFor()).read()).toEqual(['good-one']);
  });
});

describe('config merge', () => {
  it('restores persisted models alongside the env allowlist', () => {
    createAllowlistStore(envFor()).add('minted-earlier');
    const cfg = loadConfig(envFor());
    expect(cfg.models).toEqual(['from-env', 'minted-earlier']);
    expect(cfg.persistedModels).toEqual(['minted-earlier']);
  });

  it('keeps env authoritative for the DEFAULT model', () => {
    createAllowlistStore(envFor()).add('minted-earlier');
    expect(loadConfig(envFor()).models[0]).toBe('from-env');
  });

  it('never double-lists a model present in both env and the store', () => {
    createAllowlistStore(envFor()).add('from-env');
    const cfg = loadConfig(envFor());
    expect(cfg.models).toEqual(['from-env']);
    expect(cfg.persistedModels).toEqual([]);
  });

  it('still requires AGENTICOS_MODELS even when the store has entries', () => {
    // The store widens reach; it does not replace configuration, and must not let a stray file
    // silently become the whole allowlist.
    createAllowlistStore(envFor()).add('minted-earlier');
    expect(() => loadConfig(envFor({ AGENTICOS_MODELS: undefined }))).toThrow(/AGENTICOS_MODELS is required/);
  });

  it('ignores the store entirely when persistence is disabled', () => {
    createAllowlistStore(envFor()).add('minted-earlier');
    const cfg = loadConfig(envFor({ AGENTICOS_PERSIST_ALLOWLIST: 'false' }));
    expect(cfg.models).toEqual(['from-env']);
    expect(cfg.persistAllowlist).toBe(false);
  });

  it('writes a readable, hand-editable file (pruning is a documented file edit)', () => {
    createAllowlistStore(envFor()).add('team-alpha');
    const raw = readFileSync(resolveStatePath(envFor()), 'utf8');
    expect(JSON.parse(raw).models).toEqual(['team-alpha']);
    expect(JSON.parse(raw).updatedAt).toBeTruthy();
  });
});
