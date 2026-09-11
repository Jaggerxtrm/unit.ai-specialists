/**
 * NativeActivationHost — hosts a real Specialist on an in-process Pi `AgentSession`.
 *
 * This is the shared runtime seam. The Pi extension and the Claude Code MCP server are
 * both frontends over this class; neither invokes the legacy `sp run` CLI, and a future
 * Chain scheduler can call `start()` with a synthetic request because nothing here depends
 * on TUI state.
 *
 * WRITERS ARE ADMITTED, and the lease is wired. This paragraph used to say the opposite and
 * was left behind when the wiring landed — the exact drift this epic kept finding elsewhere,
 * so it is worth being precise about what is and is not true now:
 *   - A `MEDIUM` or `HIGH` tier resolves to `access: 'write'` and MUST acquire the workspace
 *     lease before an AgentSession exists; a denied lease is a refusal, not a warning.
 *   - `admitToolCall` re-checks the lease on every mutating tool call, and `guarded-tools.ts`
 *     wraps pi's four mutating builtins so a refusal comes back as a tool RESULT.
 *   - `releaseIfWriter` releases on DISPOSAL and converts a throwing release into
 *     `lease_uncertain` evidence rather than a silent success. It does NOT release on
 *     settle, though `workspace-lease.ts`'s wiring note (call site 3) says it should — so a
 *     settled writer keeps its workspace until an explicit stop, and sequential writer
 *     handoff needs one. That divergence is `unitAI-rrdnt.59` and is a design decision
 *     rather than an oversight to patch: releasing on settle buys automatic handoff and
 *     costs guaranteed resumability.
 *   The lease guards the LLM TOOL PATH ONLY. `pi.exec` and `AgentSession.executeBash` do not
 *   fire the tool_call handler (`unitAI-rrdnt.6`, unclosed), so a child reaching the
 *   filesystem that way is not fenced. Do not describe writers as "fenced" without that
 *   qualifier.
 *   - No model picker.
 *
 * The interaction protocol and the Fleet DO exist: see `./interaction.ts`, `./ask-tool.ts`
 * and `./registry.ts`.
 *
 * Session lifetime deliberately exceeds turn lifetime: reaching `agent_settled` makes a
 * Specialist *waiting and resumable*, never disposed. Disposal is an explicit act.
 */

import { randomUUID } from 'node:crypto';
import { SpecialistLoader } from '../specialist/loader.js';
import { buildSystemPrompt } from '../specialist/system-prompt.js';
import { renderTaskPrompt } from '../specialist/task-prompt.js';
import { validateBeforeRun, classifyFallbackError } from '../specialist/runner.js';
import { resolveRuntimeToolContract } from '../pi/session.js';
import { resolveModelChain } from '../specialist/model-chain.js';
import { BeadsClient, collectEpicAncestors } from '../specialist/beads.js';
import { evaluateBeadReadiness, extractPurposeExcerpt, type BeadGateOptions } from './bead-gate.js';
import { compileStepContract, type StepContract } from './step-contract.js';
import { InteractionTransport, type InteractionMessage, type PendingAsk } from './interaction.js';
import { createPeerDelivery } from './peer-bridge.js';
import { PeerAdapter, type TransportForensicEvent } from './transport/peer-adapter.js';
import { acquire as acquireLease, admitToolCall, release as releaseLease } from './workspace-lease.js';
import { createGuardedTools } from './guarded-tools.js';
import { createAskTools, ASK_TOOL, ESCALATE_TOOL } from './ask-tool.js';
import { loadPiSdk, type PiSdk, type PiAgentSessionLike, type PiAgentSessionEvent, type PiModelRuntimeLike } from './pi-sdk.js';
import { nativeSessionTokenUsage, accumulateTokenUsage } from '../specialist/native-activation-observability.js';
import { createGateModelRuntime, validateModelAvailable } from './model-gate.js';
import { FleetRegistry, RESUMABLE_STATES, RETRYABLE_STATES, nextAttemptId, type ActivationRecord } from './registry.js';
import { NULL_AUTHORITY_WRITER, type AuthorityWriter } from './authority-store.js';
import {
  DispatchRejectedError,
  type ActivationHandle,
  type ActivationRequest,
  type ActivationResult,
  type ActivationSnapshot,
  type ActivationState,
  type ActivationTokenUsage,
  type LiveActivationStats,
  THINKING_LEVELS,
  type WorkspaceAccess,
  type WorkspaceIdentity,
} from './types.js';

const TOKEN_USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'reasoning_tokens',
  'tool_tokens',
  'total_tokens',
] as const;

/**
 * Latest spend counts carried by a session event, if any.
 *
 * Pi session events carry usage nested as event.message (role=assistant) -> message.usage
 * with short keys; that shape is read by nativeSessionTokenUsage() in
 * native-activation-observability.ts, which is the canonical reader — this function reuses
 * it and only maps the result onto ActivationTokenUsage. Keep the two paired: a shape
 * change must land in the canonical reader, never in a second reader here.
 */
function extractTokenUsage(event: PiAgentSessionEvent): ActivationTokenUsage | undefined {
  const nested = nativeSessionTokenUsage(event);
  if (nested) {
    const { usage_source: _ignored, ...usage } = nested;
    if (Object.keys(usage).length > 0) return usage;
  }
  const candidates = [event.token_usage, event.tokenUsage, event.usage];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const usage: ActivationTokenUsage = {};
    for (const key of TOKEN_USAGE_KEYS) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value;
    }
    if (Object.keys(usage).length > 0) return usage;
  }
  return undefined;
}

/** Permission tiers that can mutate the workspace. Derived from the resolved grant. */
const WRITE_TIERS = new Set(['MEDIUM', 'HIGH']);

/**
 * Error classes the fallback walk advances past. The classifier itself is shared with
 * the CLI runner (`classifyFallbackError` in runner.ts) — this set is only the native
 * half of the CLI's `isTransient && !isAuth` rule, restated as classes so the two
 * cannot drift into disagreeing about what a 429 means.
 */
const FALLBACK_RETRYABLE_CLASSES = new Set(['rate_limit', 'timeout', 'transient']);

/**
 * Sink for activation forensics.
 *
 * Native activations write the SAME `observability.db` as the legacy runner — there is no
 * native-subagent telemetry database. This interface exists only so tests can observe the
 * event stream without a database; production wires it to `appendForensicEvent`.
 */
export interface ActivationForensicSink {
  emit(event: {
    activationId: string;
    attemptId: string;
    participantId: string;
    specialist: string;
    beadId?: string;
    name: string;
    payload?: Record<string, unknown>;
  }): void;

  /**
   * Receives every RAW Pi session event, untranslated.
   *
   * The `emit` path above carries a small hand-written vocabulary; this one carries the
   * whole stream so the Phase 7 mapper can produce timeline rows through the same
   * factories the legacy `sp run` path uses. Without it, a native activation and a legacy
   * one answer the same query differently.
   *
   * Optional by design: every existing sink, including the null sink and each test double,
   * keeps working untouched. The two paths do not overlap — raw events feed the timeline
   * mappers, and the translated `emit` names remain the sole producers of their own rows.
   */
  sessionEvent?(input: NativeActivationSessionEventInput): void;

