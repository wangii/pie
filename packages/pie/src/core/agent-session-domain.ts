import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { CustomEntry, SessionEntry } from "./session-manager.ts";

export const AGENT_SESSION_DOMAIN_SCHEMA_VERSION = 1 as const;
export const AGENT_SESSION_DOMAIN_CUSTOM_ENTRY = "pie.agent-session-domain-event";

export type SessionId = string;
export type TaskId = string;
export type PromptId = string;
export type TargetId = string;
export type FrameId = string;
export type RoutingId = string;
export type BeliefId = string;
export type BeliefDeltaId = string;
export type PlanId = string;
export type ExecutionId = string;
export type DistillationId = string;
export type InterventionId = string;
export type DomainEventId = string;

export type DomainIdKind =
	| "task"
	| "prompt"
	| "target"
	| "frame"
	| "routing"
	| "belief"
	| "belief-delta"
	| "plan"
	| "execution"
	| "distillation"
	| "intervention"
	| "event";

export function createDomainId(kind: DomainIdKind): string {
	return `${kind}-${randomUUID()}`;
}

export type DomainContent = string | readonly JsonValue[];
export type TaskStatus = "active" | "completed" | "cancelled" | "failed";
export type FrameStatus = "active" | "closed";
export type FrameStage = "routing" | "proposing" | "executing" | "distilling" | "closed";
export type FrameBodyKind = "belief-loop" | "fast-path";
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

export interface Plan {
	readonly id: PlanId;
	readonly selectedToExplore: readonly BeliefId[];
	readonly intent?: string;
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
	readonly frameId: FrameId;
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
	readonly stage: FrameStage;
	readonly afterExecution?: ExecutionId;
	readonly createdAt: string;
}

export interface PendingFrame {
	readonly kind: "pending";
}

export interface BeliefLoopFrame {
	readonly kind: "belief-loop";
	readonly openBeliefsAtStart: readonly BeliefId[];
	readonly plan?: Plan;
	readonly trajectory: readonly Execution[];
	readonly distillation?: Distillation;
	readonly beliefDeltas: readonly BeliefDelta[];
}

export interface FastPathFrame {
	readonly kind: "fast-path";
	readonly trajectory: readonly Execution[];
	readonly distillation?: Distillation;
}

export type TaskFrameBody = PendingFrame | BeliefLoopFrame | FastPathFrame;

export interface TaskFrame {
	readonly id: FrameId;
	readonly taskId: TaskId;
	readonly ordinal: number;
	readonly status: FrameStatus;
	readonly stage: FrameStage;
	readonly steering: readonly Intervention[];
	readonly routing?: Routing;
	readonly body: TaskFrameBody;
}

export interface Task {
	readonly id: TaskId;
	readonly parentTaskId?: TaskId;
	readonly initialPrompt: InitialPrompt;
	readonly initialTarget?: Target;
	readonly status: TaskStatus;
	readonly inheritedBeliefs: readonly BeliefId[];
	readonly introducedBeliefs: readonly BeliefId[];
	readonly frames: readonly TaskFrame[];
}

