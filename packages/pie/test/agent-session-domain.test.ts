import { describe, expect, it } from "vitest";
import {
	AGENT_SESSION_DOMAIN_CUSTOM_ENTRY,
	AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	type AgentSessionDomainEvent,
	appendAgentSessionDomainEvent,
	applicabilityComplete,
	applyAgentSessionDomainEvent,
	createAgentSessionSnapshot,
	currentFormulation,
	DomainReplayError,
	type FormulationAdoption,
	type FormulationApplicabilityEntry,
	type FormulationContent,
	type FormulationSource,
	formulationDecisionOwed,
	latestDispatchedEpisodeOrdinal,
	pendingFormulationCorrections,
	replayAgentSessionDomainEntries,
	replayAgentSessionDomainEvents,
	statusOfDomainBelief,
} from "../src/core/agent-session-domain.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const base = {
	schemaVersion: AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	timestamp: "2026-08-28T00:00:00.000Z",
} as const;

/** A selection or dispatch made before any version existed — a recorded fact, not a blank. */
const UNFORMED: FormulationAdoption = { kind: "unformed" };

const CONTENT: FormulationContent = {
	interpretation: "I read this as an identity lifecycle problem",
	alternative: "a local bug in the retry guard",
	focus: "the PaymentIntent that survives across attempts",
	tension: "retries outlive the request but the identity does not",
	implication: "look at where identity is created and retained first",
};

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
			type: "EpisodeOpened",
			eventId: "event-3",
			taskId: "task-1",
			episodeId: "episode-1",
			ordinal: 1,
		},
		{
			...base,
			type: "RoutingDecided",
			eventId: "event-4",
			taskId: "task-1",
			episodeId: "episode-1",
			routing: {
				id: "routing-1",
				statement: "investigation is required",
				decision: "belief-loop",
				suitabilityProbability: 0.2,
				successProbability: 0.9,
				estimatedSteps: 1,
				difficulty: "medium",
				reason: "requires evidence",
			},
		},
		{
			...base,
			type: "EpisodeBodySelected",
			eventId: "event-5",
			taskId: "task-1",
			episodeId: "episode-1",
			body: "belief-loop",
			openBeliefsAtStart: ["belief-1"],
		},
		{
			...base,
			type: "BeliefDeltaApplied",
			eventId: "event-6",
			taskId: "task-1",
			episodeId: "episode-1",
			delta: {
				id: "belief-delta-1",
				episodeId: "episode-1",
				producerPhase: "propose",
				operation: "propose",
				resultBeliefId: "belief-1",
				proposedRecord: belief,
				resultingBeliefs: [belief],
			},
			activeBeliefs: ["belief-1"],
		},
		{
			...base,
			type: "PlanProduced",
			eventId: "event-7",
			taskId: "task-1",
			episodeId: "episode-1",
			plan: { id: "plan-1", selectedToExplore: ["belief-1"], formulation: UNFORMED },
		},
		{
			...base,
			type: "ExecutionStarted",
			eventId: "event-8",
			taskId: "task-1",
			episodeId: "episode-1",
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
			episodeId: "episode-1",
			executionId: "execution-1",
			output: "cache source",
			status: "succeeded",
		},
		{
			...base,
			type: "DistillationProduced",
			eventId: "event-10",
			taskId: "task-1",
			episodeId: "episode-1",
			distillation: {
				id: "distillation-1",
				inputs: ["execution-1"],
				contents: "cache survives logout",
				outputs: [],
			},
		},
		{
			...base,
			type: "EpisodeClosed",
			eventId: "event-11",
			taskId: "task-1",
			episodeId: "episode-1",
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
		const episode = task?.episodes[0];

		expect(snapshot.activeBranchTasks).toEqual(["task-1"]);
		expect(task?.status).toBe("completed");
		expect(task?.introducedBeliefs).toEqual(["belief-1"]);
		expect(episode?.status).toBe("closed");
		expect(episode?.body.kind).toBe("belief-loop");
		if (episode?.body.kind !== "belief-loop") throw new Error("expected belief-loop episode");
		expect(episode.body.plan?.selectedToExplore).toEqual(["belief-1"]);
		expect(episode.body.trajectory[0].status).toBe("succeeded");
		expect(episode.body.distillation?.inputs).toEqual(["execution-1"]);
		expect(statusOfDomainBelief(snapshot.beliefs.get("belief-1")!)).toBe("proposed");
	});

	it("replays a later round as a new episode instead of revising the finished one", () => {
		// A distill→propose handoff opens the next execution round. The fold records a second
		// `ExecutionEpisode`; it never reopens or rewrites the first, so "another round" and "a
		// revised understanding of the task" stay distinguishable in the stored history.
		const firstRound = beliefLoopEvents().slice(0, 11); // through EpisodeClosed
		const secondRound: AgentSessionDomainEvent[] = [
			{
				...base,
				type: "EpisodeOpened",
				eventId: "event-21",
				taskId: "task-1",
				episodeId: "episode-2",
				ordinal: 2,
			},
			{
				...base,
				type: "CursorChanged",
				eventId: "event-22",
				taskId: "task-1",
				episodeId: "episode-2",
				stage: "routing",
			},
		];
		const snapshot = replayAgentSessionDomainEvents("session-1", [...firstRound, ...secondRound]);
		const task = snapshot.tasks.get("task-1");
		const finished = task?.episodes[0];
		const started = task?.episodes[1];
		if (finished?.body.kind !== "belief-loop") throw new Error("expected a closed belief-loop episode");

		expect(task?.episodes.map((episode) => episode.id)).toEqual(["episode-1", "episode-2"]);
		expect(task?.episodes.map((episode) => episode.ordinal)).toEqual([1, 2]);
		// The finished round keeps its own routing, trajectory, and distillation under its own id.
		expect(finished.status).toBe("closed");
		expect(finished.routing?.decision).toBe("belief-loop");
		expect(finished.body.trajectory.map((execution) => execution.id)).toEqual(["execution-1"]);
		expect(finished.body.distillation?.contents).toBe("cache survives logout");
		// The new round starts unclassified rather than inheriting the earlier round's body.
		expect(started?.status).toBe("active");
		expect(started?.body.kind).toBe("pending");
		expect(snapshot.cursor?.episodeId).toBe("episode-2");
	});

	it("folds task focus and task outcome onto the task record", () => {
		const prefix = beliefLoopEvents().slice(0, 3);
		const events: AgentSessionDomainEvent[] = [
			...prefix,
			{
				...base,
				type: "FocusDeclared",
				eventId: "event-focus-1",
				taskId: "task-1",
				beliefIds: ["belief-1", "belief-2"],
			},
			{
				...base,
				type: "TaskOutcomeRecorded",
				eventId: "event-outcome-1",
				taskId: "task-1",
				outcome: { result: "changed the adapter", evidence: "the propagation test passed" },
			},
		];
		const snapshot = replayAgentSessionDomainEvents("session-1", events);
		const task = snapshot.tasks.get("task-1");

		expect(task?.focusDeclared).toBe(true);
		expect(task?.focus).toEqual(["belief-1", "belief-2"]);
		expect(task?.taskOutcome?.result).toBe("changed the adapter");
		expect(task?.taskOutcome?.evidence).toBe("the propagation test passed");
		expect(task?.taskOutcome?.blockers).toBeUndefined();
	});

	it("starts a task with an undeclared focus and distinct from a declared-empty one", () => {
		const prefix = beliefLoopEvents().slice(0, 3);
		const undeclared = replayAgentSessionDomainEvents("session-1", prefix).tasks.get("task-1");
		expect(undeclared?.focusDeclared).toBe(false);
		expect(undeclared?.focus).toEqual([]);

		const declared = replayAgentSessionDomainEvents("session-1", [
			...prefix,
			{ ...base, type: "FocusDeclared", eventId: "event-focus-1", taskId: "task-1", beliefIds: [] },
		]).tasks.get("task-1");
		expect(declared?.focusDeclared).toBe(true);
		expect(declared?.focus).toEqual([]);
	});

	it("replaces the focus on re-declaration and keeps the last outcome", () => {
		const prefix = beliefLoopEvents().slice(0, 3);
		const snapshot = replayAgentSessionDomainEvents("session-1", [
			...prefix,
			{ ...base, type: "FocusDeclared", eventId: "event-focus-1", taskId: "task-1", beliefIds: ["belief-1"] },
			{ ...base, type: "FocusDeclared", eventId: "event-focus-2", taskId: "task-1", beliefIds: ["belief-2"] },
			{
				...base,
				type: "TaskOutcomeRecorded",
				eventId: "event-outcome-1",
				taskId: "task-1",
				outcome: { result: "first attempt", evidence: "one test passed", blockers: "the second is untested" },
			},
			{
				...base,
				type: "TaskOutcomeRecorded",
				eventId: "event-outcome-2",
				taskId: "task-1",
				outcome: { result: "both call sites changed", evidence: "both tests passed" },
			},
		]);
		const task = snapshot.tasks.get("task-1");

		expect(task?.focus).toEqual(["belief-2"]);
		expect(task?.taskOutcome?.result).toBe("both call sites changed");
		expect(task?.taskOutcome?.blockers).toBeUndefined();
	});

	it("accepts a focus id with no belief record yet", () => {
		// `onBeliefDelta` returns early when no episode is open, so a declared belief can exist in the
		// BeliefSet before any BeliefDeltaApplied reaches the snapshot. Rejecting such an id would
		// abort a live turn, so the fold must not require the belief to be present.
		const prefix = beliefLoopEvents().slice(0, 3);
		const snapshot = replayAgentSessionDomainEvents("session-1", [
			...prefix,
			{ ...base, type: "FocusDeclared", eventId: "event-focus-1", taskId: "task-1", beliefIds: ["belief-99"] },
		]);
		expect(snapshot.tasks.get("task-1")?.focus).toEqual(["belief-99"]);
	});

	it("rejects focus and outcome on an unknown or closed task, and an empty delivery", () => {
		const prefix = beliefLoopEvents().slice(0, 3);
		const closed = beliefLoopEvents();
		const expectRejected = (event: AgentSessionDomainEvent, events: AgentSessionDomainEvent[] = prefix) => {
			expect(() => replayAgentSessionDomainEvents("session-1", [...events, event])).toThrow(DomainReplayError);
		};

		expectRejected({ ...base, type: "FocusDeclared", eventId: "e", taskId: "task-404", beliefIds: [] });
		expectRejected({
			...base,
			type: "TaskOutcomeRecorded",
			eventId: "e",
			taskId: "task-404",
			outcome: { result: "r", evidence: "e" },
		});
		expectRejected({ ...base, type: "FocusDeclared", eventId: "e", taskId: "task-1", beliefIds: [] }, closed);
		expectRejected(
			{
				...base,
				type: "TaskOutcomeRecorded",
				eventId: "e",
				taskId: "task-1",
				outcome: { result: "  ", evidence: "observed" },
			},
			prefix,
		);
		expectRejected(
			{
				...base,
				type: "TaskOutcomeRecorded",
				eventId: "e",
				taskId: "task-1",
				outcome: { result: "delivered", evidence: "" },
			},
			prefix,
		);
	});

	it("persists domain events as non-context custom entries and replays the active branch", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const event of beliefLoopEvents()) appendAgentSessionDomainEvent(session, event);

		expect(session.buildSessionContext().messages).toEqual([]);
		const snapshot = replayAgentSessionDomainEntries(session.getSessionId(), session.getBranch());
		expect(snapshot.tasks.get("task-1")?.status).toBe("completed");
	});

	it("rejects a plan on a fast-path episode", () => {
		const prefix = beliefLoopEvents().slice(0, 3);
		const selected: AgentSessionDomainEvent = {
			...base,
			type: "EpisodeBodySelected",
			eventId: "event-fast",
			taskId: "task-1",
			episodeId: "episode-1",
			body: "fast-path",
			formulation: UNFORMED,
		};
		const snapshot = replayAgentSessionDomainEvents("session-1", [...prefix, selected]);
		const invalid: AgentSessionDomainEvent = {
			...base,
			type: "PlanProduced",
			eventId: "event-invalid-plan",
			taskId: "task-1",
			episodeId: "episode-1",
			plan: { id: "plan-1", selectedToExplore: [], formulation: UNFORMED },
		};

		expect(() => applyAgentSessionDomainEvent(snapshot, invalid)).toThrow(DomainReplayError);
	});

	it("rejects closing an unclassified episode", () => {
		const snapshot = replayAgentSessionDomainEvents("session-1", beliefLoopEvents().slice(0, 3));
		const close: AgentSessionDomainEvent = {
			...base,
			type: "EpisodeClosed",
			eventId: "event-invalid-close",
			taskId: "task-1",
			episodeId: "episode-1",
		};

		expect(() => applyAgentSessionDomainEvent(snapshot, close)).toThrow(DomainReplayError);
	});

	it("rejects propose-phase deltas claimed as distillation outputs", () => {
		const events = beliefLoopEvents();
		const index = events.findIndex((event) => event.type === "DistillationProduced");
		const distillation = events[index];
		if (distillation?.type !== "DistillationProduced") throw new Error("missing distillation fixture");
		events[index] = {
			...distillation,
			distillation: { ...distillation.distillation, outputs: ["belief-delta-1"] },
		};

		expect(() => replayAgentSessionDomainEvents("session-1", events)).toThrow(/must exactly match/);
	});

	it("rejects a session stored under the pre-rename schema instead of replaying it", () => {
		// v1 wrote the execution round as `TaskFrame`/`frameId`; v2 renamed it to
		// `ExecutionEpisode`/`episodeId`. The two vocabularies overlap enough that a v1 event cannot
		// be read as an episode without guessing at intent, so the fold refuses the whole log rather
		// than replaying it into a history with missing or misread episodes.
		const PRE_RENAME_SCHEMA_VERSION = 1;
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		session.appendCustomEntry(AGENT_SESSION_DOMAIN_CUSTOM_ENTRY, {
			schemaVersion: PRE_RENAME_SCHEMA_VERSION,
			event: {
				schemaVersion: PRE_RENAME_SCHEMA_VERSION,
				type: "FrameOpened",
				eventId: "event-1",
				timestamp: "2026-08-28T00:00:00.000Z",
				taskId: "task-1",
				frameId: "frame-1",
				ordinal: 1,
			},
		});

		expect(() => replayAgentSessionDomainEntries(session.getSessionId(), session.getBranch())).toThrow(
			new RegExp(`schema v${PRE_RENAME_SCHEMA_VERSION}.*requires v${AGENT_SESSION_DOMAIN_SCHEMA_VERSION}`),
		);
		// The rejection is about the stored log, not one event: the entry is left untouched so the
		// user's own history is never rewritten or deleted by a version it cannot load.
		expect(session.getBranch()).toHaveLength(1);
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

describe("problem formulation", () => {
	const taskPrefix = () => beliefLoopEvents().slice(0, 3); // through EpisodeOpened

	function versionEvent(overrides: {
		eventId: string;
		ordinal?: number;
		previousVersionId?: string;
		content?: FormulationContent;
		reason?: string;
		sources?: readonly FormulationSource[];
		taskId?: string;
		id?: string;
	}): AgentSessionDomainEvent {
		return {
			...base,
			type: "ProblemFormulationRecorded",
			eventId: overrides.eventId,
			taskId: overrides.taskId ?? "task-1",
			version: {
				id: overrides.id ?? `formulation-${overrides.eventId}`,
				taskId: overrides.taskId ?? "task-1",
				ordinal: overrides.ordinal ?? 1,
				previousVersionId: overrides.previousVersionId,
				recordedAt: base.timestamp,
				origin: "propose",
				content: overrides.content ?? CONTENT,
				reason: overrides.reason ?? "the evidence pointed at identity, not the guard",
				sources: overrides.sources ?? [],
			},
		};
	}

	it("folds versions in order and keeps the chain back to the first", () => {
		const events: AgentSessionDomainEvent[] = [
			...taskPrefix(),
			versionEvent({ eventId: "v1" }),
			versionEvent({
				eventId: "v2",
				ordinal: 2,
				previousVersionId: "formulation-v1",
				content: { ...CONTENT, focus: "where the identity is retained between attempts" },
				reason: "the first probe moved the focus to retention",
			}),
		];
		const task = replayAgentSessionDomainEvents("session-1", events).tasks.get("task-1");

		expect(task?.formulations.map((version) => version.ordinal)).toEqual([1, 2]);
		expect(task?.formulations[1].previousVersionId).toBe("formulation-v1");
		expect(task?.formulations[0].previousVersionId).toBeUndefined();
		expect(currentFormulation(task!)?.id).toBe("formulation-v2");
	});

	it("rejects a version that is missing required content", () => {
		const expectRejected = (content: FormulationContent, pattern: RegExp) => {
			const events = [...taskPrefix(), versionEvent({ eventId: "v1", content })];
			expect(() => replayAgentSessionDomainEvents("session-1", events)).toThrow(pattern);
		};

		expectRejected({ ...CONTENT, interpretation: "   " }, /missing required content: interpretation/);
		expectRejected({ ...CONTENT, focus: "" }, /missing required content: focus/);
		expectRejected({ ...CONTENT, implication: "" }, /missing required content: implication/);
	});

	it("accepts a version with no tension or alternative, but not an empty placeholder", () => {
		const minimal: FormulationContent = {
			interpretation: "I read this as a latency budget problem",
			focus: "the request path between the gateway and the cache",
			implication: "measure the segments before changing any of them",
		};
		const task = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			versionEvent({ eventId: "v1", content: minimal }),
		]).tasks.get("task-1");
		expect(task?.formulations[0].content.tension).toBeUndefined();
		expect(task?.formulations[0].content.alternative).toBeUndefined();

		// A present-but-blank optional field is a filled-in field pretending to be content.
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				versionEvent({ eventId: "v1", content: { ...CONTENT, tension: "  " } }),
			]),
		).toThrow(/tension is present but empty/);
	});

	it("rejects a version whose source does not resolve to a durable record", () => {
		const expectRejected = (source: FormulationSource, pattern: RegExp) => {
			const events = [...taskPrefix(), versionEvent({ eventId: "v1", sources: [source] })];
			expect(() => replayAgentSessionDomainEvents("session-1", events)).toThrow(pattern);
		};

		// The task's own prompt resolves; a foreign one does not.
		expect(
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				versionEvent({ eventId: "v1", sources: [{ kind: "prompt", promptId: "prompt-1" }] }),
			]).tasks.get("task-1")?.formulations[0].sources,
		).toEqual([{ kind: "prompt", promptId: "prompt-1" }]);

		expectRejected({ kind: "prompt", promptId: "prompt-other" }, /unknown prompt/);
		expectRejected({ kind: "execution", executionId: "execution-404" }, /unknown execution/);
		expectRejected({ kind: "distillation", distillationId: "distillation-404" }, /unknown distillation/);
		expectRejected(
			{ kind: "belief", beliefId: "belief-1", beliefDeltaId: "belief-delta-404" },
			/unknown belief delta/,
		);
	});

	it("rejects a belief citation whose delta says nothing about that belief", () => {
		// The delta exists here, so the only thing left to check is that it actually carries the
		// cited belief — otherwise a version could cite any delta as its basis.
		const events = [
			...beliefLoopEvents().slice(0, 11),
			versionEvent({
				eventId: "v1",
				sources: [{ kind: "belief", beliefId: "belief-2", beliefDeltaId: "belief-delta-1" }],
			}),
		];
		expect(() => replayAgentSessionDomainEvents("session-1", events)).toThrow(/does not carry belief belief-2/);
	});

	it("cites a belief through the delta that recorded its state, not by id alone", () => {
		// The whole task history, so the belief delta exists; the version cites it by (belief, delta).
		const events = [
			...beliefLoopEvents().slice(0, 11),
			versionEvent({
				eventId: "v1",
				sources: [{ kind: "belief", beliefId: "belief-1", beliefDeltaId: "belief-delta-1" }],
			}),
		];
		const task = replayAgentSessionDomainEvents("session-1", events).tasks.get("task-1");
		expect(task?.formulations[0].sources).toEqual([
			{ kind: "belief", beliefId: "belief-1", beliefDeltaId: "belief-delta-1" },
		]);
	});

	it("records a deferral, and a publication answers it without erasing history", () => {
		const deferred = {
			...base,
			type: "ProblemFormulationDeferred",
			eventId: "defer-1",
			taskId: "task-1",
			missingInformation: "whether the duplicate charge is per-attempt or per-request",
			reason: "one probe cannot separate the two readings",
			sources: [{ kind: "prompt", promptId: "prompt-1" }],
			deferredAt: base.timestamp,
		} satisfies AgentSessionDomainEvent;

		const afterDeferral = replayAgentSessionDomainEvents("session-1", [...taskPrefix(), deferred]).tasks.get(
			"task-1",
		);
		expect(afterDeferral?.formulationDeferral?.missingInformation).toContain("per-attempt");
		expect(afterDeferral?.formulations).toEqual([]);

		const afterPublication = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			deferred,
			versionEvent({ eventId: "v1" }),
		]).tasks.get("task-1");
		expect(afterPublication?.formulations).toHaveLength(1);
		expect(afterPublication?.formulationDeferral).toBeUndefined();

		// A later deferral does not erase the version that already exists.
		const deferredAfter = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			versionEvent({ eventId: "v1" }),
			{ ...deferred, eventId: "defer-2" },
		]).tasks.get("task-1");
		expect(deferredAfter?.formulations).toHaveLength(1);
		expect(deferredAfter?.formulationDeferral).toBeDefined();
	});

	it("keeps corrections as their own records with their own target version", () => {
		const submitted = (id: string, targetVersionId?: string): AgentSessionDomainEvent => ({
			...base,
			type: "FormulationCorrectionSubmitted",
			eventId: `submit-${id}`,
			taskId: "task-1",
			correction: {
				id,
				taskId: "task-1",
				targetVersionId,
				original: "it is not an identity problem, the guard is simply not re-armed",
				receivedAt: base.timestamp,
				status: "pending",
			},
		});

		const task = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			versionEvent({ eventId: "v1" }),
			submitted("correction-1", "formulation-v1"),
		]).tasks.get("task-1");
		expect(pendingFormulationCorrections(task!)).toHaveLength(1);
		expect(task?.formulationCorrections[0].targetVersionId).toBe("formulation-v1");
		// The correction never rewrites the version it objects to.
		expect(task?.formulations[0].content).toEqual(CONTENT);

		// A correction may target nothing when no version exists yet.
		const untargeted = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			submitted("correction-1"),
		]).tasks.get("task-1");
		expect(untargeted?.formulationCorrections[0].targetVersionId).toBeUndefined();

		expect(() =>
			replayAgentSessionDomainEvents("session-1", [...taskPrefix(), submitted("correction-1", "formulation-404")]),
		).toThrow(/targets unknown formulation/);
	});

	it("resolves a correction by id only, with a response that says something", () => {
		const submitted: AgentSessionDomainEvent = {
			...base,
			type: "FormulationCorrectionSubmitted",
			eventId: "submit-1",
			taskId: "task-1",
			correction: {
				id: "correction-1",
				taskId: "task-1",
				original: "the guard is simply not re-armed",
				receivedAt: base.timestamp,
				status: "pending",
			},
		};
		const resolved = (overrides: { eventId: string; correctionId?: string; response?: string; version?: string }) =>
			({
				...base,
				type: "FormulationCorrectionResolved",
				eventId: overrides.eventId,
				taskId: "task-1",
				correctionId: overrides.correctionId ?? "correction-1",
				response: overrides.response ?? "I will keep the identity reading and test the re-arm path",
				recordedVersionId: overrides.version,
			}) satisfies AgentSessionDomainEvent;

		const done = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			submitted,
			resolved({ eventId: "resolve-1" }),
		]).tasks.get("task-1");
		expect(pendingFormulationCorrections(done!)).toEqual([]);
		expect(done?.formulationCorrections[0].status).toBe("resolved");
		expect(done?.formulationCorrections[0].response).toContain("identity reading");

		// An empty response would mark the correction handled without the user learning anything.
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				submitted,
				resolved({ eventId: "resolve-1", response: "   " }),
			]),
		).toThrow(/resolved without a response/);
		// A response is addressed to one correction, so it can never resolve an unknown or an
		// already-answered one.
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				submitted,
				resolved({ eventId: "resolve-1", correctionId: "correction-404" }),
			]),
		).toThrow(/unknown correction/);
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				submitted,
				resolved({ eventId: "resolve-1" }),
				resolved({ eventId: "resolve-2" }),
			]),
		).toThrow(/already resolved/);
	});

	it("does not let a recorded adoption contradict the versions that exist", () => {
		const fastPath = (formulation: FormulationAdoption): AgentSessionDomainEvent => ({
			...base,
			type: "EpisodeBodySelected",
			eventId: "event-fast",
			taskId: "task-1",
			episodeId: "episode-1",
			body: "fast-path",
			formulation,
		});

		// Before the first publication there is nothing to name, and saying so is honest.
		const unformed = replayAgentSessionDomainEvents("session-1", [...taskPrefix(), fastPath(UNFORMED)]).tasks.get(
			"task-1",
		);
		expect(unformed?.episodes[0].body.kind === "fast-path" && unformed.episodes[0].body.formulation).toEqual({
			kind: "unformed",
		});

		// Once a version exists, claiming a dispatch ran with none would let the version escape
		// being the basis of a decision it actually governed.
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				versionEvent({ eventId: "v1" }),
				fastPath(UNFORMED),
			]),
		).toThrow(/claims no version was formed/);

		const adopted = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			versionEvent({ eventId: "v1" }),
			fastPath({ kind: "version", versionId: "formulation-v1" }),
		]).tasks.get("task-1");
		expect(adopted?.episodes[0].body.kind === "fast-path" && adopted.episodes[0].body.formulation).toEqual({
			kind: "version",
			versionId: "formulation-v1",
		});

		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				fastPath({ kind: "version", versionId: "formulation-404" }),
			]),
		).toThrow(/unknown formulation version/);
	});

	it("binds the experiment selection to the version it was chosen under", () => {
		// A first investigation selects before any version exists.
		const firstProbe = replayAgentSessionDomainEvents("session-1", [
			...beliefLoopEvents().slice(0, 6),
			{
				...base,
				type: "PlanProduced",
				eventId: "plan-event-1",
				taskId: "task-1",
				episodeId: "episode-1",
				plan: { id: "plan-1", selectedToExplore: ["belief-1"], formulation: UNFORMED },
			},
		]).tasks.get("task-1");
		expect(
			firstProbe?.episodes[0].body.kind === "belief-loop" && firstProbe.episodes[0].body.plan?.formulation,
		).toEqual(UNFORMED);

		// A later selection names the version, and an unknown one is refused.
		const bound = replayAgentSessionDomainEvents("session-1", [
			...beliefLoopEvents().slice(0, 6),
			versionEvent({ eventId: "v1" }),
			{
				...base,
				type: "PlanProduced",
				eventId: "plan-event-2",
				taskId: "task-1",
				episodeId: "episode-1",
				plan: {
					id: "plan-1",
					selectedToExplore: ["belief-1"],
					formulation: { kind: "version", versionId: "formulation-v1" },
				},
			},
		]).tasks.get("task-1");
		expect(bound?.episodes[0].body.kind === "belief-loop" && bound.episodes[0].body.plan?.formulation).toEqual({
			kind: "version",
			versionId: "formulation-v1",
		});

		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...beliefLoopEvents().slice(0, 6),
				{
					...base,
					type: "PlanProduced",
					eventId: "plan-event-3",
					taskId: "task-1",
					episodeId: "episode-1",
					plan: { id: "plan-1", selectedToExplore: [], formulation: { kind: "version", versionId: "nope" } },
				},
			]),
		).toThrow(/unknown formulation version/);
	});

	it("records the experiment choice as its own step, committed by the dispatch it becomes", () => {
		const selection = (formulation: FormulationAdoption, eventId = "selection-event-1"): AgentSessionDomainEvent => ({
			...base,
			type: "ExperimentSelected",
			eventId,
			taskId: "task-1",
			episodeId: "episode-1",
			selection: { intent: "what the answer must report", beliefIds: ["belief-1"], formulation },
		});
		const voidSelection = (eventId: string): AgentSessionDomainEvent => ({
			...base,
			type: "ExperimentSelectionVoided",
			eventId,
			taskId: "task-1",
			episodeId: "episode-1",
			reason: "a new formulation version was published",
		});
		const plan = (): AgentSessionDomainEvent => ({
			...base,
			type: "PlanProduced",
			eventId: "plan-event-selection",
			taskId: "task-1",
			episodeId: "episode-1",
			plan: { id: "plan-1", selectedToExplore: ["belief-1"], formulation: UNFORMED },
		});

		// Chosen before anything ran, and bound to the reading that governed the choice.
		const chosen = replayAgentSessionDomainEvents("session-1", [
			...beliefLoopEvents().slice(0, 6),
			selection(UNFORMED),
		]).tasks.get("task-1");
		expect(chosen?.episodes[0].experimentSelection).toEqual({
			intent: "what the answer must report",
			beliefIds: ["belief-1"],
			formulation: UNFORMED,
		});

		// Dispatching commits the choice: what remains is the plan, which records the same beliefs
		// as the decision that was actually made.
		const dispatched = replayAgentSessionDomainEvents("session-1", [
			...beliefLoopEvents().slice(0, 6),
			selection(UNFORMED),
			plan(),
		]).tasks.get("task-1");
		expect(dispatched?.episodes[0].experimentSelection).toBeUndefined();

		// A revision voids the choice explicitly, so the log shows choice → void → choice again
		// rather than a selection that merely disappeared.
		const revised = replayAgentSessionDomainEvents("session-1", [
			...beliefLoopEvents().slice(0, 6),
			selection(UNFORMED),
			versionEvent({ eventId: "v1" }),
			voidSelection("void-event-1"),
			selection({ kind: "version", versionId: "formulation-v1" }, "selection-event-2"),
		]).tasks.get("task-1");
		expect(revised?.episodes[0].experimentSelection?.formulation).toEqual({
			kind: "version",
			versionId: "formulation-v1",
		});

		// An adoption that names nothing is refused here exactly as it is for a plan, and voiding a
		// choice that does not exist would claim a transition that never happened.
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...beliefLoopEvents().slice(0, 6),
				selection({ kind: "version", versionId: "formulation-404" }),
			]),
		).toThrow(/unknown formulation version/);
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [...beliefLoopEvents().slice(0, 6), voidSelection("void-404")]),
		).toThrow(/has no experiment selection to void/);
	});

	it("starts a new task with no understanding of its own and no reach into the previous one", () => {
		const secondTask: AgentSessionDomainEvent = {
			...base,
			type: "TaskOpened",
			eventId: "event-13",
			taskId: "task-2",
			parentTaskId: "task-1",
			initialPrompt: { id: "prompt-2", original: "and now the refund path", effective: "and now the refund path" },
			inheritedBeliefs: [],
		};
		const snapshot = replayAgentSessionDomainEvents("session-1", [
			...taskPrefix(),
			versionEvent({ eventId: "v1" }),
			secondTask,
		]);

		expect(snapshot.tasks.get("task-2")?.formulations).toEqual([]);
		expect(currentFormulation(snapshot.tasks.get("task-2")!)).toBeUndefined();
		// The previous task's version is still readable history, it is just not this task's.
		expect(currentFormulation(snapshot.tasks.get("task-1")!)?.id).toBe("formulation-v1");

		// And a fresh task cannot cite the previous task's records as its own sources.
		expect(() =>
			replayAgentSessionDomainEvents("session-1", [
				...taskPrefix(),
				versionEvent({ eventId: "v1" }),
				secondTask,
				versionEvent({
					eventId: "v2",
					taskId: "task-2",
					id: "formulation-other",
					sources: [{ kind: "prompt", promptId: "prompt-1" }],
				}),
			]),
		).toThrow(/unknown prompt prompt-1/);
	});

	it("restores the same understanding, deferral, and pending corrections after a reload", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const event of [
			...taskPrefix(),
			versionEvent({ eventId: "v1" }),
			{
				...base,
				type: "ProblemFormulationDeferred",
				eventId: "defer-1",
				taskId: "task-1",
				missingInformation: "whether the second charge is per-attempt",
				reason: "the probe could not separate the readings",
				sources: [],
				deferredAt: base.timestamp,
			},
			{
				...base,
				type: "FormulationCorrectionSubmitted",
				eventId: "submit-1",
				taskId: "task-1",
				correction: {
					id: "correction-1",
					taskId: "task-1",
					targetVersionId: "formulation-v1",
					original: "the guard is not re-armed",
					receivedAt: base.timestamp,
					status: "pending",
				},
			},
		] satisfies AgentSessionDomainEvent[]) {
			appendAgentSessionDomainEvent(session, event);
		}

		const replayed = replayAgentSessionDomainEntries(session.getSessionId(), session.getBranch()).tasks.get("task-1");
		expect(currentFormulation(replayed!)?.id).toBe("formulation-v1");
		expect(replayed?.formulationDeferral?.missingInformation).toContain("per-attempt");
		expect(pendingFormulationCorrections(replayed!).map((correction) => correction.id)).toEqual(["correction-1"]);
	});
});