  /**
   * Receives peer-transport route and delivery events.
   *
   * The transport lane writes no forensics itself — `observability.db` is the single
   * forensic authority and no lane owns a file belonging to the sink, which is why
   * `PeerAdapter` takes an injected `emit` rather than importing one. Ownership follows the
   * authority; the fact that three lanes then merged without touching each other's files is
   * a consequence of that boundary, not a merge tactic to copy where no boundary exists.
   */
  peerTransportEvent?(event: TransportForensicEvent): void;
}

/** One raw session event, with the activation identity needed to attribute it. */
export interface NativeActivationSessionEventInput {
  activationId: string;
  attemptId: string;
  participantId: string;
  specialist: string;
  beadId?: string;
  piSessionId: string;
  workspacePath: string;
  event: PiAgentSessionEvent;
}

/** Discards events. Used only where forensics are genuinely not wanted (unit tests). */
export const NULL_FORENSIC_SINK: ActivationForensicSink = { emit: () => {} };

export interface NativeActivationHostDeps {
  loader?: SpecialistLoader;
  beadsClient?: Pick<BeadsClient, 'readBead'>;
  forensics?: ActivationForensicSink;
  /** Injected for tests; defaults to resolving the real Pi SDK. */
  loadSdk?: () => Promise<PiSdk>;
  /** Bead readiness gate seams. Defaults read the real `bd` state marker. */
  beadGate?: BeadGateOptions;
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  now?: () => number;
  /**
   * Persists the Fleet projection to the one Substrate authority. Defaults to a
   * no-op (unit tests); production servers inject `createFileAuthorityWriter()`.
   * Best-effort by contract — the writer never throws, so lifecycle never depends
   * on the store being present, writable, or even openable.
   */
  authority?: AuthorityWriter;
  /**
   * Push asks to a live Claude coordinator over the peer channel.
   *
   * Omit it and the host is polling-only, which is the degraded path and is correct: the
   * question is still readable through `specialist_status` and nothing is lost. Supplying
   * it does not make delivery guaranteed — see docs/design/claude-transport-decision.md §5.
   */
  peer?: PeerDelivery;
}

/** Configuration for pushing interactions to a Claude coordinator. */
export interface PeerDelivery {
  /** The coordinator's Claude session id. The only stable address on this channel. */
  coordinatorSessionId: string;
  /** Repository root under which `.specialists/interactions/` lives. Defaults to `cwd`. */
  repoRoot?: string;
  /** Built for tests; defaults to a real `PeerAdapter` against the live roster. */
  adapter?: PeerAdapter;
  replyTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * A live activation view attached to a running or resumable session.
 *
 * `detach` only removes this listener; it is symmetric with `attach`/`return` and never
 * touches the session's turn, its state, or any other attachment on the same activation.
 */
export interface ActivationAttachment {
  snapshot: ActivationSnapshot;
  detach: () => void;
}

export class NativeActivationHost {
  private readonly loader: SpecialistLoader;
  private readonly beadsClient: Pick<BeadsClient, 'readBead'>;
  private readonly forensics: ActivationForensicSink;
  private readonly loadSdk: () => Promise<PiSdk>;
  private readonly beadGate: BeadGateOptions;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly authority: AuthorityWriter;

  private readonly registry = new FleetRegistry();

  /**
   * Last per-message usage value seen per activation, keyed by live snapshot.
   * Feeds accumulateTokenUsage so delta-shape and cumulative-shape providers both
   * project monotonic totals. WeakMap: the entry dies with the snapshot, and resume
   * keeps the same snapshot so counters continue across attempts by construction.
   */
  private readonly lastUsageSeen = new WeakMap<object, Record<string, number>>();

  /**
   * One transport for the whole host. Messages carry their own activationId, so a single
   * instance serves every child and the parent enumerates asks across the Fleet in one
   * place rather than walking activations.
   *
   * Delivery is wired only when a coordinator address is configured. Without one the
   * transport is in-process and every ask reads as `pending` through `specialist_status`,
   * which is the degraded path and is fully functional — the peer channel is an
   * optimisation on top of durable state, never a prerequisite for it (PRD §30).
   */
  private readonly interactions: InteractionTransport;

  constructor(deps: NativeActivationHostDeps = {}) {
    this.cwd = deps.cwd ?? process.cwd();
    this.interactions = new InteractionTransport(
      deps.peer ? { deliver: this.wirePeerDelivery(deps.peer) } : {},
    );
    this.loader = deps.loader ?? new SpecialistLoader({ projectDir: this.cwd });
    this.beadsClient = deps.beadsClient ?? new BeadsClient();
    this.forensics = deps.forensics ?? NULL_FORENSIC_SINK;
    this.loadSdk = deps.loadSdk ?? loadPiSdk;
    this.beadGate = deps.beadGate ?? {};
    this.now = deps.now ?? (() => Date.now());
    this.authority = deps.authority ?? NULL_AUTHORITY_WRITER;
  }

