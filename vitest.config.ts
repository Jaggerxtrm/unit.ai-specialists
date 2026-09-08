import { defineConfig } from 'vitest/config';

// Refuse to run the suite under Node. bun:sqlite is a Bun builtin; without it,
// createObservabilitySqliteClient() returns null and product code throws deep
// inside supervisor.writeStatusFile with a message that names neither the runner
// nor the workaround (bead xtrm-wiy5n.4.34).
if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
  console.error('specialists: test suite requires bun. Run: bun --bun vitest run');
  process.exit(1);
}

const quarantined = [
  'tests/integration/chat/control.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/chat/launch.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/chat/mailbox-routing.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/doctor.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/edit.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/end.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/epic-flows.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/epic.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/init.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/merge.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/node.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/run.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/validate.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/cli/worktree.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/docs/ownership-guidance.integration.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/node-actions.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/node-bootstrap.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/integration/sp-script.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/smoke/sp-chat.smoke.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/smoke/telemetry-readiness.smoke.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/chat-feed.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/console-bead-view.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/console-e2e-smoke.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/console-key-gating.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/console-perf.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/console-view-model.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/doctor-drift.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/doctor.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/edit.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/finalize.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/init.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/list-rules.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/list.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/log.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/cli/run.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/changelog-drafter.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/changelog-keeper.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/node-contract.consistency.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/node-coordinator-contract.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/node-supervisor-recovery.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/script-runner.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/skill-paths.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/supervisor-sigterm-append.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/supervisor-waiting-auto-close.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/specialist/worktree.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/tools/specialist/use_specialist.tool.test.ts', // ISSUE: xtrm-wiy5n.4.11
  'tests/unit/xtrm/beads-commit-gate.test.ts', // ISSUE: xtrm-wiy5n.4.11
];

const runQuarantined = process.env.SPECIALISTS_TEST_QUARANTINED === '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Every test file gets its own observability database. Without this the resolver
    // falls back to <gitRoot>/.specialists/db and tests operate on the repository's
    // authoritative forensic store. See tests/setup/isolate-observability.ts.
    setupFiles: ['tests/setup/isolate-observability.ts'],
    server: {
      deps: {
        external: [/^bun:/, /^@mariozechner\/pi/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData.ts',
        'tests/utils/**'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    },
    include: runQuarantined ? quarantined : ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      // bun:sqlite tests — run via `bun test` not vitest (bun: protocol unsupported in Node)
      'tests/unit/specialist/observability-sqlite.test.ts',
      'tests/unit/specialist/observability-sqlite-pr-refresh.test.ts',
      'tests/unit/specialist/observability-db.test.ts',
      'tests/unit/cli/db.test.ts',
      // FIFO hang in worktree context — run in isolation.
      // ISSUE: unitAI-9n93. See tests/unit/specialist/supervisor.test.ts header warning.
      'tests/unit/specialist/supervisor.test.ts',
      ...(runQuarantined ? [] : quarantined),
    ],
    testTimeout: 30000
  }
});
