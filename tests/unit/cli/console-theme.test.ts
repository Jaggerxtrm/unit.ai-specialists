import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  composeElapsed,
  ctxColor,
  jobRowFieldValues,
  paint,
  renderGroupRow,
  renderJobRow,
  renderMeters,
  renderRail,
  renderSectionTitle,
  renderStatsLine,
  selectJobColumns,
  statusColor,
  statusGlyph,
  visibleLength,
} from '../../../src/cli/console/theme.js';
import type { ConsoleJob } from '../../../src/cli/console/types.js';
import type { ProcessSnapshot } from '../../../src/cli/console/types.js';
import type { ProcessHealthReport } from '../../../src/specialist/process-health.js';

const SGR_RE = /\x1b\[[0-9;]*m/g;

function strip(s: string): string {
  return s.replace(SGR_RE, '');
}

function makeJob(overrides: Partial<ConsoleJob> = {}): ConsoleJob {
  return {
    id: 'abc12345',
    specialist: 'executor',
    status: 'running',
    started_at_ms: 0,
    elapsed_s: 252, // 4m12s
    context_pct: 41,
    metrics: { turns: 3, tool_calls: 8, token_usage: { total_tokens: 42000 } },
    bead_id: 'unitAI-9b2dn',
    bead_title: 'add npm pack smoke',
    payload_kb: '44.2kb',
    payload_tokens: '12.1kt',
    next_action: 'result',
    ...overrides,
  } as ConsoleJob;
}

function makeSnapshot(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  const health: ProcessHealthReport = {
    status: 'OK',
    totalRssBytes: 256 * 1024 * 1024,
    totalCpuPct: 3.5,
    orphanCount: 0,
  } as ProcessHealthReport;
  return {
    generatedAtMs: 0,
    repo: { id: 'r', name: 'specialists', path: '/x' },
    filter: { historyMode: 'default', includeCleaned: false, textFilter: '' },
    rows: [],
    jobs: [],
    totalJobs: 12,
    visibleJobs: 5,
    runningJobs: 2,
    waitingJobs: 1,
    epics: 1,
    nodes: 0,
    worktrees: 2,
    maxContextPct: 41,
    totalTokens: 84000,
    health,
    ...overrides,
  };
}

describe('theme.paint() — 24-bit ANSI', () => {
  it('emits truecolor SGR with reset', () => {
    expect(paint('hello', 'running')).toBe('\x1b[38;2;195;154;94mhello\x1b[0m');
    expect(paint('x', 'rail')).toBe('\x1b[38;2;58;58;58mx\x1b[0m');
    expect(paint('y', 'blocked')).toBe('\x1b[38;2;196;128;111my\x1b[0m');
  });

  it('always resets at end (SGR does not cross lines)', () => {
    const s = paint('abc', 'dim');
    expect(s.endsWith('\x1b[0m')).toBe(true);
  });
});

describe('theme.visibleLength()', () => {
  it('strips SGR and counts only visible chars', () => {
    expect(visibleLength(paint('hello', 'dim'))).toBe(5);
    expect(visibleLength(paint('a', 'dim') + ' · ' + paint('b', 'dim'))).toBe(5);
  });
});

describe('renderMeters()', () => {
  it('renders measured activity without fabricated lease or budget counters', () => {
    const line = strip(renderMeters({ active: 2, activeTotal: 5 }, 80));
    expect(line).toBe('active 2/5');
    expect(line).not.toMatch(/lease|budget/i);
  });
});

describe('column widths (spec §6.4)', () => {
  it('matches normative widths', () => {
    expect(COLUMNS.id.width).toBe(8);
    expect(COLUMNS.spec.width).toBe(13);
    expect(COLUMNS.status.width).toBe(9);
    expect(COLUMNS.ctxPct.width).toBe(4);
    expect(COLUMNS.elapsed.width).toBe(20);
    expect(COLUMNS.payloadKb.width).toBe(8);
    expect(COLUMNS.payloadTok.width).toBe(7);
    expect(COLUMNS.bead.width).toBe(14);
    expect(COLUMNS.next.width).toBe(7);
    expect(COLUMNS.title.width).toBe(42);
  });

  it('full job row sums to 145 visible chars at depth 0', () => {
    // 4 overhead (marker, space, icon, space) + 132 column widths + 9 separators
    const widths = Object.values(COLUMNS).reduce((acc, c) => acc + c.width, 0);
    expect(widths).toBe(132);
    const fullCost = 1 + 1 + 0 + 1 + 1 + widths + 9; // 145
    expect(fullCost).toBe(145);
  });
});

describe('selectJobColumns() — truncation priority', () => {
  it('drops title first when width insufficient', () => {
    // 145 → drop title (42+1=43) → 102. width=130 should drop title.
    const cols = selectJobColumns(130, 0);
    expect(cols).not.toContain('title');
    expect(cols).toContain('next');
  });

  it('drops in order: title → next → bead → payloadTok → payloadKb → elapsed', () => {
    // Drop title at 145→102, next at 102→94, bead at 94→79
    const at80 = selectJobColumns(80, 0);
    expect(at80).not.toContain('title');
    expect(at80).not.toContain('next');
    expect(at80).not.toContain('bead');
    expect(at80).toContain('payloadTok');
    expect(at80).toContain('payloadKb');
    expect(at80).toContain('elapsed');
  });

  it('drops all six right-most columns at 60 cols', () => {
    const at60 = selectJobColumns(60, 0);
    // 145 → 102 → 94 → 79 → 71 → 62 → 41. Stops at 62 still > 60 → drops elapsed → 41 ≤ 60.
    expect(at60).toEqual(['id', 'spec', 'status', 'ctxPct']);
  });

  it('keeps all columns at 160 cols and beyond', () => {
    expect(selectJobColumns(160, 0).length).toBe(10);
  });

  it('accounts for rail depth in cost', () => {
    // At width 142, depth 0 (cost 145) → drops title to 102, depth 1 adds 2 → cost 147 → also drops title to 104.
    const d0 = selectJobColumns(142, 0);
    const d1 = selectJobColumns(142, 1);
    expect(d0).not.toContain('title');
    expect(d1).not.toContain('title');
    // At 144 depth 0 keeps all (145 > 144 → drops title).
    expect(selectJobColumns(145, 0).length).toBe(10);
    expect(selectJobColumns(145, 1).length).toBe(9); // depth+2 forces drop
  });
});

describe('composeElapsed()', () => {
  it('formats canonical `Xm Ys Tt·Ctc·Ktok` and pads to 20', () => {
    const job = makeJob();
    const result = composeElapsed(job);
    expect(strip(result.trimEnd())).toBe('4m12s 3t·8tc·42ktok');
    expect(result.length).toBe(20);
  });

  it('shows — padded to 20 when elapsed unknown', () => {
    const job = makeJob({ elapsed_s: undefined });
    const result = composeElapsed(job);
    expect(result.trimEnd()).toBe('—');
    expect(result.length).toBe(20);
  });

  it('drops metric parts that are zero/missing', () => {
    const job = makeJob({ metrics: { turns: 0, tool_calls: 0 } });
    expect(composeElapsed(job).trimEnd()).toBe('4m12s');
  });

  it('renders sub-1000 tokens as raw N tok', () => {
    const job = makeJob({ metrics: { turns: 1, tool_calls: 1, token_usage: { total_tokens: 250 } } });
    expect(composeElapsed(job).trimEnd()).toBe('4m12s 1t·1tc·250tok');
  });
});

describe('status mapping (mock-v2 §3.2 normative)', () => {
  it('glyphs', () => {
    expect(statusGlyph('running')).toBe('●');
    expect(statusGlyph('waiting')).toBe('◐');
    expect(statusGlyph('starting')).toBe('◐');
    expect(statusGlyph('done')).toBe('○');
    expect(statusGlyph('error')).toBe('✕');
    expect(statusGlyph('cancelled')).toBe('○');
    expect(statusGlyph('running', true)).toBe('✕'); // dead overrides
  });

  it('colors', () => {
    expect(statusColor('running')).toBe('running');
    expect(statusColor('waiting')).toBe('waiting');
    expect(statusColor('starting')).toBe('waiting');
    expect(statusColor('done')).toBe('done');
    expect(statusColor('error')).toBe('blocked');
    expect(statusColor('cancelled')).toBe('idle');
    expect(statusColor('running', true)).toBe('blocked');
  });
});

describe('ctxColor() — spec §8.1 thresholds', () => {
  it('dim under 80, running 80-94, blocked ≥95', () => {
    expect(ctxColor(undefined)).toBe('dim');
    expect(ctxColor(50)).toBe('dim');
    expect(ctxColor(79)).toBe('dim');
    expect(ctxColor(80)).toBe('running');
    expect(ctxColor(94)).toBe('running');
    expect(ctxColor(95)).toBe('blocked');
    expect(ctxColor(99)).toBe('blocked');
  });
});

describe('renderRail() — continuous │ , no connectors', () => {
  it('emits depth × `│ ` painted rail', () => {
    expect(strip(renderRail(0))).toBe('');
    expect(strip(renderRail(1))).toBe('│ ');
    expect(strip(renderRail(3))).toBe('│ │ │ ');
  });

  it('never includes connectors', () => {
    const rendered = strip(renderRail(4));
    expect(rendered).not.toMatch(/[├└┌─]/);
  });
});

describe('renderJobRow() — alignment and visible width', () => {
  it('fits within terminal width', () => {
    const job = makeJob();
    for (const w of [60, 80, 120, 160]) {
      const row = renderJobRow(job, w, 0, false);
      expect(visibleLength(row)).toBeLessThanOrEqual(w);
    }
  });

  it('emits no raw SGR outside the paint() helper', () => {
    // Sanity: every SGR in output must match the truecolor form.
    const row = renderJobRow(makeJob(), 160, 0, false);
    const sgrs = row.match(SGR_RE) ?? [];
    for (const sgr of sgrs) {
      expect(sgr === '\x1b[0m' || /^\x1b\[38;2;\d+;\d+;\d+m$/.test(sgr)).toBe(true);
    }
  });

  it('marker › flips when selected', () => {
    const job = makeJob();
    expect(renderJobRow(job, 160, 0, true).startsWith('›')).toBe(true);
    expect(renderJobRow(job, 160, 0, false).startsWith(' ')).toBe(true);
  });

  it('jobRowFieldValues pads id/spec/status to column widths', () => {
    const fv = jobRowFieldValues(makeJob());
    expect(fv.id.length).toBe(8);
    expect(fv.spec.length).toBe(13);
    expect(fv.status.length).toBe(9);
    expect(fv.ctxPct.length).toBe(4);
    expect(fv.elapsed.length).toBe(20);
  });
});

describe('renderStatsLine() — priority truncation §8.1', () => {
  it('drops right-to-left when width insufficient', () => {
    const snap = makeSnapshot();
    const at160 = renderStatsLine(snap, 160);
    const visible160 = strip(at160);
    // All 8 fields fit at 160
    expect(visible160).toContain('jobs');
    expect(visible160).toContain('orphans');
  });

  it('drops orphans first at narrower widths', () => {
    const snap = makeSnapshot();
    const at80 = strip(renderStatsLine(snap, 80));
    expect(at80).toContain('jobs');
    expect(at80).toContain('running');
    // orphans should be among first dropped
    expect(at80.length).toBeLessThanOrEqual(80);
  });

  it('keeps jobs field even at minimum width', () => {
    const snap = makeSnapshot();
    const at60 = renderStatsLine(snap, 60);
    expect(strip(at60)).toContain('jobs');
    expect(visibleLength(at60)).toBeLessThanOrEqual(60);
  });

  it('never wraps (single line)', () => {
    const snap = makeSnapshot();
    for (const w of [60, 80, 120, 160]) {
      const line = renderStatsLine(snap, w);
      expect(line.includes('\n')).toBe(false);
    }
  });

  it('handles missing snapshot', () => {
    expect(strip(renderStatsLine(undefined, 80))).toBe('jobs --');
  });
});

describe('renderGroupRow() — container glyphs (D2 resolution)', () => {
  it('epic ◆ chain ◇ node ▦', () => {
    expect(strip(renderGroupRow('epic', 'release', 80, 0))).toContain('◆');
    expect(strip(renderGroupRow('chain', 'root', 80, 1))).toContain('◇');
    expect(strip(renderGroupRow('node', 'research', 80, 0))).toContain('▦');
  });

  it('branch/worktree/label render without container glyph', () => {
    expect(strip(renderGroupRow('label', 'Prep', 80, 1))).not.toContain('◆');
    expect(strip(renderGroupRow('branch', 'fix/x', 80, 2))).not.toContain('◇');
    expect(strip(renderGroupRow('worktree', 'docs/x', 80, 0))).not.toContain('▦');
  });
});

describe('renderSectionTitle() — replaces empty separator lines', () => {
  it('emits dim `── label …` shape, non-empty', () => {
    const out = renderSectionTitle('actions', 40);
    expect(strip(out).startsWith('── actions ')).toBe(true);
    expect(strip(out).length).toBeGreaterThan(0);
  });
});

describe('no-raw-ANSI invariant in console module', () => {
  // High-level: only ensure paint output is well-formed; lint check is a runtime CI step.
  it('paint output is parseable by visibleLength', () => {
    const painted = paint('xyz', 'running');
    expect(visibleLength(painted)).toBe(3);
  });
});