  /**
   * Admit and start one activation.
   *
   * Every rejection below happens BEFORE an AgentSession exists, and each leaves forensic
   * evidence: a refused dispatch is still runtime evidence, and a dispatch that failed
   * silently is indistinguishable from one that never happened.
   */
  async start(request: ActivationRequest): Promise<ActivationHandle> {
    const activationId = `act:${randomUUID().slice(0, 12)}`;
    const attemptId = `att:${activationId.slice(4)}:1`;
    // `::` is the house separator for every participant kind in deriveParticipantId
    // (`orch::`, `node::`, `<container>::emitter::`), and it is what the identity
    // migration writes. A single colon here would produce a participant_id that no
    // lineage query joins against.
    const participantId = `specialist::${request.specialist}`;

    const emit = (name: string, payload?: Record<string, unknown>) =>
      this.forensics.emit({
        activationId, attemptId, participantId,
        specialist: request.specialist, beadId: request.beadId, name, payload,
      });

    emit('activation_requested', {
      requested_by: request.requestedByParticipantId,
      model_override: request.modelOverride ?? null,
      thinking_override: request.thinkingOverride ?? null,
    });

    const reject = (reason: string, detail: Record<string, unknown> = {}): never => {
      emit('activation_rejected', { reason, ...detail });
      throw new DispatchRejectedError(reason, {
        specialist: request.specialist,
        beadId: request.beadId,
        ...detail,
      });
    };

    const specialist = await this.loader.get(request.specialist).catch((error: unknown) => {
      return reject('unknown_specialist', {
        note: error instanceof Error ? error.message : String(error),
      });
    });
    if (!specialist) return reject('unknown_specialist');

    const execution = specialist.specialist.execution;
    const tier = execution.permission_required ?? 'READ_ONLY';

    // Readers and writers are both admitted. A write tier does not gate admission here; it
    // selects the LEASE path below, and the lease is what makes a single writer safe. The
    // refusal this comment used to describe was removed when the lease was wired
    // (unitAI-rrdnt.21/.36) — a comment claiming writers are refused, above code that admits
    // them, is worse than no comment.
    const access: WorkspaceAccess = WRITE_TIERS.has(tier) ? 'write' : 'read';

    const bead = this.beadsClient.readBead(request.beadId);
    if (!bead) return reject('bead_unreadable');

    // `--bead` is the prompt. A Bead that is not a usable task contract is refused here,
    // before a model turn is spent guessing at the scope it does not carry.
    const readiness = evaluateBeadReadiness(bead, this.beadGate);
    if (!readiness.ok) {
      return reject('bead_contract_incomplete', {
        note: readiness.reason,
        ...(readiness.missing.length > 0 ? { missing: readiness.missing } : {}),
      });
    }

    const toolContract = resolveRuntimeToolContract({
      level: tier,
      specialistName: request.specialist,
      specialistPermissions: specialist.specialist.permissions,
      cwd: this.cwd,
    });
    if (!toolContract || toolContract.toolsList.length === 0) {
      return reject('empty_tool_contract', { tier });
    }

    // validateBeforeRun throws on a hard failure (missing skill path, absent external
    // command, required_tool the tier does not grant). Converted into a structured
    // refusal so the caller sees one rejection shape rather than two error styles.
    try {
      validateBeforeRun(specialist, tier, toolContract);
    } catch (error) {
      return reject('preflight_failed', {
        note: error instanceof Error ? error.message : String(error),
      });
    }

    const sdk = await this.loadSdk();

    // The full configured chain is the candidate list (unitAI-3emr7 reverses the
    // unitAI-rrdnt.35 never-fallback ruling, which settled every 429 as failed and wasted
    // the run). An explicit override replaces the chain — a chain of one — which mirrors
    // the CLI `backendOverride` path: a manual switch runs on exactly what was asked for,
    // never on a silent substitute. The walk itself happens below and in runWithFallback:
    // a retryable provider error (rate_limit/timeout/transient per the classifier shared
    // with the CLI runner) advances to the next model and the winner is recorded on the
    // snapshot, so attribution answers "what actually ran" rather than "what was first".
    const fullChain = resolveModelChain(execution);
    const configuredModel = fullChain[0];
    const modelChain = request.modelOverride ? [request.modelOverride] : fullChain;
    const requestedModel = request.modelOverride ?? configuredModel;
    if (request.thinkingOverride !== undefined && !(THINKING_LEVELS as readonly string[]).includes(request.thinkingOverride)) {
      return reject('invalid_thinking_override', {
        thinkingOverride: request.thinkingOverride,
        note: `supported thinking levels: ${THINKING_LEVELS.join(', ')}`,
      });
    }
    const thinkingLevel = request.thinkingOverride ?? execution.thinking_level;
    if (!requestedModel) return reject('no_model_configured');

    // An explicit override that is unavailable must fail here rather than silently
    // running on something else. Both halves of the gate are required — see model-gate.ts.
    // Without an override the walk starts here: the first HONOURABLE model wins the
    // dispatch-time session, and an unavailable primary with a configured fallback is
    // skipped with forensics rather than spending a turn failing. Post-dispatch provider
    // failures continue the same walk inside runWithFallback.
    const modelRuntime = await createGateModelRuntime(sdk);
    let modelIndex = 0;
    let modelCheck = await validateModelAvailable(sdk, modelRuntime, modelChain[0] ?? '');
    while ((!modelCheck.ok || !modelCheck.model) && modelIndex < modelChain.length - 1) {
      const skipped = modelChain[modelIndex];
      emit('model_fallback', {
        from_model: skipped ?? null,
        to_model: modelChain[modelIndex + 1],
        error_class: 'unavailable',
        terminal: false,
        note: modelCheck.reason ?? null,
      });
      modelIndex += 1;
      modelCheck = await validateModelAvailable(sdk, modelRuntime, modelChain[modelIndex] ?? '');
    }
    if (!modelCheck.ok || !modelCheck.model) {
      return reject('model_unavailable', {
        requestedModel: modelChain[modelIndex] ?? requestedModel,
        note: modelCheck.reason,
      });
    }
    const resolvedModel = modelCheck.resolvedModel ?? modelChain[modelIndex] ?? requestedModel;

    const workspace: WorkspaceIdentity = request.workspaceHint ?? {
      repositoryRoot: this.cwd,
      worktreePath: this.cwd,
    };

    // PRD Phase 10 / §52. A writer takes the lease BEFORE a session exists, so contention
    // is refused without spending a model turn, and so a refused writer never reaches the
    // point where it could mutate anything. A reader takes nothing: it is not entitled to
    // the lease, and `admitToolCall` refuses it every mutating call for that reason.
    //
    // `acquire` throws DispatchRejectedError on contention and on an uncertain lease, and
    // both are correct refusals rather than errors — an uncertain workspace is never
    // stolen, because a holder whose liveness is unknown may still be mutating it and only
    // reconciliation decides what happened (`workspace-reconcile.ts`).
    if (access === 'write') {
      try {
        acquireLease({ workspace, activationId, attemptId, specialist: request.specialist });
      } catch (error) {
        if (error instanceof DispatchRejectedError) {
          emit('lease_denied', {
            workspace: workspace.worktreePath,
            reason: error.reason,
            note: error.detail.holder,
          });
        }
        emit('activation_rejected', { reason: 'workspace_lease_unavailable' });
        throw error;
      }
      emit('lease_acquired', { workspace: workspace.worktreePath });
    }

    // PRD §15: bound this activation to its role. Derived and in-memory — compiling a
    // StepContract creates no issue, chain, or graph (Phase 4, invariant 4).
    const stepContract = compileStepContract({
      bead,
      specialist: specialist.specialist.metadata.name,
      responseFormat: execution.response_format,
      now: this.now,
    });

    emit('step_contract_compiled', {
      root_work_ref: stepContract.rootWorkRef,
      inputs: stepContract.inputs.length,
      outputs: stepContract.outputs.length,
      non_goals: stepContract.nonGoals.length,
      constraints: stepContract.constraints?.length ?? 0,
      validation: stepContract.validation?.length ?? 0,
      source_bead_revision: stepContract.provenance.sourceBeadRevision ?? null,
    });

    emit('activation_admitted', {
      tier, access,
      configured_model: configuredModel ?? null,
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      model_override: Boolean(request.modelOverride),
      thinking_level: thinkingLevel ?? null,
      thinking_override: request.thinkingOverride !== undefined,
      workspace: workspace.worktreePath,
      tools: toolContract.toolsList.join(','),
      custom_tools: `${ASK_TOOL},${ESCALATE_TOOL}`,
    });

    const epicAncestors = collectEpicAncestors(
      (id) => this.beadsClient.readBead(id),
      bead,
      request.epicContextDepth,
    );

    const rendered = renderTaskPrompt({
      specialist: specialist.specialist,
      cwd: this.cwd,
      beadId: request.beadId,
      bead,
      epicAncestors,
    });

    const systemPrompt = buildSystemPrompt({
      systemPromptTemplate: specialist.specialist.prompt.system ?? '',
      templateVariables: rendered.beadTemplateVariables ?? {},
      bare: execution.bare ?? false,
      runCwd: this.cwd,
      specialistName: specialist.specialist.metadata.name,
      inputBeadId: request.beadId,
      responseFormat: execution.response_format ?? 'text',
      outputType: execution.output_type ?? 'custom',
      outputContractSchema: undefined,
      beadContextText: rendered.beadContextText ?? '',
      readBeadForMemory: (id) => this.beadsClient.readBead(id),
    });

    emit('activation_starting', { pi_session_id: null });

    // The ask/escalate tools are CUSTOM tools, admitted alongside the resolved allowlist
    // rather than added to it. A read-only Specialist gains the ability to ask without
    // gaining any mutation capability — asking is not a workspace operation.
    const askTools = createAskTools(sdk, {
      transport: this.interactions,
      activationId,
      currentAttemptId: () => this.registry.get(activationId)?.snapshot.attemptId ?? attemptId,
      self: participantId,
      parent: request.requestedByParticipantId,
      onAsk: (kind, body) => {
        const record = this.registry.get(activationId);
        if (record) record.snapshot.state = kind === 'escalation' ? 'escalated' : 'needs_reply';
        if (record) this.save(record.snapshot);
        emit(kind === 'escalation' ? 'escalation_raised' : 'clarification_requested', { body });
      },
      onAnswered: (kind) => {
        const record = this.registry.get(activationId);
        if (record) record.snapshot.state = 'running';
        if (record) this.save(record.snapshot);
        emit(kind === 'escalation' ? 'escalation_resolved' : 'clarification_answered');
      },
    });

    // PRD §52: the mutating builtins are RECONSTRUCTED and wrapped here, so the only
    // mutating tool the child can reach is one that consults the lease on every call. A
    // guard each frontend has to remember to call is optional enforcement; this one cannot
    // be skipped, because the frontend is not involved (unitAI-rrdnt.36.2).
    const guardedTools = createGuardedTools(sdk, {
      toolNames: toolContract.toolsList,
      cwd: workspace.worktreePath,
      admit: toolName => admitToolCall({ toolName, workspace, activationId }),
    });

    if (guardedTools.unguardable.length > 0) {
      // A mutating tool we cannot reconstruct cannot be fenced. Passing it through would
      // make the lease decorative for exactly the calls it exists to stop, so the dispatch
      // is refused and the names are named.
      emit('lease_denied', {
        workspace: workspace.worktreePath,
        note: `cannot guard mutating tools: ${guardedTools.unguardable.join(', ')}`,
      });
      return reject('unguardable_mutating_tools', {
        note: `these tools mutate and cannot be fenced by the workspace lease on this runtime: ${guardedTools.unguardable.join(', ')}`,
      });
    }

    // Session options are built once so every later attempt on a new model — the fallback
    // walk below, a retry with an override — creates its session identically to the first.
    // The ask/escalate tools are shared across attempts on purpose: they key off the live
    // attempt id, not the session, so a fallback keeps the same pending-ask correlation.
    const baseSessionOptions = {
      customTools: [...askTools, ...guardedTools.tools],
      cwd: workspace.worktreePath,
      // The pi SDK takes a Model object here. Passing the provider-qualified string
      // instead is accepted silently and then fails mid-turn with an unresolved provider.
      model: modelCheck.model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // Fail-closed: only the resolved contract's tools, never pi's defaults. `noTools`
      // must be "builtin" rather than `tools: []`, which would also empty customTools.
      noTools: 'builtin',
      // `tools` is a HARD FILTER on pi 0.85.1 and it applies to `customTools` too: a
      // session given customTools: [ask_coordinator] and tools: ['read'] reports exactly
      // ['read'], dropping the custom tool silently — no error, no diagnostic. So the ask
      // tools have to be named here as well as passed above, or no Specialist can ever
      // reach its coordinator (unitAI-rrdnt.43). Measured on a live session by enumerating
      // getAllTools(), not inferred.
      //
      // Omitting `tools` entirely is NOT the alternative: that admits every builtin,
      // measured at 50+ including bash, edit, write and powershell. Fail-open is worse than
      // the bug. Naming the two ask tools keeps admission fail-closed and widens nothing —
      // asking is not a workspace operation and neither tool can mutate anything.
      tools: [...toolContract.toolsList, ASK_TOOL, ESCALATE_TOOL],
      systemPrompt: systemPrompt.text,
    };

    const { session } = await sdk.createAgentSession({ ...baseSessionOptions, model: modelCheck.model });

    const createSessionForModel = async (model: { id?: string; provider?: string }): Promise<PiAgentSessionLike> => {
      const created = await sdk.createAgentSession({ ...baseSessionOptions, model });
      return created.session;
    };

    const purpose = extractPurposeExcerpt(bead.description ?? '');
    const startedAt = this.now();
    const snapshot: ActivationSnapshot = {
      activationId, participantId, attemptId,
      specialist: request.specialist,
      beadId: request.beadId,
      state: 'starting',
      access, workspace,
      piSessionId: session.sessionId,
      configuredModel,
      // What the CALLER asked for, recorded even when it equals what resolved. Without the
      // equal case the useful query — "which activations ran on something other than what
      // was asked for" — is unanswerable, and `configuredModel` does not substitute: that
      // is what the Specialist configures, which becomes a different question the moment an
      // override exists (unitAI-rrdnt.35).
      requestedModel,
      resolvedModel,
      modelOverride: Boolean(request.modelOverride),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      thinkingOverride: request.thinkingOverride !== undefined,
      // Captured once at dispatch from the validated contract; the tick stays an in-memory read.
      ...(purpose ? { purpose } : {}),
      startedAt,
      lastActivityAt: startedAt,
    };

    emit('activation_started', { pi_session_id: session.sessionId });

    const unsubscribe = session.subscribe((event) => this.onSessionEvent(snapshot, event, emit));

    // The result promise owns the fallback walk: the first attempt runs, and a failure
    // whose class is retryable advances to the next chain model on a FRESH session under
    // the SAME activation and attempt — dispatch already returned by then, so the walk
    // must not block it. The registry record is mutated in place (session, snapshot,
    // unsubscribe) so status/readers observe the winner, not the casualty.
    const record: ActivationRecord = {
      snapshot, session, unsubscribe,
      result: undefined as unknown as Promise<ActivationResult>,
      stepContract, initialPrompt: rendered.initial_prompt, createSession: createSessionForModel,
    };
    const result = this.runWithFallback(record, {
      modelChain, modelIndex, sdk, modelRuntime,
      initialPrompt: rendered.initial_prompt, emit,
    });
    record.result = result;

    this.registry.register(record);
    this.save(snapshot);

    return {
      activationId, participantId, attemptId,
      specialist: request.specialist,
      beadId: request.beadId,
      access, workspace, resolvedModel,
      stepContract,
      result,
    };
  }

