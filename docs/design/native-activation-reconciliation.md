# Native Activation Runtime — Phase 0 Reconciliation

**Bead:** `unitAI-rrdnt.1` (parent epic `unitAI-rrdnt`)
**PRD:** `~/dev/xtrm/docs/specialists/PRD—Native-Specialist-Subagents-for-Pi.md` (v0.3, 4517 lines)
**Branch:** `feature/unitAI-rrdnt.1-phase0-reconciliation`
**Repo HEAD at authoring:** `5543365f`
**Pi runtime inspected:** `@earendil-works/pi-coding-agent@0.85.1`, installed at
`/home/dawid/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent`

**Re-baselined 0.84.3 → 0.85.1** on 2026-09-07 (`unitAI-rrdnt.17`). The original findings
were established against 0.84.3. Every behavioural claim below was re-verified BY EXECUTION
against 0.85.1 — see §5.6 for the method, the results, and the two claims that changed.

PRD §129 Phase 0 forbids production coding before the reusable seams are identified.
This note is that identification. It states what exists, what is reusable, what must be
built, and where the current implementation conflicts with the PRD.

Claims cite `file:line`. Pi SDK claims cite the installed 0.85.1 `.d.ts` surface.

---

## 1. Feasibility verdict

**The PRD is implementable on Pi's public SDK surface. No private API access and no
`InteractiveMode` mutation is required for any v0 requirement.**

This was the primary open risk. Every runtime primitive the PRD names is exported from
the package root (`dist/index.d.ts`, the `"."` export condition):

| PRD requirement | Public Pi 0.85.1 export | Verdict |
|---|---|---|
| §19 `createAgentSession` | `createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>` — `core/sdk.ts` | available |
| §19 `prompt` / `steer` / `followUp` / `abort` / `dispose` | `AgentSession.prompt/steer/followUp/abort/dispose` — `core/agent-session.d.ts:361,377,385,439,289` | available |
| §19 subscribe | `AgentSession.subscribe(listener): () => void` — `agent-session.d.ts:282` | available |
| §19 message history | `AgentSession.messages` — `agent-session.d.ts:324` | available |
| §19 session identity | `AgentSession.sessionId` / `sessionFile` — `agent-session.d.ts:330,332` | available |
| §19 model identity | `AgentSession.model`, `modelRuntime` — `agent-session.d.ts:293,249` | available |
| §19 extension binding | `AgentSession.bindExtensions(bindings)` — `agent-session.d.ts:525` | available |
| §22 settled ≠ turn end | **distinct** `agent_settled` and `agent_end` events — `agent-session.d.ts:41-47` | available |
| §31 child supervisor tools | `customTools?: ToolDefinition[]` on `CreateAgentSessionOptions`; `defineTool` | available |
| §52 parent tool fencing | `getActiveToolNames()` / `setActiveToolsByName()` — `agent-session.d.ts:308,320` | available |
| §53 hard tool-call guard | `tool_call` extension event → `ToolCallEventResult { block?: boolean; reason?: string }` — `extensions/types.d.ts:803-812` | available |
| §62/§64 live model registry | `ModelRegistry`, `resolveCliModel`, `resolveModelScopeWithDiagnostics`, `ModelRuntime` | available |
| §20 persistence / resume | `SessionManager`, `parseSessionEntries`, `sessionEntryToContextMessages` | available |
| §81 compaction evidence | `compaction_start` / `compaction_end` events — `agent-session.d.ts:52-70` | available |
| §80 retry evidence | `auto_retry_start` / `auto_retry_end` events — `agent-session.d.ts:71-80` | available |
| §115 skills | `loadSkills`, `loadSkillsFromDir`, `formatSkillsForPrompt` | available |
| §112 fail-closed tool grant | `tools?: string[]`, `excludeTools?: string[]`, `noTools?: "all" \| "builtin"` on `CreateAgentSessionOptions` | available |
| §69/§70 attach viewport | `ExtensionUIContext.custom<T>(factory)` — focus-taking component, does not replace the parent session | available |
| §66 Fleet placement | `setWidget(key, content, { placement: "belowEditor" })` — `extensions/types.d.ts:97-100` | available, **with one ordering caveat — see §5.1** |

`ToolCallEventResult.block` is the exact shape PRD §53 sketches, so the lease guard is a
direct implementation rather than an approximation.

### 1.1 Dependency consequence

`package.json:93` declares only `@earendil-works/pi-tui@0.75.5`. The runtime does **not**
currently depend on `@earendil-works/pi-coding-agent`.

- For the **Pi extension** frontend this is free: the extension runs inside pi's own
  process, so the SDK is already loaded.
- For the **Claude Code MCP server** (PRD §99), which is a separate process, the SDK must
  be a real resolvable dependency.

Decision required before Phase 13, recorded here so it is not discovered late. Options:
add `@earendil-works/pi-coding-agent` as a dependency (version-couples us to pi releases),
as a `peerDependency` (defers the pin to the operator, matches how `pi` is installed
today at 0.85.1 globally), or resolve the globally installed pi at runtime (already
precedented — `resolveGlobalNodeModulesDir()` at `src/pi/session.ts:499`).

---

## 2. What the current runtime actually does

The headline: **Specialists does not host a Pi session in-process today. It spawns the
`pi` binary and speaks RPC to it over stdio.**

```
sp run <specialist>            src/index.ts
    → SpecialistRunner.run()   src/specialist/runner.ts:1085
    → SessionFactory           src/specialist/runner.ts:102
    → PiAgentSession.create()  src/pi/session.ts:845
    → spawn('pi', args, { detached: true })
                               src/pi/session.ts:1022
    → JSON-RPC over stdio, line-buffered
    → RunResult                src/specialist/runner.ts:84
```

`PiAgentSession` is therefore a **protocol and liveness adapter over a child process**,
not a session object. Its private state is dominated by transport concerns —
`_lineBuffer` accumulating partial stdout lines, `_pendingRequests` correlating RPC ids,
`_stderrBuffer`, `_stallTimer` (`src/pi/session.ts:846-865`). This matches the stored
project memory `lifecycle-boundary-keep-piagentsession-as-protocol-liveness`.

### 2.1 The seam that already exists

`src/specialist/runner.ts:99-102`:

```ts
type SessionLike = Pick<PiAgentSession,
  'start' | 'prompt' | 'waitForDone' | 'getLastOutput' |
  'getState' | 'close' | 'kill' | 'meta' | 'steer' | 'resume'>;
export type SessionFactory = (opts: PiSessionOptions) => Promise<SessionLike>;
```

The runner is **already injectable**. A native in-process host can satisfy `SessionLike`
without touching `SpecialistRunner`. This is the single most valuable existing asset for
this project and it materially reduces Phase 1 risk.

**But `SessionLike` is not sufficient as the native contract**, and this is the central
architectural judgement of Phase 0:

| `SessionLike` assumes | The PRD requires |
|---|---|
| `waitForDone()` — one run, one completion | persistent session across settle/wait/resume (§20) |
| output retrieved once via `getLastOutput()` | validated `ActivationResult` distinct from interaction messages (§37-39) |
| `close`/`kill` end the session | disposal only on explicit stop or governed policy (§20) |
| no inbound message channel | bidirectional participant protocol, pending asks, reply correlation (§24-35) |
| no workspace authority | writer lease with parent fencing (§47-59) |

**Conclusion:** implement `NativeActivationHost` as a *new* surface (PRD §18), and
additionally expose a `SessionLike`-compatible adapter so the legacy `SpecialistRunner`
can be pointed at the native session for one-shot runs during transition. That gives a
cheap correctness oracle — the same Specialist, same definition, run both ways, compared
— without a rewrite. PRD "development discipline" asks for exactly this.

### 2.2 Feature surface to be preserved

Derived from `src/specialist/schema.ts`. Every field below is a parity-matrix row; see §4.

