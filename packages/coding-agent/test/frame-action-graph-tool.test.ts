import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	buildFrameActionGraph,
	createFrameActionGraphTool,
	type FrameActionGraph,
} from "../src/core/tools/frame-action-graph.ts";
import { createHarness } from "./suite/harness.ts";
import { assistantMsg } from "./utilities.ts";

const timestamp = new Date(0).toISOString();

const entries: SessionEntry[] = [
	{
		type: "frame_revision",
		id: "frame-v1-entry",
		parentId: null,
		timestamp,
		frameId: "frame-1",
		version: 1,
		statement: "cache survives logout",
		expectation: "restart preserves the failure",
		horizon: 8,
		previousRevisionId: null,
		sourceEventId: "request-1",
	},
	{
		type: "frame_revision",
		id: "frame-v2-entry",
		parentId: "frame-v1-entry",
		timestamp,
		frameId: "frame-1",
		version: 2,
		statement: "worker cache survives logout",
		expectation: "worker restart preserves the failure",
		horizon: 6,
		previousRevisionId: "frame-v1-entry",
		sourceEventId: "evidence-1",
	},
	{
		type: "action_start",
		id: "action-1-entry",
		parentId: "frame-v2-entry",
		timestamp,
		actionId: "action-1",
		intent: "inspect worker cache lifetime",
		completionCondition: "identify the cache TTL",
		frameRevisionEntryId: "frame-v2-entry",
		sourceEventId: "request-1",
	},
	{
		type: "message",
		id: "assistant-1",
		parentId: "action-1-entry",
		timestamp,
		message: assistantMsg("TTL found"),
	},
	{
		type: "action_transition",
		id: "action-1-transition",
		parentId: "assistant-1",
		timestamp,
		actionId: "action-1",
		startEntryId: "action-1-entry",
		transition: "completed",
		sourceEventId: "assistant-1",
		reason: "TTL identified",
	},
	{
		type: "frame_transition",
		id: "frame-1-transition",
		parentId: "action-1-transition",
		timestamp,
		frameId: "frame-1",
		version: 2,
		revisionEntryId: "frame-v2-entry",
		transition: "replaced",
		sourceEventId: "assistant-1",
		reason: "investigate invalidation instead",
		replacementFrameId: "frame-2",
	},
	{
		type: "frame_revision",
		id: "frame-2-entry",
		parentId: "frame-1-transition",
		timestamp,
		frameId: "frame-2",
		version: 1,
		statement: "logout misses worker invalidation",
		expectation: "logout broadcasts invalidation",
		horizon: 4,
		previousRevisionId: null,
		sourceEventId: "evidence-2",
	},
	{
		type: "action_start",
		id: "action-2-entry",
		parentId: "frame-2-entry",
		timestamp,
		actionId: "action-2",
		intent: "trace logout invalidation",
		completionCondition: "determine whether workers receive invalidation",
		frameRevisionEntryId: "frame-2-entry",
		sourceEventId: "evidence-2",
	},
];

