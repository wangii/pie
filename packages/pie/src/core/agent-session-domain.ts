import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { CustomEntry, SessionEntry } from "./session-manager.ts";

/**
 * Domain protocol version.
 *
 * Each bump so far has been deliberately breaking, and stored events from an older version are
 * rejected outright rather than aliased or migrated: a log that cannot be read faithfully must
 * fail explicitly instead of replaying into a history with missing or misread records.
 *
 * - **v2** renamed the execution-round vocabulary from `TaskFrame`/`frameId` to
 *   `ExecutionEpisode`/`episodeId`, because the old name made an execution round look like a
 *   frame of reference.
 * - **v3** added the task-level problem formulation: immutable versions, deferrals, and user
 *   corrections. A `Plan` now names the formulation version its experiment was chosen under
 *   (`FormulationAdoption`), so a v2 plan carries no such record and cannot be distinguished
 *   from one whose version was never formed.
 * - **v4** added the experiment selection as a durable record (`ExperimentSelected` /
 *   `ExperimentSelectionVoided`). A v3 episode only ever held the selection in memory, so
 *   replaying one cannot tell "nothing was selected" from "a selection was never written down",
 *   and a v3 log would silently lose the choice→void→re-choice sequence.
 */
export const AGENT_SESSION_DOMAIN_SCHEMA_VERSION = 4 as const;
export const AGENT_SESSION_DOMAIN_CUSTOM_ENTRY = "pie.agent-session-domain-event";

export type SessionId = string;
export type TaskId = string;
export type PromptId = string;
export type TargetId = string;
export type EpisodeId = string;
export type RoutingId = string;
export type BeliefId = string;
export type BeliefDeltaId = string;
export type PlanId = string;
export type ExecutionId = string;
export type DistillationId = string;
export type InterventionId = string;
export type FormulationVersionId = string;
export type FormulationCorrectionId = string;
export type DomainEventId = string;

export type DomainIdKind =
	| "task"
	| "prompt"
	| "target"
	| "episode"
	| "routing"
	| "belief"
	| "belief-delta"
	| "plan"
	| "execution"
	| "distillation"
	| "intervention"
	| "formulation"
	| "formulation-correction"
	| "event";

export function createDomainId(kind: DomainIdKind): string {
	return `${kind}-${randomUUID()}`;
}

export type DomainContent = string | readonly JsonValue[];
export type TaskStatus = "active" | "completed" | "cancelled" | "failed";
export type EpisodeStatus = "active" | "closed";
export type EpisodeStage = "routing" | "proposing" | "executing" | "distilling" | "closed";
export type EpisodeBodyKind = "belief-loop" | "fast-path";
export type BeliefDomain = "product" | "code";
export type BeliefStatus = "proposed" | "supported" | "refuted" | "inconclusive" | "superseded";
export type BeliefOperation = "propose" | "support" | "refute" | "refine" | "inconclusive" | "retract";
export type BeliefDeltaProducerPhase = "propose" | "distill";
export type RoutingDecision = "belief-loop" | "fast-path";
export type RoutingDifficulty = "low" | "medium" | "high";
export type ExecutionStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface InitialPrompt {
	readonly id: PromptId;
	readonly original: DomainContent;
	readonly effective: DomainContent;
}

export interface Target {
	readonly id: TargetId;
	readonly statement: string;
}

/**
 * What the task actually delivered, the evidence that it was delivered, and any remaining
 * blocker. A task outcome, not a world belief: epistemic sufficiency ("the beliefs are settled")
 * and task completion ("the user's request was delivered and verified") are separate judgments,
 * so this lives on the Task rather than in the Belief registry. Kept field-for-field identical to
 * the runtime's `TaskOutcome` so one record has one spelling everywhere.
 */
export interface TaskOutcome {
	readonly result: string;
	readonly evidence: string;
	readonly blockers?: string;
}

export interface SupportEvidence {
	readonly evidence: string;
}

export interface RefutationEvidence {
	readonly evidence: string;
}

export interface Belief {
	readonly id: BeliefId;
	readonly statement: string;
	readonly domain: BeliefDomain;
	readonly expectation: string;
	readonly evidenceRounds: number;
	readonly skillRefs: readonly string[];
	readonly supportedBy: readonly SupportEvidence[];
	readonly refutedBy: readonly RefutationEvidence[];
	readonly inconclusiveBy?: readonly RefutationEvidence[];
	readonly supersededBy?: BeliefId;
	readonly withdrawn: boolean;
}

export function statusOfDomainBelief(belief: Belief): BeliefStatus {
	if (belief.supersededBy !== undefined || belief.withdrawn) return "superseded";
	if (belief.refutedBy.length > 0) return "refuted";
	if (belief.supportedBy.length > 0) return "supported";
	if ((belief.inconclusiveBy?.length ?? 0) > 0) return "inconclusive";
	return "proposed";
}

export interface Routing {
	readonly id: RoutingId;
	readonly statement: string;
	readonly decision: RoutingDecision;
	readonly suitabilityProbability: number;
	readonly successProbability: number;
	readonly estimatedSteps: number;
	readonly difficulty: RoutingDifficulty;
	readonly reason: string;
}

// ============================================================================
// Problem formulation (the product-facing name is "Frame")
// ============================================================================

/**
 * How the agent currently understands the task, in its own provisional first person. This is
 * not a belief: it carries no evidence verdict and no truth status, and it never substitutes
 * for one. Where a belief answers "what do I claim about the world", this answers "what do I
 * currently take the task to be".
 *
 * `interpretation`, `focus`, and `implication` are required — a version that cannot say what it
 * understands, what it is attending to, and what that changes would be a label rather than a
 * working understanding. `alternative` and `tension` are optional and deliberately so: an
 * agent with no meaningful rival reading and no articulated tension must be able to publish a
 * real version rather than invent one to fill the field.
 */
export interface FormulationContent {
	/** How I currently understand this task. */
	readonly interpretation: string;
	/** A reading I am not currently prioritizing. Not a refuted conclusion, not necessarily v(n-1). */
	readonly alternative?: string;
	/** Which objects, relations, or scales I am attending to under this reading. */
	readonly focus: string;
	/** The conflict, gap, or phenomenon I am trying to explain. Absent means "not yet clear". */
	readonly tension?: string;
	/** What this reading would change about where the investigation or intervention goes. */
	readonly implication: string;
}

/**
 * A stable reference to what a formulation was formed from. Every kind resolves to a record
 * that is already durable, so a version can be audited later without re-running anything.
 *
 * A belief is always cited together with the delta that recorded its state at the time: a
 * belief is mutable, and citing it by id alone would read today's state back into a past
 * decision. Citing an existing record is also a legitimate source on its own — reinterpreting
 * old evidence is a real reason to reframe, and does not require a fresh tool call.
 */