`execution`: mode, model, surface_models, fallback_model, fallback_models, timeout_ms,
stall_timeout_ms, max_retries, interactive, stdout_limit_bytes, prompt_limit_bytes,
response_format, output_type, permission_required, requires_worktree, bare,
thinking_level, auto_commit, extensions, expected_output_keys.
`prompt`: system, system_prompt_mode, task_template, output_schema, skill_inherit.
`skills`: paths, scripts (run/phase/inject_output/required).
`capabilities`: required_tools, external_commands.
`validation`: files_to_watch, stale_threshold_days.
`stall_detection`: running_silence_warn_ms, running_silence_error_ms, waiting_stale_ms,
waiting_auto_close_ms, tool_duration_warn_ms.
`mandatory_rules`: template_sets, disable_default_globals, inline_rules.
`permissions`: per-tier denied_natives_when_extension, denied_natives_mode.
top level: output_file, notes_mode, beads_integration, beads_write_notes.

Plus the layered-override contract itself (`schema.ts:170-235`):
`OVERRIDE_ALLOWED_EXECUTION_FIELDS`, `OVERRIDE_ALLOWED_NESTED_EXECUTION_PATHS`,
`OVERRIDE_ALLOWED_STALL_DETECTION_PATHS`, `OVERRIDE_ALLOWED_PROMPT_FIELDS`,
`OVERRIDE_ALLOWED_MANDATORY_RULES_FIELDS`, `OVERRIDE_ALLOWED_TOP_FIELDS`,
`BLOCKED_OVERRIDE_FIELDS`, and `BlockedFieldWarning` severity `strip` vs `warn`.
PRD §8 forbids a second resolver, so this contract is consumed, never reimplemented.

---

## 3. Notable pre-existing alignment

Two Pi-side mechanisms already in this repo prefigure PRD requirements and should be
reused rather than replaced:

- `validateWriteToolPathAgainstBoundary` (`src/pi/session.ts:760`) and
  `WORKTREE_BOUNDARY_ENV_KEY` already enforce a write-path boundary for the child. This
  is *spatial* containment (where may it write) and is complementary to, not a substitute
  for, the PRD's *temporal* exclusion (who may write right now). The lease needs both.
- `extension-tool-policy-extension.ts` + `NATIVE_TOOLS_ENV_KEY` + `resolvePermissionTools`
  / `resolveRuntimeToolContract` / `applyExtensionToolPolicyGate` / `buildResolvedToolContract`
  (`src/pi/session.ts:361-499`, `src/specialist/resolved-tool-contract.ts`) already
  implement the fail-closed capability policy PRD §112-113 demands be preserved. On the
  native path these resolve to `CreateAgentSessionOptions.tools` / `excludeTools` /
  `noTools` instead of to CLI `-e` args and env vars.

---

## 4. Native experiment reuse map

Source: `~/dev/xtrm/experiments/agentsession-sre-chain-vertical-slice` at xtrm HEAD
`b5bc7effd8b62d1706048dab4315fa990418c900`. This work is directly ancestral: it already
proves direct in-process `createAgentSession()` execution of XTRM participants with zero
Pi RPC subprocesses (`experiment-report.md:74-77, 283-284`), against
`@earendil-works/pi-coding-agent ^0.84.0` (`package.json:14-19`) — the same major line we
target.

### 4.1 The most valuable inheritance: an existing feature matrix

`src/specialists/loader.ts:248-364` already compiles a `SpecialistActivationProfile` from
full Specialist JSON and emits a `featureMatrix` using **the exact four-value
classification the PRD §9 requires** (`native | adapted | deferred | rejected`,
`loader.ts:11`). Its current verdicts:

| Field | Experiment verdict | Evidence |
|---|---|---|
| metadata + fingerprint | native | `loader.ts:248-364` |
| `execution.model` / `fallback_models` / `thinking_level` | native | ” |
| `execution.max_retries` | native | ” |
| `prompt.task_template` | native (one-pass substitution) | `loader.ts:486-494` |
| `mandatory_rules.inline_rules` | native | `loader.ts:496-504` |
| `skills.paths` | native (host-resolved, content-hashed) | `loader.ts:205-242` |
| `skills.scripts` | native when absent, **deferred when present** | `loader.ts:291-296` |
| `mandatory_rules.template_sets` / default globals | native when absent, deferred when present | `loader.ts:307-313` |
| `prompt.output_schema` + `expected_output_keys` | native when absent, deferred when present | `loader.ts:314-320` |
| `execution.interactive` | native when absent, deferred when present | `loader.ts:333-339` |
| `execution.extensions` | native when absent, deferred when present | `loader.ts:340-346` |
| `execution.permission_required` + `permissions` | adapted (write tiers rejected) | `loader.ts:270-274` |
| `prompt.system` + `system_prompt_mode` | adapted (cognition retained, host kernel authoritative) | `loader.ts:275-279, 506-539` |
| `output_file` | native when absent; adapted (projection only) when present | `loader.ts:321-327` |
| `beads_integration` / `beads_write_notes` / `notes_mode` | adapted | `loader.ts:328-332` |
| `execution.timeout_ms` / stall | **deferred** (compiled, not enforced) | `loader.ts:265-269` |
| `capabilities.required_tools` / `external_commands` | **deferred** | `loader.ts:297-301` |
| `execution.auto_commit !== 'never'` | **rejected** | `loader.ts:349-355` |
| `permission_required` MEDIUM/HIGH | **rejected** | `loader.ts:356-362` |

Enforced by `assertSpecialistCompatible` (`loader.ts:462-469`), with contract tests at
`tests/specialist-loader.test.ts`, `tests/specialist-resolver.test.ts`,
`tests/specialist-bindings.test.ts`.

**How this maps onto our project.** The experiment is read-only by design
(`README.md:113-115`), which is why it hard-rejects MEDIUM/HIGH and non-`never`
`auto_commit`. Those two rejections are *exactly* the gap this PRD closes: PRD Phase 8-10
converts them from `rejected` to `native`/`adapted` by introducing the writer lease. The
deferred rows (timeout/stall enforcement, capability preconditions, scripts, template
sets, output-schema validation) correspond one-to-one with the experiment's own
"remaining fusion work" list (`full-specialist-json-loader.md:190-202`) and with PRD
§114-123. **Our parity matrix therefore starts from this table and must move rows
upward, not restate them.**

### 4.2 Reuse verbatim

1. **Append-mode `ResourceLoader`** — `getSystemPrompt: () => undefined` keeps Pi's base
   prompt and its auto-generated tool discovery, while `getAppendSystemPrompt` carries
   role/doctrine (`src/agents/bridge.ts:54-68`). Directly satisfies PRD §117 (preserve
   `system_prompt_mode` semantics without flattening) and §16 (layered, not blobbed).
2. **`noTools: "builtin"` + `customTools`** as the fail-closed capability posture
   (`specialist-bridge.ts:146-148`). Satisfies PRD §112.
