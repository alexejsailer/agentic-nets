import { describe, expect, it } from 'vitest';
import {
  ALL, FULL, READ_ONLY, READ_WRITE, getAvailableTools, parseRole, roleToString,
} from '../src/agent/roles.js';

describe('parseRole', () => {
  it('parses canonical positional rwxhludcts strings', () => {
    const role = parseRole('rw--l-----');
    expect(role.read).toBe(true);
    expect(role.write).toBe(true);
    expect(role.execute).toBe(false);
    expect(role.logs).toBe(true);
    expect(role.tooling).toBe(false);
  });

  it('round-trips canonical roles through roleToString', () => {
    for (const value of ['r----', 'rw---', 'rwxh-', 'rwxhl', 'rw--l', 'rwxhludcts', 'r-------t-', 'r--------s']) {
      const parsed = parseRole(value);
      expect(parseRole(roleToString(parsed))).toEqual(parsed);
    }
  });

  it('parses short-form roles', () => {
    expect(parseRole('r')).toEqual(READ_ONLY);
    expect(parseRole('rw')).toEqual(READ_WRITE);
    expect(parseRole('rwxhludcts')).toEqual(ALL);
  });

  it('keeps the deprecated rwxhds positional fallback for saved roles', () => {
    const saved = parseRole('rwxh-s');
    expect(saved.scripts).toBe(true);
    expect(saved.logs).toBe(false);
    expect(saved.docker).toBe(false);
    const dockerOnly = parseRole('r---d-');
    expect(dockerOnly.docker).toBe(true);
    expect(dockerOnly.logs).toBe(false);
  });

  it('rejects invalid roles', () => {
    expect(() => parseRole('banana')).toThrow(/Invalid role/);
  });
});

describe('ALL / FULL', () => {
  it('keeps FULL as a deprecated alias of ALL (every flag set)', () => {
    expect(FULL).toBe(ALL);
    expect(Object.values(ALL).every(Boolean)).toBe(true);
  });

  it('grants strictly more tools than READ_WRITE', () => {
    const all = getAvailableTools(ALL);
    const rw = getAvailableTools(READ_WRITE);
    expect(all.size).toBeGreaterThan(rw.size);
    for (const tool of rw) expect(all.has(tool)).toBe(true);
  });
});
