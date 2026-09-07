/**
 * NativeActivationHost — hosts a real Specialist on an in-process Pi `AgentSession`.
 *
 * This is the shared runtime seam. The Pi extension and the Claude Code MCP server are
 * both frontends over this class; neither invokes the legacy `sp run` CLI, and a future
 * Chain scheduler can call `start()` with a synthetic request because nothing here depends
 * on TUI state.
 *
 * WHAT THIS IS NOT, in Phase 1:
 *   - no writer support. Only read-only Specialists are admitted; the workspace writer
 *     lease does not exist yet, and admitting a writer before it does would allow two
 *     concurrent mutators in one worktree.
 *   - no interaction protocol, no Fleet, no model picker.
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
   */
  private readonly interactions = new InteractionTransport();

  constructor(deps: NativeActivationHostDeps = {}) {
    this.cwd = deps.cwd ?? process.cwd();
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
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    if (!specialist) return reject('unknown_specialist');

    const execution = specialist.specialist.execution;
    const tier = execution.permission_required ?? 'READ_ONLY';

    // Phase 1 admits readers only. The lease that makes a single writer safe does not
    // exist yet, so a write-capable child would race the coordinator with nothing to stop
    // it. This refusal is removed in Phase 10, not before.
    const access: WorkspaceAccess = WRITE_TIERS.has(tier) ? 'write' : 'read';
    if (access === 'write') {
      return reject('writer_not_supported_in_phase_1', { tier });
    }

    const bead = this.beadsClient.readBead(request.beadId);
    if (!bead) return reject('bead_unreadable');

    // `--bead` is the prompt. A Bead that is not a usable task contract is refused here,
    // before a model turn is spent guessing at the scope it does not carry.
    const readiness = evaluateBeadReadiness(bead, this.beadGate);
    if (!readiness.ok) {
      return reject('bead_contract_incomplete', {
        detail: readiness.reason,
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
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const sdk = await this.loadSdk();

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
        detail: modelCheck.reason,
      });
    }
    const resolvedModel = modelCheck.resolvedModel ?? requestedModel;
    if (!modelCheck.model) return reject('model_unresolved', { requestedModel });

    const workspace: WorkspaceIdentity = request.workspaceHint ?? {
      repositoryRoot: this.cwd,
      worktreePath: this.cwd,
    };

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

    const { session } = await sdk.createAgentSession({
      customTools: askTools,
      cwd: workspace.worktreePath,
      // The pi SDK takes a Model object here. Passing the provider-qualified string
      // instead is accepted silently and then fails mid-turn with an unresolved provider.
      model: modelCheck.model,
      ...(execution.thinking_level ? { thinkingLevel: execution.thinking_level } : {}),
      // Fail-closed: only the resolved contract's tools, never pi's defaults. `noTools`
      // must be "builtin" rather than `tools: []`, which would also empty customTools.
      noTools: 'builtin',
      tools: [...toolContract.toolsList],
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

  /** Every outstanding ask across the Fleet, oldest first. */
  pendingAsks(): PendingAsk[] {
    return this.interactions.pendingAsks();
  }

  /** Current state of one activation, or undefined if unknown to this host. */
  inspect(activationId: string): ActivationSnapshot | undefined {
    return this.registry.projection(activationId);
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
    record.snapshot.attemptId = attemptId;
    record.snapshot.state = 'starting';

    const emit = (name: string, payload?: Record<string, unknown>) =>
      this.forensics.emit({
        activationId, attemptId, participantId: record.snapshot.participantId,
        specialist: record.snapshot.specialist, beadId: record.snapshot.beadId, name, payload,
      });
    emit('activation_resumed');

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