  /**
   * Translate Pi session events into Specialists forensic events.
   *
   * `agent_end` is a per-turn boundary carrying `willRetry`; `agent_settled` is the
   * governed quiescence boundary. Conflating them is why a naive host disposes a child
   * that was merely pausing.
   */
  private onSessionEvent(
    snapshot: ActivationSnapshot,
    event: PiAgentSessionEvent,
    emit: (name: string, payload?: Record<string, unknown>) => void,
  ): void {
    snapshot.lastActivityAt = this.now();
    // Session spend merges one message's provider counts into the running total
    // (unitAI-beqby.15): per-message deltas add whole, cumulative-per-message
    // counters add only their growth, so neither shape flaps the row down nor
    // explodes it. Accumulate on message_end only — the one event per message
    // carrying final usage — so streaming partials can never double-count.
    if (event.type === 'message_end') {
      const usage = extractTokenUsage(event);
      if (usage) {
        const seen = this.lastUsageSeen.get(snapshot) ?? {};
        snapshot.tokenUsage = accumulateTokenUsage(snapshot.tokenUsage, usage, seen);
        this.lastUsageSeen.set(snapshot, seen);
      }
    }

    // Offer the RAW event before any translation. Deliberately not wrapped in try/catch:
    // the sink swallows its own errors, and a forensic concern must never alter activation
    // behaviour — nor be silently hidden by a catch here.
    this.forensics.sessionEvent?.({
      activationId: snapshot.activationId,
      attemptId: snapshot.attemptId,
      participantId: snapshot.participantId,
      specialist: snapshot.specialist,
      beadId: snapshot.beadId,
      piSessionId: snapshot.piSessionId ?? '',
      workspacePath: snapshot.workspace.worktreePath,
      event,
    });

    switch (event.type) {
      case 'agent_start':
        snapshot.state = 'running';
        this.save(snapshot);
        emit('turn_started');
        break;
      case 'agent_end':
        emit('turn_completed', { will_retry: Boolean(event.willRetry) });
        break;
      case 'agent_settled':
        snapshot.state = 'settled';
        this.save(snapshot);
        emit('activation_settled');
        this.releaseIfWriter(snapshot, 'settled');
        break;
      case 'auto_retry_start':
        emit('retry_started', { attempt: event.attempt, max_attempts: event.maxAttempts });
        break;
      case 'auto_retry_end':
        emit('retry_completed', { success: event.success, attempt: event.attempt });
        break;
      case 'compaction_start':
        emit('compaction_started', { reason: event.reason });
        break;
      case 'compaction_end':
        emit('compaction_completed', { reason: event.reason, aborted: event.aborted });
        break;
      default:
        break;
    }
  }

