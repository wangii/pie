import { beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

/**
 * The `/frame` command surface, driven the way the terminal's own tests drive `InteractiveMode`:
 * a fabricated `this` with only the collaborators the handler touches. What is pinned here is the
 * routing — which argument opens the view and which one submits a correction — and that a
 * correction the user typed actually reaches the session rather than being swallowed by the UI.
 */

interface FakeContext {
	session: { submitFormulationCorrection: (text: string) => { id: string } | undefined };
	submitted: string[];
	statuses: string[];
	opened: number;
}

type FrameHandlers = {
	handleFrameCommand(this: unknown, argument: string): void;
	handleFrameToggleCommand(this: unknown): void;
	submitFrameCorrection(this: unknown, text: string): void;
};

const handlers = InteractiveMode.prototype as unknown as FrameHandlers;
const correctionHandler = handlers.submitFrameCorrection;

function createContext(): FakeContext {
	const context: FakeContext = {
		session: {
			submitFormulationCorrection: (text: string) => {
				context.submitted.push(text);
				return { id: "formulation-correction-1" };
			},
		},
		submitted: [],
		statuses: [],
		opened: 0,
	};
	return Object.assign(context, {
		chatContainer: { addChild: () => {}, clear: () => {} },
		ui: { requestRender: () => {} },
		showStatus: (message: string) => context.statuses.push(message),
		showFrameView: () => {
			context.opened += 1;
		},
		submitFrameCorrection: (text: string) => correctionHandler.call(context, text),
	});
}

describe("/frame command", () => {
	it("is listed as a built-in command so it autocompletes", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "frame");
		expect(command).toBeDefined();
		expect(command?.argumentHint).toContain("correct");
	});

	it("opens the view with no argument, and submits a correction with one", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "");
		expect(context.opened).toBe(1);
		expect(context.submitted).toEqual([]);

		handlers.handleFrameCommand.call(context, " history ");
		expect(context.opened).toBe(2);

		handlers.handleFrameCommand.call(context, " correct you are looking at the wrong target");
		expect(context.submitted).toEqual(["you are looking at the wrong target"]);
	});

	it("refuses a correction with no text instead of recording an empty one", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "correct   ");
		expect(context.submitted).toEqual([]);
		expect(context.statuses.join("\n")).toContain("Usage: /frame correct");
	});

	it("explains an unknown argument rather than doing nothing", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "nonsense");
		expect(context.submitted).toEqual([]);
		expect(context.opened).toBe(0);
		expect(context.statuses.join("\n")).toContain("Usage: /frame");
	});

	it("does not report success when no task is open to correct", () => {
		const context = createContext();
		context.session.submitFormulationCorrection = () => undefined;
		handlers.handleFrameCommand.call(context, "correct fix it");
		expect(context.statuses.join("\n")).toContain("No active task to correct");
	});

	it("toggles the panel through the keybinding handler", () => {
		const visible: boolean[] = [];
		const context = Object.assign(createContext(), {
			framePanelVisible: true,
			framePanel: { setVisible: (value: boolean) => visible.push(value) },
		});
		handlers.handleFrameToggleCommand.call(context);
		handlers.handleFrameToggleCommand.call(context);
		expect(visible).toEqual([false, true]);
		expect(context.statuses).toEqual(["Frame panel hidden", "Frame panel shown"]);
	});
});
