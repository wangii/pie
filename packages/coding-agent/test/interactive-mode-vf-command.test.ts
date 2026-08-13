import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

const externalEditorMocks = vi.hoisted(() => ({
	editInExternalEditor: vi.fn(),
}));

vi.mock("../src/modes/interactive/external-editor.ts", () => externalEditorMocks);

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ViewFrameActionGraphContext = {
	agent: {
		state: {
			tools: Array<{
				name: string;
				execute: (
					toolCallId: string,
					params: object,
				) => Promise<{
					content: Array<{ type: "text"; text: string }>;
				}>;
			}>;
		};
	};
	settingsManager: { getExternalEditorCommand: () => string };
	ui: { stop: () => void; start: () => void; requestRender: (force?: boolean) => void };
	showError: (message: string) => void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleViewFrameActionGraphCommand(this: ViewFrameActionGraphContext): Promise<void>;
};

describe("InteractiveMode /vf command", () => {
	beforeEach(() => {
		externalEditorMocks.editInExternalEditor.mockReset();
		externalEditorMocks.editInExternalEditor.mockResolvedValue({ status: "complete", content: "ignored edits" });
	});

	it("registers the built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "vf",
			description: "View the Frame/Action graph in an external editor",
		});
	});

	it("runs view_frame_action_graph and opens its text output externally", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: '{"nodes":[]}' }],
		}));
		const stop = vi.fn();
		const start = vi.fn();
		const requestRender = vi.fn();
		const showError = vi.fn();
		const context: ViewFrameActionGraphContext = {
			agent: { state: { tools: [{ name: "view_frame_action_graph", execute }] } },
			settingsManager: { getExternalEditorCommand: () => "code --wait" },
			ui: { stop, start, requestRender },
			showError,
		};

		await interactiveModePrototype.handleViewFrameActionGraphCommand.call(context);

		expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^vf-/), {});
		expect(externalEditorMocks.editInExternalEditor).toHaveBeenCalledWith({
			command: "code --wait",
			content: '{"nodes":[]}',
		});
		expect(stop).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(showError).not.toHaveBeenCalled();
	});

	it("reports when the graph tool is unavailable", async () => {
		const showError = vi.fn();
		const context: ViewFrameActionGraphContext = {
			agent: { state: { tools: [] } },
			settingsManager: { getExternalEditorCommand: () => "nano" },
			ui: { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
			showError,
		};

		await interactiveModePrototype.handleViewFrameActionGraphCommand.call(context);

		expect(showError).toHaveBeenCalledWith("view_frame_action_graph is not available in this session.");
		expect(externalEditorMocks.editInExternalEditor).not.toHaveBeenCalled();
	});
});
