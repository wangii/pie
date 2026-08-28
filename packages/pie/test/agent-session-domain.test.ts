import { describe, expect, it } from "vitest";
import {
	AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	type AgentSessionDomainEvent,
	appendAgentSessionDomainEvent,
	applyAgentSessionDomainEvent,
	createAgentSessionSnapshot,
	DomainReplayError,
	replayAgentSessionDomainEntries,
	replayAgentSessionDomainEvents,
	statusOfDomainBelief,
} from "../src/core/agent-session-domain.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const base = {
	schemaVersion: AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	timestamp: "2026-08-28T00:00:00.000Z",
} as const;

const belief = {
	id: "belief-1",
	statement: "the cache survives logout",
	domain: "product",
	expectation: "the cached value remains available",
	evidenceRounds: 1,
	skillRefs: [],
	supportedBy: [],
	refutedBy: [],
	withdrawn: false,
} as const;

function beliefLoopEvents(): AgentSessionDomainEvent[] {
	return [
		{
			...base,
			type: "TaskOpened",
			eventId: "event-1",
			taskId: "task-1",
			initialPrompt: { id: "prompt-1", original: "check cache", effective: "check cache" },
			inheritedBeliefs: [],
		},
		{
			...base,
			type: "TargetDefined",
			eventId: "event-2",
			taskId: "task-1",
			target: { id: "target-1", statement: "check cache" },
		},
		{
			...base,
			type: "FrameOpened",
			eventId: "event-3",
			taskId: "task-1",
			frameId: "frame-1",
			ordinal: 1,
		},
		{
			...base,
			type: "RoutingDecided",
			eventId: "event-4",
			taskId: "task-1",
			frameId: "frame-1",
			routing: {
				id: "routing-1",
				statement: "investigation is required",
				decision: "belief-loop",
				suitabilityProbability: 0.2,
				successProbability: 0.9,
				estimatedSteps: 1,
				difficulty: "medium",
				supportingBeliefs: [],
				handoffFromFramingBeliefs: [],
				reason: "requires evidence",
			},
		},
		{
			...base,
			type: "FrameBodySelected",
			eventId: "event-5",
			taskId: "task-1",
			frameId: "frame-1",
			body: "belief-loop",
			openBeliefsAtStart: ["belief-1"],
		},
		{
			...base,
			type: "BeliefDeltaApplied",
			eventId: "event-6",
			taskId: "task-1",
			frameId: "frame-1",
			delta: {
				id: "belief-delta-1",
				frameId: "frame-1",
				operation: "propose",
				proposedRecord: belief,
				evidenceBeliefIds: [],
				resultingBeliefs: [belief],
			},
			activeBeliefs: ["belief-1"],
		},
		{
			...base,
			type: "PlanProduced",
			eventId: "event-7",
			taskId: "task-1",
			frameId: "frame-1",
			plan: { id: "plan-1", selectedToExplore: ["belief-1"] },
		},
		{
			...base,
			type: "ExecutionStarted",
			eventId: "event-8",
			taskId: "task-1",
			frameId: "frame-1",
			execution: {
				id: "execution-1",
				planId: "plan-1",
				intention: "read cache code",
				tool: "read",
				input: { path: "cache.ts" },
				filePath: "cache.ts",
			},
		},
		{
			...base,
			type: "ExecutionCompleted",
			eventId: "event-9",
			taskId: "task-1",
			frameId: "frame-1",
			executionId: "execution-1",
			output: "cache source",
			status: "succeeded",
		},
		{
			...base,
			type: "DistillationProduced",
			eventId: "event-10",
			taskId: "task-1",
			frameId: "frame-1",
			distillation: {
				id: "distillation-1",
				inputs: ["execution-1"],
				contents: "cache survives logout",
				outputs: ["belief-delta-1"],
			},
		},
		{
			...base,
			type: "FrameClosed",
			eventId: "event-11",
			taskId: "task-1",
			frameId: "frame-1",
		},
		{
			...base,
			type: "TaskClosed",
			eventId: "event-12",
			taskId: "task-1",
			status: "completed",
		},
	];
}