export type FormulationSource =
	| { readonly kind: "prompt"; readonly promptId: PromptId }
	| { readonly kind: "intervention"; readonly interventionId: InterventionId }
	| { readonly kind: "correction"; readonly correctionId: FormulationCorrectionId }
	| { readonly kind: "execution"; readonly executionId: ExecutionId }
	| { readonly kind: "distillation"; readonly distillationId: DistillationId }
	| { readonly kind: "belief"; readonly beliefId: BeliefId; readonly beliefDeltaId: BeliefDeltaId };

/** Only propose publishes a formulation; the field is recorded so the log says so itself. */
export type FormulationOrigin = "propose";

/**
 * One immutable revision of the task's problem understanding. Versions are append-only: a
 * revision is a new version pointing back at its predecessor, never an edit of one. Whether a
 * change is substantive is propose's judgment — the runtime only refuses to record a version
 * whose content is byte-identical to the current one, and does not run a model to decide.
 */
export interface ProblemFormulationVersion {
	readonly id: FormulationVersionId;
	readonly taskId: TaskId;
	readonly ordinal: number;
	/** The version this one revises; absent only for the first version of a task. */
	readonly previousVersionId?: FormulationVersionId;
	readonly recordedAt: string;
	readonly origin: FormulationOrigin;
	readonly content: FormulationContent;
	/** Short reason this version was formed or revised. */
	readonly reason: string;
	readonly sources: readonly FormulationSource[];
}

/**
 * Recorded when propose has investigated but cannot yet state a problem understanding. This is
 * a state in its own right — "not investigated" and "investigated and deferred" are different —
 * and it is never a blank version: it records what is missing and why, and it does not erase a
 * version that already exists.
 */
export interface FormulationDeferral {
	readonly missingInformation: string;
	readonly reason: string;
	readonly sources: readonly FormulationSource[];
	readonly deferredAt: string;
	/**
	 * The highest episode ordinal whose evidence had been gathered when this deferral was made.
	 *
	 * The fold derives it from the task rather than reading it off the event, so it cannot be
	 * asserted wrong: it records the point in the investigation this deferral actually answered.
	 * That is what lets later evidence re-open the decision instead of the deferral standing
	 * forever as an exemption.
	 */
	readonly answeredThroughEpisodeOrdinal: number;
}

/**
 * A user's correction to the agent's current understanding. Corrections are kept as their own
 * record rather than written into the version they target, so the published version stays the
 * agent's own stated position and the correction, with propose's response, stays auditable
 * beside it.
 */
export interface FormulationCorrection {
	readonly id: FormulationCorrectionId;
	readonly taskId: TaskId;
	/** The version the user was looking at. Absent when no version had been formed yet. */
	readonly targetVersionId?: FormulationVersionId;
	readonly original: DomainContent;
	readonly receivedAt: string;
	readonly status: FormulationCorrectionStatus;
	/** Propose's response. Required once resolved, absent while pending. */
	readonly response?: string;
	/** The version published while answering this correction, when the response was a revision. */
	readonly recordedVersionId?: FormulationVersionId;
}

export type FormulationCorrectionStatus = "pending" | "resolved";

/**
 * The formulation version a decision was made under.
 *
 * `unformed` is a recorded fact — no version existed at that moment — not a missing field. It
 * is what keeps a first investigation honest: the version that a later round publishes cannot
 * be back-dated onto a selection that was made before it existed.
 */
export type FormulationAdoption =
	| { readonly kind: "version"; readonly versionId: FormulationVersionId }
	| { readonly kind: "unformed" };

/** The required fields a formulation must state, else it is not a usable understanding. */
export function formulationContentError(content: FormulationContent): string | undefined {
	const missing: string[] = [];
	if (!content.interpretation?.trim()) missing.push("interpretation");
	if (!content.focus?.trim()) missing.push("focus");
	if (!content.implication?.trim()) missing.push("implication");
	if (missing.length === 0) return undefined;
	return `formulation is missing required content: ${missing.join(", ")}`;
}

/**
 * The active task's problem-understanding state in one object: what the agent currently takes the
 * task to be, what it said was missing when it deferred, what corrections are still unanswered,
 * and whether the required decision is still outstanding.
 *
 * This is a view, not a stored record — every field is read off the replayed task, so a client
 * that reads it (a reconnecting RPC consumer, say) sees the same state the log holds rather than
 * a second copy that could drift. The full version history lives on the task itself.
 */
export interface FormulationState {
	/** The current version, or `null` before the first one. */
	readonly current: ProblemFormulationVersion | null;
	/** The recorded deferral while one is current, or `null`. */
	readonly deferral: FormulationDeferral | null;
	/** Corrections still awaiting propose's response, oldest first. */
	readonly pendingCorrections: readonly FormulationCorrection[];
	/** Whether propose still owes this task the publish-or-defer decision. */
	readonly decisionOwed: boolean;
}

export interface Plan {
	readonly id: PlanId;
	readonly selectedToExplore: readonly BeliefId[];
	readonly intent?: string;
	/** The formulation version this experiment was chosen under. */
	readonly formulation: FormulationAdoption;
}

/**
 * The experiment propose has chosen but not yet dispatched: which beliefs the next round probes,
 * the task decision the probe informs, and the understanding it was chosen under.
 *
 * It is a separate record from the `Plan` it becomes, because the two answer different questions.
 * The selection is a *choice* — it can be voided by a revision or a scope change before anything
 * runs, and that void is itself a fact worth replaying ("chose E1 under v1, v2 voided it, chose E2
 * under v2"). The plan is a *commitment*: it is written at dispatch, carries the outcome's
 * provenance, and is never revised.
 */
export interface ExperimentSelectionRecord {
	/** Which task decision, action, or conclusion this experiment's outcome could change. */
	readonly intent: string;
	/** The belief ids forming one coherent experiment. */
	readonly beliefIds: readonly BeliefId[];
	/** The formulation version this selection was made under; `unformed` before the first one. */
	readonly formulation: FormulationAdoption;
}

export interface Execution {
	readonly id: ExecutionId;
	readonly planId?: PlanId;
	readonly intention: string;
	readonly tool: string;
	readonly input: JsonValue;
	readonly output: DomainContent;
	readonly status: ExecutionStatus;
	readonly error?: string;
	readonly filePath?: string;
}

export interface Distillation {
	readonly id: DistillationId;
	readonly inputs: readonly ExecutionId[];
	readonly contents: string;
	readonly outputs: readonly BeliefDeltaId[];
}

export interface BeliefDelta {
	readonly id: BeliefDeltaId;
	readonly episodeId: EpisodeId;
	readonly distillationId?: DistillationId;
	/** Cognitive phase that produced this mutation; never inferred from event order. */
	readonly producerPhase: BeliefDeltaProducerPhase;
	readonly operation: BeliefOperation;
	/** Existing belief read or replaced by this mutation. */
	readonly sourceBeliefId?: BeliefId;
	/** Canonical belief written by this mutation. For refine, this is the new record. */
	readonly resultBeliefId: BeliefId;
	readonly beliefId?: BeliefId;
	readonly proposedRecord?: Belief;
	readonly evidence?: string;
	/** Complete immutable records changed by this operation, including both sides of a refinement. */
	readonly resultingBeliefs: readonly Belief[];
}