  private async runToSettled(
    snapshot: ActivationSnapshot,
    session: PiAgentSessionLike,
    initialPrompt: string,
    emit: (name: string, payload?: Record<string, unknown>) => void,
  ): Promise<ActivationResult> {
    try {
      await session.prompt(initialPrompt);
      await session.waitForIdle();

      // A settled session is NOT a successful one. pi records a failed turn as an
      // assistant message with stopReason 'error' (or 'aborted') and an errorMessage —
      // provider 429s, auth failures and aborts all land here — while `waitForIdle`
      // returns normally. Reporting that as `completed` with empty output is exactly the
      // silent-success failure the result contract exists to prevent.
      const last = lastAssistantMessage(session.messages);
      if (last && (last.stopReason === 'error' || last.stopReason === 'aborted')) {
        const detail = last.errorMessage ?? `turn ended with stopReason "${last.stopReason}"`;
        snapshot.state = 'failed';
        this.save(snapshot);
        emit('activation_failed', { error: detail, stop_reason: last.stopReason });
        return {
          activationId: snapshot.activationId,
          participantId: snapshot.participantId,
          attemptId: snapshot.attemptId,
          beadId: snapshot.beadId,
          status: 'failed',
          output: undefined,
          validation: { valid: false, errors: [detail] },
          piSessionId: session.sessionId,
          configuredModel: snapshot.configuredModel,
      requestedModel: snapshot.requestedModel,
          resolvedModel: snapshot.resolvedModel,
          modelOverride: snapshot.modelOverride,
          ...(snapshot.thinkingLevel ? { thinkingLevel: snapshot.thinkingLevel } : {}),
          thinkingOverride: snapshot.thinkingOverride,
          fallbackUsed: false,
          completedAt: this.now(),
        };
      }

      const output = textOf(last);

      emit('output_validation_started');
      // Phase 1 carries no output schema; schema/expected-key enforcement arrives with the
      // result-contract work. Recorded explicitly so the gap is visible rather than implied.
      const validation = { valid: true as const };
      emit('output_validation_passed');

      snapshot.state = 'settled';
      this.save(snapshot);
      emit('activation_completed', { pi_session_id: session.sessionId, output });
      this.releaseIfWriter(snapshot, 'completed');

      return {
        activationId: snapshot.activationId,
        participantId: snapshot.participantId,
        attemptId: snapshot.attemptId,
        beadId: snapshot.beadId,
        status: 'completed',
        output,
        validation,
        piSessionId: session.sessionId,
        configuredModel: snapshot.configuredModel,
      requestedModel: snapshot.requestedModel,
        resolvedModel: snapshot.resolvedModel,
        modelOverride: snapshot.modelOverride,
        ...(snapshot.thinkingLevel ? { thinkingLevel: snapshot.thinkingLevel } : {}),
        thinkingOverride: snapshot.thinkingOverride,
        fallbackUsed: false,
        completedAt: this.now(),
      };
    } catch (error) {
      snapshot.state = 'failed';
      this.save(snapshot);
      const message = error instanceof Error ? error.message : String(error);
      emit('activation_failed', { error: message });

      return {
        activationId: snapshot.activationId,
        participantId: snapshot.participantId,
        attemptId: snapshot.attemptId,
        beadId: snapshot.beadId,
        status: 'failed',
        output: undefined,
        validation: { valid: false, errors: [message] },
        piSessionId: session.sessionId,
        configuredModel: snapshot.configuredModel,
      requestedModel: snapshot.requestedModel,
        resolvedModel: snapshot.resolvedModel,
        modelOverride: snapshot.modelOverride,
        ...(snapshot.thinkingLevel ? { thinkingLevel: snapshot.thinkingLevel } : {}),
        thinkingOverride: snapshot.thinkingOverride,
        fallbackUsed: false,
        completedAt: this.now(),
      };
    }
    // Deliberately no dispose(): a settled Specialist remains alive and resumable.
  }

