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
		falsifier: "restart preserves the failure",
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
		falsifier: "worker restart preserves the failure",
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
		falsifier: "logout broadcasts invalidation",
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
		expect(graph.nodes).toMatchObject([
			{ id: "frame-v1-entry", kind: "frame", status: "revised" },
			{ id: "frame-v2-entry", kind: "frame", status: "replaced", completedModelResponses: 1 },
			{ id: "action-1-entry", kind: "action", status: "completed", completedModelResponses: 1 },
			{ id: "frame-2-entry", kind: "frame", status: "active" },
			{ id: "action-2-entry", kind: "action", status: "active" },
		]);
		expect(graph.edges).toEqual([
			{ from: "frame-v1-entry", to: "frame-v2-entry", relation: "revises" },
			{ from: "frame-v2-entry", to: "action-1-entry", relation: "authorizes" },
			{ from: "frame-v2-entry", to: "frame-2-entry", relation: "replaces" },
			{ from: "frame-2-entry", to: "action-2-entry", relation: "authorizes" },
		]);
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
				falsifier: "cache state is refreshed",
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