export interface Intervention {
	readonly id: InterventionId;
	readonly contents: DomainContent;
	readonly stage: EpisodeStage;
	readonly afterExecution?: ExecutionId;
	readonly createdAt: string;
}

export interface PendingEpisode {
	readonly kind: "pending";
}

export interface BeliefLoopEpisode {
	readonly kind: "belief-loop";
	readonly openBeliefsAtStart: readonly BeliefId[];
	readonly plan?: Plan;
	readonly trajectory: readonly Execution[];
	readonly distillation?: Distillation;
	readonly beliefDeltas: readonly BeliefDelta[];
}

export interface FastPathEpisode {
	readonly kind: "fast-path";
	readonly trajectory: readonly Execution[];
	readonly distillation?: Distillation;
	/**
	 * The formulation version this fast-path dispatch ran under. The fast path has no Plan to
	 * carry it, so the episode records it directly — and `unformed` is the honest record for a
	 * first investigation, rather than omitting the field and leaving a reader unable to tell
	 * "no version existed" from "the version was not recorded".
	 */
	readonly formulation: FormulationAdoption;
}

export type EpisodeBody = PendingEpisode | BeliefLoopEpisode | FastPathEpisode;

/**
 * One execution round: a routing decision, one experiment, and the evidence it produced.
 *
 * An episode is the unit the belief loop dispatches into — "what was tried, and what came back".
 * It is not the agent's problem formulation: `Stage`/`Status` here describe where a round is in
 * the loop, and `EpisodeStage`'s `proposing`/`distilling` name the roles that owned the round,
 * not an interpretation of the task. The problem formulation is a separate, task-level record.
 */
export interface ExecutionEpisode {
	readonly id: EpisodeId;
	readonly taskId: TaskId;
	readonly ordinal: number;
	readonly status: EpisodeStatus;
	readonly stage: EpisodeStage;
	readonly steering: readonly Intervention[];
	readonly routing?: Routing;
	/**
	 * The choice propose has made for this round and not yet dispatched. Cleared when a plan
	 * commits it, and by an explicit void when a revision or a scope change takes it back.
	 */
	readonly experimentSelection?: ExperimentSelectionRecord;
	readonly body: EpisodeBody;
}

export interface Task {
	readonly id: TaskId;
	readonly parentTaskId?: TaskId;
	readonly initialPrompt: InitialPrompt;
	readonly initialTarget?: Target;
	readonly status: TaskStatus;
	readonly inheritedBeliefs: readonly BeliefId[];
	readonly introducedBeliefs: readonly BeliefId[];
	readonly episodes: readonly ExecutionEpisode[];
	/**
	 * The belief ids this task declared it is acting on. Scope, not truth: membership never
	 * changes a belief's status, and the slice is never inherited from the parent task.
	 * `focusDeclared` separates "declared, and the slice is empty" from "not declared yet".
	 */
	readonly focus: readonly BeliefId[];
	readonly focusDeclared: boolean;
	readonly taskOutcome?: TaskOutcome;
	/**
	 * This task's problem-formulation history, oldest first. Append-only and never inherited:
	 * a new task starts with an empty history because its understanding of its own request is
	 * its own, even though the beliefs it reasons from carry over. A previous task's version is
	 * available as context, never as this task's current understanding.
	 */
	readonly formulations: readonly ProblemFormulationVersion[];
	/**
	 * Set while propose has deferred forming an understanding and has not published since. A
	 * deferral is cleared by a publication, never by another deferral's absence, and it never
	 * removes a version from `formulations` — a deferral after a version exists adds a state
	 * beside the current understanding rather than erasing it.
	 */
	readonly formulationDeferral?: FormulationDeferral;
	/** Corrections the user submitted against this task's understanding, oldest first. */
	readonly formulationCorrections: readonly FormulationCorrection[];
}

export interface AgentSessionCursor {
	readonly taskId: TaskId;
	readonly episodeId: EpisodeId;
	readonly stage: EpisodeStage;
}

export interface AgentSessionSnapshot {
	readonly id: SessionId;
	readonly activeBranchTasks: readonly TaskId[];
	readonly tasks: ReadonlyMap<TaskId, Task>;
	readonly beliefs: ReadonlyMap<BeliefId, Belief>;
	readonly activeBeliefs: readonly BeliefId[];
	readonly cursor?: AgentSessionCursor;
}

interface DomainEventBase {
	readonly type: string;
	readonly schemaVersion: typeof AGENT_SESSION_DOMAIN_SCHEMA_VERSION;
	readonly eventId: DomainEventId;
	readonly timestamp: string;
}

interface TaskEventBase extends DomainEventBase {
	readonly taskId: TaskId;
}

interface EpisodeEventBase extends TaskEventBase {
	readonly episodeId: EpisodeId;
}