describe("view_frame_action_graph tool", () => {
	it("projects Frame chains and authorized Action episodes without changing entries", () => {
		const before = structuredClone(entries);
		const graph = buildFrameActionGraph(entries);

		expect(entries).toEqual(before);
		expect(graph.active).toEqual({
			frameRevisionEntryId: "frame-2-entry",
			actionStartEntryId: "action-2-entry",
		});
		expect(graph.nodes.filter((node) => node.kind === "frame" || node.kind === "action")).toMatchObject([
			{ id: "frame-v1-entry", kind: "frame", status: "revised" },
			{ id: "frame-v2-entry", kind: "frame", status: "replaced", completedModelResponses: 1 },
			{ id: "action-1-entry", kind: "action", status: "completed", completedModelResponses: 1 },
			{ id: "frame-2-entry", kind: "frame", status: "active" },
			{ id: "action-2-entry", kind: "action", status: "active" },
		]);
		expect(graph.edges.filter((edge) => edge.relation !== "contains")).toEqual([
			{ from: "frame-v1-entry", to: "frame-v2-entry", relation: "revises" },
			{ from: "frame-v2-entry", to: "action-1-entry", relation: "authorizes" },
			{ from: "frame-v2-entry", to: "frame-2-entry", relation: "replaces" },
			{ from: "frame-2-entry", to: "action-2-entry", relation: "authorizes" },
		]);
	});

	it("includes every provisional contract and the response/tool-call/result structure under its Action", () => {
		const decision: AssistantMessage = assistantMsg("");
		decision.content = [
			{
				type: "text",
				text: JSON.stringify({
					kind: "create_frame",
					statement: "cache state survives logout",
					expectation: "logout invalidates every worker cache",
					actions: [
						{
							intent: "locate cache prompt sites",
							completionCondition: "record every prompt location",
							expectedEvidenceRounds: 1,
							budgetReason: "one parallel discovery round",
						},
						{
							intent: "read the located prompt sites",
							completionCondition: "record each complete prompt",
							expectedEvidenceRounds: 2,
							budgetReason: "the read paths depend on the preceding discovery result",
						},
					],
				}),
			},
		];
		const execution: AssistantMessage = assistantMsg("");
		execution.content = [
			{ type: "text", text: "Locating prompt sites" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "rg prompt src" } },
		];
		execution.stopReason = "toolUse";
		const detailedEntries: SessionEntry[] = [
			{ type: "message", id: "controller", parentId: null, timestamp, message: decision },
			{
				type: "frame_revision",
				id: "frame-entry",
				parentId: "controller",
				timestamp,
				frameId: "frame-1",
				version: 1,
				statement: "cache state survives logout",
				expectation: "logout invalidates every worker cache",
				horizon: 9,
				previousRevisionId: null,
				sourceEventId: "controller",
			},
			{
				type: "action_start",
				id: "action-entry",
				parentId: "frame-entry",
				timestamp,
				actionId: "action-1",
				intent: "locate cache prompt sites",
				completionCondition: "record every prompt location",
				frameRevisionEntryId: "frame-entry",
				sourceEventId: "controller",
			},
			{ type: "message", id: "response-entry", parentId: "action-entry", timestamp, message: execution },
			{
				type: "message",
				id: "result-entry",
				parentId: "response-entry",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "src/prompt.ts:42" }],
					details: {},
					isError: false,
					timestamp: 0,
				},
			},
		];

		const graph = buildFrameActionGraph(detailedEntries);
		const plans = graph.nodes.filter((node) => node.kind === "plannedAction");
		expect(plans).toMatchObject([
			{ contractId: "A1", status: "authorized", actionStartEntryId: "action-entry" },
			{ contractId: "A2", status: "planned", expectedEvidenceRounds: 2 },
		]);
		expect(graph.nodes).toContainEqual(
			expect.objectContaining({ kind: "response", id: "response-entry", toolCallCount: 1 }),
		);
		expect(graph.nodes).toContainEqual(
			expect.objectContaining({ kind: "toolCall", toolCallId: "call-1", toolName: "bash" }),
		);
		expect(graph.nodes).toContainEqual(
			expect.objectContaining({ kind: "toolResult", id: "result-entry", output: "src/prompt.ts:42" }),
		);
		expect(graph.edges).toContainEqual({
			from: "frame-entry:contract:A1",
			to: "action-entry",
			relation: "instantiates",
		});
	});

	it("reads the latest branch snapshot and returns the graph as structured JSON", async () => {
		let currentEntries: readonly SessionEntry[] = [];
		const tool = createFrameActionGraphTool({ getEntries: () => currentEntries });

		currentEntries = entries;
		const result = await tool.execute("graph-call", {});
		const text = result.content.find((part) => part.type === "text")?.text;
		const graph = JSON.parse(text ?? "{}") as FrameActionGraph;

		expect(graph.branchEventCount).toBe(entries.length);
		expect(graph.active.actionStartEntryId).toBe("action-2-entry");
		expect(graph.nodes.find((node) => node.id === "action-1-entry")).toMatchObject({
			kind: "action",
			completionCondition: "identify the cache TTL",
			status: "completed",
			transitionReason: "TTL identified",
		});
	});

	it("is active by default for Frame-enabled sessions and reads their live branch", async () => {
		const harness = await createHarness({
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: false,
		});
		try {
			const sourceEventId = harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "inspect the cache" }],
				timestamp: Date.now(),
			});
			harness.sessionManager.appendAnchorRevision({
				anchorId: "anchor-live",
				revision: 1,
				statement: "inspect the cache",
				previousRevisionId: null,
				sourceEventId,
			});
			const frameRevisionEntryId = harness.sessionManager.appendFrameRevision({
				frameId: "frame-live",
				version: 1,
				statement: "cache state is stale",
				expectation: "cache state is refreshed",
				horizon: 4,
				previousRevisionId: null,
				sourceEventId,
			});
			harness.sessionManager.appendActionStart({
				actionId: "action-live",
				intent: "read cache state",
				completionCondition: "determine whether state is stale",
				frameRevisionEntryId,
				sourceEventId,
			});

			const tool = harness.session.state.tools.find((candidate) => candidate.name === "view_frame_action_graph");
			expect(tool).toBeDefined();
			const result = await tool!.execute("live-graph-call", {});
			const text = result.content.find((part) => part.type === "text")?.text;
			const graph = JSON.parse(text ?? "{}") as FrameActionGraph;

			expect(graph.active.actionStartEntryId).toBe(
				harness.sessionManager.getBranch().find((entry) => entry.type === "action_start")?.id,
			);
			expect(graph.nodes).toContainEqual(
				expect.objectContaining({ kind: "action", actionId: "action-live", status: "active" }),
			);
		} finally {
			harness.cleanup();
		}
	});
});