describe("formulation decision gate", () => {
	const deferral = (eventId: string): AgentSessionDomainEvent => ({
		...base,
		type: "ProblemFormulationDeferred",
		eventId,
		taskId: "task-1",
		missingInformation: "whether the second charge is per-attempt",
		reason: "the probe could not separate the readings",
		sources: [],
		deferredAt: base.timestamp,
	});

	const secondRound: AgentSessionDomainEvent[] = [
		{
			...base,
			type: "EpisodeOpened",
			eventId: "event-21",
			taskId: "task-1",
			episodeId: "episode-2",
			ordinal: 2,
		},
		{
			...base,
			type: "EpisodeBodySelected",
			eventId: "event-22",
			taskId: "task-1",
			episodeId: "episode-2",
			body: "belief-loop",
			openBeliefsAtStart: [],
		},
		{
			...base,
			type: "PlanProduced",
			eventId: "event-23",
			taskId: "task-1",
			episodeId: "episode-2",
			plan: {
				id: "plan-2",
				selectedToExplore: ["belief-1"],
				formulation: UNFORMED,
			},
		},
	];

	const taskAfter = (events: AgentSessionDomainEvent[]) =>
		replayAgentSessionDomainEvents("session-1", events).tasks.get("task-1")!;

	const reading = (eventId: string) => ({
		...base,
		type: "ProblemFormulationRecorded" as const,
		eventId,
		taskId: "task-1",
		version: {
			id: "formulation-1",
			taskId: "task-1",
			ordinal: 1,
			recordedAt: base.timestamp,
			origin: "propose" as const,
			content: CONTENT,
			reason: "the evidence pointed at identity, not the guard",
			sources: [],
		},
	});

	it("is not owed before an experiment has been dispatched", () => {
		// Routing and choosing a body is not investigating; only a dispatched experiment is.
		expect(formulationDecisionOwed(taskAfter(beliefLoopEvents().slice(0, 5)))).toBe(false);
		// The plan is what records the dispatch, so it is what makes the decision owed.
		expect(latestDispatchedEpisodeOrdinal(taskAfter(beliefLoopEvents().slice(0, 5)))).toBeUndefined();
		expect(formulationDecisionOwed(taskAfter(beliefLoopEvents().slice(0, 7)))).toBe(true);
	});

	it("is settled for good by a published version", () => {
		const task = taskAfter([...beliefLoopEvents().slice(0, 7), reading("v1")]);
		expect(currentFormulation(task)).toBeDefined();
		expect(formulationDecisionOwed(task)).toBe(false);
	});

	it("re-opens after a deferral once another experiment is dispatched", () => {
		// The deferral answers the investigation it was made in...
		const deferred = taskAfter([...beliefLoopEvents().slice(0, 7), deferral("defer-1")]);
		expect(deferred.formulationDeferral?.answeredThroughEpisodeOrdinal).toBe(1);
		expect(formulationDecisionOwed(deferred)).toBe(false);

		// ...and a later round is new information, so the first deferral is not a standing exemption.
		const next = taskAfter([...beliefLoopEvents().slice(0, 11), deferral("defer-1"), ...secondRound]);
		expect(formulationDecisionOwed(next)).toBe(true);

		// Deferring again against the new round settles it again, without erasing anything.
		const reDeferred = taskAfter([
			...beliefLoopEvents().slice(0, 11),
			deferral("defer-1"),
			...secondRound,
			deferral("defer-2"),
		]);
		expect(reDeferred.formulationDeferral?.answeredThroughEpisodeOrdinal).toBe(2);
		expect(formulationDecisionOwed(reDeferred)).toBe(false);
		expect(reDeferred.formulations).toEqual([]);
	});
});

