// config/pi-extensions/specialist-subagents/index.mjs
//
// The PRIMARY coordinator surface named in the PRD — the Pi extension over
// `NativeActivationHost`. MCP (integrations/claude-code) is the other frontend;
// both serialise the SAME `InteractionMessage` protocol and the SAME
// `ActivationSnapshot` projection, and neither spawns a process. A tool that
// shelled out to `sp run` would satisfy the letter of "dispatch a Specialist"
// and defeat the entire purpose of the native runtime; nothing in this file
// constructs a child process (VALIDATION 2 asserts this on the process table).
//
// What this file does NOT do (and why):
//   - No permission logic. The capability invariant (PRD §112) — extension
//     installed != extension selected != capability granted — is enforced by the
//     host: only the resolved tool contract reaches the child session, plus the
//     two ask/escalate tools, fail-closed. `extension-tool-policy` remains the
//     single selector; nothing here reimplements it (PRD §113).
//   - No scheduler and no workflow engine (PRD non-goals). Dispatch is one
//     activation; the Fleet Registry inside the host is the persistent state.
//   - No second message vocabulary (PRD invariant BH). `specialist_reply`
//     correlates on `message_id` and nothing else; the answer returns as the
//     child's ask-tool result, resuming the same AgentSession.
//
// The host is a process-lifetime singleton created on first tool use: the
// FleetRegistry inside it is the seam that survives a turn boundary (VALIDATION
// 5). A per-turn host would answer `specialist_status` with an empty Fleet while
// children were still running.
//
// POLLING BUDGET (measured, not guessed): a child turn on a typical small model
// takes ~2 minutes (120s observed with deepseek-v4-flash), and the coordinator
// must keep polling specialist_status across the whole window. A loop that ends
// before settlement returns an empty result that looks like a fast failure —
// budget >= 3 minutes of polling before concluding an activation is stuck.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import {
  createActivationForensicSink,
  createObservabilitySqliteClientAtPath,
  describeBuildIdentity,
  DispatchRejectedError,
  evaluateBeadReadiness,
  extractSections,
  NativeActivationHost,
  resolveModelChain,
  resolveObservabilityDbLocation,
  resolveRuntimeToolContract,
  SpecialistLoader,
  admitCoordinatorToolCall,
  leaseScopeFor,
  readBuildId,
  toActivationResultView,
  toActivationView,
  toPendingAskView,
  validateBeforeRun,
} from '../../../dist/lib.js';


/**
 * Fence the COORDINATOR out of a workspace a Specialist is writing (PRD acceptance U,
 * unitAI-rrdnt.61).
 *
 * `pi.on('tool_call')` fires before a tool executes and can block — the per-call hook
 * workspace-lease.ts §5.9 requires, and the one `setActiveToolsByName` cannot provide.
 *
 * FAILS OPEN, on purpose and without exception. This handler runs on the operator's own
 * session: a bug here that threw or refused wrongly would stop them editing their own
 * repository, and the failure would surface as an unexplained refusal with no obvious cause.
 * A fence that occasionally misses a block is recoverable; one that wrongly blocks the
 * operator is not.
 *
 * It uses `admitCoordinatorToolCall`, NOT the Specialist-side `admitToolCall`. The latter
 * refuses an UNLEASED workspace, because a Specialist must hold a lease to mutate — applying
 * that to the coordinator would refuse every write whenever no Specialist was running.
 *
 * The boundary this does NOT cover, stated rather than implied: `pi.exec` and direct
 * `node:fs` inside extension code (H3/H4) are not interposable on Pi 0.85.1, so this fences
 * every mutation the coordinator's MODEL can initiate and no more.
 */
export function installCoordinatorFence(pi, deps = {}) {
  const scopeFor = deps.leaseScopeFor ?? leaseScopeFor;
  const admit = deps.admitCoordinatorToolCall ?? admitCoordinatorToolCall;
  const cwd = deps.cwd ?? process.cwd();

  pi.on('tool_call', (event) => {
    try {
      const verdict = admit({ toolName: event.toolName, workspace: scopeFor(cwd) });
      if (verdict.allow) return undefined;
      return { block: true, reason: `specialist-subagents: ${verdict.reason}` };
    } catch {
      // Never let this handler be the reason an operator cannot write.
      return undefined;
    }
  });
}

/** Default coordinator ParticipantId: <participant_kind>::<participant_role>, matching MCP. */
export const DEFAULT_REQUESTED_BY = 'adapter::pi-extension';

export const FLEET_MAX_ROWS = 8;

export function fleetSummaryOf({ activations, asks }) {
  const act = activations ?? [];
  const pending = asks ?? [];
  const active = act.filter((v) => v.state === 'running').length;
  return { active, waiting: act.length - active, needsReply: pending.length, total: act.length };
}

export function formatElapsedShort(elapsedS) {
  return `${Math.max(0, Math.floor(elapsedS ?? 0))}s`;
}

/** Row-budget purpose excerpt: single line, whitespace-collapsed, bounded. */
export const PURPOSE_ROW_MAX = 60;

export function formatPurposeShort(purpose) {
  const flat = String(purpose ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= PURPOSE_ROW_MAX ? flat : `${flat.slice(0, PURPOSE_ROW_MAX - 1)}…`;
}

// Spend counts only. Window-context % is coordinator-owned and out of scope;
// never fabricated here (unitAI-beqby.3).
export function formatSpendShort(tokenUsage) {
  if (!tokenUsage) return '';
  // Snapshot keys are snake_case (input_tokens, output_tokens, ...); the short
  // camel keys below are the legacy test/fixture shape. total_tokens is a rollup,
  // never a summand — adding it would double-count (unitAI-d99hb).
  const total = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'reasoning_tokens', 'tool_tokens']
    .reduce((n, k) => n + (tokenUsage[k] ?? 0), 0)
    + (tokenUsage.input ?? 0) + (tokenUsage.output ?? 0) + (tokenUsage.cache ?? 0);
  if (total <= 0) return '';
  if (total < 1000) return `${total}`;
  if (total < 10000) return `${(total / 1000).toFixed(1)}k`;
  return `${Math.round(total / 1000)}k`;
}

/** Collapsed line. Needs-reply outranks idle: always shown when nonzero.
 * Names only triggers that work (unitAI-4n9of): arrow keys cannot reach a
 * passive pi extension, so no arrow promise of any kind. */
export function renderCollapsedLine({ activations, asks }) {
  const { active, waiting, needsReply, total } = fleetSummaryOf({ activations, asks });
  if (total === 0 && needsReply === 0) return '  └ specialists · idle · /specialists inspect';
  const parts = [`${active} active`, `${waiting} waiting`];
  if (needsReply > 0) parts.push(`${needsReply} need reply`);
  const hint = needsReply > 0 ? '/specialists inspect · /specialists:reply' : '/specialists inspect';
  return `  └ specialists · ${parts.join(' · ')} · ${hint}`;
}

/** One row per specialist. Forensic IDs never appear here. An activation with a
 * pending ask renders as a needs-reply row (`!` marker) outranking idle rows. */
export function renderFleetRowLine(view, asks = []) {
  const model = view.thinking_level
    ? `${view.resolved_model ?? '?model'} ${view.thinking_level}`
    : (view.resolved_model ?? '?model');
  const ask = (asks ?? []).find((a) => a.activation_id === view.activation_id);
  if (ask) {
    const waiting = formatElapsedShort(Date.now() / 1000 - (ask.asked_at ?? Date.now() / 1000));
    return `    ! ${view.specialist} (${model}) · ${view.bead_id ?? '—'} · needs reply ${waiting}`;
  }
  const elapsed = formatElapsedShort(view.elapsed_s);
  const tokens = formatSpendShort(view.token_usage);
  const purpose = formatPurposeShort(view.purpose);
  const idleS = view.last_activity_at != null
    ? Math.max(0, Math.floor(Date.now() / 1000) - view.last_activity_at)
    : null;
  const activity = view.state === 'running'
    ? (idleS != null && idleS > 30 ? `idle ${formatElapsedShort(idleS)}` : 'working')
    : view.state;
  // Zero/absent tokens render as nothing: no "0", no "spent" word (unitAI-d99hb).
  // Spend renders for every state, not only running: final spend stays visible after settle.
  const spend = tokens ? ` · ${tokens}` : '';
  const why = purpose ? ` · ${purpose}` : '';
  return `    ● ${view.specialist} (${model}) · ${view.bead_id ?? '—'}${why} · ${view.state} ${elapsed}${spend} · ${activity}`;
}