export type AgentSessionDomainEvent =
	| (DomainEventBase & {
			type: "TaskOpened";
			taskId: TaskId;
			parentTaskId?: TaskId;
			initialPrompt: InitialPrompt;
			inheritedBeliefs: readonly BeliefId[];
	  })
	| (TaskEventBase & { type: "TaskClosed"; status: Exclude<TaskStatus, "active"> })
	| (TaskEventBase & { type: "TargetDefined"; target: Target })
	// Task scope, not episode content: the focus slice the task acts on, and the outcome it
	// delivered. The event's presence IS the declaration — `beliefIds: []` is "declared and
	// empty", distinct from a task that never declared a focus.
	| (TaskEventBase & { type: "FocusDeclared"; beliefIds: readonly BeliefId[] })
	| (TaskEventBase & { type: "TaskOutcomeRecorded"; outcome: TaskOutcome })
	// Task-level, not episode content: the agent's understanding of its own task is not a
	// property of any one execution round, so publication, deferral, and corrections hang off
	// the task and outlive the rounds they were formed in.
	| (TaskEventBase & { type: "ProblemFormulationRecorded"; version: ProblemFormulationVersion })
	| (TaskEventBase & {
			type: "ProblemFormulationDeferred";
			missingInformation: string;
			reason: string;
			sources: readonly FormulationSource[];
			deferredAt: string;
	  })
	| (TaskEventBase & { type: "FormulationCorrectionSubmitted"; correction: FormulationCorrection })
	| (TaskEventBase & {
			type: "FormulationCorrectionResolved";
			correctionId: FormulationCorrectionId;
			response: string;
			/** The version published while answering, when the response was a revision. */
			recordedVersionId?: FormulationVersionId;
	  })
	| (TaskEventBase & { type: "EpisodeOpened"; episodeId: EpisodeId; ordinal: number })
	| (EpisodeEventBase & { type: "RoutingDecided"; routing: Routing })
	| (EpisodeEventBase & {
			type: "EpisodeBodySelected";
			body: EpisodeBodyKind;
			openBeliefsAtStart?: readonly BeliefId[];
			/** Required when `body` is `fast-path`; ignored for a belief-loop episode, whose plan carries it. */
			formulation?: FormulationAdoption;
	  })
	| (EpisodeEventBase & { type: "EpisodeClosed" })
	| (EpisodeEventBase & { type: "CursorChanged"; stage: EpisodeStage })
	| (EpisodeEventBase & { type: "InterventionAdded"; intervention: Intervention })
	// The experiment choice, before anything runs. Recorded rather than kept in memory because a
	// resumed or branch-switched session has to come back with the same choice, and because
	// "chose, had it voided, chose again" is exactly the sequence a reader needs to audit.
	| (EpisodeEventBase & { type: "ExperimentSelected"; selection: ExperimentSelectionRecord })
	| (EpisodeEventBase & { type: "ExperimentSelectionVoided"; reason: string })
	| (EpisodeEventBase & { type: "BeliefDeltaApplied"; delta: BeliefDelta; activeBeliefs: readonly BeliefId[] })
	| (EpisodeEventBase & { type: "PlanProduced"; plan: Plan })
	| (EpisodeEventBase & { type: "ExecutionStarted"; execution: Omit<Execution, "output" | "status" | "error"> })
	| (EpisodeEventBase & {
			type: "ExecutionCompleted";
			executionId: ExecutionId;
			output: DomainContent;
			status: Exclude<ExecutionStatus, "running">;
			error?: string;
	  })
	| (EpisodeEventBase & { type: "DistillationProduced"; distillation: Distillation });

export interface StoredAgentSessionDomainEvent {
	readonly schemaVersion: typeof AGENT_SESSION_DOMAIN_SCHEMA_VERSION;
	readonly event: AgentSessionDomainEvent;
}

export class DomainReplayError extends Error {}

export function createAgentSessionSnapshot(id: SessionId): AgentSessionSnapshot {
	return {
		id,
		activeBranchTasks: [],
		tasks: new Map(),
		beliefs: new Map(),
		activeBeliefs: [],
	};
}

function fail(event: Pick<DomainEventBase, "type" | "eventId">, message: string): never {
	throw new DomainReplayError(`${event.type} (${event.eventId}): ${message}`);
}

function requireTask(snapshot: AgentSessionSnapshot, event: TaskEventBase): Task {
	const task = snapshot.tasks.get(event.taskId);
	if (!task) fail(event, `unknown task ${event.taskId}`);
	return task;
}

function requireEpisode(
	snapshot: AgentSessionSnapshot,
	event: EpisodeEventBase,
): { task: Task; episode: ExecutionEpisode } {
	const task = requireTask(snapshot, event);
	const episode = task.episodes.find((candidate) => candidate.id === event.episodeId);
	if (!episode) fail(event, `unknown episode ${event.episodeId}`);
	return { task, episode };
}

function replaceTask(snapshot: AgentSessionSnapshot, task: Task): ReadonlyMap<TaskId, Task> {
	const tasks = new Map(snapshot.tasks);
	tasks.set(task.id, task);
	return tasks;
}

function replaceEpisode(task: Task, episode: ExecutionEpisode): Task {
	return {
		...task,
		episodes: task.episodes.map((candidate) => (candidate.id === episode.id ? episode : candidate)),
	};
}

function requireActiveEpisode(
	snapshot: AgentSessionSnapshot,
	event: EpisodeEventBase,
): { task: Task; episode: ExecutionEpisode } {
	const result = requireEpisode(snapshot, event);
	if (result.task.status !== "active") fail(event, `task ${event.taskId} is ${result.task.status}`);
	if (result.episode.status !== "active") fail(event, `episode ${event.episodeId} is closed`);
	return result;
}

function requireClassifiedEpisode(
	snapshot: AgentSessionSnapshot,
	event: EpisodeEventBase,
): { task: Task; episode: ExecutionEpisode & { body: BeliefLoopEpisode | FastPathEpisode } } {
	const result = requireActiveEpisode(snapshot, event);
	if (result.episode.body.kind === "pending") fail(event, `episode ${event.episodeId} has no selected body`);
	return {
		task: result.task,
		episode: result.episode as ExecutionEpisode & { body: BeliefLoopEpisode | FastPathEpisode },
	};
}

function replaceExecution(
	body: BeliefLoopEpisode | FastPathEpisode,
	execution: Execution,
): BeliefLoopEpisode | FastPathEpisode {
	return {
		...body,
		trajectory: body.trajectory.map((candidate) => (candidate.id === execution.id ? execution : candidate)),
	};
}

/** This task's current understanding, or undefined before the first version. */
export function currentFormulation(task: Task): ProblemFormulationVersion | undefined {
	return task.formulations[task.formulations.length - 1];
}

/** Corrections still awaiting propose's response, oldest first. */
export function pendingFormulationCorrections(task: Task): readonly FormulationCorrection[] {
	return task.formulationCorrections.filter((correction) => correction.status === "pending");
}

/**
 * The highest-numbered episode that had an experiment dispatched in it, or undefined if none has.
 *
 * "Dispatched" is read off the durable records rather than tracked in memory: a belief-loop
 * episode records it in its `Plan`, and a fast-path episode has no plan, so its body selection is
 * the record. That covers both round shapes and, importantly, covers the moment *during* a round —
 * a distill turn that concludes still sees the dispatch that produced its evidence, so the
 * terminal path cannot slip past the decision just because the episode has not closed yet.
 *
 * Routing alone does not count. Selecting a body and then waiting to choose an experiment is not
 * an investigation, and demanding a reading for it would force one before anything was learned.
 */
export function latestDispatchedEpisodeOrdinal(task: Task): number | undefined {
	let latest: number | undefined;
	for (const episode of task.episodes) {
		const dispatched =
			episode.body.kind === "fast-path" || (episode.body.kind === "belief-loop" && episode.body.plan !== undefined);
		if (dispatched) latest = episode.ordinal;
	}
	return latest;
}

/** The most recent delta on this task that recorded this belief's state, if any. */
export function latestBeliefDeltaFor(task: Task, beliefId: BeliefId): BeliefDelta | undefined {
	const deltas = task.episodes.flatMap((episode) =>
		episode.body.kind === "belief-loop" ? episode.body.beliefDeltas : [],
	);
	for (let index = deltas.length - 1; index >= 0; index--) {
		const delta = deltas[index]!;
		const carries =
			delta.resultBeliefId === beliefId ||
			delta.sourceBeliefId === beliefId ||
			delta.resultingBeliefs.some((belief) => belief.id === beliefId);
		if (carries) return delta;
	}
	return undefined;
}