export interface AgentSessionCursor {
	readonly taskId: TaskId;
	readonly frameId: FrameId;
	readonly stage: FrameStage;
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

interface FrameEventBase extends TaskEventBase {
	readonly frameId: FrameId;
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
	| (TaskEventBase & { type: "FrameOpened"; frameId: FrameId; ordinal: number })
	| (FrameEventBase & { type: "RoutingDecided"; routing: Routing })
	| (FrameEventBase & {
			type: "FrameBodySelected";
			body: FrameBodyKind;
			openBeliefsAtStart?: readonly BeliefId[];
	  })
	| (FrameEventBase & { type: "FrameClosed" })
	| (FrameEventBase & { type: "CursorChanged"; stage: FrameStage })
	| (FrameEventBase & { type: "InterventionAdded"; intervention: Intervention })
	| (FrameEventBase & { type: "BeliefDeltaApplied"; delta: BeliefDelta; activeBeliefs: readonly BeliefId[] })
	| (FrameEventBase & { type: "PlanProduced"; plan: Plan })
	| (FrameEventBase & { type: "ExecutionStarted"; execution: Omit<Execution, "output" | "status" | "error"> })
	| (FrameEventBase & {
			type: "ExecutionCompleted";
			executionId: ExecutionId;
			output: DomainContent;
			status: Exclude<ExecutionStatus, "running">;
			error?: string;
	  })
	| (FrameEventBase & { type: "DistillationProduced"; distillation: Distillation });

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

function requireFrame(snapshot: AgentSessionSnapshot, event: FrameEventBase): { task: Task; frame: TaskFrame } {
	const task = requireTask(snapshot, event);
	const frame = task.frames.find((candidate) => candidate.id === event.frameId);
	if (!frame) fail(event, `unknown frame ${event.frameId}`);
	return { task, frame };
}

function replaceTask(snapshot: AgentSessionSnapshot, task: Task): ReadonlyMap<TaskId, Task> {
	const tasks = new Map(snapshot.tasks);
	tasks.set(task.id, task);
	return tasks;
}

function replaceFrame(task: Task, frame: TaskFrame): Task {
	return {
		...task,
		frames: task.frames.map((candidate) => (candidate.id === frame.id ? frame : candidate)),
	};
}

function requireActiveFrame(snapshot: AgentSessionSnapshot, event: FrameEventBase): { task: Task; frame: TaskFrame } {
	const result = requireFrame(snapshot, event);
	if (result.task.status !== "active") fail(event, `task ${event.taskId} is ${result.task.status}`);
	if (result.frame.status !== "active") fail(event, `frame ${event.frameId} is closed`);
	return result;
}

function requireClassifiedFrame(
	snapshot: AgentSessionSnapshot,
	event: FrameEventBase,
): { task: Task; frame: TaskFrame & { body: BeliefLoopFrame | FastPathFrame } } {
	const result = requireActiveFrame(snapshot, event);
	if (result.frame.body.kind === "pending") fail(event, `frame ${event.frameId} has no selected body`);
	return { task: result.task, frame: result.frame as TaskFrame & { body: BeliefLoopFrame | FastPathFrame } };
}

function replaceExecution(
	body: BeliefLoopFrame | FastPathFrame,
	execution: Execution,
): BeliefLoopFrame | FastPathFrame {
	return {
		...body,
		trajectory: body.trajectory.map((candidate) => (candidate.id === execution.id ? execution : candidate)),
	};
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
				frames: [],
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
			if (task.frames.some((frame) => frame.status !== "closed")) fail(event, `task ${task.id} has an open frame`);
			return { ...snapshot, tasks: replaceTask(snapshot, { ...task, status: event.status }) };
		}
		case "TargetDefined": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			if (task.initialTarget) fail(event, `task ${task.id} target is immutable`);
			return { ...snapshot, tasks: replaceTask(snapshot, { ...task, initialTarget: event.target }) };
		}
		case "FrameOpened": {
			const task = requireTask(snapshot, event);
			if (task.status !== "active") fail(event, `task ${task.id} is ${task.status}`);
			if (task.frames.some((frame) => frame.status === "active"))
				fail(event, `task ${task.id} already has an open frame`);
			if (task.frames.some((frame) => frame.id === event.frameId))
				fail(event, `frame ${event.frameId} already exists`);
			if (event.ordinal !== task.frames.length + 1) {
				fail(event, `frame ordinal ${event.ordinal} does not follow ${task.frames.length}`);
			}
			const frame: TaskFrame = {
				id: event.frameId,
				taskId: task.id,
				ordinal: event.ordinal,
				status: "active",
				stage: "routing",
				steering: [],
				body: { kind: "pending" },
			};
			return { ...snapshot, tasks: replaceTask(snapshot, { ...task, frames: [...task.frames, frame] }) };
		}
		case "RoutingDecided": {
			const { task, frame } = requireActiveFrame(snapshot, event);
			if (frame.routing) fail(event, `frame ${frame.id} already has routing`);
			return { ...snapshot, tasks: replaceTask(snapshot, replaceFrame(task, { ...frame, routing: event.routing })) };
		}
		case "FrameBodySelected": {
			const { task, frame } = requireActiveFrame(snapshot, event);
			if (frame.body.kind !== "pending") fail(event, `frame ${frame.id} body is already ${frame.body.kind}`);
			if (frame.routing && frame.routing.decision !== event.body) {
				fail(event, `routing selected ${frame.routing.decision}, not ${event.body}`);
			}
			const body: BeliefLoopFrame | FastPathFrame =
				event.body === "belief-loop"
					? {
							kind: "belief-loop",
							openBeliefsAtStart: [...(event.openBeliefsAtStart ?? [])],
							trajectory: [],
							beliefDeltas: [],
						}
					: { kind: "fast-path", trajectory: [] };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceFrame(task, { ...frame, body })) };
		}
		case "FrameClosed": {
			const { task, frame } = requireClassifiedFrame(snapshot, event);
			if (frame.body.trajectory.some((execution) => execution.status === "running")) {
				fail(event, `frame ${frame.id} has a running execution`);
			}
			if (frame.body.kind === "belief-loop" && !frame.body.plan) {
				fail(event, `belief-loop frame ${frame.id} has no plan`);
			}
			const closed = { ...frame, status: "closed" as const, stage: "closed" as const };
			return {
				...snapshot,
				tasks: replaceTask(snapshot, replaceFrame(task, closed)),
				cursor: snapshot.cursor?.frameId === frame.id ? { ...snapshot.cursor, stage: "closed" } : snapshot.cursor,
			};
		}
		case "CursorChanged": {
			requireActiveFrame(snapshot, event);
			return {
				...snapshot,
				cursor: { taskId: event.taskId, frameId: event.frameId, stage: event.stage },
			};
		}
		case "InterventionAdded": {
			const { task, frame } = requireActiveFrame(snapshot, event);
			if (frame.steering.some((item) => item.id === event.intervention.id)) {
				fail(event, `intervention ${event.intervention.id} already exists`);
			}
			const nextFrame = { ...frame, steering: [...frame.steering, event.intervention] };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceFrame(task, nextFrame)) };
		}
		case "BeliefDeltaApplied": {
			const { task, frame } = requireClassifiedFrame(snapshot, event);
			if (frame.body.kind !== "belief-loop") fail(event, `fast-path frame ${frame.id} cannot apply belief deltas`);
			if (event.delta.frameId !== frame.id)
				fail(event, `belief delta ${event.delta.id} names frame ${event.delta.frameId}`);
			if (frame.body.beliefDeltas.some((delta) => delta.id === event.delta.id)) {
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
			const body = { ...frame.body, beliefDeltas: [...frame.body.beliefDeltas, event.delta] };
			const nextTask = replaceFrame({ ...task, introducedBeliefs: introduced }, { ...frame, body });
			return {
				...snapshot,
				beliefs,
				activeBeliefs: [...event.activeBeliefs],
				tasks: replaceTask(snapshot, nextTask),
			};
		}
		case "PlanProduced": {
			const { task, frame } = requireClassifiedFrame(snapshot, event);
			if (frame.body.kind !== "belief-loop") fail(event, `fast-path frame ${frame.id} cannot own a plan`);
			if (frame.body.plan) fail(event, `frame ${frame.id} already has plan ${frame.body.plan.id}`);
			for (const beliefId of event.plan.selectedToExplore) {
				if (!snapshot.beliefs.has(beliefId)) fail(event, `plan selects unknown belief ${beliefId}`);
			}
			const body = { ...frame.body, plan: event.plan };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceFrame(task, { ...frame, body })) };
		}
		case "ExecutionStarted": {
			const { task, frame } = requireClassifiedFrame(snapshot, event);
			if (frame.body.trajectory.some((execution) => execution.id === event.execution.id)) {
				fail(event, `execution ${event.execution.id} already exists`);
			}
			if (frame.body.kind === "belief-loop") {
				if (!frame.body.plan) fail(event, `belief-loop frame ${frame.id} has no plan`);
				if (event.execution.planId !== frame.body.plan.id) fail(event, `execution does not name frame plan`);
			} else if (event.execution.planId !== undefined) {
				fail(event, `fast-path execution must not name a plan`);
			}
			const execution: Execution = { ...event.execution, output: [], status: "running" };
			const body = { ...frame.body, trajectory: [...frame.body.trajectory, execution] };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceFrame(task, { ...frame, body })) };
		}
		case "ExecutionCompleted": {
			const { task, frame } = requireClassifiedFrame(snapshot, event);
			const execution = frame.body.trajectory.find((candidate) => candidate.id === event.executionId);
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
			const body = replaceExecution(frame.body, completed);
			return { ...snapshot, tasks: replaceTask(snapshot, replaceFrame(task, { ...frame, body })) };
		}
		case "DistillationProduced": {
			const { task, frame } = requireClassifiedFrame(snapshot, event);
			if (frame.body.distillation) fail(event, `frame ${frame.id} already has distillation`);
			const executionIds = new Set(frame.body.trajectory.map((execution) => execution.id));
			for (const input of event.distillation.inputs) {
				if (!executionIds.has(input)) fail(event, `distillation input ${input} is not in frame ${frame.id}`);
			}
			if (frame.body.kind === "belief-loop") {
				const expectedOutputs = frame.body.beliefDeltas
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
			const body = { ...frame.body, distillation: event.distillation };
			return { ...snapshot, tasks: replaceTask(snapshot, replaceFrame(task, { ...frame, body })) };
		}
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