/** Footer-section lines: collapsed + bounded expanded rows with overflow.
 * Expanded by default; needs-reply rows sort first. */
export function renderSectionLines({ activations, asks }, { expanded = true } = {}) {
  const lines = [renderCollapsedLine({ activations, asks })];
  if (!expanded) return lines;
  const askIds = new Set((asks ?? []).map((a) => a.activation_id));
  const ordered = [...(activations ?? [])].sort(
    (a, b) => Number(askIds.has(b.activation_id)) - Number(askIds.has(a.activation_id)),
  );
  const rows = ordered.slice(0, FLEET_MAX_ROWS).map((view) => renderFleetRowLine(view, asks));
  lines.push(...rows);
  const overflow = (activations ?? []).length - rows.length;
  if (overflow > 0) lines.push(`    +${overflow} more`);
  return lines;
}

// ── Forensic wiring (unitAI-rrdnt.37.1) ──────────────────────────────────────
//
// Native activations must be answerable from the SAME observability.db the legacy
// runner and the MCP frontend write — no second telemetry store (PRD §73/AP). The
// MCP server wires `createActivationForensicSink(createObservabilitySqliteClient())`
// at construction; this extension does the equivalent through the lib seam. The
// canonical file is created when absent (exactly what `sp run` does), then opened
// by the same client the CLI reads, so resolution parity holds by construction.
// Null-safe: if the client cannot open (e.g. `bun:sqlite` unavailable under the
// node-based pi runtime), the host falls back to its no-op sink exactly as MCP
// does when its client is null.

export function createCoordinatorHost({ createClient, wrapSink, Host } = {}) {
  const client = createClient
    ? createClient()
    : createObservabilitySqliteClientAtPath(resolveObservabilityDbLocation(process.cwd()).dbPath);
  const HostCtor = Host ?? NativeActivationHost;
  // A null client means forensics could not open, not that nothing is listening: the
  // wake rides this sink, so the wrapper must still run over a no-op base. Returning
  // `new HostCtor()` here would make a coordinator whose observability.db failed to
  // open silently lose every escalation notification — the exact silence this bead
  // exists to remove, reappearing only in the degraded case nobody runs (rrdnt.45).
  const sink = client ? createActivationForensicSink(client) : { emit: () => {} };
  // unitAI-rrdnt.45 seam: the wake lane wraps the sink so the extension can
  // observe host emits (escalation_raised / clarification_requested) without
  // touching NativeActivationHost or this constructor's internals.
  return new HostCtor({ forensics: wrapSink ? wrapSink(sink) : sink });
}

// ── Ask observation (unitAI-rrdnt.45) ────────────────────────────────────────
//
// The coordinator's wake-up rides a seam that already exists rather than adding
// one. `native-host.ts` already emits `clarification_requested` and
// `escalation_raised` through the forensic sink on every ask, and this extension
// is what constructs that sink — so observing asks costs a wrapper here and no
// change to the host, to `InteractionTransport`, or to `NativeActivationHostDeps`.
//
// The property that matters is what this DOES NOT touch. `DeliveryState` lives in
// the transport and the wake never reaches it, so an ask stays `pending` and stays
// readable through `specialist_status` whether the wake fires, is disabled, or
// throws. Push cannot become authoritative because it has no way to say otherwise
// (PRD SS30) — that is a consequence of where the seam is, not of care at the call
// site.
//
// Timing note, measured rather than assumed: `ask-tool.ts` calls `onAsk` BEFORE
// `transport.request()`, so at notification time the ask is not yet in
// `pendingAsks()` and no `message_id` exists to carry. The wake therefore carries
// the activation identity and the question, and the coordinator reads
// `specialist_status` for the id. That keeps the durable projection as the single
// correlation authority; a message_id sourced from anywhere else would be a second
// one for the exact thing that must have only one.

/** Forensic event names that mean a child is now blocked on the coordinator. */
const ASK_EVENTS = {
  clarification_requested: 'question',
  escalation_raised: 'escalation',
};

/**
 * Forensic event names that mean a child is DONE and the coordinator was never told.
 *
 * unitAI-rrdnt.64. Only asks woke the coordinator, so a session that dispatched and waited
 * had to poll `specialist_status` to learn anything had finished — which is the operator's
 * original complaint, still live after the ask wake shipped. The `.46` Fleet widget does not
 * close it: the widget repaints for an operator watching a TUI and never wakes the model.
 *
 * `activation_settled` is deliberately ABSENT. It precedes output validation, and
 * `activation_completed` follows it on the success path — waking on both would fire twice
 * for one activation. These two are terminal and mutually exclusive.
 *
 * Admission REFUSAL is also absent, and that is correct rather than an omission: a refusal is
 * the synchronous return value of the `specialist_dispatch` call the coordinator is already
 * blocked on, so there is no asynchronous window for silence to hide in. The hole is bounded
 * to post-admission events, which is why runtime failure IS here — `activation_failed` fires
 * on a running child whose turn ended with stopReason 'error' or 'aborted', and an unattended
 * coordinator is as blind to that as to success.
 */
const TERMINAL_EVENTS = {
  activation_completed: 'completed',
  activation_failed: 'failed',
};

/**
 * Wrap a forensic sink so asks are also reported to `onAsk`, forwarding everything
 * else untouched.
 *
 * `onAsk` throwing must never reach the sink's caller: forensics are on the
 * activation's path, and a failed notification is a diagnostic loss while a failed
 * activation is a functional one. The optional members are forwarded conditionally
 * because the host tests for their presence — defining them unconditionally over a
 * sink that lacks them would silently change which forensic paths the host takes.
 */
export function createAskObserverSink(base, onAsk, onTerminal) {
  const report = (fn, payload) => {
    if (!fn) return;
    try {
      fn(payload);
    } catch {
      // A wake that throws leaves the activation exactly as it was: the ask still pending,
      // the result still readable through specialist_status. That is the degraded path, and
      // it is the same path taken when no coordinator is listening at all.
    }
  };

  const wrapped = {
    emit(event) {
      try {
        base.emit(event);
      } finally {
        const identity = {
          activationId: event.activationId,
          attemptId: event.attemptId,
          specialist: event.specialist,
          beadId: event.beadId,
        };
        const kind = ASK_EVENTS[event.name];
        if (kind) {
          report(onAsk, {
            ...identity,
            kind,
            body: typeof event.payload?.body === 'string' ? event.payload.body : '',
          });
        }
        const outcome = TERMINAL_EVENTS[event.name];
        if (outcome) {
          report(onTerminal, {
            ...identity,
            outcome,
            error: typeof event.payload?.error === 'string' ? event.payload.error : undefined,
          });
        }
      }
    },
  };
  if (base.sessionEvent) wrapped.sessionEvent = (input) => base.sessionEvent(input);
  if (base.peerTransportEvent) wrapped.peerTransportEvent = (event) => base.peerTransportEvent(event);
  return wrapped;
}

/** The wake message a blocked child produces. Exported so its shape is testable. */
export function formatAskWake(ask) {
  const what = ask.kind === 'escalation' ? 'ESCALATED' : 'is asking a question';
  return [
    `Specialist \`${ask.specialist}\` ${what} and is blocked waiting for you.`,
    '',
    `activation_id: ${ask.activationId}`,
    ...(ask.beadId ? [`bead: ${ask.beadId}`] : []),
    '',
    ask.body || '(no body)',
    '',
    'Call specialist_status to read this ask\'s message_id from pending_asks, then ' +
      'answer it with specialist_reply. The child is alive and resumable; it stays ' +
      'blocked until you answer.',
  ].join('\n');
}

