import { describe, expect, it } from "vitest";
import {
	AGENT_SESSION_DOMAIN_CUSTOM_ENTRY,
	AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	type AgentSessionDomainEvent,
	applyAgentSessionDomainEvent,
	type FormulationContent,
	replayAgentSessionDomainEntries,
	replayAgentSessionDomainEvents,
} from "../src/core/agent-session-domain.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const base = {
	schemaVersion: AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	timestamp: "2026-09-25T00:00:00.000Z",
} as const;

const CONTENT: FormulationContent = {
	interpretation: "I read this as an identity lifecycle problem",
	focus: "the PaymentIntent that survives across attempts",
	implication: "look at where identity is created and retained first",
};

const V1 = {
	id: "formulation-v1",
	taskId: "task-1",
	ordinal: 1,
	recordedAt: base.timestamp,
	origin: "propose",
	content: CONTENT,
	reason: "first reading",
	sources: [{ kind: "prompt", promptId: "prompt-1" }],
} as const;

const V2 = { ...V1, id: "formulation-v2", ordinal: 2, previousVersionId: V1.id, reason: "the probe moved the reading" };

/** An active task with a first published reading — the state an approval is made against. */
function publishedEvents(): AgentSessionDomainEvent[] {
	return [
		{
			...base,
			eventId: "event-1",
			type: "TaskOpened",
			taskId: "task-1",
			initialPrompt: { id: "prompt-1", original: "check cache", effective: "check cache" },
			inheritedBeliefs: [],
		},
		{
			...base,
			eventId: "event-2",
			type: "TargetDefined",
			taskId: "task-1",
			target: { id: "target-1", statement: "check cache" },
		},
		{ ...base, eventId: "event-3", type: "EpisodeOpened", taskId: "task-1", episodeId: "episode-1", ordinal: 1 },
		{ ...base, eventId: "event-4", type: "ProblemFormulationRecorded", taskId: "task-1", version: V1 },
	];
}

type ApprovalEvent = Extract<AgentSessionDomainEvent, { type: "FormulationApproved" }>;

const approve = (versionId: string, eventId = "event-approve"): ApprovalEvent => ({
	...base,
	eventId,
	type: "FormulationApproved",
	taskId: "task-1",
	versionId,
	approvedAt: base.timestamp,
});

const taskAfter = (events: readonly AgentSessionDomainEvent[]) =>
	replayAgentSessionDomainEvents("session-1", events).tasks.get("task-1")!;

describe("explicit Frame approval", () => {
	it("records the approval against the version it names, leaving the correction slot untouched", () => {
		const task = taskAfter([...publishedEvents(), approve(V1.id)]);
		expect(task.formulationReview?.approval).toEqual({ versionId: V1.id, approvedAt: base.timestamp });
		// A correction is a different act: approving records no objection and no answer to one.
		expect(task.formulationReview?.responseCorrectionId).toBeUndefined();
		expect(task.formulationCorrections).toEqual([]);
	});

	it("refuses an unknown version, a superseded one, and an empty time", () => {
		const pattern = (fragment: string) =>
			new RegExp(`formulation approval ${fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

		expect(() => taskAfter([...publishedEvents(), approve("formulation-nope")])).toThrow(
			pattern("names unknown version formulation-nope"),
		);

		// A later publication replaces the reading, so approval of the earlier one is consent for
		// something nobody is looking at any more.
		expect(() =>
			taskAfter([
				...publishedEvents(),
				approve(V1.id),
				{ ...base, eventId: "event-v2", type: "ProblemFormulationRecorded", taskId: "task-1", version: V2 },
				approve(V1.id, "event-late"),
			]),
		).toThrow(pattern(`names ${V1.id}, which is not the current reading`));

		const blankApproval: ApprovalEvent = { ...approve(V1.id), approvedAt: "  " };
		expect(() => taskAfter([...publishedEvents(), blankApproval])).toThrow(pattern("has no recorded time"));
	});

	it("treats a repeated approval of the same version as a no-op rather than a second decision", () => {
		const snapshot = replayAgentSessionDomainEvents("session-1", [...publishedEvents(), approve(V1.id)]);
		const again = applyAgentSessionDomainEvent(snapshot, approve(V1.id, "event-approve-2"));
		expect(again).toBe(snapshot);
	});

	it("rejects a v6 log rather than reading its corrections as approvals", () => {
		expect(AGENT_SESSION_DOMAIN_SCHEMA_VERSION).toBe(7);
		const legacy = SessionManager.inMemory();
		legacy.appendCustomEntry(AGENT_SESSION_DOMAIN_CUSTOM_ENTRY, {
			schemaVersion: 6,
			event: { type: "TaskOpened", schemaVersion: 6, eventId: "event-old", timestamp: "2026-09-25T00:00:00Z" },
		});
		const before = JSON.stringify(legacy.getBranch());
		expect(() => replayAgentSessionDomainEntries(legacy.getSessionId(), legacy.getBranch())).toThrow(
			"schema v6, but this runtime requires v7",
		);
		// The old log is refused as written: no rewrite, no reinterpretation of its replies as consent.
		expect(JSON.stringify(legacy.getBranch())).toBe(before);
	});
});
