import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	ContextBudgetError,
	PhaseFourContextCompiler,
	PhaseOneContextCompiler,
	PhaseThreeContextCompiler,
	PhaseTwoContextCompiler,
	PhaseZeroContextCompiler,
} from "../src/core/context-compiler.ts";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

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

function user(text: string, timestamp: number): AgentMessage {
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

	it("retains the current Frame with its falsifier and finite remaining horizon", async () => {
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
					falsifier: "a worker restart preserves the authorization",
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
				"Falsifier: a worker restart preserves the authorization\nHorizon: 2 of 3 model responses remain",
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
					falsifier: "worker restart preserves the failure",
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
				"Falsifier: worker restart preserves the failure\nHorizon: 4 of 4 model responses remain",
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
					falsifier: "worker restart preserves the failure",
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
					falsifier: "cache bypass reproduces the failure",
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
});