/** The wake message a finished child produces. Exported so its shape is testable. */
export function formatSettlementWake(done) {
  const failed = done.outcome === 'failed';
  return [
    `Specialist \`${done.specialist}\` ${failed ? 'FAILED' : 'finished'} and is no longer running.`,
    '',
    `activation_id: ${done.activationId}`,
    ...(done.beadId ? [`bead: ${done.beadId}`] : []),
    ...(failed && done.error ? ['', `error: ${done.error}`] : []),
    '',
    failed
      ? 'Call specialist_status to read the failure detail. The activation is settled; it can '
        + 'be resumed with specialist_resume if the cause was transient.'
      : 'Call specialist_status to read its validated result. The activation is settled and '
        + 'stays resumable until you dispose it with specialist_stop_activation.',
  ].join('\n');
}

// ── Result projection ────────────────────────────────────────────────────────
//
// There is no Pi-surface result projection any more. This file used to carry its
// own `toResultView`, and it drifted from the shared one on `configured_model`,
// `requested_model` and the `output ?? null` fallback — so a Pi coordinator and a
// Claude coordinator described the same settled activation differently. Two
// functions describing one thing is one description too many; `toActivationResultView`
// is imported from the shared frontend module for the same reason `toActivationView`
// and `toPendingAskView` already were (unitAI-kv8ac).

/**
 * Attach a settled result to a shared `ActivationView` when one is available.
 * Additive-only over the MCP vocabulary: never mutates the shared projection.
 */
function withResult(view, result) {
  if (!result) return view;
  return { ...view, result: toActivationResultView(result) };
}

/** Permission tiers that mutate the workspace (mirrors native-host.ts line 57). */
const WRITE_TIERS = new Set(['MEDIUM', 'HIGH']);

/**
 * The SAME admission checks the host runs (unitAI-rrdnt.49): model chain,
 * resolved tool contract, and preflight. A specialist whose checks pass is
 * dispatchable on the native runtime; `reason` explains the rest.
 */
export async function dispatchability(spec) {
  const execution = spec.specialist.execution;
  const tier = execution.permission_required ?? 'READ_ONLY';
  const modelChain = resolveModelChain(execution);
  if (modelChain.length === 0) {
    return { dispatchable: false, reason: 'no configured model — pass model_override at dispatch' };
  }
  const toolContract = resolveRuntimeToolContract({
    level: tier,
    specialistName: spec.specialist.metadata.name,
    specialistPermissions: spec.specialist.permissions,
    cwd: process.cwd(),
  });
  if (!toolContract || toolContract.toolsList.length === 0) {
    return { dispatchable: false, reason: 'empty tool contract for tier' };
  }
  try {
    validateBeforeRun(spec, tier, toolContract);
  } catch (error) {
    return { dispatchable: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { dispatchable: true };
}

/** Scope/layer provenance of a resolved specialist (repo + user overrides). */
/**
 * First sentence or 120 characters of a refusal reason, whichever is shorter.
 *
 * Compact mode is for scanning. A reader deciding WHICH specialist to use needs to know that
 * one is unavailable and roughly why; the full text is one `name=` call away.
 */
function shortReason(reason) {
  const text = String(reason ?? '').trim();
  if (!text) return text;
  const firstSentence = text.split(/(?<=[.!?])\s/)[0];
  const chosen = firstSentence.length > 0 && firstSentence.length <= 120 ? firstSentence : text;
  return chosen.length <= 120 ? chosen : `${chosen.slice(0, 117)}...`;
}

/**
 * Every listing answer ends with this.
 *
 * A coordinator that reads a registry listing is deciding how to delegate, and that is the
 * exact moment it might reach for the CLI. It must not: the `sp` CLI is deferred while this
 * extension is what runs Specialists, and a shelled run has no Fleet entry, no ask channel,
 * no workspace lease and no native forensics (unitAI-rrdnt.63).
 */
const NATIVE_ONLY_NOTE = 'Dispatch through specialist_dispatch. Do not shell out to the specialists CLI.';

function specialistSummaryView(summary) {
  return {
    name: summary.name,
    category: summary.category,
    description: summary.description,
    scope: summary.scope,
    source: summary.source,
    version: summary.version,
    permission_required: summary.permission_required,
  };
}

/**
 * Create a Bead from an inline dispatch contract (unitAI-rrdnt.48).
 *
 * The readiness gate has already passed BEFORE this is called — a refused
 * dispatch must leave the board unchanged. Uses the `bd` CLI exactly like the
 * runtime's own BeadsClient does; the created bead is the durable record every
 * later participant reads. Returns the new bead id, or null on failure.
 */
export function createBeadFromContract(contract, title) {
  const problem = extractSections(contract).get('PROBLEM');
  const firstLine = (problem ?? '').split('\n').map((s) => s.trim()).find(Boolean);
  const resolvedTitle = title ?? (firstLine ?? 'Specialist dispatch contract').slice(0, 72);
  const result = spawnSync(
    'bd',
    ['create', resolvedTitle, '--description', contract, '--type', 'task', '--priority', '2', '--json'],
    { encoding: 'utf-8', timeout: 20000 },
  );
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

// Build identity (unitAI-rrdnt.55): which dist artifact this session loaded vs what
// is on disk now. The static dist import below is what keeps one session on one
// gate, so staleness is structural — the only fix is making it visible. The loaded
// id is hashed once at extension load; the on-disk id is re-read on every outcome
// (a sub-millisecond hash of one file, never a re-import).
const DIST_LIB_PATH = fileURLToPath(new URL('../../../dist/lib.js', import.meta.url));
const LOADED_BUILD_ID = readBuildId(DIST_LIB_PATH);

/**
 * Attach the loaded-vs-on-disk build identity to an outcome payload. Exported
 * (pure given explicit ids) for tests; the live path always uses the load-time
 * id and a fresh on-disk read.
 */
export function annexBuildIdentity(
  payload,
  loadedId = LOADED_BUILD_ID,
  onDiskId = readBuildId(DIST_LIB_PATH),
) {
  return { ...payload, build: describeBuildIdentity(loadedId, onDiskId) };
}

/** Render an inline-contract gate refusal as a structured tool result. */
function inlineRejectionResult(reason, missing, note) {
  return annexBuildIdentity({
    status: 'rejected',
    reason,
    ...(missing?.length ? { missing } : {}),
    ...(note ? { note } : {}),
  });
}

/** Render a host-thrown `DispatchRejectedError` as a structured tool result. */
function rejectionResult(error) {
  return annexBuildIdentity({
    status: 'rejected',
    reason: error.message,
    detail: error.detail,
  });
}

/** Wrap a payload into the pi AgentToolResult shape. */
function resultOf(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: {} };
}

// ── Human-readable tool-result views (unitAI-55yjs) ──────────────────────────
//
// Every specialist_* tool result carries byte-identical machine JSON in
// content[].text (the coordinator JSON.parses it); renderResult only changes what
// the operator SEES. Each summary below reads ONLY fields the tools already emit
// — never forensic internals. Unknown shapes fall back to the raw JSON lines, and
// the expanded view always appends the full JSON underneath.
function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.activations)) {
    const lines = [`Fleet: ${payload.activations.length} activation(s), ${(payload.pending_asks ?? []).length} pending ask(s)`];
    for (const a of payload.activations) {
      lines.push(`- ${a.specialist ?? '?'} on ${a.bead_id ?? '?'} — ${a.state ?? '?'} (${a.activation_id ?? '?'})${a.resolved_model ? ` [${a.resolved_model}]` : ''}${a.result ? ` → ${a.result.status ?? 'settled'}` : ''}`);
    }
    for (const ask of payload.pending_asks ?? []) {
      lines.push(`? ${ask.kind ?? 'ask'} from ${ask.activation_id ?? '?'} (${ask.message_id ?? '?'}): ${(ask.body ?? '').split('\n')[0]}`);
    }
    return lines;
  }
  if (Array.isArray(payload.specialists)) {
    const rows = payload.specialists;
    const und = rows.filter((r) => r.dispatchable === false).length;
    const lines = [`Registry: ${payload.count ?? rows.length} specialist(s)${und ? `, ${und} undispatchable` : ''}`];
    for (const r of rows) {
      lines.push(`- ${r.name ?? '?'} [${r.tier ?? r.permission_required ?? '?'}]${r.category ? ` (${r.category})` : ''}${r.dispatchable === false ? ` — not dispatchable: ${r.reason ?? 'unknown reason'}` : ''}`);
    }
    return lines;
  }
  if (payload.specialist && typeof payload.specialist === 'object') {
    const s = payload.specialist;
    return [`${s.name ?? '?'} [${s.permission_required ?? s.tier ?? '?'}]${s.category ? ` (${s.category})` : ''}${s.dispatchable === false ? ` — not dispatchable: ${s.reason ?? 'unknown reason'}` : ''}`];
  }
  switch (payload.status) {
    case 'dispatched':
      return [
        `Dispatched ${payload.specialist ?? '?'} on ${payload.bead_id ?? '?'} — ${payload.state ?? 'started'} as ${payload.activation_id ?? '?'}` +
        `${payload.resolved_model ? ` [${payload.resolved_model}]` : ''}` +
        `${payload.created_bead_id ? ` (created bead ${payload.created_bead_id})` : ''}`,
      ];
    case 'answered':
      return [`Answered ${payload.message_id ?? '?'} for ${payload.activation_id ?? '?'}`];
    case 'resumed':
      return [`Resumed ${payload.activation_id ?? '?'} (${payload.specialist ?? '?'}) — attempt ${payload.previous_attempt_id ?? '?'} → ${payload.attempt_id ?? '?'}`];
    case 'stopped':
      return [`Stopped ${payload.activation_id ?? '?'}`];
    case 'rejected':
      return [`Rejected: ${payload.reason ?? 'no reason given'}${payload.missing?.length ? ` (missing: ${payload.missing.join(', ')})` : ''}`];
    case 'error':
      return [`Error: ${payload.error ?? 'unknown error'}`];
    default:
      return null;
  }
}