  /**
   * Run the turn-1 attempt, walking the model chain on retryable provider failures.
   *
   * The first attempt runs on the dispatch-time session; a failure whose class is
   * retryable (rate_limit/timeout/transient per the classifier shared with the CLI
   * runner) disposes that session and continues on the next chain model under the SAME
   * activation and attempt id. Auth, unknown and abort-class failures settle failed
   * immediately — retrying those on another model is either wrong (auth) or blind
   * (unknown), exactly the CLI rule. The winner lands on the snapshot (`resolvedModel`,
   * `piSessionId`) and on the result (`resolvedModel`, `fallbackUsed`), so attribution
   * answers what actually ran.
   *
   * Runs inside the dispatch result promise: dispatch already returned, so the walk never
   * blocks admission. A record removed mid-walk (stop) ends the walk — a disposed
   * activation must never resurrect.
   */
  private async runWithFallback(
    record: ActivationRecord,
    ctx: {
      modelChain: string[];
      modelIndex: number;
      sdk: PiSdk;
      modelRuntime: PiModelRuntimeLike;
      initialPrompt: string;
      emit: (name: string, payload?: Record<string, unknown>) => void;
    },
  ): Promise<ActivationResult> {
    let index = ctx.modelIndex;
    // A dispatch-time skip (unavailable primary) already advanced past the chain head.
    let fallbackUsed = index > 0;
    let result = await this.runToSettled(record.snapshot, record.session, ctx.initialPrompt, ctx.emit);

    while (result.status === 'failed' && index < ctx.modelChain.length - 1) {
      if (this.registry.get(record.snapshot.activationId) !== record) break;
      const detail = result.validation.errors?.[0] ?? 'unknown failure';
      const errorClass = classifyFallbackError(detail);
      if (!FALLBACK_RETRYABLE_CLASSES.has(errorClass)) break;
      const nextModel = ctx.modelChain[index + 1];
      const fromModel = record.snapshot.resolvedModel;
      // Validate BEFORE disposing: a fallback that cannot be honoured keeps the failed
      // session and its context rather than trading them for nothing.
      const check = await validateModelAvailable(ctx.sdk, ctx.modelRuntime, nextModel);
      if (!check.ok || !check.model) {
        ctx.emit('model_fallback', {
          from_model: fromModel,
          to_model: nextModel,
          error_class: errorClass,
          terminal: true,
          note: `fallback unavailable: ${check.reason ?? 'unresolvable'}`,
          resolved_model: fromModel,
        });
        break;
      }
      ctx.emit('model_fallback', {
        from_model: fromModel,
        to_model: nextModel,
        error_class: errorClass,
        terminal: false,
        attempt_n: index + 2,
        resolved_model: check.resolvedModel ?? nextModel,
      });
      let nextSession: PiAgentSessionLike;
      try {
        nextSession = await record.createSession(check.model);
      } catch (error) {
        ctx.emit('model_fallback', {
          from_model: fromModel,
          to_model: nextModel,
          error_class: errorClass,
          terminal: true,
          note: error instanceof Error ? error.message : String(error),
          resolved_model: fromModel,
        });
        break;
      }
      try { record.session.dispose(); } catch { /* best effort; the lease is untouched */ }
      record.unsubscribe();
      record.session = nextSession;
      record.snapshot.resolvedModel = check.resolvedModel ?? nextModel;
      record.snapshot.piSessionId = nextSession.sessionId;
      record.snapshot.state = 'starting';
      record.snapshot.lastActivityAt = this.now();
      this.save(record.snapshot);
      record.unsubscribe = nextSession.subscribe((event) => this.onSessionEvent(record.snapshot, event, ctx.emit));
      ctx.emit('activation_started', { pi_session_id: nextSession.sessionId });
      index += 1;
      fallbackUsed = true;
      result = await this.runToSettled(record.snapshot, record.session, ctx.initialPrompt, ctx.emit);
    }

    result.fallbackUsed = fallbackUsed;
    return result;
  }

  /**
   * Re-run a FAILED activation in place — the native equivalent of `sp retry`.
   *
   * Keeps `activationId` and advances `attemptId`: a retry is a new attempt under one
   * activation, never a second dispatch, so lineage and the workspace lease survive it.
   * Without a model override the SAME session is re-prompted, so its context survives
   * too; with one a new session is built identically except for the model, and the
   * failed session is disposed. The turn prompt defaults to the dispatch-time render of
   * the same bead — pass `prompt` to say something new, or dispatch fresh when the bead
   * itself was rewritten.
   *
   * Gating mirrors the CLI retry: failed only. A waiting/settled/needs_reply/escalated
   * activation resumes (its session is alive); a running one steers or stops first.
   * A refused model override leaves the activation failed-and-retryable, never
   * half-advanced. Writers reacquire their own lease for the new attempt — the workspace
   * is held across the retry, never dropped, so no orphan is possible.
   */
  async retry(activationId: string, opts?: { modelOverride?: string; prompt?: string }): Promise<ActivationHandle> {
    const record = this.registry.get(activationId);
    if (!record) {
      throw new DispatchRejectedError('unknown_activation', { activationId });
    }
    if (!RETRYABLE_STATES.has(record.snapshot.state)) {
      const state = record.snapshot.state;
      const hint = state === 'waiting' || state === 'settled' || state === 'needs_reply' || state === 'escalated'
        ? `Activation ${activationId} is ${state} — use resume, which keeps the live session.`
        : `Activation ${activationId} is ${state} — steer it or stop it first.`;
      throw new DispatchRejectedError('not_resumable', {
        activationId,
        note: `state is "${state}". retry only re-runs failed activations. ${hint}`,
      });
    }

    // Validate an override BEFORE touching lease or snapshot: a refused model leaves the
    // activation failed-and-retryable rather than half-advanced.
    const overrideName = opts?.modelOverride;
    let overrideModel: { id?: string; provider?: string } | undefined;
    let overrideResolved: string | undefined;
    if (overrideName) {
      const sdk = await this.loadSdk();
      const check = await validateModelAvailable(sdk, await createGateModelRuntime(sdk), overrideName);
      if (!check.ok || !check.model) {
        throw new DispatchRejectedError('model_unavailable', {
          activationId,
          requestedModel: overrideName,
          note: check.reason,
        });
      }
      overrideModel = check.model;
      overrideResolved = check.resolvedModel ?? overrideName;
    }

    const attemptId = nextAttemptId(record.snapshot.attemptId);
    if (record.snapshot.access === 'write') {
      try {
        acquireLease({
          workspace: record.snapshot.workspace,
          activationId, attemptId, specialist: record.snapshot.specialist,
        });
      } catch (error) {
        if (error instanceof DispatchRejectedError) {
          this.forensics.emit({
            activationId, attemptId, participantId: record.snapshot.participantId,
            specialist: record.snapshot.specialist, beadId: record.snapshot.beadId,
            name: 'lease_denied',
            payload: { reason: error.reason, note: error.detail.holder, on: 'retry' },
          });
        }
        throw error;
      }
    }
    record.snapshot.attemptId = attemptId;
    record.snapshot.state = 'starting';
    record.snapshot.lastActivityAt = this.now();
    this.save(record.snapshot);

    const emit = (name: string, payload?: Record<string, unknown>) =>
      this.forensics.emit({
        activationId, attemptId, participantId: record.snapshot.participantId,
        specialist: record.snapshot.specialist, beadId: record.snapshot.beadId, name, payload,
      });

    let reusedSession = true;
    if (overrideModel && overrideResolved && overrideName) {
      // A new model needs a new session — the model is fixed at creation. The failed
      // session is disposed; same-session context survives only on the no-override path.
      const nextSession = await record.createSession(overrideModel);
      try { record.session.dispose(); } catch { /* best effort */ }
      record.unsubscribe();
      record.session = nextSession;
      record.snapshot.requestedModel = overrideName;
      record.snapshot.resolvedModel = overrideResolved;
      record.snapshot.modelOverride = true;
      record.snapshot.piSessionId = nextSession.sessionId;
      reusedSession = false;
    } else {
      record.unsubscribe();
    }
    // Re-subscribe under the new attempt id: the old listener would emit forensics
    // against the closed attempt (the resume() shape).
    record.unsubscribe = record.session.subscribe((event) => this.onSessionEvent(record.snapshot, event, emit));

    emit('activation_retried', {
      requested_model: record.snapshot.requestedModel ?? null,
      resolved_model: record.snapshot.resolvedModel,
      model_override: record.snapshot.modelOverride,
      reused_session: reusedSession,
    });

    const result = this.runToSettled(record.snapshot, record.session, opts?.prompt ?? record.initialPrompt, emit);
    record.result = result;

    return {
      activationId, participantId: record.snapshot.participantId, attemptId,
      specialist: record.snapshot.specialist, beadId: record.snapshot.beadId,
      access: record.snapshot.access, workspace: record.snapshot.workspace,
      resolvedModel: record.snapshot.resolvedModel,
      stepContract: record.stepContract,
      result,
    };
  }

