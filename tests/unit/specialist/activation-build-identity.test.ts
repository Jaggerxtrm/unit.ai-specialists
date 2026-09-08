import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeBuildIdentity,
  hashFileBytes,
  readBuildId,
  shortBuildId,
  UNKNOWN_BUILD_ID,
} from '../../../src/activation/build-identity.js';

/**
 * Build identity for the stale-build refusal (unitAI-rrdnt.55). The identity
 * must be cheap and STABLE across identical builds — a timestamp would make
 * two identical builds look different and convert the signal into noise.
 */

function fixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-id-'));
  const file = join(dir, 'artifact.js');
  writeFileSync(file, content);
  return file;
}

describe('build identity (unitAI-rrdnt.55)', () => {
  it('hashes stably: identical bytes give identical ids', () => {
    const a = fixture('export const x = 1;\n');
    const b = fixture('export const x = 1;\n');
    expect(readBuildId(a)).toBe(readBuildId(b));
  });

  it('distinguishes builds: one changed byte gives a different id', () => {
    const a = fixture('export const x = 1;\n');
    const b = fixture('export const x = 2;\n');
    expect(readBuildId(a)).not.toBe(readBuildId(b));
  });

  it('short ids are 12 hex chars', () => {
    const id = readBuildId(fixture('anything\n'));
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(shortBuildId(hashFileBytes(fixture('anything\n')))).toHaveLength(12);
  });

  it('readBuildId never throws: a missing file reads as unknown', () => {
    expect(readBuildId(join(tmpdir(), 'build-id-does-not-exist', 'artifact.js'))).toBe(
      UNKNOWN_BUILD_ID,
    );
  });

  it('matching ids render the match line', () => {
    expect(describeBuildIdentity('aaaabbbbcccc', 'aaaabbbbcccc')).toBe(
      'build: aaaabbbbcccc (loaded module matches the file on disk)',
    );
  });

  it('differing ids name staleness outright', () => {
    const line = describeBuildIdentity('aaaabbbbcccc', 'ddddffff0000');
    expect(line).toContain('module loaded aaaabbbbcccc, file on disk ddddffff0000');
    expect(line).toContain('rebuilt after');
    expect(line).toContain('Restart the session');
  });

  it('an unreadable side renders the unknown line, not a crash', () => {
    expect(describeBuildIdentity(UNKNOWN_BUILD_ID, UNKNOWN_BUILD_ID)).toContain(
      'build: unknown',
    );
    expect(describeBuildIdentity('aaaabbbbcccc', UNKNOWN_BUILD_ID)).toContain('aaaabbbbcccc');
  });
});
