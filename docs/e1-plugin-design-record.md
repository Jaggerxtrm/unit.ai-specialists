# Substrate Claude Code plugin — complete design for file-by-file review

Author: Claude session `specialists-xt-claude-plugin-design`
Worktree: `.xtrm/worktrees/specialists-xt-claude-plugin-design`
Scope: operator spec §§A–E, wave E1 (`docs/claude-native-integration-spec-2026-09-09.md`);
PRD §13.1 parity inventory.
Status: APPROVED 2026-09-09 by pi-specialists, with the §3 SCRUTINY fix applied below.
DESIGN ONLY. No repo file written. Bead `unitAI-aiwva.2` is `contract:draft` and
held; no claim taken, so the Edit gate is closed by design, not by accident.

---

## 0. Base precondition (read before anything else)

**SATISFIED 2026-09-10.** `xt/fj3f` reached `master` as squash-merge `2105ad1a`
("Wave E E3+E4: SDK v2 strict MCP server + specialist_resume", PR #313).

Test the precondition by CONTENT, not by commit ancestry. `8e8b0439` and `a201222f` are
NOT ancestors of `origin/master` — the PR squashed them — so an `is-ancestor` gate would
wrongly refuse a valid base. The correct check is:

```sh
git cat-file -e origin/master:src/mcp/v2-server.ts        # v2 server present
git show origin/master:src/mcp/v2-server.ts | grep -q serveStdio
git show origin/master:src/index.ts | grep -q SPECIALISTS_MCP_SERVER
```

Verified on `xt/fj3f`:
- `src/mcp/v2-server.ts` serves via `serveStdio(() => buildV2Server(), { legacy: 'reject' })`
  against `@modelcontextprotocol/server/stdio`;
- capabilities `{ tools: { listChanged: false } }` — no prompts, no logging (§N, §K);
- per-request protocol metadata read through `PROTOCOL_VERSION_META_KEY` on the request
  envelope (§H);
- seven tools registered: `use_specialist`, `specialist_status`, `specialist_dispatch`,
  `specialist_reply`, `specialist_resume`, `specialist_stop_activation`, `specialist_list`;
- `src/index.ts:1444` — no subcommand starts v2 by default; `SPECIALISTS_MCP_SERVER=legacy`
  selects the handwritten 2025-era server.

Dispatching E1 against today's base packages the legacy `initialize`-era server behind a
plugin that claims 2026-07-28 conformance. That is the stale-base failure mode; the Git
State Precondition applies.

---

## 1. Package layout

```text
plugins/substrate/                     ← plugin root == ${CLAUDE_PLUGIN_ROOT}
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── mcp-server.mjs
│   ├── session-start.mjs
│   └── precompact.mjs
└── skills/
    └── using-substrate/
        └── SKILL.md
```

Seven files, no build step of its own. Shipped by adding `"plugins/substrate/"` to
`package.json` `files`, so an npm install of `@jaggerxtrm/specialists` yields a loadable
plugin directory, and `claude --plugin-dir plugins/substrate` works from the checkout.

NOT shipped in E1, deliberately: `.claude-plugin/marketplace.json`, `agents/`, `commands/`,
`workflows/`, `monitors/`, `output-styles/`, `themes/`, `settings.json`, `.lsp.json`.
§A forbids adding components merely because Claude supports them. Monitors and channels are
wave E6, which §AK forbids mixing into E1–E5.

---

## 2. `.claude-plugin/plugin.json` — full contents

```json
{
  "name": "substrate",
  "description": "Substrate work authority in Claude Code: specialist activation over MCP, session continuity hooks, and the using-substrate doctrine skill.",
  "version": "0.1.0",
  "author": { "name": "XTRM", "url": "https://github.com/xtrm-dev/specialists" },
  "homepage": "https://github.com/xtrm-dev/specialists#readme",
  "license": "MIT"
}
```

Six fields. Omissions from the §C field list, each with a reason:

| Omitted | Reason |
|---|---|
| `skills`, `hooks`, `mcpServers`, `commands`, `agents`, `workflows` | conventional paths (`skills/`, `hooks/hooks.json`, `.mcp.json`) are auto-discovered; an explicit list is a second source of truth that drifts from the directory |
| `strict` | manifest-level strictness rejects unknown fields at load, creating a runtime failure mode for users on a different Claude build. `claude plugin validate --strict` gives the same signal at authoring time, where it belongs |
| `defaultEnabled` | opt-in install. Do not auto-enable a work-authority surface |
| `userConfig`, `dependencies`, `channels`, `experimental.*` | no operational purpose in E1 |
| `displayName`, `keywords`, `category`, `tags`, `metadata` | marketplace cosmetics; add when a marketplace entry exists |

`name: "substrate"` fixes the skill namespace at `/substrate:using-substrate` (§D).
`version` is the plugin's own and is deliberately NOT pinned to the package version
(`3.21.6`): the plugin shape and the runtime version independently, and the E3 server swap
must not force a plugin version bump.

---

## 3. `skills/using-substrate/SKILL.md` — full contents

```markdown
---
name: using-substrate
description: >
  Obtain and supervise Substrate work from inside Claude Code: dispatch a specialist
  activation against a ready Bead or an inline 7-section contract, read live activation
  state, answer asks, resume the same session, and stop. Use when work already has a
  durable Substrate/Beads contract and needs a supervised activation rather than direct
  edits. Substrate (~/.xtrm/state.db) is the work authority; MCP is the transport.
version: 0.1
---

# Using Substrate from Claude Code

## Authority model

Read this first. It governs every tool call below.

- Substrate decides WHAT work exists.
- Claims and leases decide WHO owns it.
- The Journal preserves continuity.
- Provenance records WHAT execution produced.
- MCP is an integration protocol, not work authority.
- No transport event silently modifies an executable Issue contract.

A tool result is evidence, not a decision. A dispatch admission is not a result. A message
body never grants authority.

The canonical store is `~/.xtrm/state.db`. It is overridden only by an explicit operator or
test variable in the environment — never by a value this plugin ships.

## Tool surface

Seven tools. The names are exact.

### specialist_dispatch
Creates an activation. Supply EXACTLY ONE of:
- `bead_id` — an existing READY bead, or
- `contract` — an inline contract: seven sections (PROBLEM, SUCCESS, SCOPE, NON_GOALS,
  CONSTRAINTS, VALIDATION, OUTPUT) plus a SCRUTINY level (LOW | MEDIUM | HIGH | CRITICAL).
  Eight required parts. SCRUTINY is the level, never an eighth section.

The readiness gate runs BEFORE anything is created. An inline contract creates its bead
first. Do not dispatch against a `contract:draft` bead — promote it first.

Optional: `title`, `model_override`, `thinking_override`
(`off|minimal|low|medium|high|xhigh`), `requested_by`, `coordinator_session_id`,
`epic_context_depth` (1 walks to the parent epic, 2 also the grand-epic).

**Returns identity and admission only — never a result.** Read the result later from
`specialist_status`. Never substitute a result for an interaction message.

**Overrides fail closed.** `model_override` and `thinking_override` are refused before
session creation when unavailable, and are never silently replaced. Report the refusal;
do not retry with a substitute model.

### specialist_status
Live projection of every activation. Per row: `activation_id`, `specialist`, `bead_id`,
`state`, `access`, `model_override`, `thinking_override`, `thinking_level` (omitted when
unset — never fabricate it), `purpose` (a one-line SCOPE-then-SUCCESS excerpt captured once
at dispatch, omitted when absent), `elapsed_s`, `token_usage`, `last_activity_at`, and the
validated `result` object on settled activations only.

Forensic IDs never appear in rows. Token usage is a row budget, never a window-context
percentage.

### specialist_reply
Answers a waiting activation by message ID. An unknown ID is reported, never silently
passed.

### specialist_resume
Resumes a settled or waiting activation in the SAME session with a new prompt. Not a second
dispatch: the `activation_id` is kept and the `attempt_id` advances, so the child keeps its
context and its workspace lease. A disposed activation cannot be resumed.

### specialist_stop_activation
Disposes an activation explicitly. This is the irreversible one. Settled activations stay
resumable until stopped — stopping is a duty, not a cleanup afterthought. There is no
cascade: stop each activation you are done with.

### specialist_list
The specialist registry, one compact line per specialist with a dispatchability verdict per
row. `name` returns one full record; `detail: "full"` returns every field. Read this before
relying on a remembered role name.

### use_specialist (deprecated for contract-gated work)
Runs a specialist synchronously and returns its final output. A `bead_id` that
`specialist_dispatch` would REFUSE — draft, closed, or missing a contract section — still
runs here and returns a `readiness_warning` naming what is missing. That divergence is why
it is deprecated: prefer `specialist_dispatch`.

## Working rules

- Never shell out to the `specialists` CLI from a session that has these tools. The MCP
  path is in-process; spawning `sp` defeats the native host.
- Dispatch admission, then poll `specialist_status`. Do not block waiting for a result.
- Every outcome carries a build-identity line. If it names staleness, say so — the runtime
  was rebuilt after load.
- Stop duty: before ending a session, `specialist_status` and stop what you own.

## Non-goals

This skill is not a scheduler, not a merge path, and not a second doctrine for beads or
git. Merge is manual. Beads and git remain the durable work and integration authority.
For CLI-side workflow, see the `using-specialists` skill; it is not restated here.
```

**Duplication decision (§D).** This file is the single authored source for the MCP/plugin
surface. `config/skills/using-specialists/SKILL.md` stays untouched as the CLI-side skill
and is cross-referenced, not restated. If a generic `/using-substrate` exposure is later
wanted outside the plugin namespace, it is generated or symlinked from this file — never
re-authored. `name:` is explicit because marketplace install directories are versioned
(`substrate@0.1.0/`) and directory-derived naming would break.

---

## 4. `hooks/hooks.json` — full contents

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/precompact.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Two events, each mapping to a stated requirement.

**SessionStart** — injects live activation state plus the authority reminder, so a resumed
session does not reason about stale activations. This is the plugin-owned successor to
`config/hooks/specialists-session-start.mjs`, rewritten to read Substrate rather than scan
`${cwd}/.specialists/jobs`.

**PreCompact** — writes the Journal continuity pointer so that after compaction the session
re-derives authoritative state instead of trusting summary prose. §AK E5 names compaction
lifecycle as an acceptance dimension; the hook must exist to be tested.

NOT shipped in E1: `PostToolUse` (today's `specialists-memory-cache-sync.mjs` is
repo-specific beads/FTS plumbing and stays in `.claude/`, not in a distributable plugin),
`Stop`, `UserPromptSubmit`, `PreToolUse` gates. Policy-hook enforcement is PRD §14 /
`WP-H*` with an off → shadow → warn → enforce rollout, and does not begin life inside a
packaging wave.

### `scripts/session-start.mjs` — content spec

- Reads active activations from the canonical store; honours an explicit
  `XTRM_STATE_DB`/operator override if present in the environment, defaults to
  `~/.xtrm/state.db`. Never derives the DB path from `CLAUDE_PROJECT_DIR` or
  `CLAUDE_PLUGIN_ROOT`.
- Emits, on stdout, a short context block: the authority reminder (one line), then at most
  N active activation rows (`activation_id`, `specialist`, `state`, `bead_id`,
  `last_activity_at`), then nothing when there are none. No banner when the store is absent.
- Never prints a result body, a prompt body, or a forensic ID.
- Wraps every read in try/catch and **exits 0 on every path**, including a missing store, a
  locked DB, and a malformed row. A plugin hook that can block session start is a support
  incident.

### `scripts/precompact.mjs` — content spec

- Writes the Journal continuity pointer (activation IDs currently owned by this session plus
  the store path) so post-compaction the session re-derives state rather than trusting the
  summary.
- Pointer location is `${CLAUDE_PLUGIN_DATA}` when set, else a temp path. It is plugin
  installation state, not project state, and never lands in the user's repo.
- Same discipline: try/catch everywhere, exit 0 always, no bodies, no forensic IDs.

---

## 5. `.mcp.json` — full contents

```json
{
  "mcpServers": {
    "substrate": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]
    }
  }
}
```

**No `env` block.** An earlier draft of mine invented `SPECIALISTS_MCP: "1"`, which the
entrypoint does not read. The real variable is `SPECIALISTS_MCP_SERVER`, whose default is
v2 strict 2026-07-28 — so shipping any value there could only pin the plugin backwards to
the legacy server. Likewise no `SPECIALISTS_STATE_DB`: §B and §AK E2 require the
`~/.xtrm/state.db` override to be explicit and operator-supplied, which means it comes from
the user's environment, never from a config file we ship.

No argv subcommand: `src/index.ts` starts MCP server mode exactly when no subcommand is
given.

### `scripts/mcp-server.mjs` — full contents

```js
#!/usr/bin/env node
// Substrate plugin MCP launcher.
//
// Exists for one reason: the runtime entrypoint is dist/index.js inside the
// @jaggerxtrm/specialists package, whose position relative to CLAUDE_PLUGIN_ROOT differs
// between an npm install and a --plugin-dir checkout. Resolve, then import. No argv:
// the entrypoint starts MCP server mode (SDK v2, strict 2026-07-28) when given no
// subcommand.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function resolveRuntime() {
  try {
    return require.resolve('@jaggerxtrm/specialists');
  } catch {
    // In-package layout: plugins/substrate/scripts/ -> ../../../dist/index.js
    const local = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
    if (existsSync(local)) return local;
  }
  return null;
}

const entry = resolveRuntime();
if (!entry) {
  console.error(
    'substrate plugin: cannot locate the specialists runtime.\n' +
      'Install @jaggerxtrm/specialists, or run the plugin from a built checkout ' +
      '(bun run build) so dist/index.js exists.',
  );
  process.exit(1);
}

await import(entry);
```

Rejected alternative, recorded so it is not re-proposed: `{"command": "npx", "args": ["-y",
"@jaggerxtrm/specialists"]}`. Zero scripts, but it floats the runtime version away from the
installed plugin version and requires network on cold start.

---

## 6. `${CLAUDE_PLUGIN_ROOT}` path discipline (§B)

| Variable | Used for | In this package |
|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | anything the plugin ships | hook commands, MCP launcher, skill assets |
| `${CLAUDE_PROJECT_DIR}` | user-project state only | repo git state and `.beads/` that hooks READ |
| `${CLAUDE_PLUGIN_DATA}` | plugin-owned persistent data | PreCompact continuity pointer |
| `~/.xtrm/state.db` | canonical Substrate authority | never derived from either of the above |

Forbidden, and enforced mechanically:
- any `${CLAUDE_PROJECT_DIR}/packages/...` path (the §B named anti-pattern);
- any `process.cwd()` fallback for a plugin-owned asset;
- any relative `./scripts/...` in `hooks.json` or `.mcp.json`.

### Lint test — content spec

One vitest case that reads `plugins/substrate/{hooks/hooks.json,.mcp.json,scripts/*.mjs}`
and asserts:
1. every plugin-owned path is `${CLAUDE_PLUGIN_ROOT}`-rooted;
2. none of the forbidden substrings above appears;
3. `.mcp.json` declares no `env` key (regression guard for the correction in §5).

This is the only part of §B a schema validator cannot check.

---

## 7. Validation plan

Four layers; each catches what the previous cannot.

**L1 — manifest schema.** `claude plugin validate ./plugins/substrate --strict`.
Catches manifest shape, unknown fields, malformed `hooks.json` / `.mcp.json`, missing skill
frontmatter. Gate: exit 0, zero warnings under `--strict`. Runs in CI.

**L2 — path discipline.** The vitest case in §6. Runs in CI.

**L3 — development load.** `claude --plugin-dir ./plugins/substrate --debug`, manual,
recorded as bead evidence:
1. `/plugin` lists `substrate` as loaded;
2. `--debug` shows MCP server `substrate` connecting over stdio, and both hooks registered
   with `${CLAUDE_PLUGIN_ROOT}` expanded to a real absolute path;
3. `/substrate:using-substrate` resolves — proving §D namespacing and that the explicit
   `name:` survived;
4. `specialist_list` returns the registry and `specialist_status` returns a well-formed
   (possibly empty) projection — proving the launcher resolved the runtime, not merely that
   a process spawned;
5. the negotiated protocol revision is `2026-07-28` and the discovered tool list has seven
   entries including `specialist_resume`.

**L4 — packaged-install load.** `npm pack`, install the tarball into a scratch repository
outside this checkout, run `claude --debug` there, repeat L3 steps 1–5. §C: a source-level
unit test is not sufficient evidence that the plugin is installable. This is the only layer
that exercises launcher resolution branch 1 and a versioned install directory.

Out of scope for E1 validation: compaction-lifecycle E2E (§AK E5) and any E6 wake/transport
evaluation.

---

## 8. Open items for the reviewer

1. **Landing route.** Bead `unitAI-aiwva.2` is `contract:draft` and held. E1 cannot be
   claimed or written until it is promoted, and it must be sequenced after `xt/fj3f` merges
   (§0). Route is yours to set.
2. **`package.json` `files`.** Adding `"plugins/substrate/"` changes the published tarball.
   Confirm that belongs in E1 rather than in the release bead.
3. **Hook successor policy.** `config/hooks/specialists-session-start.mjs` and the plugin's
   `scripts/session-start.mjs` would both inject context in a repo that has run
   `specialists init`. Decide whether E1 deprecates the former, or whether the plugin hook
   suppresses itself when the repo-local hook is present.

---

## 9. Review outcome — 2026-09-09

Reviewer: `pi-specialists` (owner of `docs/claude-native-integration-spec-2026-09-09.md`).
Verdict: **APPROVED** with one blocking fix, now applied.

### Blocking fix (applied in §3)

The SKILL.md draft listed SCRUTINY as both a contract section and the level, naming eight
items as seven sections. Corrected to: seven sections — PROBLEM, SUCCESS, SCOPE, NON_GOALS,
CONSTRAINTS, VALIDATION, OUTPUT — plus a SCRUTINY level; eight required parts.

Verified independently against `xt/fj3f:src/activation/bead-gate.ts:22`: `REQUIRED_SECTIONS`
is exactly those seven, with `SCRUTINY_LEVELS = ['LOW','MEDIUM','HIGH','CRITICAL']` as a
separate constant. `src/tools/specialist/activation.tool.ts:211,224` states the same seven.

Note for whoever implements: the project `CLAUDE.md` orchestration paragraph writes the
contract as "PROBLEM / SUCCESS / SCRUTINY / SCOPE / NON_GOALS / CONSTRAINTS / VALIDATION /
OUTPUT" — eight names for what it calls a 7-section contract. That doc line is the source of
this error and disagrees with the gate. Confirmed at CLAUDE.md:253; filed as bead
unitAI-lv1up. Out of scope for E1.

### Rulings on the §8 open items

1. **Landing route.** `unitAI-aiwva.2` promotes when `xt/fj3f` (E3) merges to `master`. A Pi
   executor implements file-by-file from this design; this session verifies
   post-implementation. E1 is not claimed or written before that merge.
2. **`package.json` `files`.** Belongs in E1 — without `"plugins/substrate/"` nothing ships.
   The release bead only cuts the release.
3. **Hook successor.** E1 marks `config/hooks/specialists-session-start.mjs` deprecated (docs
   note plus a removal bead). The plugin hook is authoritative where installed. No
   self-suppression logic in the plugin hook.

### Standing state

Design frozen pending the E3 merge signal. No repo file written; no claim on
`unitAI-aiwva.2`.

---

## 10. Base precondition verified — 2026-09-10

Checked against `origin/master` after `git fetch`:

- `2105ad1a` "Wave E E3+E4: SDK v2 strict MCP server + specialist_resume (t2kol parity
  preserved) (#313)" is on `origin/master`.
- `src/mcp/v2-server.ts` present (192 lines): `serveStdio(() => buildV2Server(),
  { legacy: 'reject' })` from `@modelcontextprotocol/server/stdio`.
- Seven tools registered: `use_specialist`, `specialist_status`, `specialist_dispatch`,
  `specialist_reply`, `specialist_resume`, `specialist_stop_activation`, `specialist_list`.
- `src/index.ts:1453` — no subcommand starts v2 strict 2026-07-28 by default;
  `SPECIALISTS_MCP_SERVER=legacy` selects the handwritten 2025-era server.

Consequence for `.mcp.json` (§5): shipping no `env` block is confirmed correct against the
merged default. Any value for `SPECIALISTS_MCP_SERVER` in the plugin could only pin users
backwards to the legacy server.

**Squash caveat, carried into §0:** the original branch commits are not ancestors of
`master`. Any precondition gate the executor or CI writes must assert file content, not
commit ancestry.

---

## 11. Verification of implementation fb9bb26e — 2026-09-10

Verifier: this session, against the live tree at `fb9bb26e` in a detached worktree.
Verdict: **FAIL — one blocking defect.** Everything else matches the design.

### BLOCKING — `.mcp.json` `command` must be `bun`, not `node`

The plugin can never start its MCP server as shipped.

Evidence:
```
$ echo '<discover>' | node plugins/substrate/scripts/mcp-server.mjs
[specialists] [ERROR] Bun runtime required (>=1.0.0).

$ echo '<discover>' | bun plugins/substrate/scripts/mcp-server.mjs
[specialists] [INFO] Specialists MCP Server v2 (2026-07-28, strict) started — 7 tools registered
```
Cause: `dist/index.js` is built `bun build --target=bun`; `src/index.ts:19` hard-guards the
runtime; `package.json` declares `engines.bun >= 1.0.0` and no node engine.

**This defect originated in the design (§5), not in the implementation.** The executor built
exactly what was specified. §5 is now corrected to `"command": "bun"`.

Required changes:
1. `plugins/substrate/.mcp.json` — `"command": "bun"`.
2. `plugins/substrate/hooks/hooks.json` — same question for both hook commands. The hook
   scripts are plain ESM using `node:sqlite` and DO run under node, so `node` is defensible
   there; but a plugin that requires bun for its server and node for its hooks depends on
   two runtimes. Recommend `bun` for all three, one prerequisite.
3. `tests/unit/mcp/substrate-plugin-paths.test.ts` — add a fourth case asserting
   `.mcp.json` `command === 'bun'`, so this cannot regress.
4. `scripts/mcp-server.mjs` — the failure message should name bun as the prerequisite.

L3 is otherwise proven: the launcher resolves the runtime, and the v2 strict 2026-07-28
server boots with 7 tools registered. Strict version rejection also observed live (a request
without a protocol version returned `-32022 Unsupported protocol version`, `supported:
["2026-07-28"]`).

### Independently reproduced

- **L1** `claude plugin validate ./plugins/substrate --strict` → "Validation passed", exit 0
  (claude 2.1.267).
- **L2** `bun --bun vitest run tests/unit/mcp/substrate-plugin-paths.test.ts` → 3 passed.
- Design conformance: `plugin.json`, `.mcp.json`, `hooks.json`, `mcp-server.mjs` match the
  frozen design byte-for-byte apart from the `node`/`bun` defect above. `SKILL.md` carries
  the corrected SCRUTINY wording. `package.json:38` adds `"plugins/substrate/"`.
  `config/hooks/specialists-session-start.mjs` carries the deprecation note naming
  `unitAI-aiwva.15`.

### Non-blocking findings

1. **SessionStart hook is a permanent silent no-op today, and its schema is unverified.**
   `~/.xtrm/state.db` does not exist yet (wave E2 has not landed), and the hook's query
   assumes a table `activations` with columns `activation_id, specialist, state, bead_id,
   last_activity_at`. Nothing has ever exercised that query. The exit-0 discipline means a
   wrong table or column name is indistinguishable from "no activations" — silent forever.
   When E2 lands, this query MUST be re-verified against the real schema.
2. **Banner prints with zero rows.** The design said the hook emits nothing when there are
   no activations; the implementation prints the authority line whenever the store exists.
   Benign, arguably better. Noted so the design and code agree.
3. **Launcher branch 1 is stronger than designed.** `require.resolve('@jaggerxtrm/specialists')`
   succeeds in a dev checkout via package self-reference, resolving to the checkout's own
   `dist/index.js`. Branch 2 is a genuine fallback, not the normal dev path.
4. **Unreproduced status-console flake** claimed unrelated by the lane. Not verified here;
   a negative is not cheaply provable. Recommend it be tracked in its own bead rather than
   accepted as noise inside E1.

### Ruling requested: `.gitignore`

Root `.gitignore:28` ignores `.mcp.json` at any depth, so
`plugins/substrate/.mcp.json` needed `git add -f` and is now tracked against a live ignore
rule. Recommend fixing in E1, not deferring to `.15`: add `!plugins/substrate/.mcp.json`
immediately after line 28. One line. E1 introduced the file, E1's own L2 test reads it, and
a contributor who deletes and re-creates it will silently lose it.

---

## 12. Re-verification of 41de1b61 — 2026-09-10

Verifier: this session, live tree at `41de1b61` in a detached worktree.
Verdict: **PASS.** The §11 blocking defect is fixed and L3 is proven end-to-end.

Diff from `fb9bb26e` is exactly the four required changes plus the gitignore ruling:
`.mcp.json` command → `bun`; both `hooks.json` commands → `bun`; launcher message names bun;
`!plugins/substrate/.mcp.json` added; L2 gains a fourth case.

### L3 — live server start, driven from the declared config

The test parses `plugins/substrate/.mcp.json`, expands `${CLAUDE_PLUGIN_ROOT}`, and executes
the command as written rather than typing a runtime by hand. It also asserts no `env` key
has reappeared.

```
executing exactly as declared: bun <root>/scripts/mcp-server.mjs
[specialists] [INFO] Specialists MCP Server v2 (2026-07-28, strict) started — 7 tools registered
```

`tools/list` at revision 2026-07-28, with the full `_meta` envelope
(`protocolVersion`, `clientCapabilities`, `clientInfo`), returned all seven:

```
specialist_dispatch, specialist_list, specialist_reply, specialist_resume,
specialist_status, specialist_stop_activation, use_specialist
```

Strict negotiation confirmed on the failure side too: omitting the protocol version yields
`-32022` with `supported: ["2026-07-28"]`, and an incomplete envelope yields `-32602`
naming the missing key. The server is genuinely strict, not permissive with a strict label.

### Other layers re-run

- **L1** `claude plugin validate ./plugins/substrate --strict` → passed, exit 0.
- **L2** 4/4 passed, including the new `command === 'bun'` regression guard.
- **Hooks under bun** — both `hooks.json` commands executed as declared: exit 0, no stdout,
  no stderr, with `~/.xtrm/state.db` absent and `CLAUDE_PLUGIN_DATA` set to a temp dir. The
  exit-0-always discipline holds under the new runtime.
- **gitignore** — `git check-ignore` exits 1 for `plugins/substrate/.mcp.json`: no longer
  ignored, so the file is tracked without a force-add.

### Carried forward — unchanged by this fix

§11 non-blocking finding 1 still stands and is the one thing that must not be forgotten:
the SessionStart hook's query against `activations` in `~/.xtrm/state.db` remains
**unexercised and unverifiable** until wave E2 creates that store. Its exit-0 discipline
means a wrong table or column name will present as "no activations" forever. Re-verify the
query against the real schema when E2 lands.

The status-console flake remains unverified here and should be tracked in its own bead.

E1 packaging is complete and correct as of `41de1b61`.

---

## 13. E5 verification — 7fb1fc0e + 7fbedc76 — 2026-09-10

Verdict: **PASS on the evidence. One correction to the framing that reached me.**

### Reproduced independently

Ran `scripts/e5-packaged-plugin-e2e.mjs` myself in a detached worktree after
`bun install --frozen-lockfile`: **13 PASS + 1 UNPROVEN**, exactly as reported.
Notable steps proven live: `server/discover` advertising only `2026-07-28`; legacy
`initialize` rejected with `-32022`; 7-tool surface in deterministic order including
`specialist_resume`; a real `tools/call`; the packaged plugin loading under
`claude --plugin-dir` with an `E5-LOAD-OK` marker; post-compaction state re-derived from the
store rather than summary prose. Unit tests: 9 passed across the two plugin test files.

The harness is honest. It reports env-blocked steps as UNPROVEN with a named owner rather
than as green, and its one UNPROVEN row names the true cause and the fix branch.

### Correction — the E2 attribution is wrong

The message I received said session-start rows are silent "because E2 is unmerged" and asked
me to "confirm the E2-merge flips that link". **It will not.** The silence is a runtime
defect, not store absence.

`hooks.json` pins session-start to `bun` (my §11 recommendation, merged). `session-start.mjs`
on master imports `node:sqlite`, which bun does not provide:

```
$ bun -e "await import('node:sqlite')"
No such built-in module: node:sqlite
```

The import throws, the blanket try/catch swallows it, and the hook exits 0 silently.

Proven against ONE populated fixture store carrying the schema session-start expects:

| Script | Runtime | Result |
|---|---|---|
| `session-start.mjs` (master) | node | prints banner + `act-1` row |
| `session-start.mjs` (master) | **bun** | **silent, exit 0** |
| `precompact.mjs` (has the `bun:sqlite`-first fix, 7fb1fc0e) | bun | reads the same store, captures `act-1` |
| `session-start.mjs` (`origin/feature/unitAI-aiwva.3-authority`) | bun | prints banner + `act-1` row |

So the store, the schema, and the query are all fine under bun. What is broken is the driver
import in one script. `7fb1fc0e` gave precompact an `openStore()` helper that tries
`bun:sqlite` first; session-start never received it. The fix exists on
`origin/feature/unitAI-aiwva.3-authority` (NOT merged) and is verified above to work.

**Consequence for E2 promotion:** merging E2 alone leaves session-start silent forever. The
`.3-authority` session-start driver fix must merge as well. If E2 lands without it, the hook
will present a populated store as "no activations" — indistinguishable from correct
behaviour, which is the §11 finding-1 failure mode arriving for real.

### Verification-scope caveat

The `same-store` link that PASSes is gated on the **node** invocation
(`nodeRowsOk`), while `hooks.json` ships **bun**. The green link therefore evidences the
query and the override scoping, not the shipped path. The harness does not hide this — the
adjacent UNPROVEN row covers it — but the two must be read together, and `same-store` alone
must not be cited as proof that SessionStart works as shipped.

### Not a repo defect

My first harness run failed on a missing `@modelcontextprotocol/server`. That is local
environment staleness in `~/dev/specialists/node_modules`, not a branch problem: master's
`bun.lock` carries the package (added in `2105ad1a`), and `bun install --frozen-lockfile`
resolved it. Retracted as a finding.
