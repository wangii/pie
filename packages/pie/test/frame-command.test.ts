import { beforeAll, describe, expect, it } from "vitest";
import type { FormulationState, ProblemFormulationVersion } from "../src/core/agent-session-domain.ts";
import type { FormulationApprovalResult } from "../src/core/belief-loop/belief-loop-controller.ts";
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
	session: {
		submitFormulationCorrection: (text: string) => { id: string } | undefined;
		approveFormulation: (versionId?: string) => FormulationApprovalResult;
	};
	submitted: string[];
	/** Every version id the approval command passed, `undefined` for "the reading on screen". */
	approved: Array<string | undefined>;
	/** Set to make the next approval come back refused, as the runtime does. */
	approvalRejection?: string;
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
	approveFrame(this: unknown, versionId: string): void;
	handleEvent(this: unknown, event: unknown): Promise<void>;
	addMessageToChat(this: unknown, message: unknown): void;
	formulationWaitResolution(this: unknown, versionId: string): string | undefined;
	showFrameDetail(this: unknown): void;
	hideFrameDetail(this: unknown): void;
	writeFrameDetailToTranscript(this: unknown): void;
};

const handlers = InteractiveMode.prototype as unknown as FrameHandlers;
const correctionHandler = handlers.submitFrameCorrection;
const approveHandler = handlers.approveFrame;
const eventHandler = handlers.handleEvent;
const addMessageHandler = handlers.addMessageToChat;
const waitResolutionHandler = handlers.formulationWaitResolution;
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
		awaitingResponse: false,
		approved: false,
		resume: null,
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
			approveFormulation: (versionId?: string) => {
				context.approved.push(versionId);
				if (context.approvalRejection !== undefined) {
					return { outcome: "rejected", reason: context.approvalRejection };
				}
				return {
					outcome: "recorded",
					approval: { versionId: versionId ?? "formulation-1", approvedAt: "2026-09-25T00:00:00.000Z" },
				};
			},
		},
		submitted: [],
		approved: [],
		statuses: [],
		frameDetailVisible: false,
		detailVisibility: [],
		editorCalls: [],
		transcript: [],
	};
	return Object.assign(context, {
		// approveFrame resolves the wait block it approved, so the fake has to carry the same map the
		// handler reads.
		formulationWaitComponents: new Map(),
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
		approveFrame: (versionId?: string) => approveHandler.call(context, versionId ?? ""),
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
		expect(command?.argumentHint).toContain("approve");
		expect(command?.argumentHint).toContain("close");
	});

	it("approves the reading on screen through an explicit command rather than a reply", () => {
		const context = createContext();
		handlers.handleFrameCommand.call(context, "approve");
		expect(context.approved).toEqual([undefined]);
		expect(context.statuses).toEqual([]);
		// A named version is passed through as given; whitespace is not part of the id.
		handlers.handleFrameCommand.call(context, " approve formulation-7 ");
		expect(context.approved).toEqual([undefined, "formulation-7"]);
		expect(context.submitted).toEqual([]);
	});

	it("reports a refused approval as a status instead of showing it as consent", () => {
		const context = createContext();
		context.approvalRejection = "no published reading is waiting for a response";
		handlers.handleFrameCommand.call(context, "approve");
		expect(context.approved).toEqual([undefined]);
		expect(context.statuses.join("\n")).toContain(
			"Frame approval rejected: no published reading is waiting for a response",
		);
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

/**
 * The confirmation an approval prints, and its retraction.
 *
 * `approveFormulation` can only attest that the continuation was started; whether it settles is
 * reported afterwards. The two rendered outcomes therefore have to differ, and a failure has to
 * correct the line already on screen instead of leaving the optimistic statement in the record.
 */
describe("/frame approve presentation", () => {
	function presentationContext() {
		const children: unknown[] = [];
		const statuses: string[] = [];
		// The session records the continuation when the approval is made, so the fake does the same:
		// before it, nothing about this version is resolved and the wait block must render untouched.
		let resume: { versionId: string; phase: "started" | "settled" | "failed" } | undefined;
		const context: Record<string, unknown> = {
			isInitialized: true,
			outputPad: 0,
			formulationWaitComponents: new Map(),
			chatContainer: { addChild: (child: unknown) => children.push(child) },
			footer: { invalidate: () => {} },
			ui: { requestRender: () => {}, terminal: { columns: 80 } },
			showStatus: (message: string) => statuses.push(message),
			getMarkdownThemeWithSettings: () => ({}),
			toolOutputExpanded: false,
			// The prototype method the handler calls, bound the way the other handlers are: the fake
			// carries the collaborators, not a reimplementation.
			formulationWaitResolution: (versionId: string) => waitResolutionHandler.call(context, versionId),
			session: {
				approveFormulation: () => {
					resume = { versionId: "formulation-1", phase: "started" };
					return {
						outcome: "recorded",
						approval: { versionId: "formulation-1", approvedAt: "2026-09-25T00:00:00.000Z" },
						continuation: "started",
					};
				},
				getFormulationResume: () => resume,
				extensionRunner: { getMessageRenderer: () => undefined },
			},
		};
		return { context, children, statuses };
	}
	const renderedTexts = (children: unknown[]) =>
		children
			.filter((child): child is { text: string } => typeof (child as { text?: unknown })?.text === "string")
			.map((child) => child.text)
			.join("\n");

	it("states that the continuation was started, and rewrites that line when it fails", async () => {
		const { context, children } = presentationContext();
		approveHandler.call(context, "");
		const confirmed = renderedTexts(children);
		expect(confirmed).toContain("Frame formulation-1 approved");
		expect(confirmed).toContain("starting to continue on this reading");
		const childCount = children.length;

		await eventHandler.call(context, {
			type: "formulation_resume_failed",
			versionId: "formulation-1",
			reason: "transport closed",
		});
		const corrected = renderedTexts(children);
		expect(corrected).toContain("did not resume: transport closed");
		// One statement about the version, and it is the true one: the confirmation is rewritten in
		// place rather than joined by a second, contradictory line.
		expect(corrected).not.toContain("starting to continue on this reading");
		expect(children.length).toBe(childCount);
	});

	it("marks the wait block it approved as resolved while keeping its text as history", () => {
		const { context } = presentationContext();
		const waits = context.formulationWaitComponents as Map<
			string,
			{ getStatusLine(): string | undefined; render(width: number): string[] }
		>;
		addMessageHandler.call(context, {
			role: "custom",
			customType: "formulation_wait",
			content: [
				{
					type: "text",
					text: "Frame v1 — Execution is paused until you act on this Frame yourself. Approve it to build on this reading.",
				},
			],
			display: true,
			details: { versionId: "formulation-1" },
			timestamp: 1,
		});
		// While the reading is waiting there is nothing to resolve yet.
		expect(waits.get("formulation-1")?.getStatusLine()).toBeUndefined();

		approveHandler.call(context, "");

		const wait = waits.get("formulation-1");
		expect(wait?.getStatusLine()).toContain("Resolved");
		// History is kept: the block still carries the instruction it was written with, and the
		// resolution is the note on it rather than a rewritten body.
		expect(wait?.render(80).join("\n")).toContain("Execution is paused");
	});
});
