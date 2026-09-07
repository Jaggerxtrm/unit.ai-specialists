import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { deploymentEnvironment } from '../../../src/specialist/forensic-events.js';

/**
 * unitAI-rrdnt.29. `bun build` substitutes the literal token `process.env.NODE_ENV` at
 * bundle time. Writing it directly in source therefore freezes the BUILDER's environment
 * into dist/ as a string constant: every packed install reported the environment of the
 * machine that built it, and the `production` branch was unreachable in any shipped
 * artifact. Because dist/ is tracked and CI rebuilds and diffs it, it also made the
 * committed dist unmatchable — CI builds under NODE_ENV=test, a local build does not.
 *
 * These tests fail if someone inlines the token back, which is the tempting simplification
 * because the direct form reads better and its breakage is invisible in source.
 */

const original = process.env.NODE_ENV;
afterEach(() => {
  if (original === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original;
});

describe('deploymentEnvironment', () => {
  it('follows the environment the process is RUNNING in, not the one it was built in', () => {
    process.env.NODE_ENV = 'production';
    expect(deploymentEnvironment()).toBe('production');

    process.env.NODE_ENV = 'test';
    expect(deploymentEnvironment()).toBe('test');
  });

  it('falls back to local when unset or blank, never to an empty label', () => {
    delete process.env.NODE_ENV;
    expect(deploymentEnvironment()).toBe('local');

    process.env.NODE_ENV = '   ';
    expect(deploymentEnvironment()).toBe('local');
  });

  it('no forensic source reads the inlineable token directly', () => {
    // The whole defect is that this token is a BUILD-time constant to bun. One resolver
    // reads it through a computed key; anything else that spells it out gets baked.
    const sources = [
      'src/server.ts',
      'src/cli/epic.ts',
      'src/specialist/supervisor.ts',
      'src/specialist/dead-job-audit.ts',
      'src/specialist/forensic-events.ts',
      'src/activation/forensic-sink.ts',
    ];

    // Comments are stripped first: the docstring on the resolver names the token
    // deliberately, and a test that cannot tell prose from code would force that warning
    // to be deleted to stay green.
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const offenders = sources.filter(path =>
      stripComments(readFileSync(path, 'utf8')).includes('process.env.NODE_ENV'),
    );
    expect(offenders).toEqual([]);
  });
});