3. **Host-injected trusted participant identity via closure, never read from the tool
   body** (`src/tools/index.ts:1-17`), with an authority check on every message post and a
   `runtime.message_rejected` forensic record on refusal (`src/channels/index.ts:60-100,
   116-134`). This is the concrete implementation of PRD §26 ("communication does not
   grant authority") and §111 (trust boundary). Lift the pattern.
4. **Pointer-first evidence**: publish returns a pointer, body lives in a separate JSON,
   dereferenced on read (`src/evidence/index.ts:27-47`). Satisfies PRD §77's
   "do not duplicate Pi transcripts unnecessarily".
5. **Result requires evidence, never `agent_end` alone** (`src/chain/reducer.ts:65-96`;
   scheduler distinguishes `produced_result` from `failed` post-`agent_end` at
   `src/chain/scheduler.ts:482-490`). This is PRD §119 ("a model response is not a valid
   result merely because the model stopped") already implemented.
6. **Upstream-loader seam** `compileFromEffectiveResolver` (`src/specialists/resolver.ts:48-73`)
   — the experiment explicitly marks its own local file resolver as non-canonical and
   names upstream `SpecialistLoader.get(name)` as the production source
   (`full-specialist-json-loader.md:37, 191`). We plug our real loader into this seam.

### 4.3 Evolve

- The deferred matrix rows (§4.1) become native/adapted here, per PRD Phase 8-11.
- Timeout/stall enforcement moves from "compiled but unenforced" to host-enforced
  (PRD §121).
- Shared mandatory-rule resolver instead of inline-only rendering (PRD §116).

### 4.4 Discard — and the trap to avoid

The experiment carries chain-shaped machinery that **PRD §17 and §210 explicitly
forbid this project from reproducing**: `ResolvedChain` freeze, a chain reducer, Beads
step-issue materialization (`src/adapters/beads.ts:112-156`), a ChainRun Epic with
`--parent` step children, and topology composition. Those are excellent work and are the
right shape for the *future Chain runtime* — but an interactive delegation must not
fabricate a Container, a `ResolvedChain`, a step Issue, or a second dependency graph.

**This is the single largest borrowing hazard in the project.** The ancestral code is
attractive and directly adjacent, and lifting it wholesale would violate PRD invariants
4, 5 and 32. Take the *activation* layer (profile compilation, session bridge, evidence,
authority, identity injection); leave the *chain* layer (reducer, scheduler, topology,
step materialization) where it is.

Also discard, on the experiment's own evidence:
- `tools: []` as the "disable builtins" knob — it empties `customTools` too; the correct
  knob is `noTools: "builtin"` (`experiment-report.md:195`).
- `systemPromptOverride` — replaces the base prompt and hides tool discovery; use
  append-mode (`experiment-report.md:197`).
- One-turn `dispose()` in a `finally` block (`bridge.ts:169-226`) — correct for a
  one-shot chain step, and precisely what PRD §20 forbids for a persistent Specialist.

---

## 5. Current runner map — `sp run` to a model turn

```
 1. sp run <specialist>                     src/index.ts → src/cli/run.ts:1655
 2. loader.get(name)                        src/specialist/loader.ts:500        (unknown/null model → exit 1)
 3. worktree policy decision                src/cli/run.ts:1664-1672
      editCapable = permission ∈ {MEDIUM,HIGH}
      autoProvision = editCapable && requires_worktree && !--job
 4. active-job pre-flight                   src/cli/run.ts:1692-1711            (sqlite.findActiveJob)
 5. stale-base pin / sibling gate           src/cli/run.ts:411-426, 787-815
 6. readBead(beadId)                        src/cli/run.ts:1923-1931            ← EXISTENCE CHECK ONLY
 7. buildBeadContext                        src/cli/run.ts:1938
 8. SpecialistRunner.run()                  src/specialist/runner.ts:1085
 9.   validateBeforeRun()                   src/specialist/runner.ts:376,  called :1169
10.   pre scripts                           src/specialist/runner.ts:1180       (runScript :160)
11.   task prompt render                    src/specialist/task-prompt.ts:174
12.   system prompt assembly                src/specialist/runner.ts:1259-1467  ← ~200 inline lines
13.   tool contract resolution              src/pi/session.ts:361,453,476
14.   sessionFactory(PiSessionOptions)      src/specialist/runner.ts:102
15.   PiAgentSession.create()               src/pi/session.ts:845
16.   spawn('pi', args, {detached:true})    src/pi/session.ts:1022              ← PROCESS BOUNDARY
17.   JSON-RPC over stdio, line-buffered
18.   retry / model-fallback loop           src/specialist/runner.ts:1548-1633
19.   getLastOutput() + stripJsonFences     src/pi/session.ts:1505, runner.ts:1641
20.   validateOutputContract()              src/specialist/runner.ts:975        (advisory: stderr only)
21.   post scripts                          src/specialist/runner.ts:1667
22.   RunResult                             src/specialist/runner.ts:84
```

### 5.1 Coupling verdict — what a native host can reuse

Classification per PRD "extract reusable components from current `sp` machinery":
**(a)** pure, reusable as-is · **(b)** cheaply extractable · **(c)** entangled with the
subprocess or supervisor loop.

| Concern | Verdict | Note |
|---|---|---|
| Task-prompt composition | **(a)** | `renderTaskPrompt` `task-prompt.ts:174`, already shared with `sp render-task` |
| Pre-flight validation | **(a)** | `validateBeforeRun` `runner.ts:376` — exported, structural args, no `RunOptions` |
| Script execution | **(a)** | `runScript` :160, `findRequiredPreScriptFailure` :210, `formatScriptOutput` :314 |
| Tool resolution | **(a)** | `resolveRuntimeToolContract` `session.ts:361`, `resolveExecutionExtensionSelection` :476, `buildResolvedToolContract` |
| Result validation | **(a)** module-private | `resolveOutputContractSchema` :666, `validateOutputContract` :975 — pure, just not exported |
| Auto-commit | **(a)** | `runAutoCommitCheckpoint` `supervisor.ts:532`, already outside the runner |
| Retry / model fallback | **(b)** | loop `runner.ts:1548-1633`; helpers already pure. Extract `runWithModelChain(...)` |
| `SessionLike` seam | **(b)** | 10 methods; the real coupling is `PiSessionOptions` (`session.ts:105-170`), which is argv-shaped |
| **System-prompt composition** | **(c)** | ~200 inline lines in `run()` `runner.ts:1259-1467`, mixing `existsSync`, `execSync('gitnexus context …')`, event emission. Not a function, not exported, not independently tested. **Largest single piece of work in the port.** |
| Stall detection | **(c)** | inside `PiAgentSession` (`session.ts:1107-1189`); enforcement is `this.kill()`, a process operation |
| Worktree boundary | **(c)**, cheap | enforced by a generated `.mjs` extension passed via `-e` (`session.ts:780-844`). The in-process equivalent is a `tool_call` guard calling the already-pure and currently-unused `validateWriteToolPathAgainstBoundary` `session.ts:760` |

**Verdict: the port is tractable.** Six of eleven concerns are already pure functions. Two
are cheap extractions. Only the system-prompt assembly is genuinely expensive, and it is
expensive because of accumulated inline growth, not because of the subprocess boundary.

### 5.2 Behaviors that will be silently dropped unless deliberately carried

The spawned child is a **deliberately sterile agent**. An in-process session inherits the
host's ambient configuration instead. Each of these is a real regression risk:

1. `--no-extensions` / `--no-skills` / `--no-context-files` / `--no-prompt-templates`
   isolation (`session.ts:900-911`).
2. The five auto-injected Pi extensions and their env — quality-gates, python-kernel,
   caveman, nvidia-nim, read-line-numbers (`session.ts:935-994`; `CAVEMAN_LEVEL`,
   `PI_KERNEL_AUDIT_POLICY`).
3. The worktree-boundary block hook — today the only hard write containment.
4. `detached:true` + group SIGKILL teardown (`session.ts:1027, 1560-1567, 1594-1600`).
   This is what reaps orphaned MCP children; an in-process session has no equivalent and
   must dispose MCP transports explicitly.
5. `getLastOutput()`'s RPC-then-local fallback (`session.ts:1505-1521`) — the local
   accumulator is what saves a run whose child died after `agent_end`.
6. `stripJsonFences` before validation (`runner.ts:1641`).
7. `PI_SPECIALIST_ALLOWED_NATIVE_TOOLS` + `--no-builtin-tools` fail-closed native
   allowlist (`applyExtensionToolPolicyGate` `session.ts:453`).

---

## 6. Forensic writer map

### 6.1 The good news: the write layer is already reusable

`observability.db` does **not** need a fork, and barely needs extraction. The core writers
are pure functions over plain data, and a non-runner caller already exists as precedent:
the MCP gateway writes forensic rows with the literal job id `'mcp-gateway'`
(`src/server.ts:57-66`).

| Writer | Verdict |
|---|---|
| `appendForensicEvent(jobId, specialist, beadId, event)` `observability-sqlite.ts:1814` | **PURE** — cheapest injection point for a native host; already called by `dead-job-audit.ts:65`, `cli/epic.ts:429`, `server.ts:66` |
| `appendEvent(jobId, specialist, beadId, event)` `:1808` | **PURE** — takes a plain `TimelineEvent` |
| `mapCallbackEventToTimelineEvent(cbEvent, context)` `timeline-events.ts:541` | **PURE — the single most reusable adapter piece.** A native host can feed AgentSession event names straight in |
| All `timeline-events.ts` factories (`createRunStartEvent` :778 … `createChainEvent` :987) | **PURE** |
| `createForensicEvent` `forensic-events.ts:335`, `forensicEventFromTimelineEvent` :531, `redactForensicValue` :252 | **PURE** |
| `aggregateJobMetrics(jobId)` `:2714` | **PURE** — re-derives from the DB |
| `claimJobStartWithStore(store, status, event)` `:1121` | **PURE** — already behind a store interface |
| `writeStatusRow(status)` `:1322` | **EXTRACTABLE** — depends only on the `SupervisorStatus` *type* (`supervisor.ts:117`), a plain record. Cost is a type relocation to a neutral module, not a refactor |
| `appendTimelineEvent` closure `supervisor.ts:1590-1601` | **ENTANGLED** — captures `RunOptions`, the per-run `eventsFd`, the mutable `statusSnapshot`, and the per-run sequence counter `nextTimelineSeq` :1583 |
| `onEvent` / `onToolStart` / `onToolEnd` handlers `supervisor.ts:2368-2660` | **ENTANGLED** — the tool-correlation state machine over `activeToolCalls`, `latestUncorrelatedToolState`, `toolStartMs`, `gitnexusAccumulator` |

**Consequence for the plan.** The native host reuses the writers directly and
reimplements only the *event-source adapter* — the per-turn tool-correlation state machine
— against `AgentSession.subscribe()` instead of RPC stdout. That is precisely the
`AgentSessionForensicAdapter` of PRD §74, and it is new code by necessity rather than a
port. `SupervisorStatus` should move to a neutral module as its own small commit.

### 6.2 Identity lineage — only 1 of the PRD's 4 layers is durable

This is the most significant schema finding and it blocks acceptance AL/AM.

| PRD layer | Status |
|---|---|
| `activation_id` / `job_id` | **EXISTS, canonical.** PK on `specialist_jobs`, present on every event table |
| `participant_id` | **DERIVED, UNSTABLE, OFTEN NULL.** `deriveParticipantId` `forensic-events.ts:389-398` computes `"<chain_id>::<specialist>"`; returns `undefined` when `chain_id` is absent, so a whole class of activations has NULL. Being keyed on chain, the *same logical participant* gets a different id in a different chain — the opposite of the PRD's "stable logical participant identity" |
| `attempt_id` | **ABSENT.** No column, no field. Retries are only *counted* (`SessionRunMetrics.auto_retries` `session.ts:88`; a `retry` event carrying `attempt`/`max_attempts` `timeline-events.ts:355`). Nothing separates attempt N's rows from attempt N+1's within one `job_id` |
| `pi_session_id` | **EXISTS but non-columnar.** `SupervisorStatus.session_id` (`supervisor.ts:132`, set from `onMeta` :2528) lives only inside the `status_json` blob, lifted to `correlation.session_id` at read time (`observability-sqlite.ts:1489`). Not queryable without `JSON_EXTRACT` |

Also not first-class: **workspace** is only `specialist_jobs.worktree_column` (unindexed,
and the column name does not say what it holds); **model** is a column on
`specialist_job_metrics` only.

A migration adding `attempt_id`, promoting `pi_session_id` and `workspace_id` to indexed
columns, and redefining `participant_id` to be chain-independent is required. This is
Phase 7 work and should be its own bead.

### 6.3 Event vocabulary gap

Against the PRD §75 required list: **13 exist, ~14 are semantically mappable** (several
only as a status mutation or a function return value rather than a persisted event), and
**12 are fully absent**.

Fully absent: the entire **lease** family (`lease_requested/acquired/denied/released/
uncertain/reconciled`), the entire **clarification/escalation** family, plus
`tool_blocked`, `activation_requested`, `activation_settled`, `output_validation_started`,
`interaction_received`.

Two mappings are traps and must not be accepted as-is:
- `activation_rejected` → `claimJobStart` **returns** `{ok:false, existingJobId}`
  (`:1216`) and persists nothing. PRD §13/§76 require every refusal to be forensic. A
  rejected dispatch currently leaves no evidence at all.
- `output_validation_passed/failed` → the nearest names are `review.verdict.pass/fail`,
  which are the **reviewer Specialist's verdict**, an entirely different concept from
  runtime output-schema validation. Reusing them would corrupt both meanings.

### 6.4 `tool_blocked` is absent, and blocks are indistinguishable from crashes

Nothing emits an event when a tool call is denied. What exists is *pre-launch* shaping
only — `denied_natives_when_extension` / `denied_natives_mode`
(`tool-catalog.ts:17-18` → `resolved-tool-contract.ts:35-36`) — which changes the tool set
handed to `pi` and writes no row. `worktreeBoundary` (`session.ts:117`) likewise emits
nothing when it refuses a write.

A tool that fails at runtime is recorded as `tool.call.failed` (`forensic-events.ts:808`)
**with no reason taxonomy**, so a policy block and a tool crash are the same row today.
Acceptance V (blocked parent mutation must appear in `observability.db`) therefore needs a
new event *and* a reason field, not a filter over existing rows.

---

## 7. Feature parity matrix

Classification: `native` (implemented directly on the native path) · `adapted` (behavior
preserved, mechanism changes) · `deferred` (explicitly not in v0, with reason) ·
`rejected` (deliberately not carried, with reason).

"Test" names the check that will prove the row. Rows marked *(new)* have no current test.

### 7.1 Resolution and definition

| Feature | Current owner | Native path | Class | Test |
|---|---|---|---|---|
| `SpecialistLoader` layered merge (**three** layers — see §5.14) | `loader.ts:500`, scan dirs `loader.ts:158-170` | consumed unchanged; PRD §8 forbids a second resolver | native | acceptance A |
| `metadata.name/version` | `schema.ts:9-11` | carried into activation identity | native | A |
| `metadata.description/category/updated/tags` | `schema.ts:12-16` | carried verbatim, no runtime effect | native | schema round-trip |
| `OVERRIDE_ALLOWED_*` / `BLOCKED_OVERRIDE_FIELDS` / `BlockedFieldWarning` | `schema.ts:170-235` | enforced by the same loader | native | existing loader tests |

### 7.2 Execution and model

| Feature | Current owner | Native path | Class | Test |
|---|---|---|---|---|
| `execution.model` | `loader.ts` + `model-chain.ts` | `CreateAgentSessionOptions.model` | native | B |
| `execution.fallback_model` / `fallback_models` | `selectAvailableModel` `runner.ts:1016` | reused via extracted `runWithModelChain` | native | B |
| `execution.surface_models` | `loader.ts` | resolved before session creation | native | B |
| activation model **override** | **already exists** — CLI `--model` `cli/run.ts:162`; MCP `backend_override` `use_specialist.tool.ts:11,59` → `runner.ts:1132` | `ActivationRequest.modelOverride`; the genuinely new part is **pre-creation validation** (§5.10), not the override | adapted | C, D, F |
| `execution.thinking_level` | `--thinking` argv | `CreateAgentSessionOptions.thinkingLevel` | native | B |
| `execution.max_retries` | `runner.ts:1548-1633` | extracted retry loop; retries become **attempts under one activation** | adapted | AM |
| `execution.timeout_ms` | `waitForDone` `session.ts:1491` | host timer over the session | native | *(new)* |
| `execution.stall_timeout_ms` | `PiAgentSession` `session.ts:1107` | reimplemented on `subscribe()`; cancellation is `abort()`, not `kill()` | adapted | *(new)* |
| `execution.mode` (`tool`/`skill`/`auto`) | `loader.ts` | carried | native | schema round-trip |
| `execution.interactive` | `runner.ts` | superseded — every native activation is interactive | adapted | H |
| `execution.bare` | `loader.ts` | carried | native | schema round-trip |
| `execution.stdout_limit_bytes` / `prompt_limit_bytes` | `capStream` `runner.ts:154` | reused | native | existing |
| `execution.response_format` / `output_type` | `runner.ts:666-975` | reused, promoted from advisory to enforced | adapted | AO |
| `execution.expected_output_keys` | **`script-runner.ts:633` `collectRequiredOutputKeys` only** — the `sp run` path never reads it (see §5.13) | honoured on every dispatch path | adapted | AO |
| `execution.permission_required` | `resolvePermissionTools` `session.ts:425` | → `tools`/`excludeTools`/`noTools` | adapted | G, R |
| `execution.extensions` | `-e` argv `session.ts:476` | → `bindExtensions` + `customTools` | adapted | R |
| `execution.requires_worktree` | `run.ts:1664-1672` | **semantics change — see §8.1** | adapted | AT |
| `execution.auto_commit` | `supervisor.ts:532` | reused; must not conflict with lease release | adapted | W |
| `permissions.*` tier policy | `manifest-resolver.ts:95-228` | same resolver | native | R |

### 7.3 Prompt and knowledge

| Feature | Current owner | Native path | Class | Test |
|---|---|---|---|---|
| `prompt.task_template` | `renderTaskPrompt` `task-prompt.ts:174` | reused verbatim | native | existing |
| `prompt.system` + `system_prompt_mode` | inline `runner.ts:1259-1467` | **extracted** to `buildSystemPrompt()`, applied via append-mode `ResourceLoader` | adapted | *(new)* |
| `prompt.output_schema` | `resolveOutputContractSchema` `runner.ts:666` | reused | native | AO |
| `prompt.skill_inherit` | `--skill` argv | `resourceLoader` / `loadSkills` | adapted | Q |
| `skills.paths` | `validateBeforeRun` `runner.ts:384` | `loadSkills`, fail-closed preserved | adapted | Q |
| `skills.scripts` (pre/post) | `runScript` `runner.ts:160,1180,1667` | reused unchanged — host authority, runs outside the session | native | Q |
| `mandatory_rules.*` | `mandatory-rules.ts` + `buildMandatoryRulesInjection` | same compiler | native | existing |
| `capabilities.required_tools` | `validateBeforeRun` `runner.ts:384-446` | same, against the in-process registry | native | Q |
| `capabilities.external_commands` | `commandExists` `runner.ts:332` | reused, pre-admission | native | Q |
| `validation.files_to_watch` / `stale_threshold_days` | `drift-detector.ts` | unaffected | native | existing |

### 7.4 Lifecycle, output, tracking

| Feature | Current owner | Native path | Class | Test |
|---|---|---|---|---|
| `stall_detection.*` (5 thresholds) | `supervisor.ts:2099`, `session.ts:1107` | fed by AgentSession events | adapted | *(new)* |
| `output_file` | `job-file-output.ts` | reused | native | existing |
| `notes_mode` / `beads_write_notes` / `beads_integration` | `beads.ts`, `bead-notes.ts` | reused | native | existing |
| result → `ActivationResult` | `RunResult` `runner.ts:84` | new typed result, distinct from interaction messages | native *(new)* | N |
| observability write path | `appendForensicEvent` `:1814` etc. | reused directly | native | AJ, AP |
| forensic event source | `supervisor.ts:2368-2660` | new `AgentSessionForensicAdapter` | adapted *(new)* | AJ |
| identity lineage | §6.2 | schema migration | adapted *(new)* | AK, AL, AM |
| **Bead readiness gate** | **ABSENT** | new `DispatchGate` | native *(new)* | O, P |
| **workspace writer lease** | **ABSENT** | new `WorkspaceLeaseStore` | native *(new)* | S–AC |
| **interaction protocol** | **ABSENT** | new participant protocol | native *(new)* | AD–AI |
| legacy `sp run` subprocess path | `session.ts:1022` | retained during transition, not the native path | deferred | — |
| `pi-intercom` for same-process children | n/a | direct transport instead (PRD §29) | rejected | AD |

Mechanical completeness is enforced by `scripts/check-parity-matrix.mjs`, which fails if a
field in `schema.ts` has no row here.

---

## 5. Conflicts between current implementation and the PRD

### 5.1 Fleet vertical ordering may require a Core seam — CONFIRMED CONSTRAINT

PRD §66 wants `editor → XTRM statusline → Specialist Fleet`.

Pi 0.85.1 offers two mechanisms:
- `setWidget(key, content, { placement })` where `WidgetPlacement = "aboveEditor" | "belowEditor"`
  (`extensions/types.d.ts:43-48, 97-100`);
- `setFooter(factory)` — a **single-owner** replacement of the built-in footer
  (`extensions/types.d.ts:101-109`).

The XTRM statusline is a footer. There is no third placement between "belowEditor" and
the footer, and `setFooter` admits one owner, so two extensions cannot compose a footer.
A Fleet widget at `belowEditor` therefore renders *above* the statusline, inverting the
requested order.

This is precisely the case PRD §66 anticipates ("if exact ordering needs a tiny generic
footer-section registration seam in Core, make the smallest possible reusable change").
Resolution deferred to Phase 2 with two candidate paths: (a) accept
`editor → Fleet → statusline` for v0 and defer the seam; (b) add a minimal
footer-section registry to whichever component owns `setFooter` today. Path (a) is
preferred for v0 because it ships the Fleet without a cross-repo change; the ordering is
cosmetic and reversible.

`pi-subagents` (SHA `1deda8643f5e32856b7475642b2f35b819bbbecf`) is precedent for path (a):
its fleet status registers as `ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, factory, { placement })`
with placement resolving to `"aboveEditor" | "belowEditor"` and defaulting to below
(`pi-subagents/src/tui/fleet-status.ts:567, 65`). It does not attempt footer composition.

### 5.2 pi-subagents has no `observability.db` — do not inherit its telemetry model

`pi-subagents` persists observability as a **file set** — `status.json`, `events.jsonl`,
step output logs, transcripts, `foreground-history.json`, a result index — read through
`readStatus(asyncDir)` and `listAsyncRuns()`
(`pi-subagents/src/runs/background/async-status.ts:8, 485`). There is no SQLite store.

We borrow its *mechanics* (widget registration, overlay attach/restore, the
empty-editor key takeover, the `agent_settled` drain barrier) and explicitly **not** its
persistence model. PRD §73 forbids a telemetry fork: native activations write
`observability.db` like every other Specialist run. A file-set status store would be
exactly the forbidden `specialist-subagents.db` in another shape.

### 5.3 The ancestral experiment disposes on settle — PRD forbids it

`bridge.ts:169-226` and `specialist-bridge.ts:156-213` subscribe, wait for `agent_end`
(`willRetry`-aware), then `session.dispose()` in a `finally`. Correct for a one-shot chain
step; directly contrary to PRD §20 and invariant 6 for a persistent Specialist. The
native host must treat `agent_settled` as a *waiting barrier*, not a disposal trigger.
Flagged here because the ancestral code is otherwise the primary reuse source and this is
its most copy-pasteable mistake.

### 5.4 Auto-provisioned worktree for write-capable Specialists — DIRECT CONFLICT

`src/cli/run.ts:1664-1672`:

```
editCapable   = permission ∈ {MEDIUM, HIGH}
autoProvision = editCapable && execution.requires_worktree && !--job
```

with `requires_worktree` defaulting to **`true`** (`schema.ts:42`). So dispatching an
executor today *automatically creates a new git worktree* via `provisionWorktree`
(`worktree.ts:205-278`), branch `feature/<beadId>-<specialist-slug>`.

PRD §43 and acceptance AT say the opposite: "Do not automatically provision a new worktree
for a write-capable child… the normal child uses the coordinator's current worktree."

**Resolution (PRD wins):** on the native path, `requires_worktree` no longer triggers
provisioning. Workspace defaults to the coordinator's worktree and exclusion is provided by
the writer lease instead of by physical separation. The legacy `sp run` path keeps its
current behavior — this is a native-path semantic change, recorded as `adapted` in §7.2,
not a change to the legacy CLI.

This is the deepest behavioral divergence in the project: it replaces *spatial* isolation
(a worktree per writer) with *temporal* exclusion (one writer at a time in a shared
worktree). It is also why the lease must be correct before Phase 10 enables writers.

### 5.5 There is no workspace lease today, and one identifier pretends to be one

Searching `flock|mutex|lock|lease|exclusive` across `src/` finds three real mechanisms,
none of which is a workspace lease:
- `withEpicAdvisoryLock` — `openSync(lockPath, 'wx')` at
  `<obs-db-dir>/locks/epic-<id>.lock` (`epic-reconciler.ts:41-76`). Scoped to an epic, and
  **not crash-safe**: a killed holder leaves a stale file.
- `sp script --single-instance` — re-execs under `flock -n`, exit 75 when busy
  (`cli/script.ts:133-139`).
- `claimJobStart` / `findActiveJob` — a transactional claim on `(bead_id, specialist)`
  backed by `UNIQUE idx_jobs_active_bead_specialist` (`observability-sqlite.ts:750, 1121-1148`).
  This prevents *duplicate dispatch of the same specialist to the same bead*. It does not
  constrain two different specialists mutating one workspace.

**The decoy:** `worktree_owner_job_id` is chain-provenance metadata
(`chain-identity.ts:40,46`; `supervisor.ts:142,1243,1455`), yet the console renders it under
the label **`lease`** (`cli/console/runtime.ts:540`) and displays a hardcoded placeholder
`leases: 1, leaseCapacity: 4` (`cli/console/components.ts:300-307`). Anyone reading the
console would reasonably conclude a lease system exists. It does not. Do not build on
`worktree_owner_job_id`, and fix or remove the placeholder when the real lease lands.

What actually prevents concurrent writers today is (a) the SQLite bead+specialist claim
and (b) deterministic branch naming causing worktree *reuse*. Neither survives the §5.4
change to a shared worktree, which is why the lease is a hard prerequisite for Phase 10
rather than an enhancement.

### 5.6 Pi version baseline — re-verified at 0.85.1

The runtime installed here is **0.85.1** (was 0.84.3 when this note was written). Rather
than assume the findings carried over, each behavioural claim was re-run against 0.85.1
with a control, in a scratch project with an extension registering a `tool_call` handler.
The live smoke (`tests/integration/activation/native-activation.live.test.ts`) also passes
unchanged on 0.85.1, which is the end-to-end confirmation that the runtime seam holds.

| Claim | Verdict on 0.85.1 | How it was re-verified |
|---|---|---|
| `tool_call` veto blocks an LLM tool call | **holds** | LLM-issued `bash` with `{block:true, reason}` produced `isError:true` carrying the reason; the command never ran. `ToolCallEventResult` shape unchanged (`block`/`reason`/`terminate`). |
| `executeBash()` / `pi.exec()` bypass the veto | **holds — still unfixed** | `executeBash` ran and returned real output with the handler invoked **zero** times; same for `pi.exec` from inside an extension. See §5.8. |
| All `tool_call` handlers in a batch fire before any execution | **holds** | Two-call batch (`sleep 0.4 && echo one`, `echo two`): both handlers fired 11ms apart, both results completed ~430ms later, so handler 2 ran well before execution 1 finished. |
| Active-tool revocation cannot cancel an already-planned call | **holds** | Revoking mid-batch left both planned `bash` calls executing; the narrowed list applied only to subsequent calls. |
| `agent_end` and `agent_settled` are distinct | **holds, with a narrowing** | See below. |
| `createAgentSession` takes a `Model` object; `noTools:'builtin'` + `tools` allowlist works | **holds** | Live-tested in every probe. **No new option** for tool permissions, exec confinement or workspace sandboxing exists — nothing in 0.85.1 closes the §5.8 bypass. |
| Model gate needs both halves | **holds — but one instrument changed** | See below. |

Two things genuinely changed, and both are recorded because they would mislead a reader
who trusted the 0.84.3 text:

- **`agent_end`'s extension-facing type no longer declares `willRetry`.** The
  session-subscriber event still carries it — `agent-session.js:386` splices it in for
  `session.subscribe()` consumers — so `NativeActivationHost`, which subscribes that way
  (`native-host.ts:306`), is unaffected. An *extension-side* `agent_end` handler would not
  see it. Any future extension that needs retry state must read it from the session
  subscription, not from its own handler.
- **`ModelRuntime.getAvailable()` no longer distinguishes auth state**, returning the full
  catalogue regardless of `allowModelNetwork` or `refreshOnCreate`. The auth half of the
  model gate must be measured with `hasConfiguredAuth(providerId)`, which behaves exactly
  as originally claimed: 8 authed providers under normal creation, zero under
  `refreshOnCreate:false`. `model-gate.ts` already uses `hasConfiguredAuth` and never
  `getAvailable`, so the gate is correct; only its comment was wrong and is now fixed.

Upstream-only surface (`./experimental/plugin`) remains out of scope; nothing in the
current design needs it.

### 5.7 Quiescence: use `await prompt()` + `agent_settled`, not raw `agent_end`

`emitToolCall` returns on the **first** handler that sets `result.block`
(`extensions/runner.ts:982`), and the governed quiescence boundary is `await prompt()`
plus `agent_settled` / `waitForIdle()`, not `agent_end`. `agent_end` fires per model turn
and carries `willRetry`; treating it as completion is the bug the ancestral experiment's
one-shot design hides (§5.3). PRD §22's four-way distinction — model turn stopped, agent
settled, activation completed, activation accepted — maps onto: `agent_end` → turn,
`agent_settled` → settled, validated `ActivationResult` → completed, coordinator decision
→ accepted.

### 5.8 Lease guard reach — PRD §54 is partially unsatisfiable on Pi 0.85.1

`tool_call` is a genuine single choke point for **LLM tool calls**. `AgentSession`
installs `agent.beforeToolCall`, which calls `runner.emitToolCall(...)` and converts
`{block:true}` into an error tool result instead of execution
(`dist/core/agent-session.js:228`; `dist/core/extensions/runner.js:701`;
`pi-agent-core/dist/agent-loop.js:393-430`). Built-ins, extension-registered tools, SDK
`customTools` and `baseToolsOverride` replacements are all wrapped into one registry
(`agent-session.js:2030-2130`), and the hook is tool-agnostic — there is no per-tool
exemption. So paths (a) built-in edit/write, (b) bash-as-tool, (c) `pi.registerTool`, and
(d) `createAgentSession({customTools})` are **all covered**.

Four paths are **not** covered, and each is a lease bypass:

| # | Bypass | Evidence |
|---|---|---|
| H1 | `AgentSession.executeBash()` called directly by any in-process holder of the session — including our own host | no `emitToolCall`/`emitUserBash` in `agent-session.js:2289-2310` |
| H2 | the operator `user_bash` path — interactive `!bash` and **RPC `bash`** emit `user_bash`, not `tool_call` | `dist/modes/interactive/interactive-mode.js:5417`; `dist/modes/rpc/rpc-mode.js:439`; `runner.js:720` |
| H3 | `pi.exec(command, args, options)` inside any extension handler | `dist/core/extensions/loader.js:320`; `types.d.ts:976` |
| H4 | direct `node:fs` / `child_process` / `fetch` inside extension code — extensions are in-process | architectural |

**Conclusion, recorded as an accepted limitation rather than a solved problem:** PRD §54
("explicitly enabled extension tooling does not bypass the lease… avoid a model where only
Edit/Write are protected while custom mutation remains unrestricted") is satisfiable for
H1 and H2 by our own discipline — we simply never call `executeBash` from the host, and we
route the MCP server's shell work through prompt-induced tool calls rather than RPC `bash`.
It is **not** satisfiable for H3 and H4 on Pi 0.85.1, because no `exec`/filesystem
interposition layer exists. A trusted extension can mutate the workspace without the agent
loop ever seeing it.

This is a genuine conflict with PRD canon. Per the project's development discipline it is
persisted as discovered work rather than papered over, and it does not block the
non-conflicting portions: the lease still covers every mutation an LLM can initiate, which
is the entire threat model for a delegated Specialist. H3/H4 are a *trusted-extension*
threat, not a *delegated-agent* threat.

### 5.9 The PRD's defense-in-depth ordering is inverted — the hard guard is load-bearing

PRD §52-53 presents active-tool deactivation as the primary fence and the `tool_call` guard
as protection for "current-turn timing gaps". **It is the other way round.**

`setActiveToolsByName` synchronously replaces `agent.state.tools` but is documented as
taking effect **on the next agent turn** (`agent-session.d.ts:320`;
`agent-session.js:634-652`). Within a turn, the agent loop executes against
`currentContext`, a snapshot taken at turn start: `prepareToolCall` resolves each call via
`currentContext.tools?.find(...)` (`agent-loop.js:393-394`), and the snapshot is refreshed
only at the turn boundary (`agent-loop.js:130-145`). In parallel mode every preparation
runs before any execution (`agent-loop.js:332-365`), so a `setActiveTools` call made from
inside one `tool_call` handler cannot affect the rest of that batch. There is no fence,
epoch, or generation counter.

Therefore: **the per-call `block` is the enforcement layer; the tool-set change is
advisory.** Removing a tool mid-turn only changes the next request's tool list and system
prompt — already-emitted tool calls still execute unless individually blocked. Phase 8 must
implement the guard first and treat `setActiveToolsByName` as a cosmetic/aid measure, not
as the fence. Building it the way §52 describes would produce a lease that silently leaks
for the remainder of every turn in which it is acquired.

### 5.10 Model-override validation has a trap — do not use `resolveCliModel` alone

For acceptance D (unavailable explicit model must reject *before* session creation):

- `resolveModelScopeWithDiagnostics(patterns, modelRuntime)` resolves against
  `modelRuntime.getAvailable(...)`, which returns only models whose providers have complete
  auth configuration. An unknown model, or a known one with no auth, yields
  `ModelScopeDiagnostic{ code: "no-match" }` (`dist/core/model-resolver.d.ts`). Both cases
  are catchable at dispatch.
- `resolveCliModel` is **not** a safe substitute. With a known `--provider`, an unknown
  model id is silently accepted as a custom model with a *warning*, not an error; and it
  resolves against the full catalog rather than authed models, deliberately, so that
  `--api-key` first-time setup works. "It returned a model" does not mean "the model
  exists".
- Provider **unreachability** cannot be determined before the first request. Neither
  function probes the network.

**Gate to implement:** (i) `resolveModelScopeWithDiagnostics` returns the requested model
with no `no-match` diagnostic covering its pattern, **and** (ii)
`modelRuntime.hasConfiguredAuth(model.provider)` for the selected model
(`dist/core/model-runtime.d.ts:67-77`). Everything else — reachability, expired OAuth,
wrong custom-model id behind a known provider — is first-request territory and must be
reported as a runtime failure, not a dispatch rejection.

### 5.11 Export map — three subpaths only

`package.json` exports exactly `"."`, `"./rpc-entry"`, `"./client"`. Deep imports
(`dist/core/...`) work inside the pi repo but are **not exported** and must not be used by
an external package. Everything this project needs — `createAgentSession`, `AgentSession`,
`ModelRegistry`, `ModelRuntime`, `resolveModelScopeWithDiagnostics`, `ToolCallEvent`,
`ToolCallEventResult`, `ExtensionAPI`, `ToolDefinition`, the session event types — is on the
package root.

### 5.12 An `AgentSession` does **not** require living in pi's process — verified

This was asserted during research and is **false**; it is corrected here because it would
otherwise have forced the Claude Code integration into the wrong architecture.

`createAgentSession` constructs a session in whatever Node/Bun process calls it. Proof: the
ancestral experiment is launched as `bun run src/cli/main.ts`
(`experiments/agentsession-sre-chain-vertical-slice/package.json:8`) — its own process, not
pi — calls `createAgentSession` at `src/agents/bridge.ts:152` and
`src/agents/specialist-bridge.ts:137`, and contains **no `spawn` anywhere under `src/agents/`**.
The experiment report records the same: "no Pi RPC subprocess… zero subprocesses"
(`experiment-report.md:283-284`).

**Consequence for Phase 13.** The Claude Code MCP server is a Node process, so it hosts
`NativeActivationHost` and its `AgentSession` children directly. It does **not** need
`RpcClient`, the `./client` `RemoteSession`, or any pi subprocess. This is what makes
PRD §99's requirement satisfiable — "the MCP server imports/calls the Specialists runtime
library directly", with `MCP handler → exec("sp run …")` forbidden. Had the claim been
true, the only remaining out-of-process surfaces would have been RPC-shaped, and the
`user_bash` hole H2 (§5.8) would have become structural rather than avoidable.

The lease consequence follows: because the MCP server hosts sessions in-process, its
Specialist children are covered by the same `tool_call` guard as the Pi extension's
children, satisfying acceptance BA (a Claude-launched Specialist obeys the same lease).

### 5.13 `expected_output_keys` is silently ignored on the `sp run` path

`schema.ts` documents `execution.expected_output_keys` as triggering a required-keys check
"independent of `response_format`", returning `error_type: 'invalid_json'` on a miss, so
that "hallucinated key sets" cannot pass as success. That is true only of the `sp script`
surface. The sole consumer is `collectRequiredOutputKeys`
(`src/specialist/script-runner.ts:633`); `SpecialistRunner.run` never reads the field.

So a Specialist authored with `expected_output_keys` and dispatched via `sp run` gets no
required-keys check at all — the precise failure the field exists to prevent. Compounding
it, output validation on the run path is advisory: `validateOutputContract`
(`runner.ts:975`) writes stderr warnings and never fails the run.

Filed as `unitAI-rrdnt.8`. It predates this project and is independent of it, but the
native path must not inherit the gap — hence the `adapted` classification in §7.2 rather
than `native`.

### 5.14 The override contract has three layers, not four

PRD §8 lists "package canonical / global user override / repo default override / repo user
Specialist override". The repo `.specialists/default/` mirror was **retired** by commit
`31a6421c` and is no longer walked by the loader (`loader.ts:147-157`). The live contract
is three layers (KAN-90):

```
package canonical  →  ~/.config/specialists/user.json  →  repo .specialists/user/<name>
```

Stale `.specialists/default/` files left on disk are detected by `drift-detector` and
removed by `sp prune-stale-defaults`, but they do not feed the merge. The legacy paths
`./specialists`, `.claude/specialists` and `.agent-forge/specialists` belonged to the same
retired `scope: 'default'` tier and are likewise non-authoritative.

Consuming the loader unchanged (PRD §8) is still correct; only the PRD's description of the
layer stack is stale. Nothing else in this document depends on the count.

### 5.15 Empirical verification of §5.8-§5.10

The claims in §5.8, §5.9 and §5.10 were originally derived from reading Pi's shipped
JavaScript. They have since been **verified by execution** against 0.84.3 and re-verified against 0.85.1 (harness and
results at `/tmp/xtrm-pi-veto-probe/`, 5 short model turns). Everything below is EXECUTED,
not READ.

**§5.9 confirmed, and improved.** A real parallel batch — one assistant message, two tool
calls — where the `tool_call` handler for call #1 called `setActiveTools` to revoke call
#2's tool: **call #2 still executed** (both marker files created). The same batch with
`{block:true}`: both handlers fired, neither file created. `setActiveToolsByName` cannot
revoke a planned call; `block` is the only fence.

The improvement: **every `tool_call` handler in a batch fires before any tool in that batch
executes** — prepare-all runs to completion, then a `Promise.all`
(`pi-agent-core/dist/agent-loop.js:332-374`). Therefore a lease acquired during call #1
*can* still block call #2 in the same batch, via `block`. Mid-batch lease acquisition is
enforceable, just never by tool removal. §5.9's original wording understated the
guarantee.

**§5.8 confirmed on both sides.** All five LLM tool paths — built-in `edit`, `write`,
`bash`, a `registerTool` tool, and an SDK `customTool` — fired the handler *and* had
execution prevented, proven by side effect (target file unchanged, four marker files
absent), with a veto-off control run confirming the negatives were real rather than broken
plumbing. A blocked call surfaces as `isError=true` carrying the reason string. The two
predicted holes were confirmed with the veto active and blocking everything:
`AgentSession.executeBash()` and `pi.exec()` inside an extension handler each exited 0,
wrote their file, and fired the handler **zero times**.

**§5.10 confirmed, and both halves of the gate are load-bearing.** With
`--provider nvidia --model no-such-model-at-all`, `resolveCliModel` returns a *fabricated*
model — `error: undefined`, only `warning: 'Model "…" not found for provider "nvidia".
Using custom model id.'` — while `hasConfiguredAuth('nvidia')` is `true`. An auth-only gate
accepts a model that does not exist; only the `no-match` diagnostic catches it. Conversely
a real model under an unauthenticated provider resolves cleanly through `resolveCliModel`
and is caught only by the auth check. Neither half alone is sufficient.

**Operational trap:** `ModelRuntime.create({ refreshOnCreate: false })` yields zero
configured-auth providers and an empty `getAvailable()`, which would make the gate reject
every model. Use `{ allowModelNetwork: false }` and leave `refreshOnCreate` alone.

### 5.16 MCP cannot push to a busy Claude Code coordinator

PRD §102 assumes Specialist→Claude events can be pushed "through the supported Claude MCP
channel/event surface where available". Against Claude Code's MCP **client**
implementation, that surface is not available: `sampling/createMessage` is not implemented
(anthropics/claude-code#1785); `resources/subscribe` + `notifications/resources/updated`
are ignored and never refresh model context (#7252); progress notifications and tokens are
not implemented (#31893, #51713); `notifications/message` logging is received and silently
discarded (#3174, #33679); `elicitation/create` is CLI-only and partial (#2799, #85442);
`tools/list_changed` works across turns but not same-turn (#31893).

PRD Phase 14 as specified is therefore not buildable, and acceptance AX cannot be satisfied
over MCP.

**But out-of-band push does work.** Claude Code's own cross-session messaging delivers
unsolicited messages into a running session mid-turn — observed repeatedly while authoring
this document, arriving as `<cross-session-message from="uds:/run/user/1000/cc-socks/<pid>.sock">`.
Both mechanisms `pi-claude-link` (MIT) documents are present and were verified on this
machine: per-PID `0600` sockets under `/run/user/1000/cc-socks/`, and session registration
files under `~/.claude/sessions/<pid>.json`.

Consequent transport reassignment, filed as `unitAI-rrdnt.10` (P0):

```
MCP channel      coordinator → Specialist   (delegate, status, stop, message-in)
peer transport   Specialist → coordinator   (clarification, escalation, finding, completion)
polling          degraded fallback when no peer channel is registered
```

This promotes the PRD Phase 15 roster/peer adapter to a **Phase 14 prerequisite** rather
than an additive layer. It remains an adapter: PRD §107 and invariant 14 still hold, so it
never becomes the source of activation identity, lease authority, result state or forensic
state. Peer delivery passes a user approval gate — observed as an explicit "approved and
released" step — so delivery is never guaranteed and must never be treated as authority
(PRD §26, §111); an undeliverable push degrades to pending state readable via
`specialist_status`, satisfying §30's no-silent-loss rule.

---

## 6. Open decisions requiring an owner

| # | Decision | Blocking | Default if unanswered |
|---|---|---|---|
| 1 | How the Claude MCP server resolves the Pi SDK | Phase 13 | **Resolved — see §5.12.** MCP server hosts sessions in-process; `peerDependency` + global-resolution fallback mirroring `resolveGlobalNodeModulesDir()` `src/pi/session.ts:499` |
| 2 | Fleet vs statusline ordering (§5.1) | Phase 2 | accept `editor → Fleet → statusline`, defer the Core seam |
| 3 | Native path stops auto-provisioning worktrees for MEDIUM/HIGH (§5.4) | Phase 8 | PRD wins; legacy `sp run` unchanged |
| 4 | Identity schema migration — add `attempt_id`, promote `pi_session_id`/`workspace_id` to indexed columns, redefine `participant_id` chain-independently (§6.2) | Phase 7 | do the migration; acceptance AL/AM cannot pass otherwise |
| 5 | `SupervisorStatus` moves from `supervisor.ts:117` to a neutral module | Phase 7 | do it as its own small commit — it is the only thing making `writeStatusRow` non-pure |
| 6 | **Claude transport reassignment (§5.16)** — MCP for request/response, peer channel for push, polling as fallback | **Phase 13/14** | **Resolved — `docs/design/claude-transport-decision.md`** (`unitAI-rrdnt.10`). Peer adapter is a Phase 14 prerequisite. Measured on the authoring host: the roster misreports liveness (10 of 20 registrations named dead PIDs while advertising `status: idle`), so liveness is `/proc/<pid>` + `procStart`, never socket existence |
| 7 | Whether `expected_output_keys` is honoured on the run path or documented as script-only (§5.13) | Phase 1 | **Resolved — documented as script-only** (`unitAI-rrdnt.8`). The "honour it" default was wrong: the sole declarer (`service-knowledge-sync`) binds those keys to its JSON `script_template`, not its markdown `task_template`, so enforcing on the run path would reject compliant runs. The native path still must not inherit the gap |

---

## 9. Phase 0 exit statement

The reusable seams are identified. Concretely:

- **Reuse as-is:** the entire forensic write layer (`appendForensicEvent`, `appendEvent`,
  `mapCallbackEventToTimelineEvent`, every timeline factory), `renderTaskPrompt`,
  `validateBeforeRun`, the script runners, the tool-contract resolvers, the output-contract
  validators, `runAutoCommitCheckpoint`, and `SpecialistLoader` unchanged.
- **Extract:** `buildSystemPrompt()` out of `runner.ts:1259-1467` (the one expensive item),
  `runWithModelChain()` out of `runner.ts:1548-1633`, and the `SupervisorStatus` type out of
  `supervisor.ts`.
- **Build new:** `DispatchGate` (bead readiness — absent today), `WorkspaceLeaseStore`
  (absent today), the participant interaction protocol (absent today),
  `AgentSessionForensicAdapter` (the event *source* must be rewritten even though the
  event *sink* is reusable), `ActivationResult`, and the identity migration.
- **Do not port:** the subprocess boundary, one-turn dispose, chain/step materialization,
  `pi-intercom` for same-process children, `pi-subagents`' file-set telemetry.

Five findings change the plan rather than merely informing it:

1. **Bead-readiness enforcement does not exist at all** — not weakly enforced, absent. PRD
   Phases 3 and 13 must each add it, at `src/cli/run.ts:1923-1931` and
   `src/tools/specialist/use_specialist.tool.ts:39-46`, sharing one validator.
2. **No workspace lease exists**, and `worktree_owner_job_id` misleadingly presents as one
   in the console (§5.5).
3. **Only one of the PRD's four identity layers is durable** (§6.2); `attempt_id` is absent
   outright, so acceptance AM cannot pass without a migration.
4. **The §52 defense-in-depth ordering is inverted** (§5.9, verified by execution in
   §5.15). The per-call `block` is the enforcement layer. Building it as the PRD describes
   would produce a lease that leaks for the remainder of every turn in which it is acquired.
5. **MCP cannot push to a busy Claude coordinator** (§5.16). PRD Phase 14 is not buildable
   as specified; the Phase 15 peer adapter moves onto the Phase 14 critical path.

Two PRD statements are additionally stale rather than wrong-in-consequence: the override
stack is three layers, not four (§5.14), and per-activation model override already exists
(§7.2) — the new work is pre-creation validation.

`buildSystemPrompt` is extracted (`unitAI-rrdnt.3`, commit `378e55fe`), so **Phase 1
(read-only native Specialist) is unblocked** and can start against the installed Pi 0.85.1
surface.
