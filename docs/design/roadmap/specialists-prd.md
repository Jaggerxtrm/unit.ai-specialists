# Specialists Programme PRD — Current Canon

> **Status:** CANONICAL / NORMATIVE requirements and acceptance contract  
> **Owner:** `xtrm-dev/specialists`  
> **Date:** 2026-08-22  
> **Programme residual:** `xtrm-cn8.5`  
> **Replaces as current reading path:** `enhanced-prd.md` v3.2 (preserved in `history/enhanced-prd-v3.2-2026-07-24.md`)  
> **Work-package continuity:** [`wp-continuity.json`](wp-continuity.json) — all 90 historical `WP-*` identifiers remain stable.

## 1. Document role and authority

This PRD owns the **current Specialists programme requirements, work-package families, acceptance criteria, and promotion rules**. It deliberately does not embed historical release snapshots, superseded planning packets, old Beads migrations, prompt examples, or multi-generation revision narratives.

Use the following authority order:

1. Current repository code, executable schemas, tests, released artifacts, and installed runtime behavior define what exists now.
2. [XTRM Native Chain Runtime PRD](https://github.com/xtrm-dev/xtrm/blob/main/docs/runtime/prd/native-chain-runtime.md) and ADR-001…006 define the integrated cross-domain runtime model.
3. [`specialists-roadmap.md`](specialists-roadmap.md) defines Specialists-owned architecture, package sequencing, and current bridge/read-forward decisions.
4. [`specialist-execution-protocol.md`](../execution-protocol-design/specialist-execution-protocol.md) defines the deterministic lifecycle of one managed Specialist activation.
5. This PRD defines accepted Specialists programme scope, `WP-*` continuity, evaluation requirements, rollout gates, and success criteria.
6. [`current-release-snapshot.md`](current-release-snapshot.md) is the mutable release/landed-state ledger. It may change status classifications without redesigning this PRD.
7. Repository-local Beads and Git are implementation/task and integration truth. Jira is programme projection, not a step-level source of truth.

Historical documents under [`history/`](history/) remain provenance only unless this PRD or the roadmap explicitly retains a requirement.

## 2. Product objective

Specialists provides governed role definitions and participant execution semantics for XTRM chains. The target is not a collection of prompt-heavy autonomous scripts. The target is a measurable runtime in which:

- Specialist role cognition is small, explicit, versioned, and reproducible;
- chain membership, step mandate, upstream evidence, and downstream obligations are deterministic;
- one common activation protocol surrounds the model with PREPARE and FINALIZE safety boundaries;
- requested capabilities are resolved into explicit grants rather than inferred from role prose;
- skills contain cognition/procedure while deterministic probes, validators, effects, and finalization live in typed runtime contracts;
- evidence, not self-report or process termination, satisfies chain work;
- prompt, model, memory, chain, and runtime changes are evaluated with deterministic and calibrated graders before promotion;
- current Beads, Git, xtmux, XTRM runtime, Channels, telemetry, and Console authorities remain non-duplicated.

The system invariant is inherited from the XTRM runtime canon:

> Pi owns the model session. XTRM owns what that session means inside a governed workflow.

## 3. Integrated runtime boundary

### 3.1 Workflow objects

The cross-domain chain lifecycle is:

```text
ChainSource
  → ChainDefinition
  → ResolvedChain
  → ChainRun
```

`TemplateChainSource`, `JsonChainSource`, `AdHocChainSource`, and `ImportedWorkflowSource` all pass through the same loader/compiler. The Specialists formula catalog is a compatibility/promotion source, not the ontology.

### 3.2 Specialist objects

The Specialists-owned role/runtime projection is:

```text
SpecialistDefinition
  → SpecialistActivationProfile
  → ResolvedCapabilityGrant
  → Activation
  → AgentSession
```

`SpecialistDefinition` owns authored role cognition and requests. `SpecialistActivationProfile` is the frozen runtime projection of the effective definition for one resolved chain/step/environment. It includes source/cognition fingerprints, runtime feature disposition, requested capabilities, PREPARE requirements, result/evidence contracts, finalization requirements, and model/runtime preferences.

### 3.3 Identity

The runtime must preserve these distinctions:

```text
participant_id != job_id != attempt_id != pi_session_id
```

- `participant_id`: stable logical participant within its chain/container scope;
- `job_id`: one activation;
- `attempt_id`: one attempt/retry within the activation lineage;
- Pi session identity: physical model session owned by Pi.

A new physical session may continue the same logical participant lineage after recovery. No display name, pane, session name, or message body may substitute for runtime-derived identity.

### 3.4 Supervision

Three supervisors have distinct authority:

- **ChainReducer/Scheduler** — derives workflow progression from persisted evidence and emits exact intents;
- **ActivationSupervisor** — supervises exactly one directly hosted participant activation, including start, settlement, heartbeat/stall, timeout, retry signal, cancel/abort, and disposal;
- **xtmux RuntimeSupervisor** — supervises external/interactive runtime instances through terminal/provider adapters.

A direct Pi AgentSession does not require tmux for correctness. tmux/xtmux may remain an operator and observability backend.

## 4. Non-negotiable invariants

```text
SpecialistDefinition != ChainDefinition
ChainDefinition != ResolvedChain
ResolvedChain != ChainRun
Participant != Activation
Activation != AgentSession
agent_end != protocol completion
result exists != result validated
job completed != chain step satisfied
requested capability != granted capability
message body != authority
attention != authorization
visibility != action target
read != processing acknowledgement
delivery != processing
working state != semantic memory
template != only ChainSource
UI != scheduler
xtmux != workflow authority
```

No new Specialists feature may introduce a second mutable authority for a concern already owned by Beads, Git, XTRM chain runtime, Channels, telemetry, or xtmux runtime state.

## 5. Deterministic Specialist execution

The canonical activation lifecycle remains:

```text
PREPARE
→ typed agentic PLAN
→ typed agentic EXECUTE
→ FINALIZE
```

The semantic contract and detailed state machine live in the execution-protocol document. This PRD requires the following outcomes.

### 5.1 PREPARE

PREPARE resolves and validates before model work begins:

- participant/activation/attempt/root/chain/step identity;
- effective SpecialistDefinition and SpecialistActivationProfile;
- source JSON, rules, skills, cognition assets, and hashes;
- root/step work contract and bounded upstream evidence/context;
- workspace/worktree/branch and writer-lease state where applicable;
- requested capabilities and actual `ResolvedCapabilityGrant`;
- required typed probes;
- model/provider availability and fallback policy;
- retry/convergence budget;
- result/output/evidence contract.

A required contract that cannot be established blocks before agentic execution.

### 5.2 PLAN and EXECUTE

The model owns semantic reasoning and role work inside the granted capability envelope. Typed local planning may adapt to evidence but may not widen contract scope or mutate chain topology.

The model does not:

- schedule successors;
- own polling/wait/retry orchestration loops;
- mutate ResolvedChain;
- grant itself capabilities;
- mark its result authoritative;
- bypass deterministic gates;
- infer write authority from a role name or prompt text.

### 5.3 FINALIZE

FINALIZE validates and persists in deterministic order:

1. output schema;
2. evidence requirements and freshness;
3. scope and capability compliance;
4. Git/worktree state and commit policy where applicable;
5. authoritative result;
6. Beads work/evidence reconciliation;
7. typed Channels/handoff notification;
8. forensic and evaluation facts;
9. activation-owned cleanup.

External effects have idempotency keys and durable receipts. Outcomes are `completed`, `failed`, or `uncertain`. `uncertain` blocks blind replay until reconciliation records resolving evidence.

## 6. Capabilities, skills, probes, and tools

### 6.1 Capability equation

```text
ResolvedCapabilityGrant =
    Specialist requested capabilities
  + Chain/step policy
  + operator policy
  + runtime/sandbox capabilities
```

The plus signs represent policy resolution, not union. A request may be denied or narrowed.

`required_tools` expresses an execution requirement. It does not directly enable unrestricted Pi built-ins. Runtime tools must be exposed through the resolved grant and their declared authority.

### 6.2 Taxonomy

The canonical conceptual split is:

```text
cognition
  skills
  system/task cognition
  procedures

activation policy
  model / fallback
  timeout / retry
  capability requests

PREPARE
  typed probes
  validators
  context resolvers

result contract
  output schema
  evidence requirements

FINALIZE
  validators
  projections
  terminal effects
```

Legacy `skills.scripts` may compile to typed `ProbeDefinition`/effect contracts for compatibility. Arbitrary shell from Specialist JSON is not a privileged implicit preflight API.

### 6.3 Probe requirements

Production ProbeDefinitions must declare at least:

- stable ID/version;
- phase;
- required capabilities;
- cwd/scope;
- timeout/output bounds;
- deterministic status/exit contract;
- result schema/content type;
- evidence identity;
- retry/idempotency/side-effect class;
- forensic receipt and redaction policy.

## 7. Prompt and policy modernization

The original prompt-modernization programme remains active where residual work exists. The target effective prompt is composed from five conceptual layers:

```text
small role core
+ applicable shared mandatory rules
+ compact runtime/chain identity
+ task/step contract
+ on-demand procedural skills/tools
```

Requirements:

1. Shared policy has one source of truth; generated schemas/contracts outrank duplicate prose.
2. Role prompts contain role mandate, boundaries, evidence hierarchy, and decision rules — not general programming manuals or duplicated CLI instructions.
3. Runtime injections are role-aware; read-only roles do not receive writer rituals.
4. Output contracts use one formal merged schema and stable status/verdict vocabulary.
5. Effective prompt components, rules, skills, runtime injections, tool catalog, model configuration, and output schema are fingerprinted per activation.
6. Prompt/model/rule changes are promoted through controlled evaluation, never by anecdotal PASS rate.
7. Reviewer false-PASS, writer scope violation, test-role source-boundary violation, and schema validity remain hard quality dimensions.

## 8. Chain participant context and cooperation

A participant must receive compact deterministic chain identity without receiving an unbounded transcript.

Required startup context includes, where available:

- ChainRun/ResolvedChain/root/step identity;
- role and step class;
- effective scrutiny/policy;
- completed required upstream participants and evidence pointers;
- pending required gates;
- context-completeness flags;
- downstream obligation;
- workspace/lease information relevant to the role.

Retrieval order is pointer-first:

1. injected chain/runtime metadata;
2. step and root work contract;
3. preloaded bounded dependency evidence;
4. exact upstream results/evidence;
5. current repository/Git state;
6. detailed feed/forensics only when chronology or claimed action must be verified;
7. related work edges;
8. semantic memory only when prior durable knowledge is materially relevant.

Channels communication follows the XTRM Channels canon. Participants may share findings, request evidence/context, challenge hypotheses, and propose involvement. Routing remains hard, attention soft, authority hard. Participant communication never rewrites chain topology or grants work authority.

## 9. Work, Beads, and chain materialization

Beads remains the runway work/acceptance authority.

Rules:

- a root work contract may pre-exist chain composition;
- planning/composition produces an inspectable ChainDefinition before production materialization;
- after review/freeze, known step work is materialized idempotently using Beads-native hierarchy/readiness/gates/claims where sufficient;
- hierarchy and readiness edges are distinct;
- Specialists must not maintain a competing blocker/dependency graph;
- one mutable workspace has one writer lease; planned concurrent writers require separate worktrees and explicit integration topology;
- formulas remain supported compatibility ChainSources until migrated/compiled through the generic ChainDefinition pipeline.

The first implementation acceptance fixture is the SRE workflow with zero SRE-specific generic runtime topology code.

## 10. Memory requirements

Memory is a governed capability, not a default prompt dump.

Distinct surfaces remain distinct:

```text
working state
session continuity
transcript/history
evidence
forensics
semantic memory
policy/skill
```

Semantic memory is reusable promoted knowledge only.

The retained lenses are:

- `herd` — project/domain reusable knowledge;
- `workgroup` — bounded work-class/collaboration knowledge;
- `identity` — reusable actor/role operating knowledge.

Execution lineage is provenance/filter context, not a fourth memory store.

Promotion flow:

```text
observation / finding
→ evidence
→ memory candidate
→ dedupe / contradiction / supersession
→ review/policy
→ promoted versioned memory
```

Memory retrieval is targeted and provenance-aware. Current contract/code/evidence outrank memory. A model may propose memory but may not silently rewrite global memory, skills, mandatory rules, or Specialist definitions.

## 11. Telemetry and forensics

`xtrm.forensic.v1` remains the exact high-cardinality forensic envelope. Specialists emits compatible facts; it does not introduce another event envelope.

Requirements:

- identity/correlation fields are preserved across participant, activation, attempt, session, chain, work, Git, evidence, and eval lineage;
- canonical tool calls are deduplicated by tool-call identity and lifecycle phase;
- thinking/turn/message/tool timing semantics are explicit and versioned;
- historical data has `complete | partial | unavailable | estimated` completeness rather than implicit zero;
- changed metric semantics are versioned;
- Prometheus exposes low-cardinality aggregates only;
- raw prompts, output bodies, credentials, raw paths/commands/errors and high-cardinality IDs are not labels;
- every promotion-relevant metric must have resolved counting semantics before it is used as a gate.

## 12. Eval Core

Do not create a second evaluation subsystem. Preserve the existing Eval Core entities:

```text
EvalSuite
EvalCase
EvalExperiment
EvalTrial
EvalArtifact
EvalScore
PairwiseComparison
HumanAnnotation
```

### 12.1 Candidate fingerprint

A candidate is the resolved combination of model, Specialist version, prompt/rules/skills, runtime injections, tool/capability grant, thinking level, chain position, task/environment, and runtime version. The complete candidate is fingerprinted.

### 12.2 Evaluation levels

Hard gates precede weighted quality/cost dimensions.

Evaluate:

- environment/outcome correctness;
- role and capability compliance;
- evidence correctness;
- chain contribution and cooperation;
- operational reliability/recovery;
- efficiency/cost separately.

### 12.3 Whole-chain/runtime subjects

Extend the existing subject model to include:

- ChainDefinition normalization/validation;
- compiler determinism;
- ResolvedChain freeze integrity;
- materialization parity;
- ChainRun/Container outcome;
- scheduler determinism;
- effect idempotency and duplicate-effect rate;
- `uncertain` reconciliation;
- crash/replay equivalence;
- participant/activation lineage;
- stale-activation rejection;
- capability/probe enforcement;
- Channels delivery/processing consistency;
- wake amplification;
- cooperation/handoff usefulness;
- resource cleanup/leak rate;
- end-to-end outcome per time/token/cost.

Use the cheapest reliable grader first:

```text
environment/state
→ deterministic trace
→ deterministic artifact
→ calibrated model grader
→ human adjudication
```

Model graders remain advisory unless independently calibrated and promoted.

### 12.4 Continuous evaluation

After every run, eligible deterministic graders may score schema, role boundary, forbidden action/path, handoff completeness, startup context, telemetry integrity, and required evidence.

After every chain, evaluate topology/gate completion, final verdict consistency, remediation loops, recovery, cleanup, time/tokens to PASS, and final outcome.

High-risk model-based graders begin in shadow mode.

## 13. Interactive coordinator bridge

The current interactive `chain-coordinator` is a bridge participant/operator aid, not chain topology authority.

Requirements retained from the interactive programme:

- stable role cognition excludes tracked Bead payload and flattened mandatory-rule blocks;
- direct tracked assignment and preheated standby are distinct modes;
- tracked Bead/task/rules arrive exactly once as a user assignment after runtime readiness;
- prompt bodies do not leak through argv, pane metadata, message summaries, or low-cardinality telemetry;
- Pi and Claude remain interactive after assignment;
- the coordinator consumes validated chain shape rather than hardcoded role sequences;
- conflict/collision mechanics, close-readiness evidence, and bounded escalation are explicit;
- mechanical coordination may be peer-to-peer; vision/architecture/authority changes escalate to the owning orchestrator/operator;
- bridge assignment and xtmux notification paths carry retirement triggers toward the canonical runtime/Channels model.

Coordinator agents must not own fanout/poll/wait/retry/child-failure loops that belong to deterministic runtime supervision.

### 13.1 Native Pi extension surface — authoritative inventory

The native Pi extension (`config/pi-extensions/specialist-subagents/index.mjs` over
`dist/lib.js`, rebuilt from `src/` on every change) is the reference implementation the MCP
Claude Code plugin must mirror field-for-field. The following inventory is normative: anything
here absent from the MCP surface is a parity gap, not a Pi-only feature.

**Dispatch (`specialist_dispatch`).** Exactly one of `bead_id` (an existing READY Bead) or
`contract` (inline 7-section contract plus SCRUTINY level — eight required parts). The readiness
gate runs before anything is created; an inline contract creates its bead first. Optional:
`title`, `model_override` (refused before session creation when unavailable, never silently
replaced), `thinking_override` (one of `off|minimal|low|medium|high|xhigh`, same fail-closed
rule), `requested_by`, `coordinator_session_id`, `epic_context_depth` (1 walks to the parent
epic, 2 also the grand-epic). Returns identity and admission only — never a result; a result
is read later from `specialist_status`, never substituted for an interaction message.

**Projections.** `specialist_status` maps live snapshots through `toActivationView`:
`activation_id`, `specialist`, `bead_id`, `state`, `access`, `model_override`,
`thinking_override`, `thinking_level` (omitted when unset, never fabricated), `purpose`
(one-line SCOPE-then-SUCCESS excerpt captured once at dispatch, omitted when absent),
`elapsed_s` (in-memory snapshot read, never a query), `token_usage` (monotonic
non-decreasing per key on both delta-shaped and cumulative-shaped provider usage; row-budget
short rendering, never a window-context percent), `last_activity_at`, plus the validated
`result` object on settled activations. Forensic IDs never appear in rows.

**Fleet UI.** A footer-section seam (`registerFooterSection`) renders below the XTRM
statusline: collapsed line plus at most 8 expanded rows, needs-reply first. Running rows lead
with a millisecond-resolution spinner; settled rows keep final spend; zero/absent tokens render
as nothing. No `setWidget` fallback, no poll timer, no `ui.custom` mount — the seam is the
only surface; without it the fleet stays hidden and slash commands report text.

**Wake notifications.** Ask and settle events emit follow-up messages
(`specialist_ask`/`specialist_settled`) carrying a far-left rail in `#8d7fe8`; fleet rows and
tool-result cards carry no rail.

**Control.** `specialist_reply` answers by message ID (unknown IDs reported, never silently
passed); `specialist_resume` continues the same session; `specialist_stop_activation` disposes
explicitly — settled activations stay resumable until stopped (stop duty). No per-call
re-import, no hot reload; every outcome carries a build-identity line naming staleness when
the runtime was rebuilt after load.

**Workspace and evidence.** Dispatch admits through a workspace lease (writers fenced out of
held paths; coordinator fenced out of held workspaces); every activation writes forensically
to the shared observability store. Spend and timing come from the in-memory snapshot and the
event stream — per-tool "doing X now" inference is out of scope.

## 14. Policy hooks and runtime adapters

Cross-harness policy must have one semantic kernel with thin runtime adapters.

```text
shared policy / schema / decision kernel
├── Claude hook adapter
├── Pi extension adapter
└── authoritative runtime/composition validator
```

Requirements:

- cheap no-match path;
- stable finding fingerprints;
- off → shadow → warn → enforce rollout;
- no hook may become a second scheduler or release authority;
- adapters derive runtime identity rather than trusting prompt/body identity;
- adapters do not own durable workflow state privately;
- provider/transport differences do not redefine chain or participant semantics.

## 15. Console and operator surfaces

Console remains a read/control projection over versioned upstream contracts.

Specialists owns detailed run/eval semantics and evidence production. Console may materialize summaries, freshness/completeness, experiment state, and forensic pointers. It must not read private per-repo storage directly from the frontend or mutate source telemetry during normal reads.

Required evaluation views remain:

- suite/regression health;
- experiment/candidate comparison;
- case and trial detail;
- chain evaluation timeline;
- historical mining/case promotion;
- live evaluation status;
- regression drift;
- drilldown to jobs, work contracts, chain, evidence, Git/PR, tests, and grader output.

## 16. Security, privacy, and authority

- Raw prompt/output bodies remain protected artifacts, not metrics.
- Candidate/evidence bundles are minimized and redacted.
- Held-out fixtures are not exposed to candidate agents.
- Read-only roles are enforced by tool/filesystem/runtime policy where available, not prompt prose alone.
- Commit staging is explicit and path-scoped.
- Message bodies never grant authority.
- Capability grants are runtime state, not user-editable body fields.
- Scope expansion requires an explicit contract/authority transition.
- Specialist/self-improvement findings may create governed proposals; a Specialist may never silently edit its own definition or mandatory policy.

## 17. Work-package registry and continuity

The historical programme defines **90 stable work-package identifiers**. They remain valid traceability anchors and MUST NOT be silently renumbered or recreated under a second namespace.

The complete per-ID title, source, documentary status claim, delivery evidence, and residual risk are maintained in [`wp-continuity.json`](wp-continuity.json).

Canonical families:

| Family | IDs | Current purpose |
|---|---|---|
| Programme/document gates | `WP-G00`–`WP-G03` | documentation, Beads capability/reuse, traceability gates |
| Telemetry integrity | `WP-T01`–`WP-T07` | event/counting correctness, fingerprints, telemetry suite |
| Eval Core | `WP-E01`–`WP-E10` | storage, graders, backfill, experiments, CLI, scheduling |
| Prompt/policy | `WP-P01`–`WP-P09` | prompt manifest, output contract, role/runtime policy, evaluated prompt changes |
| Execution protocol | `WP-XP01`–`WP-XP07` | protocol schemas, PREPARE, planning/evidence, FINALIZE, failure injection |
| Chain foundation/context | `WP-C01`–`WP-C10` | workspace/shape/composition/dispatch/context/handoffs/chain eval |
| Memory | `WP-M01`–`WP-M06` | memory audit, retrieval, pull policy, telemetry/eval, promotion |
| Role/eval suites | `WP-S01`–`WP-S08` | reviewer/executor/seconder/test/research/chain/telemetry suites |
| Console | `WP-U01`–`WP-U06` | eval materialization/query/UI/live/adjudication surfaces |
| Interactive coordinator | `WP-IC01`–`WP-IC13` | skill/prompt/rendering/readiness/assignment/protocol/eval/chain consumption |
| Shared policy hooks | `WP-H01`–`WP-H05` | policy kernel, Claude/Pi adapters, authoritative validator, rollout |
| Deferred XTRM-owned target work | `WP-X01`–`WP-X05` | Stage-0/Channels/xtmux target integration; not a Specialists runway dependency unless current XTRM plan promotes it |

Total: **90 identifiers**.

### 17.1 Status rule

`wp-continuity.json` records documentary status only; before dispatch, refresh current code, releases, Beads, and the XTRM execution plan. A historical `defined` status does not prove that work remains, and an old `delivered` claim does not prove current release identity.

### 17.2 No duplicate backlog

Before creating work:

1. query current repository-local Beads;
2. map the intended outcome to existing `WP-*` IDs;
3. classify existing work as KEEP / REFINE / MERGE / RESEQUENCE / REPLACE / DELIVERED / SUPERSEDED;
4. create a new Bead only for a genuinely missing executable contract;
5. preserve discovered-from provenance for new findings.

## 18. Programme sequencing and promotion

The XTRM current execution plan is the single cross-repository sequencing authority. This PRD does not copy its dependency DAG.

Within Specialists, the ordering invariants are:

```text
current release/interface truth
→ ChainSource/ChainDefinition + compiler/freeze foundations
→ minimum participant execution contracts
→ materialization and evidence reducer/scheduler
→ data-defined SRE parity fixture
→ recovery/receipt hardening
→ whole-chain Eval Core
→ measured prompt/memory/coordinator authority promotion
```

Telemetry/eval baselining and observe-only protocol work may proceed in parallel where it cannot mutate authoritative lifecycle or chain state.

Do not promote:

- automatic chain advancement before deterministic evidence/recovery gates;
- coordinator authority before measured Eval Core evidence;
- prompt/model changes using ambiguous telemetry;
- automatic memory writes before precision/promotion policy;
- generic shell/probe execution without explicit capability grant;
- external workflow/RLM children into chain authority;
- full Substrate migration merely to unblock the native runtime.

## 19. Acceptance criteria

### 19.1 Specialist activation

- every managed native activation records effective Specialist source/profile and protocol identity;
- PREPARE fail-closes on structural contract, mandatory-policy, capability, cognition/probe, or required-input failure;
- required cognition assets are fingerprinted and drift can be detected;
- capability requests resolve into explicit grants;
- local plans cannot widen role/step scope;
- required evidence is typed, attributable, and current;
- output schema validates before authoritative persistence;
- writer finalization touches/stages only authorized paths and honors commit policy;
- read-only profiles cannot obtain write/commit capability through task prose;
- result/Bead handoff/notification/final effects are idempotent;
- notification failure cannot rewrite an otherwise valid result verdict;
- cleanup releases activation-owned transient resources without destroying durable work/evidence.

### 19.2 Chain integration

- templates, user JSON, ad-hoc typed composition, and imported formulas can converge through the generic ChainSource/ChainDefinition path;
- approved topology is frozen and revisions are explicit;
- Beads materialization follows freeze and agrees with native readiness/claim semantics;
- a participant executes the assigned step rather than deciding successors;
- validated evidence, not process exit, satisfies a chain step;
- crash/restart does not rerun already satisfied authoritative work;
- duplicate authoritative effects are prevented or reconciled;
- the SRE fixture runs data-defined with zero SRE-specific generic topology code.

### 19.3 Prompt/policy

- effective prompt/cognition components can be fingerprinted;
- generated output schema is the machine-readable SSOT;
- role prompt changes have controlled regression/capability evidence;
- reviewer false-PASS and role-boundary regressions do not increase;
- first-turn context reduction is measured against outcomes, not token count alone.

### 19.4 Telemetry/Eval

- promotion metrics have unambiguous counting semantics;
- exact IDs stay out of Prometheus labels;
- existing runs can be evaluated only for dimensions whose evidence exists, with explicit completeness;
- new runs receive deterministic post-run grading where configured;
- ChainRuns can receive whole-chain grading;
- experiments record candidate/environment fingerprints and paired comparison evidence;
- promotion policy can block regressions and leaves a reproducible report.

### 19.5 Memory

- memory retrieval is targeted and provenance-bearing;
- unnecessary retrieval is measurable;
- findings remain candidates until promotion;
- contradictions/supersession are explicit;
- no unreviewed activation silently changes global knowledge/policy.

### 19.6 Interactive bridge

- runtime readiness precedes tracked assignment delivery;
- task/rules arrive exactly once;
- prompt bodies do not leak into unsafe transport surfaces;
- Pi/Claude remain interactive;
- coordinator uses canonical chain/runtime state rather than reconstructed hardcoded sequences;
- bridge mechanisms have explicit retirement owners/triggers.

## 20. Current open decisions

Only implementation choices that remain genuinely unresolved should live here. Architectural questions closed by XTRM ADR-001…006 are not reopened locally.

Before the affected package is dispatched, verify/decide as needed:

1. canonical base status/reviewer-verdict storage and presentation casing if current schemas still diverge;
2. exact versioned CLI/JSON names for interactive role assignment surfaces where not already released;
3. secure prompt transport-file lifecycle/expiry policy if still used by the bridge;
4. exact coordinator conflict-matrix serialization if it remains a bridge artifact;
5. exact Claude readiness fact source where current hooks do not provide parity;
6. current Beads memory retrieval/provenance surface before adding wrappers;
7. which deterministic graders may become blocking in the first enforcement wave;
8. authoritative provider-cost provenance; tokens/time remain primary until cost source is versioned;
9. trial-count/confidence policy by evaluation suite;
10. retention policy for long-lived eval and hidden-fixture artifacts;
11. runtime vocabulary/event-name decisions explicitly marked open in the XTRM runtime decision matrix;
12. package/source placement decisions that require current local dependency evidence.

These decisions do not authorize a new competing runtime or work-package namespace.

## 21. Historical continuity and supersession

The former `enhanced-prd.md` v3.2 is preserved unchanged under [`history/enhanced-prd-v3.2-2026-07-24.md`](history/enhanced-prd-v3.2-2026-07-24.md). It remains the provenance source for:

- the detailed 12–24 July investigation/reconciliation narrative;
- historical release/version tables;
- full original WP tables and filed-Beads disposition appendices;
- proposed role prompt bodies;
- historical command examples and rollout drafts.

[`history/chains-prompt-evals.md`](history/chains-prompt-evals.md) is an earlier predecessor and remains historical.

Neither historical file is implementation authority after this consolidation. When a historical detail appears useful but is absent here, first determine whether it is still valid against current code/runtime and `wp-continuity.json`; do not silently resurrect superseded bridge assumptions.

## 22. Next implementation milestone

The documentation programme terminates into one bounded implementation milestone:

> **Make the SRE chain the first completely data-defined XTRM chain.**

Expected implementation sequence, owned by the XTRM runtime plan rather than this PRD:

```text
ChainSource + ChainDefinition contracts
→ ChainLoader
→ pure compiler → ResolvedChain
→ migrate SRE topology from hard-coded runtime data to chain source
→ semantic/parity proof
→ SpecialistActivationProfile integration
→ PREPARE
→ capability resolver + typed probes
→ ActivationSupervisor
→ FINALIZE
→ receipts/recovery hardening
```

This PRD defines the Specialist-side requirements and acceptance bars consumed by that work. It does not itself authorize implementation outside the current XTRM execution plan.