import { beforeAll, describe, expect, it } from "vitest";
import type { FormulationState, ProblemFormulationVersion } from "../src/core/agent-session-domain.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import type { FrameView } from "../src/modes/interactive/components/frame-panel.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

/**
 * The `/frame` command surface, driven the way the terminal's own tests drive `InteractiveMode`:
 * a fabricated `this` with only the collaborators the handlers touch. What is pinned here is the
 * routing — which argument opens the dock region, which one hides it, which one submits a
 * correction — and that opening the region never touches the editor container, because the whole
 * point of the region is that the user can keep typing while the reading is on screen.
 */

interface FakeContext {
	session: { submitFormulationCorrection: (text: string) => { id: string } | undefined };
	submitted: string[];
	statuses: string[];
	frameDetailVisible: boolean;
	detailVisibility: boolean[];
	/** Every call the handlers make on the editor container; must stay empty. */
	editorCalls: string[];
	transcript: unknown[];
}

type FrameHandlers = {
	handleFrameCommand(this: unknown, argument: string): void;
	handleFrameToggleCommand(this: unknown): void;
	submitFrameCorrection(this: unknown, text: string): void;
	showFrameDetail(this: unknown): void;
	hideFrameDetail(this: unknown): void;
	writeFrameDetailToTranscript(this: unknown): void;
};

const handlers = InteractiveMode.prototype as unknown as FrameHandlers;
const correctionHandler = handlers.submitFrameCorrection;
const showHandler = handlers.showFrameDetail;
const hideHandler = handlers.hideFrameDetail;
const transcriptHandler = handlers.writeFrameDetailToTranscript;

function version(): ProblemFormulationVersion {
	return {
		id: "formulation-1",
		taskId: "task-1",
		ordinal: 1,
		recordedAt: "2026-09-20T10:01:00.000Z",
		origin: "propose",
		content: {
			interpretation: "I read this as a reading shown beside the editor",
			focus: "whether the editor keeps focus",
			implication: "where the reading is drawn",
		},
		reason: "reason 1",
		sources: [],
	};
}

function frameView(): FrameView {
	const state: FormulationState = {
		current: version(),
		deferral: null,
		corrections: [],
		decisionOwed: false,
		recheckOwed: false,
		recheck: null,
		pendingApplicability: [],
		unrevalidated: [],
	};
	return { state, history: [version()], adopted: undefined };
}

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
		frameDetailVisible: false,
		detailVisibility: [],
		editorCalls: [],
		transcript: [],
	};
	return Object.assign(context, {
		chatContainer: {
			addChild: (child: unknown) => context.transcript.push(child),
			clear: () => context.editorCalls.push("chatContainer.clear"),
		},
		editorContainer: {
			clear: () => context.editorCalls.push("editorContainer.clear"),
			addChild: () => context.editorCalls.push("editorContainer.addChild"),
		},
		frameDetail: {
			setVisible: (visible: boolean) => {
				context.detailVisibility.push(visible);
			},
		},
		ui: { requestRender: () => {}, terminal: { columns: 80 } },
		getFrameView: () => frameView(),
		showStatus: (message: string) => context.statuses.push(message),
		submitFrameCorrection: (text: string) => correctionHandler.call(context, text),
		showFrameDetail: () => showHandler.call(context),
		hideFrameDetail: () => hideHandler.call(context),
		writeFrameDetailToTranscript: () => transcriptHandler.call(context),
	});
}

describe("/frame command", () => {
	it("is listed as a built-in command so it autocompletes", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "frame");
		expect(command).toBeDefined();
		expect(command?.argumentHint).toContain("correct");
		expect(command?.argumentHint).toContain("close");
	});

	it("opens the detail region without touching the editor container", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "");
		expect(context.frameDetailVisible).toBe(true);
		expect(context.detailVisibility).toEqual([true]);
		expect(context.editorCalls).toEqual([]);
		expect(context.submitted).toEqual([]);

		handlers.handleFrameCommand.call(context, " history ");
		expect(context.detailVisibility).toEqual([true, true]);
		expect(context.editorCalls).toEqual([]);
	});

	it("hides the region through an explicit frame command", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "close");
		expect(context.frameDetailVisible).toBe(false);
		expect(context.detailVisibility).toEqual([false]);
		expect(context.editorCalls).toEqual([]);
		expect(context.statuses.join("\n")).toContain("Frame detail hidden");
	});

	it("writes the full detail to the transcript so a capped region loses nothing", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "full");
		expect(context.transcript).toHaveLength(2);
		expect(context.statuses.join("\n")).toContain("written to the transcript");
		expect(context.editorCalls).toEqual([]);

		const text = context.transcript[1] as { render(width: number): string[] };
		expect(text.render(80).join("\n")).toContain("HOW I SEE THIS TASK");
	});

	it("reports instead of writing when no task is open", () => {
		const context = Object.assign(createContext(), { getFrameView: () => undefined });
		handlers.handleFrameCommand.call(context, "full");
		expect(context.transcript).toEqual([]);
		expect(context.statuses.join("\n")).toContain("No task is open");
	});

	it("submits a correction without leaving the editor behind", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, " correct you are looking at the wrong target");
		expect(context.submitted).toEqual(["you are looking at the wrong target"]);
		expect(context.frameDetailVisible).toBe(false);
		expect(context.editorCalls).toEqual([]);
	});

	it("refuses a correction with no text instead of recording an empty one", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "correct   ");
		expect(context.submitted).toEqual([]);
		expect(context.statuses.join("\n")).toContain("Usage: /frame correct");
	});

	it("explains an unknown argument, naming the close path", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "nonsense");
		expect(context.submitted).toEqual([]);
		expect(context.detailVisibility).toEqual([]);
		expect(context.statuses.join("\n")).toContain("/frame close");
	});

	it("does not report success when no task is open to correct", () => {
		const context = createContext();
		context.session.submitFormulationCorrection = () => undefined;
		handlers.handleFrameCommand.call(context, "correct fix it");
		expect(context.statuses.join("\n")).toContain("No active task to correct");
	});

	it("toggles the summary panel through the keybinding handler", () => {
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
