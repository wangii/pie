import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { FrameActionGraph } from "../src/core/tools/frame-action-graph.ts";
import {
	buildFrameActionGraphTree,
	FrameActionGraphSelectorComponent,
} from "../src/modes/interactive/components/frame-action-graph-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

const graph: FrameActionGraph = {
	branchEventCount: 5,
	active: { frameRevisionEntryId: "frame-v2", actionStartEntryId: "action-2" },
	nodes: [
		{
			kind: "frame",
			id: "frame-v1",
			frameId: "frame-1",
			version: 1,
			statement: "cache survives logout",
			falsifier: "restart preserves the failure",
			horizon: 8,
			completedModelResponses: 2,
			status: "revised",
			sourceEventId: "request-1",
		},
		{
			kind: "frame",
			id: "frame-v2",
			frameId: "frame-1",
			version: 2,
			statement: "worker cache survives logout",
			falsifier: "worker restart preserves the failure",
			horizon: 6,
			completedModelResponses: 1,
			status: "active",
			sourceEventId: "evidence-1",
		},
		{
			kind: "action",
			id: "action-1",
			actionId: "action-1",
			frameRevisionEntryId: "frame-v1",
			intent: "inspect cache lifetime",
			completionCondition: "identify the cache TTL",
			completedModelResponses: 1,
			status: "completed",
			sourceEventId: "request-1",
		},
		{
			kind: "action",
			id: "action-2",
			actionId: "action-2",
			frameRevisionEntryId: "frame-v2",
			intent: "trace logout invalidation",
			completionCondition: "determine whether workers receive invalidation",
			completedModelResponses: 0,
			status: "active",
			sourceEventId: "evidence-1",
		},
	],
	edges: [
		{ from: "frame-v1", to: "frame-v2", relation: "revises" },
		{ from: "frame-v1", to: "action-1", relation: "authorizes" },
		{ from: "frame-v2", to: "action-2", relation: "authorizes" },
	],
};

describe("FrameActionGraphSelectorComponent", () => {
	it("maps revisions and authorized Actions into /tree nodes", () => {
		const tree = buildFrameActionGraphTree(graph);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.entry.id).toBe("frame-v1");
		expect(tree[0]!.children.map((node) => node.entry.id)).toEqual(["frame-v2", "action-1"]);
		expect(tree[0]!.children[0]!.children[0]!.entry.id).toBe("action-2");
		expect(tree[0]!.children[0]!.label).toBe("active");
	});

	it("uses /tree navigation, search, folding, active markers, and width clipping", () => {
		const selector = new FrameActionGraphSelectorComponent(graph, 24, () => {});
		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe("action-2");

		const lines = selector.render(58).map(stripVTControlCharacters);
		const rendered = lines.join("\n");
		expect(rendered).toContain("Frame / Action Graph");
		expect(rendered).toContain("[active]");
		expect(rendered).toContain("Action action-2");
		expect(rendered).toContain("branch");
		expect(rendered).toContain("copy");
		expect(rendered).not.toContain("filters");
		expect(rendered).not.toContain("Actions under Frame");
		expect(lines.every((line) => visibleWidth(line) <= 58)).toBe(true);

		selector.handleInput("cache");
		expect(selector.render(120).map(stripVTControlCharacters).join("\n")).toContain("cache");
	});

	it("shows the Actions authorized by the selected Frame", () => {
		const selector = new FrameActionGraphSelectorComponent(graph, 24, () => {});

		selector.handleInput("\x1b[A");

		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe("frame-v2");
		const rendered = selector.render(120).map(stripVTControlCharacters).join("\n");
		expect(rendered).toContain("Actions under Frame frame-1 v2 (1)");
		expect(rendered).toContain("[active] Action action-2: trace logout invalidation");
	});
});
