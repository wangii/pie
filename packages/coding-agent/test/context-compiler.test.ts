import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	ContextBudgetError,
	EXECUTION_EVIDENCE_CONTEXT_MESSAGE_TYPE,
	PhaseFourContextCompiler,
	PhaseOneContextCompiler,
	PhaseThreeContextCompiler,
	PhaseTwoContextCompiler,
	PhaseZeroContextCompiler,
	summarizeContextSelection,
} from "../src/core/context-compiler.ts";
import { restoreEpistemicState } from "../src/core/epistemic-state.ts";
import { type SessionEntry, SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(contextWindow: number): Model<"faux"> {
	return {
		id: "faux-1",
		name: "Faux",
		api: "faux",
		provider: "faux",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8,
	};
}

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function text(message: AgentMessage): string {
	if (
		!(
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult" ||
			message.role === "custom"
		)
	)
		return "";
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

describe("PhaseZeroContextCompiler", () => {
	it("preserves the uncompressed transcript when it fits", async () => {
		const events: SessionEntry[] = [
			messageEntry("u1", null, user("first", 1)),
			messageEntry("a1", "u1", assistant("answer", 2)),
			messageEntry("u2", "a1", user("second", 3)),
		];

		const result = await new PhaseZeroContextCompiler().compile({
			rawEvents: events,
			epistemicState: {},
			runtimeMessages: events.flatMap((event) => (event.type === "message" ? [event.message] : [])),
			model: model(100),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text)).toEqual(["first", "answer", "second"]);
		expect(result.manifest.selectedEventIds).toEqual(["u1", "a1", "u2"]);
		expect(result.manifest.omissions).toEqual([]);
	});

	it("treats legacy summaries as provenance and compiles from raw messages", async () => {
		const events: SessionEntry[] = [
			messageEntry("u1", null, user("raw question", 1)),
			messageEntry("a1", "u1", assistant("raw answer", 2)),
			{
				type: "compaction",
				id: "compact",
				parentId: "a1",
				timestamp: new Date(3).toISOString(),
				summary: "narrative summary",
				firstKeptEntryId: "u1",
				tokensBefore: 50,
			},
			messageEntry("u2", "compact", user("continue", 4)),
		];

		const result = await new PhaseZeroContextCompiler().compile({
			rawEvents: events,
			epistemicState: {},
			runtimeMessages: [user("continue", 4)],
			model: model(100),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text)).toEqual(["raw question", "raw answer", "continue"]);
		expect(result.manifest.omissions).toContainEqual({
			eventId: "compact",
			eventType: "compaction",
			reason: "historical_summary",
		});
		expect(summarizeContextSelection(result.manifest)).toEqual({
			inputEventCount: 4,
			selectedEventCount: 3,
			excludedEventCount: 1,
			omissionsByReason: { historical_summary: 1 },
		});
	});

	it("drops whole older turns under budget pressure without mutating raw events", async () => {
		const events: SessionEntry[] = [
			messageEntry("u1", null, user("a".repeat(24), 1)),
			messageEntry("a1", "u1", assistant("b".repeat(24), 2)),
			messageEntry("u2", "a1", user("c".repeat(24), 3)),
			messageEntry("a2", "u2", assistant("d".repeat(24), 4)),
		];
		const rawCount = events.length;

		const result = await new PhaseZeroContextCompiler().compile({
			rawEvents: events,
			epistemicState: {},
			runtimeMessages: events.map((event) => (event as SessionMessageEntry).message),
			model: model(21),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text)).toEqual(["c".repeat(24), "d".repeat(24)]);
		expect(result.manifest.selectedEventIds).toEqual(["u2", "a2"]);
		expect(result.manifest.omissions.filter((omission) => omission.reason === "budget")).toHaveLength(2);
		expect(events).toHaveLength(rawCount);
	});

	it("keeps tool calls paired with their results", async () => {
		const toolCall = assistant("", 2);
		toolCall.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }];
		toolCall.stopReason = "toolUse";
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			details: {},
			isError: false,
			timestamp: 3,
		};
		const events: SessionEntry[] = [
			messageEntry("u1", null, user("read", 1)),
			messageEntry("a1", "u1", toolCall),
			messageEntry("t1", "a1", toolResult),
		];

		const result = await new PhaseZeroContextCompiler().compile({
			rawEvents: events,
			epistemicState: {},
			runtimeMessages: events.map((event) => (event as SessionMessageEntry).message),
			model: model(100),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("returns an actionable error when the newest coherent window cannot fit", async () => {
		const event = messageEntry("u1", null, user("x".repeat(80), 1));
		await expect(
			new PhaseZeroContextCompiler().compile({
				rawEvents: [event],
				epistemicState: {},
				runtimeMessages: [event.message],
				model: model(16),
				systemPrompt: "",
				tools: [],
				reservedOutputTokens: 8,
			}),
		).rejects.toBeInstanceOf(ContextBudgetError);
	});

	it("retains the Anchor while dropping older raw turns under pressure", async () => {
		const events: SessionEntry[] = [
			messageEntry("u1", null, user("a".repeat(24), 1)),
			messageEntry("a1", "u1", assistant("b".repeat(24), 2)),
			messageEntry("u2", "a1", user("c".repeat(24), 3)),
		];
		const result = await new PhaseOneContextCompiler().compile({
			rawEvents: events,
			epistemicState: {
				anchor: {
					id: "anchor-1",
					revision: 1,
					statement: "keep original",
					revisionEntryId: "ar1",
					previousRevisionId: null,
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
				},
			},
			runtimeMessages: events.map((event) => (event as SessionMessageEntry).message),
			model: model(30),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text)).toEqual(["[ANCHOR]\nkeep original", "c".repeat(24)]);
		expect(result.manifest.selectedEventIds).toEqual(["u2"]);
		expect(result.manifest.epistemicState.anchor).toMatchObject({ id: "anchor-1", revision: 1 });
	});

	it("retains the current Frame with its expectation and finite remaining horizon", async () => {
		const event = messageEntry("u1", null, user("inspect the failure", 1));
		const result = await new PhaseTwoContextCompiler().compile({
			rawEvents: [event],
			epistemicState: {
				anchor: {
					id: "anchor-1",
					revision: 1,
					statement: "restore authorization correctness",
					revisionEntryId: "ar1",
					previousRevisionId: null,
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
				},
				frame: {
					id: "frame-1",
					version: 2,
					statement: "worker-local state survives logout",
					expectation: "a worker restart preserves the authorization",
					horizon: 3,
					revisionEntryId: "fr2",
					previousRevisionId: "fr1",
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
					completedModelResponses: 1,
				},
			},
			runtimeMessages: [event.message],
			model: model(100),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text)).toEqual([
			"[ANCHOR]\nrestore authorization correctness",
			"[CURRENT FRAME]\nCommitment: worker-local state survives logout\n" +
				"Expectation: a worker restart preserves the authorization\nResponse lease: 1/3 completed; 2 model responses remain",
			"inspect the failure",
		]);
		expect(result.manifest.epistemicState.frame).toMatchObject({
			id: "frame-1",
			version: 2,
			completedModelResponses: 1,
			remainingModelResponses: 2,
		});
	});

	it("prioritizes current-Frame then Anchor Observations before older execution", async () => {
		const event = messageEntry("u1", null, user("continue investigation", 1));
		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: [event],
			epistemicState: {
				anchor: {
					id: "anchor-1",
					revision: 1,
					statement: "logout revokes authorization",
					revisionEntryId: "ar1",
					previousRevisionId: null,
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
				},
				frame: {
					id: "frame-1",
					version: 1,
					statement: "worker cache survives logout",
					expectation: "worker restart preserves the failure",
					horizon: 4,
					revisionEntryId: "fr1",
					previousRevisionId: null,
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
					completedModelResponses: 0,
				},
				observations: [
					{
						id: "old-frame",
						entryId: "o1",
						statement: "an earlier Frame had contrary evidence",
						sourceEventIds: ["t1"],
						frameId: "frame-old",
						frameRevisionEntryId: "fr-old",
						timestamp: new Date(2).toISOString(),
					},
					{
						id: "anchor-evidence",
						entryId: "o2",
						statement: "authorization remains after logout",
						sourceEventIds: ["t2"],
						anchorId: "anchor-1",
						anchorRevisionEntryId: "ar1",
						timestamp: new Date(3).toISOString(),
					},
					{
						id: "frame-evidence",
						entryId: "o3",
						statement: "worker cache TTL is 30 seconds",
						sourceEventIds: ["t3"],
						frameId: "frame-1",
						frameRevisionEntryId: "fr1",
						timestamp: new Date(4).toISOString(),
					},
				],
			},
			runtimeMessages: [event.message],
			model: model(200),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text).slice(0, 4)).toEqual([
			"[ANCHOR]\nlogout revokes authorization",
			"[CURRENT FRAME]\nCommitment: worker cache survives logout\n" +
				"Expectation: worker restart preserves the failure\nResponse lease: 0/4 completed; 4 model responses remain",
			"[OBSERVATION anchor-evidence]\nauthorization remains after logout\nRelevance: Anchor",
			"[OBSERVATION frame-evidence]\nworker cache TTL is 30 seconds\nRelevance: current Frame",
		]);
		expect(result.manifest.epistemicState.observations).toMatchObject({
			selected: [{ id: "anchor-evidence" }, { id: "frame-evidence" }],
			omitted: [{ id: "old-frame", reason: "not_relevant" }],
		});

		const stateManifest = result.manifest.epistemicState;
		const observationManifest = stateManifest.observations!;
		const userTokens =
			result.manifest.budget.selectedMessageTokens -
			stateManifest.anchor!.tokens -
			stateManifest.frame!.tokens -
			observationManifest.selected.reduce((sum, observation) => sum + observation.tokens, 0);
		const frameObservationTokens = observationManifest.selected.find(
			(observation) => observation.id === "frame-evidence",
		)!.tokens;
		const constrained = await new PhaseFourContextCompiler().compile({
			rawEvents: [event],
			epistemicState: {
				anchor: result.manifest.epistemicState.anchor
					? {
							id: "anchor-1",
							revision: 1,
							statement: "logout revokes authorization",
							revisionEntryId: "ar1",
							previousRevisionId: null,
							sourceEventId: "u1",
							timestamp: new Date(1).toISOString(),
						}
					: undefined,
				frame: {
					id: "frame-1",
					version: 1,
					statement: "worker cache survives logout",
					expectation: "worker restart preserves the failure",
					horizon: 4,
					revisionEntryId: "fr1",
					previousRevisionId: null,
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
					completedModelResponses: 0,
				},
				observations: [
					{
						id: "anchor-evidence",
						entryId: "o2",
						statement: "authorization remains after logout",
						sourceEventIds: ["t2"],
						anchorId: "anchor-1",
						anchorRevisionEntryId: "ar1",
						timestamp: new Date(3).toISOString(),
					},
					{
						id: "frame-evidence",
						entryId: "o3",
						statement: "worker cache TTL is 30 seconds",
						sourceEventIds: ["t3"],
						frameId: "frame-1",
						frameRevisionEntryId: "fr1",
						timestamp: new Date(4).toISOString(),
					},
				],
			},
			runtimeMessages: [event.message],
			model: model(500),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
			inputTokenLimit:
				result.manifest.budget.requiredTokens +
				stateManifest.anchor!.tokens +
				stateManifest.frame!.tokens +
				userTokens +
				frameObservationTokens,
		});
		expect(constrained.manifest.epistemicState.observations).toMatchObject({
			selected: [{ id: "frame-evidence" }],
			omitted: [{ id: "anchor-evidence", reason: "budget" }],
		});
	});

	it("uses a depth projection for execution and excludes controller decisions", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("diagnose cache behavior", 1));
		manager.appendAnchorRevision({
			anchorId: "anchor-1",
			revision: 1,
			statement: "diagnose cache behavior",
			previousRevisionId: null,
			sourceEventId: userId,
		});
		const frameControlId = manager.appendMessage(
			assistant(
				JSON.stringify({
					kind: "create_frame",
					statement: "Worker cache lifetime controls authorization",
					expectation: "A clean worker restart preserves the failure",
					horizon: 8,
				}),
				2,
			),
		);
		const frameRevisionId = manager.appendFrameRevision({
			frameId: "frame-1",
			version: 1,
			statement: "Worker cache lifetime controls authorization",
			expectation: "A clean worker restart preserves the failure",
			horizon: 8,
			previousRevisionId: null,
			sourceEventId: frameControlId,
		});
		const actionControlId = manager.appendMessage(
			assistant(
				JSON.stringify({
					kind: "authorize_action",
					intent: "Inspect worker cache lifetime",
					completionCondition: "Exact results establish the cache lifetime",
				}),
				3,
			),
		);
		manager.appendActionStart({
			actionId: "action-1",
			intent: "Inspect worker cache lifetime",
			completionCondition: "Exact results establish the cache lifetime",
			expectation: "Exact results establish the cache lifetime",
			frameRevisionEntryId: frameRevisionId,
			sourceEventId: actionControlId,
		});
		manager.appendMessage(
			assistant('Controller decision:\n{"operation":"continue_action","reason":"Need exact evidence"}', 4),
		);
		const toolCall = assistant("", 5);
		toolCall.content = [{ type: "toolCall", id: "cache-read", name: "read", arguments: { path: "cache.ts" } }];
		toolCall.stopReason = "toolUse";
		manager.appendMessage(toolCall);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "cache-read",
			toolName: "read",
			content: [{ type: "text", text: "ttl=30" }],
			details: {},
			isError: false,
			timestamp: 6,
		});
		const events = manager.getBranch();

		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: events,
			epistemicState: restoreEpistemicState(events),
			runtimeMessages: manager.buildSessionContext().messages,
			model: model(500),
			systemPrompt: "",
			tools: [],
			projectionRole: "execution",
			reservedOutputTokens: 8,
		});

		expect(result.manifest.projection).toMatchObject({
			role: "execution",
			policy: "commitment-depth/v1",
		});
		expect(result.messages.map(text)).toContain("ttl=30");
		expect(result.messages.map(text)).not.toContain("diagnose cache behavior");
		expect(result.messages.map(text).join("\n")).not.toContain("authorize_action");
		expect(result.messages.map(text).join("\n")).not.toContain("continue_action");
		expect(result.messages.map((message) => message.role).slice(-2)).toEqual(["assistant", "toolResult"]);
	});

	it("uses a breadth projection of completed Action outcomes and current feedback", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("diagnose authorization", 1));
		manager.appendAnchorRevision({
			anchorId: "anchor-1",
			revision: 1,
			statement: "diagnose authorization",
			previousRevisionId: null,
			sourceEventId: userId,
		});
		const frameControlId = manager.appendMessage(assistant('{"kind":"create_frame"}', 2));
		const frameRevisionId = manager.appendFrameRevision({
			frameId: "frame-1",
			version: 1,
			statement: "Worker cache lifetime controls authorization",
			expectation: "A clean worker restart preserves the failure",
			horizon: 12,
			previousRevisionId: null,
			sourceEventId: frameControlId,
		});
		const firstControlId = manager.appendMessage(assistant('{"kind":"authorize_action"}', 3));
		const firstStartId = manager.appendActionStart({
			actionId: "action-1",
			intent: "Inspect cache ownership",
			completionCondition: "The owning process is identified",
			expectation: "The owning process is identified",
			frameRevisionEntryId: frameRevisionId,
			sourceEventId: firstControlId,
		});
		manager.appendMessage(assistant("low-level first episode trace", 4));
		const firstCompletionId = manager.appendMessage(assistant('{"kind":"complete_action"}', 5));
		manager.appendActionTransition({
			actionId: "action-1",
			startEntryId: firstStartId,
			transition: "completed",
			sourceEventId: firstCompletionId,
			reason: "Exact results identified the worker process",
		});
		const secondControlId = manager.appendMessage(assistant('{"kind":"authorize_action"}', 6));
		manager.appendActionStart({
			actionId: "action-2",
			intent: "Inspect cache invalidation",
			completionCondition: "An exact result establishes invalidation behavior",
			expectation: "An exact result establishes invalidation behavior",
			frameRevisionEntryId: frameRevisionId,
			sourceEventId: secondControlId,
		});
		manager.appendMessage(assistant("current episode feedback", 7));
		const events = manager.getBranch();

		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: events,
			epistemicState: restoreEpistemicState(events),
			runtimeMessages: manager.buildSessionContext().messages,
			model: model(1_000),
			systemPrompt: "",
			tools: [],
			projectionRole: "epistemic",
			reservedOutputTokens: 8,
		});
		const texts = result.messages.map(text);

		expect(result.manifest.projection).toMatchObject({
			role: "epistemic",
			policy: "epistemic-breadth/v1",
			actionOutcomes: {
				selected: [{ actionId: "action-1", transition: "completed" }],
				omitted: [],
			},
		});
		expect(texts).toContain("diagnose authorization");
		expect(texts).toContain("current episode feedback");
		expect(texts.join("\n")).toContain("[ACTION OUTCOME action-1]");
		expect(texts.join("\n")).toContain("Worker cache lifetime controls authorization");
		expect(texts).not.toContain("low-level first episode trace");
		expect(texts.join("\n")).not.toContain("authorize_action");
	});

	it("retains a frozen Action and excludes execution before its episode source", async () => {
		const events: SessionEntry[] = [
			messageEntry("u1", null, user("old investigation", 1)),
			messageEntry("a1", "u1", assistant("old result", 2)),
			messageEntry("u2", "a1", user("start bounded action", 3)),
		];
		const result = await new PhaseThreeContextCompiler().compile({
			rawEvents: events,
			epistemicState: {
				anchor: {
					id: "anchor-1",
					revision: 1,
					statement: "identify the defect",
					revisionEntryId: "ar1",
					previousRevisionId: null,
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
				},
				frame: {
					id: "frame-1",
					version: 1,
					statement: "the cache is stale",
					expectation: "cache bypass reproduces the failure",
					horizon: 4,
					revisionEntryId: "fr1",
					previousRevisionId: null,
					sourceEventId: "u1",
					timestamp: new Date(1).toISOString(),
					completedModelResponses: 1,
				},
				action: {
					id: "action-1",
					intent: "inspect cache ownership",
					completionCondition: "the owning process is identified",
					expectation: "the owning process is identified",
					startEntryId: "as1",
					frameRevisionEntryId: "fr1",
					sourceEventId: "u2",
					timestamp: new Date(3).toISOString(),
					completedModelResponses: 0,
				},
			},
			runtimeMessages: events.map((event) => (event as SessionMessageEntry).message),
			model: model(200),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text).at(-1)).toBe("start bounded action");
		expect(result.messages.map(text)).not.toContain("old investigation");
		expect(result.manifest.selectedEventIds).toEqual(["u2"]);
		expect(result.manifest.omissions.filter(({ reason }) => reason === "outside_action_episode")).toHaveLength(2);
		expect(result.manifest.epistemicState.action).toMatchObject({ id: "action-1", startEntryId: "as1" });
	});

	it("projects terminal Frame outcomes with expectation and reason into the epistemic breadth projection", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("diagnose authorization", 1));
		manager.appendAnchorRevision({
			anchorId: "anchor-1",
			revision: 1,
			statement: "diagnose authorization",
			previousRevisionId: null,
			sourceEventId: userId,
		});
		const frameControlId = manager.appendMessage(assistant('{"kind":"create_frame"}', 2));
		const frameRevisionId = manager.appendFrameRevision({
			frameId: "frame-1",
			version: 1,
			statement: "Worker cache lifetime controls authorization",
			expectation: "A clean worker restart preserves the failure",
			horizon: 12,
			previousRevisionId: null,
			sourceEventId: frameControlId,
		});
		const actionControlId = manager.appendMessage(assistant('{"kind":"authorize_action"}', 3));
		const actionStartId = manager.appendActionStart({
			actionId: "action-1",
			intent: "Inspect cache ownership",
			completionCondition: "The owning process is identified",
			expectation: "The owning process is identified",
			frameRevisionEntryId: frameRevisionId,
			sourceEventId: actionControlId,
		});
		manager.appendMessage(assistant("low-level episode trace", 4));
		const unresolvableControlId = manager.appendMessage(assistant('{"kind":"unresolvable_action"}', 5));
		manager.appendActionTransition({
			actionId: "action-1",
			startEntryId: actionStartId,
			transition: "unresolvable",
			sourceEventId: unresolvableControlId,
			reason: "The owning process cannot be identified under the current constraints",
		});
		const killControlId = manager.appendMessage(assistant('{"kind":"falsify_frame"}', 6));
		manager.appendFrameTransition({
			frameId: "frame-1",
			version: 1,
			revisionEntryId: frameRevisionId,
			transition: "expired",
			sourceEventId: killControlId,
			reason: "Frame reached its 12-response horizon before any Action satisfied its completion condition",
		});
		const events = manager.getBranch();
		const epistemicState = restoreEpistemicState(events);

		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: events,
			epistemicState,
			runtimeMessages: manager.buildSessionContext().messages,
			model: model(1_000),
			systemPrompt: "",
			tools: [],
			projectionRole: "epistemic",
			reservedOutputTokens: 8,
		});
		const texts = result.messages.map(text);

		expect(epistemicState.frame).toBeUndefined();
		expect(result.manifest.projection).toMatchObject({
			role: "epistemic",
			frameOutcomes: {
				selected: [{ frameId: "frame-1", transition: "expired" }],
				omitted: [],
			},
		});
		expect(texts.join("\n")).toContain("[FRAME OUTCOME frame-1]");
		expect(texts.join("\n")).toContain("[ACTION OUTCOME action-1]");
		expect(texts.join("\n")).toContain("Worker cache lifetime controls authorization");
		expect(texts.join("\n")).toContain("A clean worker restart preserves the failure");
		expect(texts.join("\n")).toContain("reached its 12-response horizon");
	});

	it("omits terminal Frame outcomes from the default transcript projection", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("diagnose authorization", 1));
		manager.appendAnchorRevision({
			anchorId: "anchor-1",
			revision: 1,
			statement: "diagnose authorization",
			previousRevisionId: null,
			sourceEventId: userId,
		});
		const frameControlId = manager.appendMessage(assistant('{"kind":"create_frame"}', 2));
		const frameRevisionId = manager.appendFrameRevision({
			frameId: "frame-1",
			version: 1,
			statement: "Worker cache lifetime controls authorization",
			expectation: "A clean worker restart preserves the failure",
			horizon: 12,
			previousRevisionId: null,
			sourceEventId: frameControlId,
		});
		const killControlId = manager.appendMessage(assistant('{"kind":"falsify_frame"}', 3));
		manager.appendFrameTransition({
			frameId: "frame-1",
			version: 1,
			revisionEntryId: frameRevisionId,
			transition: "falsified",
			sourceEventId: killControlId,
			reason: "The expectation fired",
		});
		const events = manager.getBranch();

		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: events,
			epistemicState: restoreEpistemicState(events),
			runtimeMessages: manager.buildSessionContext().messages,
			model: model(1_000),
			systemPrompt: "",
			tools: [],
			reservedOutputTokens: 8,
		});

		expect(result.messages.map(text).join("\n")).not.toContain("[FRAME OUTCOME");
		expect(result.manifest.projection.frameOutcomes).toBeUndefined();
	});

	it("summarizes finalized tool results from a terminal Action episode into execution evidence", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("diagnose authorization", 1));
		manager.appendAnchorRevision({
			anchorId: "anchor-1",
			revision: 1,
			statement: "diagnose authorization",
			previousRevisionId: null,
			sourceEventId: userId,
		});
		const frameControlId = manager.appendMessage(assistant('{"kind":"create_frame"}', 2));
		const frameRevisionId = manager.appendFrameRevision({
			frameId: "frame-1",
			version: 1,
			statement: "Worker cache lifetime controls authorization",
			expectation: "A clean worker restart preserves the failure",
			horizon: 12,
			previousRevisionId: null,
			sourceEventId: frameControlId,
		});
		const actionControlId = manager.appendMessage(assistant('{"kind":"authorize_action"}', 3));
		const actionStartId = manager.appendActionStart({
			actionId: "action-1",
			intent: "Inspect cache ownership",
			completionCondition: "The owning process is identified",
			expectation: "The owning process is identified",
			frameRevisionEntryId: frameRevisionId,
			sourceEventId: actionControlId,
		});

		const firstCall = assistant("", 4);
		firstCall.content = [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }];
		firstCall.stopReason = "toolUse";
		manager.appendMessage(firstCall);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "first evidence" }],
			details: {},
			isError: false,
			timestamp: 5,
		});

		const secondCall = assistant("", 6);
		secondCall.content = [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "b.ts" } }];
		secondCall.stopReason = "toolUse";
		manager.appendMessage(secondCall);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "read-2",
			toolName: "read",
			content: [{ type: "text", text: "second evidence" }],
			details: {},
			isError: false,
			timestamp: 7,
		});

		const unresolvableControlId = manager.appendMessage(assistant('{"kind":"unresolvable_action"}', 8));
		manager.appendActionTransition({
			actionId: "action-1",
			startEntryId: actionStartId,
			transition: "unresolvable",
			sourceEventId: unresolvableControlId,
			reason: "The completion condition cannot be met under the current constraints",
		});
		const killControlId = manager.appendMessage(assistant('{"kind":"falsify_frame"}', 9));
		manager.appendFrameTransition({
			frameId: "frame-1",
			version: 1,
			revisionEntryId: frameRevisionId,
			transition: "expired",
			sourceEventId: killControlId,
			reason: "Frame reached its horizon",
		});
		const events = manager.getBranch();

		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: events,
			epistemicState: restoreEpistemicState(events),
			runtimeMessages: manager.buildSessionContext().messages,
			model: model(1_000),
			systemPrompt: "",
			tools: [],
			projectionRole: "epistemic",
			reservedOutputTokens: 8,
		});
		const texts = result.messages.map(text);

		expect(texts.join("\n")).toContain("first evidence");
		expect(texts.join("\n")).toContain("second evidence");
	});

	it("replaces raw tool-call/tool-result traffic with a bounded execution-evidence summary", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("diagnose authorization", 1));
		manager.appendAnchorRevision({
			anchorId: "anchor-1",
			revision: 1,
			statement: "diagnose authorization",
			previousRevisionId: null,
			sourceEventId: userId,
		});
		const frameControlId = manager.appendMessage(assistant('{"kind":"create_frame"}', 2));
		const frameRevisionId = manager.appendFrameRevision({
			frameId: "frame-1",
			version: 1,
			statement: "Worker cache lifetime controls authorization",
			expectation: "A clean worker restart preserves the failure",
			horizon: 12,
			previousRevisionId: null,
			sourceEventId: frameControlId,
		});
		const actionControlId = manager.appendMessage(assistant('{"kind":"authorize_action"}', 3));
		const actionStartId = manager.appendActionStart({
			actionId: "action-1",
			intent: "Inspect cache ownership",
			completionCondition: "The owning process is identified",
			expectation: "The owning process is identified",
			frameRevisionEntryId: frameRevisionId,
			sourceEventId: actionControlId,
		});

		const call = assistant("", 4);
		call.content = [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "big.ts" } }];
		call.stopReason = "toolUse";
		manager.appendMessage(call);
		const huge = "x".repeat(3000);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: huge }],
			details: {},
			isError: false,
			timestamp: 5,
		});

		const unresolvableControlId = manager.appendMessage(assistant('{"kind":"unresolvable_action"}', 6));
		manager.appendActionTransition({
			actionId: "action-1",
			startEntryId: actionStartId,
			transition: "unresolvable",
			sourceEventId: unresolvableControlId,
			reason: "The completion condition cannot be met under the current constraints",
		});
		const events = manager.getBranch();

		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: events,
			epistemicState: restoreEpistemicState(events),
			runtimeMessages: manager.buildSessionContext().messages,
			model: model(100_000),
			systemPrompt: "",
			tools: [],
			projectionRole: "epistemic",
			reservedOutputTokens: 8,
		});
		// Structured tool traffic never reaches the controller.
		expect(result.messages.map((message) => message.role)).not.toContain("toolResult");
		expect(
			result.messages.some(
				(message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
			),
		).toBe(false);

		// A single derived evidence message carries a bounded probe summary instead.
		const evidence = result.messages.find(
			(message) => message.role === "custom" && message.customType === EXECUTION_EVIDENCE_CONTEXT_MESSAGE_TYPE,
		);
		expect(evidence).toBeDefined();
		const evidenceText = text(evidence!);
		expect(evidenceText).toContain("read");
		expect(evidenceText).toContain("[excerpted");
		expect(evidenceText).not.toContain(huge);
	});

	it("injects prior Actions' located probes into the execution projection", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage(user("map prompt construction sites", 1));
		const anchorRevisionId = manager.appendAnchorRevision({
			anchorId: "anchor-1",
			revision: 1,
			statement: "map prompt construction sites",
			previousRevisionId: null,
			sourceEventId: userId,
		});

		// A completed explore episode that already located the compiler path.
		const exploreControlId = manager.appendMessage(assistant('{"kind":"explore"}', 2));
		const firstActionStartId = manager.appendActionStart({
			actionId: "action-1",
			intent: "Locate the compiler",
			completionCondition: "The compiler path is known",
			expectation: "The compiler lives under packages/coding-agent/src/core",
			anchorRevisionEntryId: anchorRevisionId,
			sourceEventId: exploreControlId,
		});
		const findCall = assistant("", 3);
		findCall.content = [
			{ type: "toolCall", id: "find-1", name: "find", arguments: { pattern: "context-compiler.ts" } },
		];
		findCall.stopReason = "toolUse";
		manager.appendMessage(findCall);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "find-1",
			toolName: "find",
			content: [{ type: "text", text: "packages/coding-agent/src/core/context-compiler.ts" }],
			details: {},
			isError: false,
			timestamp: 4,
		});
		const unresolvableControlId = manager.appendMessage(assistant('{"kind":"unresolvable_action"}', 5));
		manager.appendActionTransition({
			actionId: "action-1",
			startEntryId: firstActionStartId,
			transition: "unresolvable",
			sourceEventId: unresolvableControlId,
			reason: "budget exhausted",
		});

		// The active Action is a fresh episode with no memory of the prior probe.
		const secondControlId = manager.appendMessage(assistant('{"kind":"explore"}', 6));
		manager.appendActionStart({
			actionId: "action-2",
			intent: "Read the compiler",
			completionCondition: "The compiler structure is read",
			expectation: "The compiler structure is readable",
			anchorRevisionEntryId: anchorRevisionId,
			sourceEventId: secondControlId,
		});

		const events = manager.getBranch();
		const result = await new PhaseFourContextCompiler().compile({
			rawEvents: events,
			epistemicState: restoreEpistemicState(events),
			runtimeMessages: manager.buildSessionContext().messages,
			model: model(1_000),
			systemPrompt: "",
			tools: [],
			projectionRole: "execution",
			reservedOutputTokens: 8,
		});
		const texts = result.messages.map(text);

		expect(texts.join("\n")).toContain("[PRIOR EXECUTION EVIDENCE]");
		expect(texts.join("\n")).toContain("context-compiler.ts");
	});
});
