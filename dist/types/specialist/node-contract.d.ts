import * as z from 'zod';
export declare const BARRIER_TYPES: readonly ["all_members_terminal"];
export declare const NODE_COMPLETION_STRATEGIES: readonly ["pr", "manual"];
export declare const NODE_BASE_BRANCH_DEFAULT = "master";
export declare const NODE_SUPERVISOR_MAX_RETRIES_DEFAULT = 3;
export declare const phaseKindSchema: z.ZodEnum<["explore", "design", "impl", "review", "fix", "re_review", "custom"]>;
export declare const PHASE_KINDS: z.Values<["explore", "design", "impl", "review", "fix", "re_review", "custom"]>;
export declare const actionTypeSchema: z.ZodEnum<["spawn_member", "create_bead", "complete_node"]>;
export declare const ACTION_TYPES: {
    readonly SPAWN_MEMBER: "spawn_member";
    readonly CREATE_BEAD: "create_bead";
    readonly COMPLETE_NODE: "complete_node";
};
export declare const completionStrategySchema: z.ZodEnum<["pr", "manual"]>;
export declare const memberSpawnSchema: z.ZodObject<{
    member_key: z.ZodString;
    role: z.ZodString;
    bead_id: z.ZodString;
    scope: z.ZodObject<{
        paths: z.ZodArray<z.ZodString, "many">;
        mutates: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        paths: string[];
        mutates: boolean;
    }, {
        paths: string[];
        mutates: boolean;
    }>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    failure_policy: z.ZodEnum<["blocking", "non_blocking"]>;
    isolated: z.ZodDefault<z.ZodBoolean>;
    retry_of: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    scope: {
        paths: string[];
        mutates: boolean;
    };
    bead_id: string;
    role: string;
    member_key: string;
    depends_on: string[];
    failure_policy: "blocking" | "non_blocking";
    isolated: boolean;
    retry_of: string | null;
}, {
    scope: {
        paths: string[];
        mutates: boolean;
    };
    bead_id: string;
    role: string;
    member_key: string;
    failure_policy: "blocking" | "non_blocking";
    depends_on?: string[] | undefined;
    isolated?: boolean | undefined;
    retry_of?: string | null | undefined;
}>;
export declare const phaseSchema: z.ZodObject<{
    phase_id: z.ZodString;
    phase_kind: z.ZodEnum<["explore", "design", "impl", "review", "fix", "re_review", "custom"]>;
    barrier: z.ZodLiteral<"all_members_terminal">;
    members: z.ZodDefault<z.ZodArray<z.ZodObject<{
        member_key: z.ZodString;
        role: z.ZodString;
        bead_id: z.ZodString;
        scope: z.ZodObject<{
            paths: z.ZodArray<z.ZodString, "many">;
            mutates: z.ZodBoolean;
        }, "strip", z.ZodTypeAny, {
            paths: string[];
            mutates: boolean;
        }, {
            paths: string[];
            mutates: boolean;
        }>;
        depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        failure_policy: z.ZodEnum<["blocking", "non_blocking"]>;
        isolated: z.ZodDefault<z.ZodBoolean>;
        retry_of: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        scope: {
            paths: string[];
            mutates: boolean;
        };
        bead_id: string;
        role: string;
        member_key: string;
        depends_on: string[];
        failure_policy: "blocking" | "non_blocking";
        isolated: boolean;
        retry_of: string | null;
    }, {
        scope: {
            paths: string[];
            mutates: boolean;
        };
        bead_id: string;
        role: string;
        member_key: string;
        failure_policy: "blocking" | "non_blocking";
        depends_on?: string[] | undefined;
        isolated?: boolean | undefined;
        retry_of?: string | null | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    phase_id: string;
    phase_kind: "review" | "custom" | "impl" | "design" | "explore" | "fix" | "re_review";
    barrier: "all_members_terminal";
    members: {
        scope: {
            paths: string[];
            mutates: boolean;
        };
        bead_id: string;
        role: string;
        member_key: string;
        depends_on: string[];
        failure_policy: "blocking" | "non_blocking";
        isolated: boolean;
        retry_of: string | null;
    }[];
}, {
    phase_id: string;
    phase_kind: "review" | "custom" | "impl" | "design" | "explore" | "fix" | "re_review";
    barrier: "all_members_terminal";
    members?: {
        scope: {
            paths: string[];
            mutates: boolean;
        };
        bead_id: string;
        role: string;
        member_key: string;
        failure_policy: "blocking" | "non_blocking";
        depends_on?: string[] | undefined;
        isolated?: boolean | undefined;
        retry_of?: string | null | undefined;
    }[] | undefined;
}>;
export declare const createBeadActionSchema: z.ZodObject<{
    type: z.ZodEnum<["create_bead"]>;
    title: z.ZodString;
    description: z.ZodString;
    bead_type: z.ZodEnum<["task", "bug", "feature", "epic", "chore", "decision"]>;
    priority: z.ZodNumber;
    parent_bead_id: z.ZodOptional<z.ZodString>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    priority: number;
    description: string;
    type: "create_bead";
    title: string;
    depends_on: string[];
    bead_type: "task" | "decision" | "epic" | "bug" | "feature" | "chore";
    parent_bead_id?: string | undefined;
}, {
    priority: number;
    description: string;
    type: "create_bead";
    title: string;
    bead_type: "task" | "decision" | "epic" | "bug" | "feature" | "chore";
    depends_on?: string[] | undefined;
    parent_bead_id?: string | undefined;
}>;
export declare const completeNodeActionSchema: z.ZodObject<{
    type: z.ZodEnum<["complete_node"]>;
    gate_results: z.ZodDefault<z.ZodArray<z.ZodObject<{
        gate: z.ZodString;
        status: z.ZodEnum<["pass", "fail", "skip"]>;
        details: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }, {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }>, "many">>;
    report_payload_ref: z.ZodString;
    force_draft_pr: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    type: "complete_node";
    gate_results: {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }[];
    report_payload_ref: string;
    force_draft_pr?: boolean | undefined;
}, {
    type: "complete_node";
    report_payload_ref: string;
    gate_results?: {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }[] | undefined;
    force_draft_pr?: boolean | undefined;
}>;
export declare const coordinatorActionSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodEnum<["create_bead"]>;
    title: z.ZodString;
    description: z.ZodString;
    bead_type: z.ZodEnum<["task", "bug", "feature", "epic", "chore", "decision"]>;
    priority: z.ZodNumber;
    parent_bead_id: z.ZodOptional<z.ZodString>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    priority: number;
    description: string;
    type: "create_bead";
    title: string;
    depends_on: string[];
    bead_type: "task" | "decision" | "epic" | "bug" | "feature" | "chore";
    parent_bead_id?: string | undefined;
}, {
    priority: number;
    description: string;
    type: "create_bead";
    title: string;
    bead_type: "task" | "decision" | "epic" | "bug" | "feature" | "chore";
    depends_on?: string[] | undefined;
    parent_bead_id?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodEnum<["complete_node"]>;
    gate_results: z.ZodDefault<z.ZodArray<z.ZodObject<{
        gate: z.ZodString;
        status: z.ZodEnum<["pass", "fail", "skip"]>;
        details: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }, {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }>, "many">>;
    report_payload_ref: z.ZodString;
    force_draft_pr: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    type: "complete_node";
    gate_results: {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }[];
    report_payload_ref: string;
    force_draft_pr?: boolean | undefined;
}, {
    type: "complete_node";
    report_payload_ref: string;
    gate_results?: {
        status: "pass" | "fail" | "skip";
        gate: string;
        details?: string | undefined;
    }[] | undefined;
    force_draft_pr?: boolean | undefined;
}>]>;
export declare const coordinatorMemoryPatchEntrySchema: z.ZodObject<{
    entry_type: z.ZodEnum<["fact", "question", "decision"]>;
    entry_id: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    source_member_id: z.ZodString;
    confidence: z.ZodNumber;
    provenance: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    summary: string;
    entry_type: "fact" | "question" | "decision";
    source_member_id: string;
    confidence: number;
    entry_id?: string | undefined;
    provenance?: Record<string, unknown> | undefined;
}, {
    summary: string;
    entry_type: "fact" | "question" | "decision";
    source_member_id: string;
    confidence: number;
    entry_id?: string | undefined;
    provenance?: Record<string, unknown> | undefined;
}>;
export interface CoordinatorOutputContract {
    summary: string;
    node_status: 'in_progress' | 'complete' | 'blocked' | 'aborted';
    phases: z.infer<typeof phaseSchema>[];
    memory_patch: z.infer<typeof coordinatorMemoryPatchEntrySchema>[];
    actions: z.infer<typeof coordinatorActionSchema>[];
    validation: {
        ok?: boolean;
        issues?: string[];
        notes?: string;
        [key: string]: unknown;
    };
}
export type CoordinatorAction = z.infer<typeof coordinatorActionSchema>;
export type MemberSpawn = z.infer<typeof memberSpawnSchema>;
export type NodeCompletionStrategy = z.infer<typeof completionStrategySchema>;
export declare const NODE_STATES: readonly ["created", "starting", "running", "waiting", "degraded", "awaiting_merge", "fixing_after_review", "failed", "error", "done", "stopped"];
export type NodeState = (typeof NODE_STATES)[number];
export declare const VALID_STATE_TRANSITIONS: Record<NodeState, NodeState[]>;
export interface FirstTurnContext {
    nodeId: string;
    nodeName: string;
    sourceBeadId: string | null;
    beadGoal: string;
    memberRegistry: Array<{
        memberId: string;
        specialist: string;
        role: string | null;
        generation: number;
        status: string;
        enabled: boolean;
        member_key?: string;
        retry_of?: string | null;
        worktree?: string | null;
    }>;
    availableSpecialists: string[];
    qualityGates: string[];
    nodeConfigSnapshot: Record<string, unknown>;
    completionStrategy: NodeCompletionStrategy;
    maxRetries: number;
    baseBranch: string;
    coordinatorGoal: string;
}
export interface ResumePayloadContext {
    nodeId: string;
    stateMachine: {
        state: string;
        allowed_next: string[];
    };
    memberUpdates: unknown[];
    registrySnapshot: unknown[];
    memoryPatchSummary: unknown[];
    unresolvedDecisions: unknown[];
    actionLedgerSummary: unknown[];
    stateDigest: Record<string, unknown>;
}
export declare function renderForSystemPrompt(): string;
export declare function renderForFirstTurnContext(ctx: FirstTurnContext): string;
export declare function renderForResumePayload(update: ResumePayloadContext): string;
export declare function renderForDocs(): string;
//# sourceMappingURL=node-contract.d.ts.map