/** Build a renderResult that shows the human summary, with full JSON on expand. */
function humanResultOf() {
  return (result, { expanded } = {}) => {
    // Recomputed per render call: pi re-invokes render() as its own state
    // changes, so closing over first-call lines could go stale.
    const render = () => {
      const raw = (result?.content ?? []).find((c) => c?.type === 'text')?.text ?? '';
      let payload = null;
      try { payload = JSON.parse(raw); } catch { /* fall through to raw lines */ }
      const summary = payload ? summarizePayload(payload) : null;
      const lines = summary ?? (raw ? raw.split('\n') : ['(empty result)']);
      return summary && expanded ? [...summary, '', ...raw.split('\n')] : lines;
    };
    // pi wraps every tool renderer in a MouseRegion and walks invalidate()
    // on theme/resume; a missing method kills the session (unitAI-q02sz).
    // Every custom renderer object in this file must expose it.
    return { dispose: () => {}, invalidate: () => {}, render };
  };
}

/** Build a renderCall one-liner naming the tool and its key argument. */
function humanCallOf(describe) {
  return (args) => {
    const line = describe(args ?? {});
    // invalidate() required: see humanResultOf (unitAI-q02sz).
    return { dispose: () => {}, invalidate: () => {}, render: () => [line] };
  };
}

// ── Extension factory ────────────────────────────────────────────────────────

/**
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {{ createHost?: () => NativeActivationHost }} [options] — test seam;
 *   when omitted, one process-lifetime host is created on first tool use.
 */