/**
 * Whether propose owes a formulation decision — either publishing a version or recording a
 * deferral.
 *
 * This is the runtime half of "investigate first, then say what you take the task to be": once an
 * experiment has been dispatched, the task may not slide on without the agent ever stating what it
 * made of it. It is deliberately narrow, because it is a gate on the loop:
 *
 * - Nothing is owed before the first dispatch: choosing a preliminary probe before having a
 *   reading is legitimate, and gating it would force an uninformed formulation.
 * - A published version settles it for good. Later revisions are propose's judgment on substance,
 *   so accumulating evidence never nags a task into manufacturing a revision.
 * - A deferral settles it only for the investigation it answered. A later dispatch re-opens the
 *   question, which is what stops the first deferral from becoming a standing exemption.
 */
export function formulationDecisionOwed(task: Task): boolean {
	const investigated = latestDispatchedEpisodeOrdinal(task);
	if (investigated === undefined) return false;
	if (currentFormulation(task)) return false;
	const deferral = task.formulationDeferral;
	return deferral === undefined || deferral.answeredThroughEpisodeOrdinal < investigated;
}

/**
 * Resolve one formulation source to a record that already exists on this task.
 *
 * The point is auditability: a version must be traceable to the evidence it was formed from, and
 * a citation that names nothing is worse than no citation because it reads as provenance. A
 * belief is cited through a delta rather than an id alone, so replaying a version later shows the
 * belief's state at the time instead of its latest one.
 */
export function formulationSourceError(task: Task, source: FormulationSource): string | undefined {
	const episodes = task.episodes;
	switch (source.kind) {
		case "prompt":
			return task.initialPrompt.id === source.promptId ? undefined : `unknown prompt ${source.promptId}`;
		case "intervention":
			return episodes.some((episode) => episode.steering.some((item) => item.id === source.interventionId))
				? undefined
				: `unknown intervention ${source.interventionId}`;
		case "correction":
			return task.formulationCorrections.some((correction) => correction.id === source.correctionId)
				? undefined
				: `unknown correction ${source.correctionId}`;
		case "execution":
			return episodes.some(
				(episode) =>
					episode.body.kind !== "pending" &&
					episode.body.trajectory.some((execution) => execution.id === source.executionId),
			)
				? undefined
				: `unknown execution ${source.executionId}`;
		case "distillation":
			return episodes.some(
				(episode) => episode.body.kind !== "pending" && episode.body.distillation?.id === source.distillationId,
			)
				? undefined
				: `unknown distillation ${source.distillationId}`;
		case "belief": {
			const delta = episodes
				.flatMap((episode) => (episode.body.kind === "belief-loop" ? episode.body.beliefDeltas : []))
				.find((candidate) => candidate.id === source.beliefDeltaId);
			if (!delta) return `unknown belief delta ${source.beliefDeltaId}`;
			// The delta must actually carry the cited belief. Without this, a version could cite a
			// delta that says nothing about the belief it claims as its basis.
			const cites =
				delta.resultBeliefId === source.beliefId ||
				delta.sourceBeliefId === source.beliefId ||
				delta.resultingBeliefs.some((belief) => belief.id === source.beliefId);
			return cites ? undefined : `belief delta ${delta.id} does not carry belief ${source.beliefId}`;
		}
		default:
			return `unknown formulation source ${JSON.stringify(source)}`;
	}
}

function requireFormulationSources(
	task: Task,
	event: AgentSessionDomainEvent,
	sources: readonly FormulationSource[],
): void {
	for (const source of sources) {
		const error = formulationSourceError(task, source);
		if (error) fail(event, error);
	}
}

function formulationContentFailure(event: AgentSessionDomainEvent, content: FormulationContent): void {
	const error = formulationContentError(content);
	if (error) fail(event, error);
	// An optional field that is present must say something: a blank `alternative` or `tension`
	// is a filled-in field masquerading as content, and the whole point of leaving them optional
	// is that an agent with nothing to say leaves them out.
	if (content.alternative !== undefined && !content.alternative.trim()) {
		fail(event, "formulation alternative is present but empty");
	}
	if (content.tension !== undefined && !content.tension.trim()) {
		fail(event, "formulation tension is present but empty");
	}
}

function requireAdoption(event: AgentSessionDomainEvent, task: Task, adoption: FormulationAdoption): void {
	if (adoption.kind === "version") {
		if (!task.formulations.some((version) => version.id === adoption.versionId)) {
			fail(event, `unknown formulation version ${adoption.versionId}`);
		}
		return;
	}
	// `unformed` is a recorded fact about the moment of the decision, so it cannot be claimed
	// once a version exists: a selection made after a publication is under that publication, and
	// marking it "unformed" would let a later version escape being the basis of a decision it
	// actually governed.
	if (task.formulations.length > 0) {
		const current = currentFormulation(task);
		fail(event, `formulation is ${current?.id} but this record claims no version was formed`);
	}
}