  /**
   * Answer an outstanding ask, resuming the child inside its existing tool call.
   *
   * The answer returns as that tool's result, so the SAME AgentSession continues with its
   * context intact. Correlation is by `messageId`; there is deliberately no "answer the
   * latest ask" convenience, because with two asks outstanding that is a coin flip.
   */
  async answer(messageId: string, body: string): Promise<InteractionMessage | undefined> {
    const ask = this.interactions.pendingAsks().find(a => a.message.messageId === messageId);
    if (!ask) return undefined;

    return this.interactions.send({
      kind: 'reply',
      from: ask.message.to,
      to: ask.message.from,
      activationId: ask.message.activationId,
      attemptId: ask.message.attemptId,
      body,
      inReplyTo: messageId,
    });
  }

  /**
   * Mirror one snapshot to the Substrate authority. Best-effort twice over: the
   * writer swallows its own errors, and this guards the call, because a store
   * failure must never alter activation behaviour.
   */
  private save(snapshot: ActivationSnapshot): void {
    try {
      this.authority.record(snapshot);
    } catch {
      // Authority writes never fail an activation.
    }
  }

  /**
   * Mirror disposal to the authority: the row goes with the activation, so
   * SessionStart never surfaces stopped work as live. Guarded like `save`.
   */
  private forget(activationId: string): void {
    try {
      this.authority.remove(activationId);
    } catch {
      // Authority writes never fail an activation.
    }
  }