describe("revision applicability isolation", () => {
	const version = (overrides: {
		eventId: string;
		ordinal?: number;
		previousVersionId?: string;
		content?: FormulationContent;
		reason?: string;
	}): AgentSessionDomainEvent => ({
		...base,
		type: "ProblemFormulationRecorded",
		eventId: overrides.eventId,
		taskId: "task-1",
		version: {
			id: `formulation-${overrides.eventId}`,
			taskId: "task-1",
			ordinal: overrides.ordinal ?? 1,
			previousVersionId: overrides.previousVersionId,
			recordedAt: base.timestamp,
			origin: "propose",
			content: overrides.content ?? CONTENT,
			reason: overrides.reason ?? "the evidence pointed at identity, not the guard",
			sources: [],
		},
	});

	const focus = (eventId: string, beliefIds: readonly string[], versionId: string): AgentSessionDomainEvent => ({
		...base,
		type: "FocusDeclared",
		eventId,
		taskId: "task-1",
		beliefIds,
		formulation: { kind: "version", versionId },
	});

	const applicability = (
		eventId: string,
		versionId: string,
		entries: readonly FormulationApplicabilityEntry[],
	): AgentSessionDomainEvent => ({
		...base,
		type: "FormulationApplicabilityRecorded",
		eventId,
		taskId: "task-1",
		versionId,
		entries,
	});

	const v1 = version({ eventId: "v1" });
	const v2 = version({
		eventId: "v2",
		ordinal: 2,
		previousVersionId: "formulation-v1",
		content: { ...CONTENT, focus: "where the identity is retained between attempts" },
		reason: "the first probe moved the focus to retention",
	});
	const v3 = version({
		eventId: "v3",
		ordinal: 3,
		previousVersionId: "formulation-v2",
		content: { ...CONTENT, focus: "identity ownership across components" },
		reason: "the correction moved the question to ownership",
	});
	const taskAfter = (events: readonly AgentSessionDomainEvent[]) =>
		replayAgentSessionDomainEvents("session-1", events).tasks.get("task-1")!;

	it("marks the decision stale when the belief comes back into scope, and replaces it when re-decided", () => {
		const decided = taskAfter([
			...beliefLoopEvents().slice(0, 6),
			v1,
			focus("focus-1", ["belief-1"], "formulation-v1"),
			v2,
			applicability("app-1", "formulation-v2", [
				{ beliefId: "belief-1", decision: "not-applicable", reason: "this reading asks about another path" },
			]),
		]);
		expect(decided.formulationReview?.applicability[0].stale).toBeUndefined();
		expect(applicabilityComplete(decided.formulationReview!)).toBe(true);

		// Declaring the belief back into focus makes the decision a statement about a scope the task no
		// longer holds: it stops counting, so the belief is owed a fresh one.
		const backInScope = taskAfter([
			...beliefLoopEvents().slice(0, 6),
			v1,
			focus("focus-1", ["belief-1"], "formulation-v1"),
			v2,
			applicability("app-1", "formulation-v2", [
				{ beliefId: "belief-1", decision: "not-applicable", reason: "this reading asks about another path" },
			]),
			focus("focus-2", ["belief-1"], "formulation-v2"),
		]);
		expect(backInScope.formulationReview?.applicability[0]).toEqual({
			beliefId: "belief-1",
			decision: "not-applicable",
			reason: "this reading asks about another path",
			stale: true,
		});
		expect(applicabilityComplete(backInScope.formulationReview!)).toBe(false);

		const reDecided = taskAfter([
			...beliefLoopEvents().slice(0, 6),
			v1,
			focus("focus-1", ["belief-1"], "formulation-v1"),
			v2,
			applicability("app-1", "formulation-v2", [
				{ beliefId: "belief-1", decision: "not-applicable", reason: "this reading asks about another path" },
			]),
			focus("focus-2", ["belief-1"], "formulation-v2"),
			applicability("app-2", "formulation-v2", [
				{ beliefId: "belief-1", decision: "carries-over", reason: "it is in scope again" },
			]),
		]);
		expect(reDecided.formulationReview?.applicability).toEqual([
			{ beliefId: "belief-1", decision: "carries-over", reason: "it is in scope again" },
		]);
		expect(applicabilityComplete(reDecided.formulationReview!)).toBe(true);
	});

	it("rebuilds the review on a further revision instead of carrying the earlier decisions", () => {
		const events: AgentSessionDomainEvent[] = [
			...beliefLoopEvents().slice(0, 6),
			v1,
			focus("focus-1", ["belief-1"], "formulation-v1"),
			v2,
			applicability("app-1", "formulation-v2", [
				{ beliefId: "belief-1", decision: "not-applicable", reason: "this reading asks about another path" },
			]),
			focus("focus-2", ["belief-1"], "formulation-v2"),
			applicability("app-2", "formulation-v2", [
				{ beliefId: "belief-1", decision: "carries-over", reason: "it is in scope again" },
			]),
		];
		const beforeThird = taskAfter(events);
		expect(beforeThird.formulationReview?.versionId).toBe("formulation-v2");
		expect(beforeThird.formulationReview?.applicability).toHaveLength(1);

		const afterThird = taskAfter([...events, v3]);
		expect(afterThird.formulations.map((item) => item.ordinal)).toEqual([1, 2, 3]);
		expect(currentFormulation(afterThird)?.id).toBe("formulation-v3");
		// The new version's review starts from the scope that was in force when it was published, with
		// nothing carried over from the version before it: decisions describe one reading.
		expect(afterThird.formulationReview).toEqual({
			versionId: "formulation-v3",
			focusReviewed: false,
			scopedBeliefIds: ["belief-1"],
			introducedAtRevision: 1,
			applicability: [],
		});
		// The belief records themselves are untouched: applicability never re-judges evidence.
		expect(
			statusOfDomainBelief(replayAgentSessionDomainEvents("session-1", [...events, v3]).beliefs.get("belief-1")!),
		).toBe("proposed");
	});
});