export function applyAgentSessionDomainEvent(
	snapshot: AgentSessionSnapshot,
	event: AgentSessionDomainEvent,
): AgentSessionSnapshot {
	if (event.schemaVersion !== AGENT_SESSION_DOMAIN_SCHEMA_VERSION) {
		fail(event, `unsupported schema version ${event.schemaVersion}`);
	}

	switch (event.type) {
		case "TaskOpened": {
			if (snapshot.tasks.has(event.taskId)) fail(event, `task ${event.taskId} already exists`);
			if (event.parentTaskId !== undefined && !snapshot.tasks.has(event.parentTaskId)) {
				fail(event, `unknown parent task ${event.parentTaskId}`);
			}
			for (const beliefId of event.inheritedBeliefs) {
				if (!snapshot.beliefs.has(beliefId)) fail(event, `unknown inherited belief ${beliefId}`);
			}
			const task: Task = {
				id: event.taskId,
				parentTaskId: event.parentTaskId,
				initialPrompt: event.initialPrompt,
				status: "active",
				inheritedBeliefs: [...event.inheritedBeliefs],
				introducedBeliefs: [],
				episodes: [],
				// A new task inherits beliefs, never scope: the parent's focus says nothing about
				// what this task is acting on, so it starts undeclared.
				focus: [],
				focusDeclared: false,
				// Understanding is not inherited either. The previous task's versions stay readable as
				// context, but this task's current understanding must be formed and owned by this task.
				formulations: [],
				formulationCorrections: [],
			};
			const tasks = new Map(snapshot.tasks);
			tasks.set(task.id, task);
			return {
				...snapshot,
				tasks,
				activeBranchTasks: [...snapshot.activeBranchTasks, task.id],
				activeBeliefs: [...event.inheritedBeliefs],
			};
		}
		case "TaskClosed": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is already ${task.status}`);
			if (!task.initialTarget) fail(event, `task ${task.id} has no target`);
			if (task.episodes.some((episode) => episode.status !== "closed"))
				fail(event, `task ${task.id} has an open episode`);
			return { ...snapshot, tasks: replaceTask(snapshot, { ...task, status: event.status }) };
		}
		case "TargetDefined": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			if (task.initialTarget) fail(event, `task ${task.id} target is immutable`);
			return { ...snapshot, tasks: replaceTask(snapshot, { ...task, initialTarget: event.target }) };
		}
		case "FocusDeclared": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			// Re-declaration replaces, matching FocusSet's replace semantics: a task may restate or
			// narrow its scope, and the last declaration wins. No belief-existence check: a focus id
			// can name a belief that has no BeliefDeltaApplied yet (see `onBeliefDelta`'s
			// no-current-episode early return), which is a legitimate in-flight state.
			return {
				...snapshot,
				tasks: replaceTask(snapshot, { ...task, focus: [...event.beliefIds], focusDeclared: true }),
			};
		}
		case "TaskOutcomeRecorded": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			if (!event.outcome.result.trim()) fail(event, "task outcome has no result");
			if (!event.outcome.evidence.trim()) fail(event, "task outcome has no evidence");
			// Last-wins: the loop can refuse a `conclude` after the tool recorded its outcome, and
			// the model may conclude again with a corrected delivery record.
			return { ...snapshot, tasks: replaceTask(snapshot, { ...task, taskOutcome: event.outcome }) };
		}
		case "ProblemFormulationRecorded": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			const version = event.version;
			if (version.taskId !== task.id) {
				fail(event, `formulation version ${version.id} names task ${version.taskId}`);
			}
			if (version.origin !== "propose") fail(event, `formulation version ${version.id} is not published by propose`);
			formulationContentFailure(event, version.content);
			if (!version.reason.trim()) fail(event, `formulation version ${version.id} has no reason`);
			if (!version.recordedAt.trim()) fail(event, `formulation version ${version.id} has no recorded time`);
			if (task.formulations.some((existing) => existing.id === version.id)) {
				fail(event, `formulation version ${version.id} already exists`);
			}
			const current = currentFormulation(task);
			if (version.ordinal !== task.formulations.length + 1) {
				fail(event, `formulation ordinal ${version.ordinal} does not follow ${task.formulations.length}`);
			}
			// The chain is what makes the history a history: a revision must name the version it
			// revises, and a first version must not name one. Together with the append-only store and
			// the ordinal check, this is what "versions are immutable" means on replay.
			if (current === undefined) {
				if (version.previousVersionId !== undefined) {
					fail(event, `first formulation version ${version.id} names a previous version`);
				}
			} else if (version.previousVersionId !== current.id) {
				fail(event, `formulation version ${version.id} does not follow ${current.id}`);
			}
			requireFormulationSources(task, event, version.sources);
			return {
				...snapshot,
				tasks: replaceTask(snapshot, {
					...task,
					formulations: [...task.formulations, version],
					// Publishing answers the deferral: whatever was missing has been supplied, so the
					// deferred state stops being current. The deferral record itself is not erased from
					// the event log, only from the task's current state.
					formulationDeferral: undefined,
				}),
			};
		}
		case "ProblemFormulationDeferred": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			if (!event.missingInformation.trim()) fail(event, "formulation deferral has no missing information");
			if (!event.reason.trim()) fail(event, "formulation deferral has no reason");
			requireFormulationSources(task, event, event.sources);
			// Last-wins, like the other task-level states. A later deferral replaces the earlier one
			// because it was made against the newer evidence; it never removes a version, so a
			// deferral recorded after a publication leaves the current understanding in place.
			return {
				...snapshot,
				tasks: replaceTask(snapshot, {
					...task,
					formulationDeferral: {
						missingInformation: event.missingInformation,
						reason: event.reason,
						sources: [...event.sources],
						deferredAt: event.deferredAt,
						// Derived, not read off the event: the deferral answers the investigation as it
						// stood at this point in the log, and a later episode re-opens the decision.
						answeredThroughEpisodeOrdinal: latestDispatchedEpisodeOrdinal(task) ?? 0,
					},
				}),
			};
		}
		case "FormulationCorrectionSubmitted": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			const correction = event.correction;
			if (correction.taskId !== task.id) {
				fail(event, `correction ${correction.id} names task ${correction.taskId}`);
			}
			if (task.formulationCorrections.some((existing) => existing.id === correction.id)) {
				fail(event, `correction ${correction.id} already exists`);
			}
			if (correction.status !== "pending") fail(event, `correction ${correction.id} is not submitted as pending`);
			if (!correction.receivedAt.trim()) fail(event, `correction ${correction.id} has no received time`);
			// A correction may target no version — the user can object to the current understanding
			// before any version exists — but a target it does name must be a real one, so "which
			// version was the user looking at" is answerable later.
			if (correction.targetVersionId !== undefined) {
				if (!task.formulations.some((version) => version.id === correction.targetVersionId)) {
					fail(event, `correction ${correction.id} targets unknown formulation ${correction.targetVersionId}`);
				}
			}
			return {
				...snapshot,
				tasks: replaceTask(snapshot, {
					...task,
					formulationCorrections: [...task.formulationCorrections, correction],
				}),
			};
		}
		case "FormulationCorrectionResolved": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			const correction = task.formulationCorrections.find((candidate) => candidate.id === event.correctionId);
			if (!correction) fail(event, `unknown correction ${event.correctionId}`);
			if (correction.status !== "pending") fail(event, `correction ${correction.id} is already resolved`);
			// Only a response that says something resolves a correction. An empty one would mark a
			// correction handled without the user ever learning how it was handled.
			if (!event.response.trim()) fail(event, `correction ${correction.id} is resolved without a response`);
			if (event.recordedVersionId !== undefined) {
				if (!task.formulations.some((version) => version.id === event.recordedVersionId)) {
					fail(event, `correction ${correction.id} names unknown formulation ${event.recordedVersionId}`);
				}
			}
			// Resolution is addressed to one correction id, so an answer to an older correction can
			// never be recorded as the answer to a newer one that arrived while it was being handled.
			const resolved: FormulationCorrection = {
				...correction,
				status: "resolved",
				response: event.response,
				recordedVersionId: event.recordedVersionId,
			};
			return {
				...snapshot,
				tasks: replaceTask(snapshot, {
					...task,
					formulationCorrections: task.formulationCorrections.map((candidate) =>
						candidate.id === resolved.id ? resolved : candidate,
					),
				}),
			};
		}
		case "EpisodeOpened": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			if (task.episodes.some((episode) => episode.status === "active"))
				fail(event, `task ${task.id} already has an open episode`);
			if (task.episodes.some((episode) => episode.id === event.episodeId))
				fail(event, `episode ${event.episodeId} already exists`);
			if (event.ordinal !== task.episodes.length + 1) {
				fail(event, `episode ordinal ${event.ordinal} does not follow ${task.episodes.length}`);
			}
			const episode: ExecutionEpisode = {
				id: event.episodeId,
				taskId: task.id,
				ordinal: event.ordinal,
				status: "active",
				stage: "routing",
				steering: [],
				body: { kind: "pending" },
			};
			return { ...snapshot, tasks: replaceTask(snapshot, { ...task, episodes: [...task.episodes, episode] }) };
		}
		case "RoutingDecided": {
			const { task, episode } = requireActiveEpisode(snapshot, event);
			if (episode.routing) fail(event, `episode ${episode.id} already has routing`);
			return {
				...snapshot,
				tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, routing: event.routing })),
			};
		}
		case "EpisodeBodySelected": {
			const { task, episode } = requireActiveEpisode(snapshot, event);
			if (episode.body.kind !== "pending") fail(event, `episode ${episode.id} body is already ${episode.body.kind}`);
			if (episode.routing && episode.routing.decision !== event.body) {
				fail(event, `routing selected ${episode.routing.decision}, not ${event.body}`);
			}
			let body: BeliefLoopEpisode | FastPathEpisode;
			if (event.body === "belief-loop") {
				// A belief-loop episode never carries the adoption itself: its Plan does, so the
				// selection and the dispatch cannot disagree about which version governed them.
				if (event.formulation !== undefined) {
					fail(event, `belief-loop episode ${episode.id} records its formulation on the plan, not the body`);
				}
				body = {
					kind: "belief-loop",
					openBeliefsAtStart: [...(event.openBeliefsAtStart ?? [])],
					trajectory: [],
					beliefDeltas: [],
				};
			} else {
				// The fast path has no Plan, so the episode is the only place this can be recorded.
				// Requiring it here is deliberate: an absent field would be indistinguishable from
				// "no version had been formed", which is exactly the distinction that matters.
				if (event.formulation === undefined) {
					fail(event, `fast-path episode ${episode.id} does not record which formulation it ran under`);
				}
				requireAdoption(event, task, event.formulation);
				body = { kind: "fast-path", trajectory: [], formulation: event.formulation };
			}
			return { ...snapshot, tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, body })) };
		}
		case "EpisodeClosed": {
			const { task, episode } = requireClassifiedEpisode(snapshot, event);
			if (episode.body.trajectory.some((execution) => execution.status === "running")) {
				fail(event, `episode ${episode.id} has a running execution`);
			}
			if (episode.body.kind === "belief-loop" && !episode.body.plan) {
				fail(event, `belief-loop episode ${episode.id} has no plan`);
			}
			const closed = { ...episode, status: "closed" as const, stage: "closed" as const };
			return {
				...snapshot,
				tasks: replaceTask(snapshot, replaceEpisode(task, closed)),
				cursor:
					snapshot.cursor?.episodeId === episode.id ? { ...snapshot.cursor, stage: "closed" } : snapshot.cursor,
			};
		}
		case "CursorChanged": {
			requireActiveEpisode(snapshot, event);
			return {
				...snapshot,
				cursor: { taskId: event.taskId, episodeId: event.episodeId, stage: event.stage },
			};
		}
		case "InterventionAdded": {
			const { task, episode } = requireActiveEpisode(snapshot, event);
			if (episode.steering.some((item) => item.id === event.intervention.id)) {
				fail(event, `intervention ${event.intervention.id} already exists`);
			}
			const nextEpisode = { ...episode, steering: [...episode.steering, event.intervention] };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceEpisode(task, nextEpisode)) };
		}
		case "ExperimentSelected": {
			const { task, episode } = requireActiveEpisode(snapshot, event);
			// The ids are deliberately not checked against the belief registry. A selection is a
			// choice, not a commitment: the tool that made it validated against the live belief set,
			// and it is `PlanProduced` — the dispatch — that enforces existence. Rejecting a choice
			// on replay would fail a log over a belief that never became anything.
			if (event.selection.beliefIds.length === 0) fail(event, "experiment selection has no beliefs");
			if (!event.selection.intent.trim()) fail(event, "experiment selection has no intent");
			requireAdoption(event, task, event.selection.formulation);
			const selection: ExperimentSelectionRecord = {
				intent: event.selection.intent,
				beliefIds: [...event.selection.beliefIds],
				formulation: event.selection.formulation,
			};
			return {
				...snapshot,
				tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, experimentSelection: selection })),
			};
		}
		case "ExperimentSelectionVoided": {
			const { task, episode } = requireActiveEpisode(snapshot, event);
			if (!event.reason.trim()) fail(event, "a voided experiment selection needs a reason");
			if (!episode.experimentSelection) {
				fail(event, `episode ${episode.id} has no experiment selection to void`);
			}
			return {
				...snapshot,
				tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, experimentSelection: undefined })),
			};
		}
		case "BeliefDeltaApplied": {
			const { task, episode } = requireClassifiedEpisode(snapshot, event);
			if (episode.body.kind !== "belief-loop")
				fail(event, `fast-path episode ${episode.id} cannot apply belief deltas`);
			if (event.delta.episodeId !== episode.id)
				fail(event, `belief delta ${event.delta.id} names episode ${event.delta.episodeId}`);
			if (episode.body.beliefDeltas.some((delta) => delta.id === event.delta.id)) {
				fail(event, `belief delta ${event.delta.id} already exists`);
			}
			if (event.delta.producerPhase !== "propose" && event.delta.producerPhase !== "distill") {
				fail(event, `belief delta ${event.delta.id} has invalid producer phase`);
			}
			if (!event.delta.resultingBeliefs.some((belief) => belief.id === event.delta.resultBeliefId)) {
				fail(event, `belief delta ${event.delta.id} does not contain result ${event.delta.resultBeliefId}`);
			}
			if (event.delta.sourceBeliefId !== undefined && !snapshot.beliefs.has(event.delta.sourceBeliefId)) {
				fail(event, `belief delta ${event.delta.id} names unknown source ${event.delta.sourceBeliefId}`);
			}
			const beliefs = new Map(snapshot.beliefs);
			const introduced = [...task.introducedBeliefs];
			for (const belief of event.delta.resultingBeliefs) {
				if (!beliefs.has(belief.id) && !introduced.includes(belief.id)) introduced.push(belief.id);
				beliefs.set(belief.id, belief);
			}
			for (const beliefId of event.activeBeliefs) {
				if (!beliefs.has(beliefId)) fail(event, `active belief ${beliefId} has no record`);
			}
			const body = { ...episode.body, beliefDeltas: [...episode.body.beliefDeltas, event.delta] };
			const nextTask = replaceEpisode({ ...task, introducedBeliefs: introduced }, { ...episode, body });
			return {
				...snapshot,
				beliefs,
				activeBeliefs: [...event.activeBeliefs],
				tasks: replaceTask(snapshot, nextTask),
			};
		}
		case "PlanProduced": {
			const { task, episode } = requireClassifiedEpisode(snapshot, event);
			if (episode.body.kind !== "belief-loop") fail(event, `fast-path episode ${episode.id} cannot own a plan`);
			if (episode.body.plan) fail(event, `episode ${episode.id} already has plan ${episode.body.plan.id}`);
			for (const beliefId of event.plan.selectedToExplore) {
				if (!snapshot.beliefs.has(beliefId)) fail(event, `plan selects unknown belief ${beliefId}`);
			}
			// The selection and the dispatch must agree on which understanding governed them, so the
			// adoption is validated here as well as at body selection; a plan is the durable record
			// of "this experiment was chosen because the task looked like this".
			requireAdoption(event, task, event.plan.formulation);
			const body = { ...episode.body, plan: event.plan };
			// Dispatching commits the choice, so the selection stops being pending: what remains is
			// the plan, which records the same beliefs as the decision that was actually made.
			return {
				...snapshot,
				tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, experimentSelection: undefined, body })),
			};
		}
		case "ExecutionStarted": {
			const { task, episode } = requireClassifiedEpisode(snapshot, event);
			if (episode.body.trajectory.some((execution) => execution.id === event.execution.id)) {
				fail(event, `execution ${event.execution.id} already exists`);
			}
			if (episode.body.kind === "belief-loop") {
				if (!episode.body.plan) fail(event, `belief-loop episode ${episode.id} has no plan`);
				if (event.execution.planId !== episode.body.plan.id) fail(event, `execution does not name episode plan`);
			} else if (event.execution.planId !== undefined) {
				fail(event, `fast-path execution must not name a plan`);
			}
			const execution: Execution = { ...event.execution, output: [], status: "running" };
			const body = { ...episode.body, trajectory: [...episode.body.trajectory, execution] };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, body })) };
		}
		case "ExecutionCompleted": {
			const { task, episode } = requireClassifiedEpisode(snapshot, event);
			const execution = episode.body.trajectory.find((candidate) => candidate.id === event.executionId);
			if (!execution) fail(event, `unknown execution ${event.executionId}`);
			if (execution.status !== "running")
				fail(event, `execution ${event.executionId} is already ${execution.status}`);
			if (event.status === "failed" && !event.error)
				fail(event, `failed execution ${event.executionId} has no error`);
			const completed: Execution = {
				...execution,
				output: event.output,
				status: event.status,
				error: event.error,
			};
			const body = replaceExecution(episode.body, completed);
			return { ...snapshot, tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, body })) };
		}
		case "DistillationProduced": {
			const { task, episode } = requireClassifiedEpisode(snapshot, event);
			if (episode.body.distillation) fail(event, `episode ${episode.id} already has distillation`);
			const executionIds = new Set(episode.body.trajectory.map((execution) => execution.id));
			for (const input of event.distillation.inputs) {
				if (!executionIds.has(input)) fail(event, `distillation input ${input} is not in episode ${episode.id}`);
			}
			if (episode.body.kind === "belief-loop") {
				const expectedOutputs = episode.body.beliefDeltas
					.filter((delta) => delta.producerPhase === "distill")
					.map((delta) => delta.id);
				if (
					expectedOutputs.length !== event.distillation.outputs.length ||
					expectedOutputs.some((output, index) => event.distillation.outputs[index] !== output)
				) {
					fail(event, `distillation outputs must exactly match distill-produced belief deltas`);
				}
			} else if (event.distillation.outputs.length > 0) {
				fail(event, `fast-path distillation cannot produce belief deltas`);
			}
			const body = { ...episode.body, distillation: event.distillation };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceEpisode(task, { ...episode, body })) };
		}
		default:
			// An unrecognized type means a log written by a newer runtime is being replayed by an
			// older build. Fail loudly: falling through would return an undefined snapshot and crash
			// much later with no trace of the cause.
			return fail(event, `unknown domain event type`);
	}
}

export function replayAgentSessionDomainEvents(
	sessionId: SessionId,
	events: readonly AgentSessionDomainEvent[],
): AgentSessionSnapshot {
	let snapshot = createAgentSessionSnapshot(sessionId);
	for (const event of events) snapshot = applyAgentSessionDomainEvent(snapshot, event);
	return snapshot;
}

export function isStoredAgentSessionDomainEvent(value: unknown): value is StoredAgentSessionDomainEvent {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<StoredAgentSessionDomainEvent>;
	return (
		candidate.schemaVersion === AGENT_SESSION_DOMAIN_SCHEMA_VERSION &&
		candidate.event !== undefined &&
		typeof candidate.event === "object" &&
		candidate.event.schemaVersion === AGENT_SESSION_DOMAIN_SCHEMA_VERSION &&
		typeof candidate.event.type === "string" &&
		typeof candidate.event.eventId === "string"
	);
}

export function domainEventsFromSessionEntries(entries: readonly SessionEntry[]): AgentSessionDomainEvent[] {
	const events: AgentSessionDomainEvent[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AGENT_SESSION_DOMAIN_CUSTOM_ENTRY) continue;
		const stored = (entry as CustomEntry).data;
		if (!isStoredAgentSessionDomainEvent(stored)) {
			// A log from an older protocol version is the expected way to land here. Name that case
			// explicitly — the alternative is an operator seeing "invalid event" and
			// suspecting corruption rather than a protocol version they cannot load.
			const version = (stored as { schemaVersion?: unknown } | null | undefined)?.schemaVersion;
			if (typeof version === "number" && version !== AGENT_SESSION_DOMAIN_SCHEMA_VERSION) {
				throw new DomainReplayError(
					`Session entry ${entry.id} was written with agent-session domain schema v${version}, ` +
						`but this runtime requires v${AGENT_SESSION_DOMAIN_SCHEMA_VERSION}. Every version bump ` +
						`so far has been a breaking change with no migration path (v2 renamed TaskFrame to ` +
						`ExecutionEpisode; v3 added problem-formulation records; v4 added the experiment ` +
						`selection), so a v${version} session is rejected rather than replayed with missing ` +
						`or misread records.`,
				);
			}
			throw new DomainReplayError(`Invalid agent-session domain event in session entry ${entry.id}`);
		}
		events.push(stored.event);
	}
	return events;
}

export function replayAgentSessionDomainEntries(
	sessionId: SessionId,
	entries: readonly SessionEntry[],
): AgentSessionSnapshot {
	return replayAgentSessionDomainEvents(sessionId, domainEventsFromSessionEntries(entries));
}

export function appendAgentSessionDomainEvent(
	session: { appendCustomEntry(customType: string, data?: unknown): string },
	event: AgentSessionDomainEvent,
): string {
	const stored: StoredAgentSessionDomainEvent = {
		schemaVersion: AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
		event,
	};
	return session.appendCustomEntry(AGENT_SESSION_DOMAIN_CUSTOM_ENTRY, stored);
}
