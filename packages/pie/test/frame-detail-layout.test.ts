import { Container, Text, VStack } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import type {
	FormulationCorrection,
	FormulationState,
	ProblemFormulationVersion,
} from "../src/core/agent-session-domain.ts";
import { FrameDetailPanel, FramePanel, type FrameView } from "../src/modes/interactive/components/frame-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

/**
 * The dock composition `InteractiveMode` builds, at the terminal heights where it has to hold:
 * the transcript shrinks, the summary panel and the frame detail region take their lines, and the
 * editor keeps its three. The point of the region is that the user reads the frame and keeps
 * typing, so the editor's draft must stay on screen at a 60x14 window with a 16-line detail.
 *
 * `renderLayoutFrame` is imported from the TUI source the way the other pie tests import TUI
 * internals; the height-constrained allocation lives there, not in `VStack.render`.
 */

const EDITOR_DRAFT = "draft typed while the frame is on screen";

function version(ordinal: number): ProblemFormulationVersion {
	return {
		id: `formulation-${ordinal}`,
		taskId: "task-1",
		ordinal,
		previousVersionId: ordinal > 1 ? `formulation-${ordinal - 1}` : undefined,
		recordedAt: `2026-09-20T10:0${ordinal}:00.000Z`,
		origin: "propose",
		content: {
			interpretation: `I read this as reading ${ordinal}`,
			focus: "the observations the tested beliefs predict",
			implication: "which conclusion the answer reports",
		},
		reason: `reason ${ordinal}`,
		sources: [],
	};
}

function correction(index: number): FormulationCorrection {
	return {
		id: `formulation-correction-${index}`,
		taskId: "task-1",
		original: `correction ${index}: you are looking at the wrong target, keep reading this line as the user wrote it`,
		receivedAt: "2026-09-20T10:05:00.000Z",
		status: index % 2 === 0 ? "pending" : "resolved",
		response: index % 2 === 0 ? undefined : `kept the reading; correction ${index} names the re-arm path`,
	};
}

/** A long reading: several corrections and a version history, so the region has to elide lines. */
function longView(ordinal = 3): FrameView {
	const history = [version(1), version(2), version(3)];
	const state: FormulationState = {
		current: version(ordinal),
		deferral: null,
		corrections: [1, 2, 3, 4, 5, 6].map(correction),
		decisionOwed: false,
	};
	return { state, history, adopted: { kind: "version", versionId: `formulation-${ordinal}` } };
}

function renderDock(view: FrameView, width: number, height: number) {
	const summaryContainer = new Container();
	summaryContainer.addChild(new FramePanel(() => view));
	const detailContainer = new Container();
	const detail = new FrameDetailPanel(() => view);
	detail.setVisible(true);
	detailContainer.addChild(detail);
	const statusContainer = new Container();
	statusContainer.addChild(new Text("Frame detail shown — type below to reply, /frame close to hide", 1, 0));
	const editorContainer = new Container();
	editorContainer.addChild(new Text(EDITOR_DRAFT, 1, 0));
	const footerContainer = new Container();
	footerContainer.addChild(new Text("0.0%/1.0M  model · medium", 0, 0));

	// The dock entries and options are the ones interactive-mode.ts builds.
	const dock = new VStack([
		{ component: summaryContainer, shrink: 1, minSize: 0 },
		{ component: detailContainer, shrink: 1, minSize: 0, visible: () => true },
		{ component: statusContainer, shrink: 1, minSize: 0 },
		{ component: editorContainer, shrink: 1, minSize: 3 },
		{ component: footerContainer, shrink: 1, minSize: 1 },
	]);
	const transcript = new Container();
	transcript.addChild(new Text("transcript line that must give up its rows first", 0, 0));
	const root = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);

	const frame = renderLayoutFrame(root, width, height, () => {});
	const dockBox = frame.root.children[1];
	if (!dockBox) throw new Error("dock did not get a layout box");
	return {
		text: frame.lines.map(stripAnsi).join("\n"),
		summaryHeight: dockBox.children[0]?.rect.height ?? -1,
		detailHeight: dockBox.children[1]?.rect.height ?? -1,
		editorHeight: dockBox.children[3]?.rect.height ?? -1,
	};
}

describe("frame detail region layout", () => {
	for (const [width, height] of [
		[60, 14],
		[80, 24],
	] as const) {
		it(`keeps the editor and its draft at ${width}x${height} with a long reading`, () => {
			const layout = renderDock(longView(), width, height);
			expect(layout.detailHeight).toBeLessThanOrEqual(16);
			expect(layout.detailHeight).toBeGreaterThan(1);
			expect(layout.editorHeight).toBeGreaterThanOrEqual(3);
			expect(layout.text).toContain(EDITOR_DRAFT);
			expect(layout.text).toContain("/frame close to hide");
			expect(layout.text).toContain("/frame full");
		});
	}

	it("keeps the draft in place when the frame updates underneath it", () => {
		const before = renderDock(longView(3), 60, 14);
		const after = renderDock(longView(4), 60, 14);
		expect(before.text).toContain(EDITOR_DRAFT);
		expect(after.text).toContain(EDITOR_DRAFT);
		expect(after.editorHeight).toBeGreaterThanOrEqual(3);
		expect(after.text).toContain("v4");
		expect(before.text).toContain("v3");
	});
});