export default function specialistSubagentsExtension(pi, options = {}) {
  // PRD acceptance U: the coordinator is fenced out of a workspace a Specialist holds.
  // Fails open — see installCoordinatorFence.
  installCoordinatorFence(pi, options);

  // The wake exists so that an operator who does nothing still learns a child is
  // blocked. The flag turns it off so the DEGRADED path is reproducible on demand:
  // the case worth regression-testing is not that a notification fires, it is that
  // an ask with no notification is still readable and still not marked delivered.
  pi.registerFlag('no-specialist-wake', {
    type: 'boolean',
    default: false,
    description:
      'Do not wake this coordinator when a Specialist asks, escalates, finishes or fails. ' +
      'Everything stays readable through specialist_status; only the notification is ' +
      'suppressed. With this set you must poll to learn any of it.',
  });

  /**
   * Wake the coordinator for one blocked child.
   *
   * `followUp` rather than `steer`: a question delivered between a tool call and
   * its result splits a turn the coordinator is in the middle of, and the child is
   * blocked either way — waiting for the current turn's tool calls to finish costs
   * the child nothing and costs the coordinator its train of thought otherwise.
   * `triggerTurn` is what makes an IDLE coordinator act, which is the whole bug:
   * without it a dispatched-then-waiting coordinator sees the message only when the
   * operator next types, which is the polling they were already doing.
   */
  /**
   * Wake the coordinator when a child FINISHES (unitAI-rrdnt.64).
   *
   * Always, rather than batched or only-when-idle. Each activation terminates exactly once,
   * so the volume is bounded by dispatches the coordinator itself made — and a coordinator
   * that dispatched something is the one participant that wants to know it is done. Batching
   * would trade the defect being fixed for a smaller version of itself.
   */
  const wakeSettled = (done) => {
    if (pi.getFlag('no-specialist-wake') === true) return;

    const summary = `Specialist ${done.specialist} ${done.outcome === 'failed' ? 'FAILED' : 'finished'}`;
    const ctx = liveContext({ requireUI: true });
    if (ctx) {
      try {
        ctx.ui.notify(summary, done.outcome === 'failed' ? 'warning' : 'info');
      } catch {
        // The UI can disappear while async work settles; the message below is the
        // load-bearing half and does not depend on it.
      }
    }

    pi.sendMessage(
      {
        customType: 'specialist_settled',
        content: formatSettlementWake(done),
        display: true,
        details: done,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  };

  const wake = (ask) => {
    if (pi.getFlag('no-specialist-wake') === true) return;

    const summary = `Specialist ${ask.specialist} ${ask.kind === 'escalation' ? 'escalated' : 'asked a question'}`;
    const ctx = liveContext({ requireUI: true });
    if (ctx) {
      try {
        ctx.ui.notify(summary, ask.kind === 'escalation' ? 'warning' : 'info');
      } catch {
        // The UI can disappear while async work settles; the message below is the
        // load-bearing half and does not depend on it.
      }
    }

    pi.sendMessage(
      {
        customType: 'specialist_ask',
        content: formatAskWake(ask),
        display: true,
        details: ask,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  };

  /**
   * State the wake behaviour once, when the operator first dispatches a child.
   *
   * Not at session start: an extension that announces itself on every session is
   * noise, and before a dispatch there is nothing the wake could do. This fires at
   * the moment it becomes true that a child could start a turn on its own — which
   * is the behaviour a reader needs to have been told about, and the suppressed
   * case is the one a silent session would otherwise be unexplainable without.
   */
  let announced = false;
  const announceWake = () => {
    if (announced) return;
    announced = true;
    const ctx = liveContext({ requireUI: true });
    if (!ctx) return;
    const off = pi.getFlag('no-specialist-wake') === true;
    try {
      ctx.ui.notify(
        off
          ? 'Specialist wake is OFF (--no-specialist-wake): a child that blocks, finishes or fails will not notify you. Poll specialist_status.'
          : 'Specialist wake is on: a child that blocks, finishes or fails will start a turn here on its own. Disable with --no-specialist-wake.',
        off ? 'warning' : 'info',
      );
    } catch {
      // Announcing is courtesy, never a precondition for dispatching.
    }
  };

  /** One host for the life of the pi process — never per-turn (VALIDATION 5). */
  let host = null;
  const getHost = () => {
    if (!host) {
      // The wrapper is handed to the test seam as well as to the real constructor,
      // so a test with an injected host still exercises the wake rather than
      // routing around the only path that matters here.
      const wrapSink = (sink) => createAskObserverSink(sink, wake, wakeSettled);
      host = options.createHost
        ? options.createHost({ wrapSink })
        : createCoordinatorHost({ wrapSink });
      announceWake();
    }
    return host;
  };

  /** Settled ActivationResults by activation id, collected without blocking a turn. */
  const results = new Map();

  const disposeActivation = async (activationId, reason) => {
    await getHost().stop(activationId, reason);
    results.delete(activationId);
  };

  pi.registerTool({
    name: 'specialist_dispatch',
    label: 'Specialist dispatch',
    description:
      'Dispatch a Specialist on the native in-process runtime. No CLI process is ' +
      'spawned. Provide EITHER bead_id (an existing READY Bead — 7 sections plus ' +
      'SCRUTINY) OR contract (an inline 7-section contract: the same readiness gate ' +
      'runs first, then a Bead is created and dispatched). Never both. Returns once ' +
      'the activation is ADMITTED and started, not when it completes — poll ' +
      'specialist_status for state and for any question it raises, and answer with ' +
      'specialist_reply. A draft or incomplete contract is refused here, before a model ' +
      'turn is spent guessing at scope it does not carry — fix the Bead (planning ' +
      'skill, /planning), not the dispatch. Write-capable Specialists (MEDIUM/HIGH ' +
      'tiers) activate only when they can acquire the workspace lease. Each dispatch ' +
      'creates a persistent activation YOU own: stop it with ' +
      'specialist_stop_activation when you are done with it.',
    promptSnippet: 'Dispatch an XTRM Specialist (specialist_dispatch: specialist, bead_id)',
    renderCall: humanCallOf((args) => `Dispatch ${args.specialist ?? '?'} on ${args.bead_id || 'inline contract'}`),
    renderResult: humanResultOf(),
    parameters: Type.Object({
      specialist: Type.String({ description: 'Specialist name, e.g. codebase-explorer' }),
      bead_id: Type.Optional(
        Type.String({
          description:
            'The id of an EXISTING READY Bead to dispatch against. Mutually exclusive ' +
            'with contract: provide exactly one of bead_id or contract, never both.',
        }),
      ),
      contract: Type.Optional(
        Type.String({
          description:
            'An INLINE task contract, used instead of bead_id: the SAME readiness gate ' +
            'runs first, then a Bead is created from it and dispatched. The contract ' +
            'must contain all seven sections — PROBLEM, SUCCESS, SCOPE, NON_GOALS, ' +
            'CONSTRAINTS, VALIDATION, OUTPUT — plus a SCRUTINY level, which must be exactly ' +
            'one of LOW, MEDIUM, HIGH or CRITICAL. Note that this is EIGHT required parts, ' +
            'not seven; SCRUTINY is the one most often left out. Write each section as a ' +
            'heading: either the section name on its own line with its body beneath, or ' +
            '`PROBLEM: the body` on one line. Both forms are accepted. ' +
            'THIS IS THE PATH FOR ALL DELEGATED WORK, including small and quick questions. ' +
            'A short contract is a fine contract — a one-line body per section is enough for a ' +
            'bounded question, and dispatching here is what gives you the Fleet view, the ' +
            'ask/answer channel, the workspace lease and forensics. Do NOT shell out to the ' +
            '`sp` CLI to avoid writing a contract; a native activation is cheaper, not dearer. ' +
            'Use the planning skill (/planning) for genuinely complex work; a contract missing ' +
            'any section is refused and nothing is created.',
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: 'Optional title for the Bead created from `contract` (default: derived from PROBLEM).',
        }),
      ),
      model_override: Type.Optional(
        Type.String({
          description:
            'Override the configured model for THIS activation only. An unavailable ' +
            'model is refused before the session is created, never silently replaced.',
        }),
      ),
      requested_by: Type.Optional(
        Type.String({
          description:
            'ParticipantId of the requesting coordinator. Defaults to the Pi extension ' +
            'adapter participant.',
        }),
      ),
      coordinator_session_id: Type.Optional(
        Type.String({ description: 'Pi session id, for lineage.' }),
      ),
      epic_context_depth: Type.Optional(
        Type.Integer({
          description:
            'Walk bead.parent UP this many hops (1 = immediate parent epic, 2 = epic + ' +
            'grand-epic) and render each ancestor contract into the turn-1 prompt as an ' +
            "'## Epic lineage' section. Omit for single-bead dispatch with no lineage.",
          minimum: 1,
          maximum: 2,
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const h = getHost();
      try {
        // unitAI-rrdnt.48: EITHER an existing bead_id OR an inline contract —
        // never both, and the readiness gate runs BEFORE any bead is created.
        const beadId = (params.bead_id ?? '').trim();
        const contract = (params.contract ?? '').trim();
        if (beadId && contract) {
          return resultOf(inlineRejectionResult(
            'both bead_id and contract were provided — provide exactly one; silently preferring one would dispatch against a contract the coordinator did not mean',
          ));
        }
        const epicContextDepth = params.epic_context_depth;
        if (epicContextDepth !== undefined && epicContextDepth !== 1 && epicContextDepth !== 2) {
          return resultOf(inlineRejectionResult(
            'epic_context_depth must be 1 or 2 — 1 walks to the immediate parent epic, 2 also includes the grand-epic',
          ));
        }
        let effectiveBeadId = beadId;
        let autoCreatedBeadId;
        if (!effectiveBeadId) {
          if (!contract) {
            return resultOf(inlineRejectionResult(
              'neither bead_id nor contract was provided — dispatch requires a READY Bead (7 sections + SCRUTINY) or an inline contract',
            ));
          }
          // The SAME gate the host runs at admission, before anything is created.
          const gate = evaluateBeadReadiness({
            id: '<inline>',
            status: 'open',
            title: params.title ?? 'specialist dispatch',
            description: contract,
          });
          if (!gate.ok) {
            return resultOf(inlineRejectionResult(gate.reason, gate.missing));
          }
          const created = (options.createBead ?? createBeadFromContract)(contract, params.title);
          if (!created) {
            return resultOf({ status: 'error', error: 'bd create failed — bead not created, board unchanged' });
          }
          effectiveBeadId = created;
          autoCreatedBeadId = created;
        }

        const handle = await h.start({
          specialist: params.specialist,
          beadId: effectiveBeadId,
          // Inline-contract dispatch creates a fresh bead with no parent: no lineage.
          ...(epicContextDepth !== undefined && !autoCreatedBeadId ? { epicContextDepth } : {}),
          ...(params.model_override ? { modelOverride: params.model_override } : {}),
          requestedByParticipantId: params.requested_by ?? DEFAULT_REQUESTED_BY,
          ...(params.coordinator_session_id ? { coordinatorSessionId: params.coordinator_session_id } : {}),
        });

        // Deliberately NOT awaited (a tool that blocked until completion would make
        // every clarification a deadlock) and deliberately not dropped either: an
        // unhandled rejection on a failed activation would crash the pi process. The
        // host has already recorded the failure forensically and in the snapshot; the
        // settled result is projected through specialist_status.
        handle.result
          .then((result) => { results.set(handle.activationId, result); })
          .catch(() => { /* observed via specialist_status */ });

        const snapshot = h.inspect(handle.activationId);
        const view = snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId };
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(annexBuildIdentity({
              status: 'dispatched',
              ...view,
              // An inline contract creates a durable board record. Saying so in the RESULT
              // is the difference between a coordinator tracking it and an operator finding
              // an orphan bead later — the caller cannot see the side effect otherwise.
              ...(autoCreatedBeadId
                ? {
                  created_bead_id: autoCreatedBeadId,
                  created_bead_note:
                    'This dispatch CREATED the bead above from your inline contract. It is a '
                    + 'durable board record and is yours to track: close it when the work is '
                    + 'done, or reassign it. It is not cleaned up automatically.',
                }
                : {}),
              step_contract: {
                root_work_ref: handle.stepContract.rootWorkRef,
                inputs: handle.stepContract.inputs.length,
                outputs: handle.stepContract.outputs.length,
              },
            }), null, 2),
          }],
          details: {},
        };
      } catch (error) {
        if (error instanceof DispatchRejectedError) {
          return {
            content: [{ type: 'text', text: JSON.stringify(rejectionResult(error), null, 2) }],
            details: {},
          };
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: 'specialist_status',
    label: 'Specialist fleet status',
    description:
      'The Fleet: every native activation this process hosts, with its state, and ' +
      'every outstanding question or escalation it is waiting on (answer those with ' +
      'specialist_reply). Settled activations carry their validated ActivationResult. ' +
      'Activations stay listed until stopped: a settled entry is either waiting for ' +
      'a follow-up or waiting to be stopped. Stop with specialist_stop_activation ' +
      'every activation you will not resume. No CLI background jobs are shown — ' +
      'this surface only hosts in-process activations.',
    promptSnippet: 'Show the Specialist Fleet (specialist_status)',
    renderResult: humanResultOf(),
    parameters: Type.Object({}),
    async execute() {
      const h = getHost();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(annexBuildIdentity({
            activations: h.list().map((snapshot) =>
              withResult(toActivationView(snapshot), results.get(snapshot.activationId))),
            pending_asks: h.pendingAsks().map(toPendingAskView),
          }), null, 2),
        }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: 'specialist_reply',
    label: 'Specialist reply',
    description:
      'Answer an outstanding Specialist question or escalation by its message_id (read ' +
      'them from specialist_status.pending_asks). The answer returns as that tool call\'s ' +
      'result, so the Specialist continues with its context intact rather than being ' +
      'restarted with an answer pasted into a fresh prompt. An unknown or already ' +
      'answered message_id is reported, not silently accepted.',
    promptSnippet: 'Answer a Specialist question (specialist_reply: message_id, body)',
    renderCall: humanCallOf((args) => `Reply to ${args.message_id ?? '?'}`),
    renderResult: humanResultOf(),
    parameters: Type.Object({
      message_id: Type.String({
        description:
          'The message_id of the outstanding ask, from specialist_status.pending_asks. ' +
          'Correlation is by message id and nothing else — there is no "answer the ' +
          'latest ask", because with two asks outstanding that is a coin flip.',
      }),
      body: Type.String({ description: 'The answer. Returned to the Specialist as its tool result.' }),
    }),
    async execute(toolCallId, params) {
      const message = await getHost().answer(params.message_id, params.body);
      if (!message) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              error: `No outstanding ask with message_id '${params.message_id}' — it may have been answered already, or its activation may have been disposed.`,
              message_id: params.message_id,
            }, null, 2),
          }],
          details: {},
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'answered',
            message_id: message.messageId,
            in_reply_to: message.inReplyTo ?? null,
            activation_id: message.activationId,
            attempt_id: message.attemptId,
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  // unitAI-rrdnt.33.1. `NativeActivationHost.resume()` existed, was unit-tested, and was
  // called by nothing — no MCP tool, no CLI, no extension command. A settled Specialist is
  // documented as "waiting and resumable" and the lease reacquisition path exists solely for
  // resume, so the whole resume half of the runtime was unreachable from any operator surface.
  // That is the epic's recurring shape: a module complete, tested, closed on the board, and
  // reachable by nobody.
  pi.registerTool({
    name: 'specialist_resume',
    label: 'Specialist resume',
    description:
      'Resume a settled or waiting Specialist with a new prompt, in the SAME session. ' +
      'This is not a second dispatch: the activation_id is kept and the attempt_id advances, ' +
      'so the child keeps its context and its workspace lease rather than starting over. ' +
      'Use this after answering a question, or to give a settled Specialist more work. ' +
      'A disposed activation cannot be resumed — that is what makes specialist_stop_activation ' +
      'the irreversible one.',
    promptSnippet: 'Resume a settled Specialist (specialist_resume: activation_id, prompt)',
    renderCall: humanCallOf((args) => `Resume ${args.activation_id ?? '?'}`),
    renderResult: humanResultOf(),
    parameters: Type.Object({
      activation_id: Type.String({ description: 'The settled or waiting activation to resume.' }),
      prompt: Type.String({ description: 'The new instruction for the resumed Specialist.' }),
    }),
    async execute(toolCallId, params) {
      const h = getHost();
      const before = h.inspect(params.activation_id);
      // Capture the VALUE now. `inspect` hands back the host's live snapshot object, not a
      // copy, and `resume` mutates it in place — so reading `before.attemptId` when the
      // response is built returns the NEW attempt and previous_attempt_id always equals
      // attempt_id. Found live (act:25bc5ad5-cc3 reported att:...:2 for both); the unit test
      // missed it because the fake host returns a fresh object per call and so does not
      // alias the way the real one does.
      const previousAttemptId = before?.attemptId;
      if (!before) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              error: `Unknown activation: ${params.activation_id}`,
              activation_id: params.activation_id,
            }, null, 2),
          }],
          details: {},
        };
      }

      let handle;
      try {
        handle = await h.resume(params.activation_id, params.prompt);
      } catch (error) {
        // A refused resume is evidence, not a malfunction — the host refuses a disposed or
        // running activation, and a lease it can no longer reacquire.
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'rejected',
              activation_id: params.activation_id,
              reason: error instanceof Error ? error.message : String(error),
            }, null, 2),
          }],
          details: {},
        };
      }

      handle.result
        .then((result) => { results.set(handle.activationId, result); })
        .catch(() => { /* observed via specialist_status */ });

      const snapshot = h.inspect(handle.activationId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'resumed',
            previous_attempt_id: previousAttemptId,
            ...(snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId }),
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: 'specialist_stop_activation',
    label: 'Specialist stop',
    description:
      'Stop and dispose a native activation. This is the only ordinary path to ' +
      'disposal — a settled Specialist is waiting and resumable, not finished. ' +
      'There is no child process to signal; disposal is a method call on the ' +
      'in-process AgentSession. You MUST stop every activation you are unlikely ' +
      'to use again: a settled or waiting activation keeps its session and Fleet ' +
      'entry until YOU stop it — nothing expires it for you.',
    promptSnippet: 'Stop a Specialist (specialist_stop_activation: activation_id)',
    renderCall: humanCallOf((args) => `Stop ${args.activation_id ?? '?'}`),
    renderResult: humanResultOf(),
    parameters: Type.Object({
      activation_id: Type.String({ description: 'Activation to stop and dispose.' }),
      reason: Type.Optional(Type.String({ description: 'Recorded forensically with the disposal.' })),
    }),
    async execute(toolCallId, params) {
      if (!getHost().inspect(params.activation_id)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              error: `Unknown activation: ${params.activation_id}`,
              activation_id: params.activation_id,
            }, null, 2),
          }],
          details: {},
        };
      }
      await disposeActivation(params.activation_id, params.reason ?? 'pi operator request');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'stopped',
            activation_id: params.activation_id,
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  // unitAI-rrdnt.49: an sp-list equivalent inside the extension — awareness, not
  // surface area. One listing tool over the RESOLVED registry (repo + user layer
  // overrides merged by SpecialistLoader), marking what the native runtime can
  // actually dispatch. This extension is the dispatch surface; this tool is not a
  // replacement for it and deliberately does not reproduce run/feed/steer.
  pi.registerTool({
    name: 'specialist_list',
    label: 'Specialist registry',
    description:
      'List the resolved Specialist registry after repo and user layer overrides. ' +
      'Returns a COMPACT line per specialist by default — name, permission tier, ' +
      'category, and a reason only where the native runtime cannot dispatch it. ' +
      'Pass `name` for one specialist\'s full record including its description, or ' +
      'detail:"full" for every field of every specialist (large — prefer `name`). ' +
      'Write-capable tiers (MEDIUM/HIGH) still need the workspace lease at dispatch ' +
      'time. This extension is the dispatch surface: do not shell out to the specialists ' +
      'CLI to run a Specialist.',
    promptSnippet: 'List configured Specialists (specialist_list; name= for detail)',
    renderResult: humanResultOf(),
    parameters: Type.Object({
      name: Type.Optional(Type.String({
        description: 'Return the full record for this one specialist instead of the compact list.',
      })),
      detail: Type.Optional(Type.String({
        description: '"compact" (default) is one line each; "full" returns every field for every specialist.',
      })),
    }),
    // Progressive disclosure (operator report 2026-09-08). The unconditional form returned
    // 32 specialists x 9 fields = 16,161 bytes across 357 lines, and 44% of that was
    // `description` prose — a field a coordinator needs when choosing ONE specialist and
    // never when scanning all of them. The compact form is 1,204 bytes, a 13x reduction.
    // Undispatchable rows keep their reason in every mode: that is the part with signal,
    // and it is what tells a reader why `bare` and `changelog-keeper` are excluded.
    async execute(_toolCallId, params = {}) {
      const loader = new SpecialistLoader({ projectDir: process.cwd() });
      const summaries = await loader.list();
      const rows = [];
      for (const summary of summaries) {
        const row = {
          ...specialistSummaryView(summary),
          access: WRITE_TIERS.has(summary.permission_required ?? 'READ_ONLY') ? 'write' : 'read',
        };
        // loader.get throws for specialists with no configured model — that IS the
        // undispatchable signal (the host rejects them with no_model_configured),
        // not a listing failure.
        let spec = null;
        try {
          spec = await loader.get(summary.name);
        } catch (error) {
          row.dispatchable = false;
          row.reason = error instanceof Error ? error.message : String(error);
        }
        if (spec) {
          const capability = await dispatchability(spec);
          row.dispatchable = capability.dispatchable;
          if (capability.reason) row.reason = capability.reason;
        }
        rows.push(row);
      }
      const wanted = params.name;
      if (wanted) {
        const one = rows.find((r) => r.name === wanted);
        return resultOf(one
          ? { specialist: one, note: NATIVE_ONLY_NOTE }
          : {
            error: `Unknown specialist: ${wanted}`,
            known: rows.map((r) => r.name),
            note: NATIVE_ONLY_NOTE,
          });
      }

      if (params.detail === 'full') {
        return resultOf({ specialists: rows, detail: 'full', note: NATIVE_ONLY_NOTE });
      }

      const compact = rows.map((r) => ({
        name: r.name,
        tier: r.permission_required ?? 'READ_ONLY',
        access: r.access,
        ...(r.category ? { category: r.category } : {}),
        // ALWAYS present, even when true. Omitting it to save bytes would make absence mean
        // "dispatchable", which is indistinguishable from the field going missing through a
        // bug — and dispatchability is the one thing this tool exists to report. Only the
        // `reason` is conditional, because there is no reason when nothing is wrong.
        dispatchable: r.dispatchable !== false,
        // The reason is TRUNCATED here and complete under `name=`. In an environment where
        // most specialists are undispatchable — CI, or a checkout with no model config —
        // untruncated reasons dominate the compact payload and undo the disclosure: measured
        // at 7,561 bytes compact against 16,283 full, versus 1,204 against 16,161 locally.
        // The first clause is what a scanner needs; the rest is drill-down like everything
        // else this tool now defers.
        ...(r.dispatchable === false ? { reason: shortReason(r.reason) } : {}),
      }));
      const undispatchable = compact.filter((r) => r.dispatchable === false).length;
      return resultOf({
        specialists: compact,
        count: compact.length,
        undispatchable,
        detail: 'compact',
        note: 'Pass name=<specialist> for one full record, or detail="full" for everything. '
          + NATIVE_ONLY_NOTE,
      });
    },
  });


  // ── Operator surface (unitAI-rrdnt.46) ─────────────────────────────────────
  //
  // Everything above this line is a MODEL surface: it exists only when the
  // coordinator decides to call a tool. An operator in an interactive TUI saw
  // nothing at all — no Fleet, no pending ask, no way to answer one. The PRD
  // says this extension owns a child viewport; it owned none.
  //
  // Measured against pi 0.85.1 before any of this was written (the SDK types at
  // dist/core/extensions/types.d.ts and @aliou/pi-processes as the worked
  // example), then proved in a live TUI: `pi.registerCommand` produces a real
  // slash command with argument completion, and `ctx.ui.setWidget` paints a
  // persistent panel above or below the editor. Neither needed a host change.
  //
  // The view is a PROJECTION and never a second source of state. Every repaint
  // reads `host.list()` and `host.pendingAsks()` afresh; nothing is cached
  // between ticks, because a cache would drift exactly when something
  // interesting happens. `toActivationView`/`toPendingAskView` are the same
  // projections the tools serialise, so the operator and the model are looking
  // at one vocabulary rather than two.
  //
  // Refresh is a poll, deliberately. `NativeActivationHost` is pull-only
  // (`list`, `pendingAsks`, `inspect`) and giving it an emitter whose only
  // subscriber is a widget would couple the host to a UI consumer for no
  // measured gain. A tick is a read of an in-memory Map. If the latency ever
  // shows in use, that is the evidence that justifies an emitter.

  // One capture of the live ExtensionContext, shared by every consumer in this
  // file (unitAI-rrdnt.45 wake-ups, unitAI-rrdnt.46 Fleet UI). Two independent
  // holders is how a stale ctx survives a session restart, so there is one.
  let capture = null;          // { ctx, generation, sessionId }
  let generation = 0;

  pi.on('session_start', (_event, ctx) => {
    capture = {
      ctx,
      generation: ++generation,
      sessionId: ctx.sessionManager.getSessionId(),
    };
  });
  pi.on('session_shutdown', () => { capture = null; });

  /**
   * The live context, or null. Null means "no UI right now", never an error:
   * every consumer must degrade rather than throw, because a context can go
   * stale mid-flight during a session switch or reload.
   */
  function liveContext({ requireUI = false } = {}) {
    const held = capture;
    if (!held || held.generation !== generation) return null;
    try {
      // A context that outlived its session reports a different id; one that is
      // torn down throws on property access. Both mean "not live".
      if (held.sessionId && held.ctx.sessionManager.getSessionId() !== held.sessionId) return null;
      if (requireUI && !held.ctx.hasUI) return null;
      return held.ctx;
    } catch {
      return null;
    }
  }

  const FLEET_WIDGET_KEY = 'specialist-fleet';

  /** Operator-facing toggle. The widget is shown by default; `/specialists hide` opts out. */
  let fleetVisible = true;

  /** Snapshot state and pending asks together — every caller needs both. */
  const readFleet = () => {
    // `host` stays null until the first tool use, and a null host is an empty
    // Fleet, not an error: creating one here would open the observability
    // database for a session that has not dispatched anything.
    if (!host) return { activations: [], asks: [] };
    return {
      // Arrow form, never bare `.map(toActivationView)`: Array.map passes the
      // element INDEX as nowMs, freezing every row at elapsed 0s (unitAI-d99hb).
      activations: host.list().map((s) => toActivationView(s)),
      asks: host.pendingAsks().map(toPendingAskView),
    };
  };

  /** Fleet view-model helper (projection-only; no cached state). */
  const renderFleetSection = (fleet, opts) => renderSectionLines(fleet, opts);

  // Operational fleet: the footer section below the statusline repaints on its
  // own cycle. Rows render expanded one row per specialist by default;
  // /specialists collapse opts out to the single line. No inspector: /specialists inspect
  // prints the same expanded text report (the ui.custom path hard-locked the
  // TUI in this pi version, unitAI-nmxhg — the interactive inspector stays
  // deferred with UI-4 and the footer repaints on its own cycle). The section
  // render is a projection: readFleet() afresh on every render, nothing cached.
  let fleetExpanded = true;
  let fleetUnregister = null;

  const renderBelow = () => {
    if (!fleetVisible) return [];
    const fleet = readFleet();
    if (fleet.activations.length === 0 && fleet.asks.length === 0) return [];
    return renderFleetSection(fleet, { expanded: fleetExpanded });
  };

  // Seam lookup order: explicit test seam, then the core footer's global hook,
  // then absent. The core module is not importable from this tree, so the
  // runtime shares it via globalThis (set by custom-footer when loaded).
  const findFooterSeam = () => {
    if (typeof options.registerFooterSection === 'function') return options.registerFooterSection;
    try {
      const hook = globalThis.__registerFooterSection;
      if (typeof hook === 'function') return hook;
    } catch { /* no global — fallback decides */ }
    return null;
  };

  // Hide-until-seam (unitAI-beqby.9, operator decision): the footer-section seam
  // is the only fleet surface. When the seam is absent the fleet stays hidden —
  // no setWidget fallback, so no aboveEditor/belowEditor widget competes with
  // the footer. Slash commands still report the fleet as text. The section
  // renders on the footer's own cycle, so repaints are no-ops everywhere else.
  const paintFleet = () => {};

  // Inspector deferred with UI-4 (unitAI-nmxhg): /specialists inspect prints the
  // expanded text report instead of mounting a ui.custom pane.
  const openFleetInspector = async (ctx) => {
    report(ctx ?? { hasUI: false }, renderFleetSection(readFleet(), { expanded: true }).join('\n'));
    return false;
  };

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    const seam = findFooterSeam();
    if (seam && !fleetUnregister) {
      try { fleetUnregister = seam(FLEET_WIDGET_KEY, renderBelow) ?? null; }
      catch { fleetUnregister = null; }
    }
    if (fleetUnregister) return; // section renders on the footer's own cycle
    // No seam: the fleet stays hidden (hide-until-seam, unitAI-beqby.9).
  });

  /** Report to the operator on whichever surface the current mode actually has. */
  const report = (ctx, message, level = 'info') => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.log(message);
  };

  const specialistsHandler = async (args, ctx) => {
      const action = args.trim().split(/\s+/, 1)[0] ?? '';
      if (action === 'hide') fleetVisible = false;
      else if (action === 'show') fleetVisible = true;
      else if (action === 'expand') fleetExpanded = true;
      else if (action === 'collapse') fleetExpanded = false;
      else if (action === 'inspect') { await openFleetInspector(ctx); return; }
      else if (action !== '') {
        report(ctx, 'Usage: /specialists [show|hide|inspect|expand|collapse]', 'warning');
        return;
      }
      // The panel is only half the answer: in json/print mode there is no
      // widget at all, so the command always reports the Fleet in text too.
      report(ctx, renderFleetSection(readFleet(), { expanded: fleetExpanded }).join('\n'));
      paintFleet();
    };
  const specialistsCompletions = (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const items = ['show', 'hide', 'inspect', 'expand', 'collapse']
        .filter((value) => value.startsWith(normalized))
        .map((value) => ({
          value,
          label: value,
          description: value === 'show' ? 'Show the Fleet panel.' : value === 'hide' ? 'Hide the Fleet panel.' : value === 'inspect' ? 'Print the expanded Fleet report.' : value === 'expand' ? 'Expand rows in the footer section.' : 'Collapse to one line.',
        }));
      return items.length > 0 ? items : null;
  };
  pi.registerCommand('specialists', {
    description: 'Show the Specialist Fleet and any pending asks. Usage: /specialists [show|hide|inspect|expand|collapse]',
    getArgumentCompletions: specialistsCompletions,
    handler: specialistsHandler,
  });
  pi.registerCommand('fleet', {
    description: 'Compat alias for /specialists. Usage: /specialists [show|hide|inspect|expand|collapse]',
    getArgumentCompletions: specialistsCompletions,
    handler: specialistsHandler,
  });

  pi.registerCommand('specialists:reply', {
    description:
      'Answer an outstanding Specialist question or escalation. ' +
      'Usage: /specialists:reply <message_id> <answer>',
    getArgumentCompletions: (prefix) => {
      // Completing the message id is the whole point — an operator cannot be
      // expected to retype one off the panel.
      const normalized = prefix.trim();
      if (normalized.includes(' ')) return null;
      const items = readFleet().asks
        .filter((ask) => ask.message_id.startsWith(normalized))
        .map((ask) => ({
          value: ask.message_id,
          label: ask.message_id,
          description: `${ask.kind} from ${ask.from}`,
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const split = trimmed.indexOf(' ');
      if (split === -1) {
        report(ctx, 'Usage: /specialists:reply <message_id> <answer>', 'warning');
        return;
      }
      const messageId = trimmed.slice(0, split);
      const body = trimmed.slice(split + 1).trim();
      if (!body) {
        report(ctx, 'Usage: /specialists:reply <message_id> <answer>', 'warning');
        return;
      }
      const message = await getHost().answer(messageId, body);
      if (!message) {
        report(
          ctx,
          `No outstanding ask with message_id '${messageId}' — it may have been ` +
          'answered already, or its activation may have been disposed.',
          'warning',
        );
        return;
      }
      report(ctx, `Answered ${message.messageId} on activation ${message.activationId}.`);
    },
  });
  pi.registerCommand('fleet:reply', {
    description:
      'Compat alias for /specialists:reply. ' +
      'Usage: /specialists:reply <message_id> <answer>',
    getArgumentCompletions: (prefix) => pi.commands.find((c) => c.name === 'specialists:reply')?.getArgumentCompletions?.(prefix) ?? null,
    handler: (args, ctx) => pi.commands.find((c) => c.name === 'specialists:reply').handler(args, ctx),
  });

  const activationCompletions = (prefix) => {
    const normalized = prefix.trim();
    if (normalized.includes(' ')) return null;
    const items = readFleet().activations
      .filter((view) => view.activation_id.startsWith(normalized))
      .map((view) => ({
        value: view.activation_id,
        label: view.activation_id,
        description: `${view.specialist} · ${view.state}`,
      }));
    return items.length > 0 ? items : null;
  };
  const stopHandler = async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        report(ctx, 'Usage: /specialists:stop <activation_id> [reason]', 'warning');
        return;
      }
      const split = trimmed.indexOf(' ');
      const activationId = split === -1 ? trimmed : trimmed.slice(0, split);
      const reason = split === -1 ? '' : trimmed.slice(split + 1).trim();
      if (!getHost().inspect(activationId)) {
        report(ctx, `Unknown activation: ${activationId}`, 'warning');
        return;
      }
      await disposeActivation(activationId, reason || 'pi operator request');
      report(ctx, `Stopped ${activationId}.`);
  };
  const resumeHandler = async (args, ctx) => {
    const trimmed = args.trim();
    const split = trimmed.indexOf(' ');
    if (split === -1) {
      report(ctx, 'Usage: /specialists:resume <activation_id> <prompt>', 'warning');
      return;
    }
    const activationId = trimmed.slice(0, split);
    const prompt = trimmed.slice(split + 1).trim();
    if (!prompt) {
      report(ctx, 'Usage: /specialists:resume <activation_id> <prompt>', 'warning');
      return;
    }
    if (!getHost().inspect(activationId)) {
      report(ctx, `Unknown activation: ${activationId}`, 'warning');
      return;
    }
    try {
      await getHost().resume(activationId, prompt);
    } catch (err) {
      report(ctx, `Resume refused for ${activationId}: ${err?.message ?? err}`, 'warning');
      return;
    }
    report(ctx, `Resumed ${activationId}.`);
  };
  pi.registerCommand('specialists:stop', {
    description: 'Stop and dispose a native activation. Usage: /specialists:stop <activation_id> [reason]',
    getArgumentCompletions: activationCompletions,
    handler: stopHandler,
  });
  pi.registerCommand('fleet:stop', {
    description: 'Compat alias for /specialists:stop. Usage: /specialists:stop <activation_id> [reason]',
    getArgumentCompletions: activationCompletions,
    handler: stopHandler,
  });
  pi.registerCommand('specialists:resume', {
    description: 'Resume a settled or waiting activation with a new prompt. Usage: /specialists:resume <activation_id> <prompt>',
    getArgumentCompletions: activationCompletions,
    handler: resumeHandler,
  });
  pi.registerCommand('fleet:resume', {
    description: 'Compat alias for /specialists:resume. Usage: /specialists:resume <activation_id> <prompt>',
    getArgumentCompletions: activationCompletions,
    handler: resumeHandler,
  });

  // A child must never outlive the coordinator process. Best-effort: stop and
  // dispose every live activation when the pi session shuts down.
  pi.on('session_shutdown', async () => {
    try { fleetUnregister?.(); } catch {}
    fleetUnregister = null;
    if (!host) return;
    if (!host) return;
    for (const snapshot of host.list()) {
      try {
        await disposeActivation(snapshot.activationId, 'session shutdown');
      } catch {
        // Disposal during shutdown is best-effort.
      }
    }
  });
}