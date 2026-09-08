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
import { validateBeforeRun } from '../specialist/runner.js';
import { resolveRuntimeToolContract } from '../pi/session.js';
import { resolveModelChain } from '../specialist/model-chain.js';
import { BeadsClient } from '../specialist/beads.js';
import { evaluateBeadReadiness, type BeadGateOptions } from './bead-gate.js';
import { compileStepContract, type StepContract } from './step-contract.js';
import { InteractionTransport, type InteractionMessage, type PendingAsk } from './interaction.js';
import { createPeerDelivery } from './peer-bridge.js';
import { PeerAdapter, type TransportForensicEvent } from './transport/peer-adapter.js';
import { acquire as acquireLease, admitToolCall, release as releaseLease } from './workspace-lease.js';
import { createGuardedTools } from './guarded-tools.js';
import { createAskTools, ASK_TOOL, ESCALATE_TOOL } from './ask-tool.js';
import { loadPiSdk, type PiSdk, type PiAgentSessionLike, type PiAgentSessionEvent } from './pi-sdk.js';
import { createGateModelRuntime, validateModelAvailable } from './model-gate.js';
import { FleetRegistry, RESUMABLE_STATES, nextAttemptId } from './registry.js';
import {
  DispatchRejectedError,
  type ActivationHandle,
  type ActivationRequest,
  type ActivationResult,
  type ActivationSnapshot,
  type ActivationState,
  type WorkspaceAccess,
  type WorkspaceIdentity,
} from './types.js';

/** Permission tiers that can mutate the workspace. Derived from the resolved grant. */
const WRITE_TIERS = new Set(['MEDIUM', 'HIGH']);

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

  private readonly registry = new FleetRegistry();

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

    // Ruling (a), bead unitAI-rrdnt.35: the native runtime never falls back. Only the head
    // of the configured chain is a candidate, and discarding the tail is deliberate — a
    // Specialist that quietly ran on a fallback produces results nobody can attribute, and
    // substituting a configured primary would contradict acceptance D refusing an
    // unavailable override rather than replacing it. Honouring a chain later needs its own
    // forensics and its own acceptance, not a silent widening of acceptance B.
    const configuredModel = resolveModelChain(execution)[0];
    const requestedModel = request.modelOverride ?? configuredModel;
    if (!requestedModel) return reject('no_model_configured');

    // An explicit override that is unavailable must fail here rather than silently
    // running on something else. Both halves of the gate are required — see model-gate.ts.
    const modelRuntime = await createGateModelRuntime(sdk);
    const modelCheck = await validateModelAvailable(sdk, modelRuntime, requestedModel);
    if (!modelCheck.ok) {
      return reject('model_unavailable', {
        requestedModel,
        note: modelCheck.reason,
      });
    }
    const resolvedModel = modelCheck.resolvedModel ?? requestedModel;
    if (!modelCheck.model) return reject('model_unresolved', { requestedModel });

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
      workspace: workspace.worktreePath,
      tools: toolContract.toolsList.join(','),
      custom_tools: `${ASK_TOOL},${ESCALATE_TOOL}`,
    });

    const rendered = renderTaskPrompt({
      specialist: specialist.specialist,
      cwd: this.cwd,
      beadId: request.beadId,
      bead,
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
        emit(kind === 'escalation' ? 'escalation_raised' : 'clarification_requested', { body });
      },
      onAnswered: (kind) => {
        const record = this.registry.get(activationId);
        if (record) record.snapshot.state = 'running';
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

    const { session } = await sdk.createAgentSession({
      customTools: [...askTools, ...guardedTools.tools],
      cwd: workspace.worktreePath,
      // The pi SDK takes a Model object here. Passing the provider-qualified string
      // instead is accepted silently and then fails mid-turn with an unresolved provider.
      model: modelCheck.model,
      ...(execution.thinking_level ? { thinkingLevel: execution.thinking_level } : {}),
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
    });

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
      startedAt,
      lastActivityAt: startedAt,
    };

    emit('activation_started', { pi_session_id: session.sessionId });

    const unsubscribe = session.subscribe((event) => this.onSessionEvent(snapshot, event, emit));

    const result = this.runToSettled(snapshot, session, rendered.initial_prompt, emit);

    this.registry.register({ snapshot, session, unsubscribe, result, stepContract });

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
        emit('turn_started');
        break;
      case 'agent_end':
        emit('turn_completed', { will_retry: Boolean(event.willRetry) });
        break;
      case 'agent_settled':
        snapshot.state = 'settled';
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
      emit('activation_completed', { pi_session_id: session.sessionId });
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
        fallbackUsed: false,
        completedAt: this.now(),
      };
    } catch (error) {
      snapshot.state = 'failed';
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
        fallbackUsed: false,
        completedAt: this.now(),
      };
    }
    // Deliberately no dispose(): a settled Specialist remains alive and resumable.
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
