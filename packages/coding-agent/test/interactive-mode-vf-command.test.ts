import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import type { FrameActionGraph } from "../src/core/tools/frame-action-graph.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

import { FrameActionGraphSelectorComponent } from "../src/modes/interactive/components/frame-action-graph-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const graph: FrameActionGraph = {
	branchEventCount: 2,
	active: { frameRevisionEntryId: "frame-entry", actionStartEntryId: "action-entry" },
	nodes: [
		{
			kind: "frame",
			id: "frame-entry",
			frameId: "frame-1",
			version: 1,
			statement: "cache survives logout",
			falsifier: "restart preserves the failure",
			horizon: 8,
			completedModelResponses: 2,
			status: "active",
			sourceEventId: "request-1",
		},
		{
			kind: "action",
			id: "action-entry",
			actionId: "action-1",
			frameRevisionEntryId: "frame-entry",
			intent: "inspect cache lifetime",
			completionCondition: "identify the cache TTL",
			completedModelResponses: 1,
			status: "active",
			sourceEventId: "request-1",
		},
	],
	edges: [{ from: "frame-entry", to: "action-entry", relation: "authorizes" }],
};

type ViewFrameActionGraphContext = {
	agent: {
		state: {
			tools: Array<{
				name: string;
				execute: (toolCallId: string, params: object) => Promise<{ details?: { graph: FrameActionGraph } }>;
			}>;
		};
	};
	ui: { terminal: { rows: number }; requestRender: (force?: boolean) => void };
	showSelector: (
		create: (done: () => void) => {
			component: FrameActionGraphSelectorComponent;
			focus: FrameActionGraphSelectorComponent;
		},
	) => void;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleViewFrameActionGraphCommand(this: ViewFrameActionGraphContext): Promise<void>;
};

describe("InteractiveMode /vf command", () => {
	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("registers the built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "vf",
			description: "View the Frame/Action graph",
		});
	});

	it("runs view_frame_action_graph and displays it with the tree selector infrastructure", async () => {
		const execute = vi.fn(async () => ({ details: { graph } }));
		const requestRender = vi.fn();
		const showError = vi.fn();
		const showStatus = vi.fn();
		let component: FrameActionGraphSelectorComponent | undefined;
		const context: ViewFrameActionGraphContext = {
			agent: { state: { tools: [{ name: "view_frame_action_graph", execute }] } },
			ui: { terminal: { rows: 24 }, requestRender },
			showSelector: (create) => {
				component = create(() => {}).component;
			},
			showError,
			showStatus,
		};

		await interactiveModePrototype.handleViewFrameActionGraphCommand.call(context);

		expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^vf-/), {});
		expect(component).toBeInstanceOf(FrameActionGraphSelectorComponent);
		expect(component!.getTreeList().getSelectedNode()?.entry.id).toBe("action-entry");
		expect(component!.render(120).join("\n")).toContain("Frame / Action Graph · 2 state nodes · 1 edges");
		expect(showError).not.toHaveBeenCalled();
	});

	it("reports when the graph tool is unavailable", async () => {
		const showError = vi.fn();
		const context: ViewFrameActionGraphContext = {
			agent: { state: { tools: [] } },
			ui: { terminal: { rows: 24 }, requestRender: vi.fn() },
			showSelector: vi.fn(),
			showError,
			showStatus: vi.fn(),
		};

		await interactiveModePrototype.handleViewFrameActionGraphCommand.call(context);

		expect(showError).toHaveBeenCalledWith("view_frame_action_graph is not available in this session.");
		expect(context.showSelector).not.toHaveBeenCalled();
	});
});
