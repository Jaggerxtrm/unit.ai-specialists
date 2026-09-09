// ISSUE: xtrm-wiy5n.4.11 — quarantined from the default test baseline.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { validateBeforeRun } from '../../../src/specialist/runner.js';
import { SpecialistLoader } from '../../../src/specialist/loader.js';
import { isBareLogicalSkillName, resolveBareLogicalSkill } from '../../../src/specialist/project-pack-skill-resolver.js';

const REPO = resolve(__dirname, '../../..');
const SPECIALISTS_DIR = join(REPO, 'config/specialists');
const GLOBAL_SKILLS_ROOT = join(homedir(), '.xtrm/skills/default');
const RETIRED_ROOT = '.xtrm/skills/active';

// The interactive surfaces both read the same canonical root through a symlink:
//   ~/.pi/agent/skills -> ~/.xtrm/skills/default   (Pi session startup)
//   ~/.claude/skills   -> ~/.xtrm/skills/default   (Claude session startup)
const STARTUP_ROOTS = {
  pi: join(homedir(), '.pi/agent/skills'),
  claude: join(homedir(), '.claude/skills'),
};

function specFiles(): string[] {
  return readdirSync(SPECIALISTS_DIR).filter((f) => f.endsWith('.specialist.json'));
}

function declaredPaths(): Array<{ specialist: string; path: string }> {
  return specFiles().flatMap((file) => {
    const spec = JSON.parse(readFileSync(join(SPECIALISTS_DIR, file), 'utf8'));
    const paths: string[] = spec.specialist?.skills?.paths ?? [];
    return paths.map((path) => ({ specialist: spec.specialist.metadata.name, path }));
  });
}

// Mirrors loader.resolveSkillsPaths (via the shared resolver, unitAI-jndsb.11):
// '~/' -> $HOME, './' -> spec file dir, bare logical name -> consumer project
// pack or global-default candidate, else verbatim.
function resolveLikeLoader(path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (path.startsWith('./')) return join(SPECIALISTS_DIR, path.slice(2));
  if (isBareLogicalSkillName(path)) return resolveBareLogicalSkill(path, process.cwd());
  return path;
}

describe('validateBeforeRun: missing skills are a hard pre-run failure', () => {
  // Regression guard for unitAI-6639v.1: this used to be a warning, and pi silently
  // ignores a bad `--skill`, so specialists ran with no skills loaded and nothing said so.
  it('throws when a declared skill path does not exist', () => {
    expect(() =>
      validateBeforeRun(
        { specialist: { skills: { paths: ['~/.xtrm/skills/default/definitely-not-a-real-skill/SKILL.md'] } } },
        'READ_ONLY',
      ),
    ).toThrow(/skills\.paths: skill not found/);
  });

  it('names the retired root in the remediation hint', () => {
    expect(() =>
      validateBeforeRun({ specialist: { skills: { paths: ['.xtrm/skills/active/using-specialists/SKILL.md'] } } }, 'READ_ONLY'),
    ).toThrow(/~\/\.xtrm\/skills\/default/);
  });

  it('passes when the declared skill exists', () => {
    expect(() =>
      validateBeforeRun({ specialist: { skills: { paths: [join(REPO, 'config/skills/using-specialists/SKILL.md')] } } }, 'READ_ONLY'),
    ).not.toThrow();
  });
});

describe('package contract: shipped specialists declare resolvable skills', () => {
  it('no specialist references the retired .xtrm/skills/active root', () => {
    const stale = declaredPaths().filter((entry) => entry.path.includes(RETIRED_ROOT));
    expect(stale).toEqual([]);
  });

  it('every declared skill path is in a canonical, cwd-independent form', () => {
    // Bare logical names ('service-knowledge') are resolved by the shared
    // resolver into <consumerRoot>/.xtrm/skills/<pack>/<skill>/ (project-pack
    // wins, global-default candidate otherwise — unitAI-jndsb.11), so they are
    // canonical. '~/' (global), './' (spec-relative), and absolute are stable.
    // Only literal relative paths with separators ('config/skills/...') resolve
    // against process.cwd() and break from a worktree or consumer repo.
    const bad = declaredPaths().filter(
      (entry) =>
        !entry.path.startsWith('~/') &&
        !entry.path.startsWith('./') &&
        !isAbsolute(entry.path) &&
        !isBareLogicalSkillName(entry.path),
    );
    expect(bad).toEqual([]);
  });

  it('every declared skill resolves on disk', () => {
    if (!existsSync(GLOBAL_SKILLS_ROOT)) return; // machine without the global tree installed
    const missing = declaredPaths().filter((entry) => !existsSync(resolveLikeLoader(entry.path)));
    expect(missing).toEqual([]);
  });
});

describe('interactive startup: skills are reachable from Pi and Claude session roots', () => {
  for (const [surface, root] of Object.entries(STARTUP_ROOTS)) {
    it(`global skills resolve under the ${surface} startup root`, () => {
      if (!existsSync(GLOBAL_SKILLS_ROOT) || !existsSync(root)) return;
      const globalSkills = declaredPaths().filter((entry) => entry.path.startsWith('~/.xtrm/skills/default/'));
      expect(globalSkills.length).toBeGreaterThan(0);

      const unreachable = globalSkills.filter((entry) => {
        const relative = entry.path.replace('~/.xtrm/skills/default/', '');
        return !existsSync(join(root, relative));
      });
      expect(unreachable).toEqual([]);
    });
  }
});

describe('loader expands ~/ skill paths to absolute paths', () => {
  it('chain-coordinator resolves its skills to existing absolute files', async () => {
    const spec = await new SpecialistLoader().get('chain-coordinator');
    const paths = spec.specialist.skills?.paths ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(isAbsolute(path)).toBe(true);
      expect(path.startsWith('~')).toBe(false);
      if (existsSync(GLOBAL_SKILLS_ROOT)) expect(existsSync(path)).toBe(true);
    }
  });
});