  /**
   * Release a writer's lease, converting an uncertain release into evidence.
   *
   * `release` THROWS when the holder's liveness cannot be established, and that throw is
   * the point: it refuses to guess whether the previous writer finished. Swallowing it
   * would silently free a workspace that may still be under mutation, which is the exact
   * inference the uncertain state exists to prevent. So the throw becomes a
   * `lease_uncertain` event and the workspace stays uncertain until an operator reconciles
   * it through `specialist_status` — the shape argued by the unitAI-rrdnt.31 lane.
   *
   * Teardown is never failed by this. A stop that could not release is still a stop.
   */
  private releaseIfWriter(snapshot: ActivationSnapshot, reason: string): void {
    if (snapshot.access !== 'write') return;
    try {
      releaseLease(snapshot.workspace, snapshot.activationId);
      this.forensics.emit({
        activationId: snapshot.activationId,
        attemptId: snapshot.attemptId,
        participantId: snapshot.participantId,
        specialist: snapshot.specialist,
        beadId: snapshot.beadId,
        name: 'lease_released',
        payload: { workspace: snapshot.workspace.worktreePath, reason },
      });
    } catch (error) {
      this.forensics.emit({
        activationId: snapshot.activationId,
        attemptId: snapshot.attemptId,
        participantId: snapshot.participantId,
        specialist: snapshot.specialist,
        beadId: snapshot.beadId,
        name: 'lease_uncertain',
        payload: {
          workspace: snapshot.workspace.worktreePath,
          note: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * Decide whether one planned tool call may run — PRD §52, the per-call block.
   *
   * This must be a per-call verdict and NOT `setActiveToolsByName`. Within a turn the agent
   * loop runs against a tool snapshot taken at turn start, so revoking a tool cannot cancel
   * a call that is already planned; every handler in a batch fires before any execution, so
   * a block is enforceable exactly where a tool-set change is not (unitAI-rrdnt.7).
   *
   * A read-only activation is refused every mutating call. That is not an error — it holds
   * no lease because it is not entitled to one, and this is the only choke point where the
   * capability grant can actually be enforced.
   *
   * KNOWN HOLE, unclosed and not closable on pi 0.85.1: this guards the LLM tool path only.
   * `AgentSession.executeBash()` and `pi.exec()` fire the extension `tool_call` handler
   * ZERO times, re-verified on 0.85.1 (unitAI-rrdnt.6). An extension that mutates the
   * workspace through those bypasses this gate entirely. Do not document the lease as
   * protecting a worktree against arbitrary extension effects; it does not.
   */
  admitToolCall(activationId: string, toolName: string): { allow: boolean; reason?: string } {
    const record = this.registry.get(activationId);
    if (!record) return { allow: false, reason: `unknown activation ${activationId}` };

    const verdict = admitToolCall({
      toolName,
      workspace: record.snapshot.workspace,
      activationId,
    });

    if (!verdict.allow) {
      this.forensics.emit({
        activationId,
        attemptId: record.snapshot.attemptId,
        participantId: record.snapshot.participantId,
        specialist: record.snapshot.specialist,
        beadId: record.snapshot.beadId,
        name: 'tool_blocked',
        payload: { tool: toolName, note: verdict.reason },
      });
    }
    return verdict;
  }

  /** Every outstanding ask across the Fleet, oldest first. */
  pendingAsks(): PendingAsk[] {
    return this.interactions.pendingAsks();
  }

  /** Current state of one activation, or undefined if unknown to this host. */
  inspect(activationId: string): ActivationSnapshot | undefined {
    return this.registry.projection(activationId);
  }

  /**
   * Live per-activation stats over existing in-memory state: one Map read plus
   * arithmetic, never an observability.db query, so the 1s widget tick stays cheap.
   */
  liveStats(activationId: string): LiveActivationStats | undefined {
    const snapshot = this.registry.projection(activationId);
    if (!snapshot) return undefined;
    return {
      activationId: snapshot.activationId,
      elapsed_s: Math.max(0, Math.floor((this.now() - snapshot.startedAt) / 1000)),
      last_activity_at: snapshot.lastActivityAt,
      ...(snapshot.thinkingLevel ? { thinking_level: snapshot.thinkingLevel } : {}),
      ...(snapshot.tokenUsage ? { token_usage: { ...snapshot.tokenUsage } } : {}),
    };
  }

  /**
   * Build the delivery hook for a configured coordinator.
   *
   * Called from the constructor, so it must not read any field the constructor has not yet
   * assigned — `repoRoot` is taken from the config or from `deps.cwd` directly rather than
   * from `this.cwd`, which is set on the line above but would be a trap to depend on if the
   * order ever changed.
   */
  private wirePeerDelivery(peer: PeerDelivery) {
    const repoRoot = peer.repoRoot ?? this.cwd;
    return createPeerDelivery({
      transport: () => this.interactions,
      adapter: peer.adapter ?? new PeerAdapter({
        repoRoot,
        emit: event => this.forensics.peerTransportEvent?.(event),
      }),
      repoRoot,
      coordinatorSessionId: peer.coordinatorSessionId,
      ...(peer.replyTimeoutMs !== undefined ? { replyTimeoutMs: peer.replyTimeoutMs } : {}),
      ...(peer.pollIntervalMs !== undefined ? { pollIntervalMs: peer.pollIntervalMs } : {}),
    });
  }

  /** The Fleet projection: every activation this process knows about, transport-neutral. */
  list(): ActivationSnapshot[] {
    return this.registry.list();
  }

  /**
   * Explicitly stop and dispose an activation.
   *
   * This is the only ordinary path to disposal — settling is not one.
   */
  async stop(activationId: string, reason = 'operator request'): Promise<void> {
    const record = this.registry.get(activationId);
    if (!record) return;

    record.snapshot.state = 'stopping';
    try {
      await record.session.abort();
    } finally {
      record.unsubscribe();
      record.session.dispose();
      record.snapshot.state = 'stopped';
      this.forget(record.snapshot.activationId);
      this.releaseIfWriter(record.snapshot, reason);
      this.forensics.emit({
        activationId,
        attemptId: record.snapshot.attemptId,
        participantId: record.snapshot.participantId,
        specialist: record.snapshot.specialist,
        beadId: record.snapshot.beadId,
        name: 'activation_disposed',
        payload: { reason },
      });
      this.registry.remove(activationId);
    }
  }

  /**
   * Attach a listener to a live activation's event stream without perturbing its turn.
   *
   * Subscribing is additive — `PiAgentSessionLike.subscribe` fans out to every listener —
   * so an attached observer (a Fleet view, a follow MCP call) never displaces the host's
   * own lifecycle subscription or any other attachment on the same activation.
   */
  attach(
    activationId: string,
    listener: (event: PiAgentSessionEvent) => void,
  ): ActivationAttachment | undefined {
    const record = this.registry.get(activationId);
    if (!record) return undefined;
    return { snapshot: record.snapshot, detach: record.session.subscribe(listener) };
  }

  /** Release an attachment. Symmetric with `attach`; the activation itself is unaffected. */
  return(attachment: ActivationAttachment): void {
    attachment.detach();
  }

  /**
   * Resume a settled or waiting activation with a new prompt.
   *
   * Keeps `activationId` and advances `attemptId` — a resume is never a second activation.
   * The host's own lifecycle listener is re-subscribed so forensics for the new attempt
   * carry the new `attemptId` rather than the one closed over at `start()`.
   */
  async resume(activationId: string, prompt: string): Promise<ActivationHandle> {
    const record = this.registry.get(activationId);
    if (!record) {
      throw new DispatchRejectedError('unknown_activation', { activationId });
    }
    if (!RESUMABLE_STATES.has(record.snapshot.state)) {
      throw new DispatchRejectedError('not_resumable', {
        activationId,
        note: `state is "${record.snapshot.state}"`,
      });
    }

    const attemptId = nextAttemptId(record.snapshot.attemptId);
    if (record.snapshot.access === 'write') {
      try {
        acquireLease({
          workspace: record.snapshot.workspace,
          activationId, attemptId, specialist: record.snapshot.specialist,
        });
      } catch (error) {
        if (error instanceof DispatchRejectedError) {
          this.forensics.emit({
            activationId, attemptId, participantId: record.snapshot.participantId,
            specialist: record.snapshot.specialist, beadId: record.snapshot.beadId,
            name: 'lease_denied',
            payload: { reason: error.reason, note: error.detail.holder, on: 'resume' },
          });
        }
        throw error;
      }
    }
    record.snapshot.attemptId = attemptId;
    record.snapshot.state = 'starting';
    this.save(record.snapshot);

    const emit = (name: string, payload?: Record<string, unknown>) =>
      this.forensics.emit({
        activationId, attemptId, participantId: record.snapshot.participantId,
        specialist: record.snapshot.specialist, beadId: record.snapshot.beadId, name, payload,
      });
    // A resumed attempt carried no payload, so an override could not be shown to survive a
    // resume from observability.db — only from memory, which is not evidence.
    emit('activation_resumed', {
      requested_model: record.snapshot.requestedModel,
      resolved_model: record.snapshot.resolvedModel,
      model_override: record.snapshot.modelOverride,
      thinking_level: record.snapshot.thinkingLevel ?? null,
      thinking_override: record.snapshot.thinkingOverride,
    });

    record.unsubscribe();
    record.unsubscribe = record.session.subscribe((event) => this.onSessionEvent(record.snapshot, event, emit));

    const result = this.runToSettled(record.snapshot, record.session, prompt, emit);
    record.result = result;

    return {
      activationId, participantId: record.snapshot.participantId, attemptId,
      specialist: record.snapshot.specialist, beadId: record.snapshot.beadId,
      access: record.snapshot.access, workspace: record.snapshot.workspace,
      resolvedModel: record.snapshot.resolvedModel,
      stepContract: record.stepContract,
      result,
    };
  }
}

/** Structural view of a pi assistant message. */
interface AssistantMessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/** The last assistant message in a Pi message list, or undefined. */
function lastAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as AssistantMessageLike | undefined;
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

/** Concatenated text content of an assistant message, defensively. */
function textOf(message: AssistantMessageLike | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } =>
      typeof part === 'object' && part !== null &&
      (part as { type?: string }).type === 'text' &&
      typeof (part as { text?: string }).text === 'string')
    .map(part => part.text)
    .join('');
}