describe("agent session domain replay", () => {
	it("replays a complete belief-loop task with explicit ownership", () => {
		const snapshot = replayAgentSessionDomainEvents("session-1", beliefLoopEvents());
		const task = snapshot.tasks.get("task-1");
		const frame = task?.frames[0];

		expect(snapshot.activeBranchTasks).toEqual(["task-1"]);
		expect(task?.status).toBe("completed");
		expect(task?.introducedBeliefs).toEqual(["belief-1"]);
		expect(frame?.status).toBe("closed");
		expect(frame?.body.kind).toBe("belief-loop");
		if (frame?.body.kind !== "belief-loop") throw new Error("expected belief-loop frame");
		expect(frame.body.plan?.selectedToExplore).toEqual(["belief-1"]);
		expect(frame.body.trajectory[0].status).toBe("succeeded");
		expect(frame.body.distillation?.inputs).toEqual(["execution-1"]);
		expect(statusOfDomainBelief(snapshot.beliefs.get("belief-1")!)).toBe("proposed");
	});

	it("persists domain events as non-context custom entries and replays the active branch", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const event of beliefLoopEvents()) appendAgentSessionDomainEvent(session, event);

		expect(session.buildSessionContext().messages).toEqual([]);
		const snapshot = replayAgentSessionDomainEntries(session.getSessionId(), session.getBranch());
		expect(snapshot.tasks.get("task-1")?.status).toBe("completed");
	});

	it("rejects a plan on a fast-path frame", () => {
		const prefix = beliefLoopEvents().slice(0, 3);
		const selected: AgentSessionDomainEvent = {
			...base,
			type: "FrameBodySelected",
			eventId: "event-fast",
			taskId: "task-1",
			frameId: "frame-1",
			body: "fast-path",
		};
		const snapshot = replayAgentSessionDomainEvents("session-1", [...prefix, selected]);
		const invalid: AgentSessionDomainEvent = {
			...base,
			type: "PlanProduced",
			eventId: "event-invalid-plan",
			taskId: "task-1",
			frameId: "frame-1",
			plan: { id: "plan-1", selectedToExplore: [] },
		};

		expect(() => applyAgentSessionDomainEvent(snapshot, invalid)).toThrow(DomainReplayError);
	});

	it("rejects closing an unclassified frame", () => {
		const snapshot = replayAgentSessionDomainEvents("session-1", beliefLoopEvents().slice(0, 3));
		const close: AgentSessionDomainEvent = {
			...base,
			type: "FrameClosed",
			eventId: "event-invalid-close",
			taskId: "task-1",
			frameId: "frame-1",
		};

		expect(() => applyAgentSessionDomainEvent(snapshot, close)).toThrow(DomainReplayError);
	});

	it("starts each task with only explicitly inherited active beliefs", () => {
		const events = beliefLoopEvents();
		const secondTask: AgentSessionDomainEvent = {
			...base,
			type: "TaskOpened",
			eventId: "event-13",
			taskId: "task-2",
			parentTaskId: "task-1",
			initialPrompt: { id: "prompt-2", original: "next", effective: "next" },
			inheritedBeliefs: [],
		};
		const snapshot = replayAgentSessionDomainEvents("session-1", [...events, secondTask]);

		expect(snapshot.activeBeliefs).toEqual([]);
		expect(snapshot.beliefs.has("belief-1")).toBe(true);
	});

	it("creates an empty snapshot without mutable shared collections", () => {
		const first = createAgentSessionSnapshot("session-1");
		const second = createAgentSessionSnapshot("session-2");
		expect(first.tasks).not.toBe(second.tasks);
		expect(first.beliefs).not.toBe(second.beliefs);
	});
});
