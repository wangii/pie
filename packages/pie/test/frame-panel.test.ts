import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type {
	FormulationCorrection,
	FormulationState,
	ProblemFormulationVersion,
} from "../src/core/agent-session-domain.ts";
import {
	buildFrameDetailLines,
	buildFrameSummaryLines,
	type FrameView,
} from "../src/modes/interactive/components/frame-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * The terminal's Frame view is a pure function of the replayed state, so it is tested that way:
 * the three states the milestone names (not yet formed, deferred, published), the correction
 * status a user has to be able to check, and the width handling that keeps a Chinese reading
 * readable rather than cut in half.
 */

beforeAll(() => initTheme("dark"));

function version(ordinal: number, overrides: Partial<ProblemFormulationVersion> = {}): ProblemFormulationVersion {
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
		...overrides,
	};
}

function correction(overrides: Partial<FormulationCorrection> = {}): FormulationCorrection {
	return {
		id: "formulation-correction-1",
		taskId: "task-1",
		original: "you are looking at the wrong target",
		receivedAt: "2026-09-20T10:05:00.000Z",
		status: "pending",
		...overrides,
	};
}

function state(overrides: Partial<FormulationState> = {}): FormulationState {
	return { current: null, deferral: null, corrections: [], decisionOwed: false, ...overrides };
}

function view(overrides: Partial<FrameView> = {}): FrameView {
	return { state: state(), history: [], adopted: undefined, ...overrides };
}

function plain(lines: readonly string[]): string[] {
	return lines.map(stripAnsi);
}

describe("frame panel", () => {
	it("distinguishes waiting for the user from the subsequent focus review", () => {
		const waiting = view({
			state: state({ current: version(2), review: { versionId: "formulation-2", focusReviewed: false } }),
		});
		expect(plain(buildFrameSummaryLines(waiting, 80)).join("\n")).toContain("awaiting your response");
		expect(plain(buildFrameDetailLines(waiting, 80)).join("\n")).toContain("Paused: reply");
		const reviewing = view({
			state: state({
				current: version(2),
				review: { versionId: "formulation-2", responseCorrectionId: "correction-1", focusReviewed: false },
			}),
		});
		expect(plain(buildFrameSummaryLines(reviewing, 80)).join("\n")).toContain("focus review owed");
		for (const width of [24, 40, 60]) {
			for (const item of [waiting, reviewing]) {
				for (const line of [...buildFrameSummaryLines(item, width), ...buildFrameDetailLines(item, width)]) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("says a reading has not been formed yet rather than showing nothing", () => {
		const lines = plain(buildFrameSummaryLines(view(), 80));
		expect(lines[0]).toContain("not yet formed");
		expect(lines.join("\n")).toContain("has not yet said how it reads this task");
	});

	it("shows the current version, what is missing when deferred, and pending corrections", () => {
		const published = plain(buildFrameSummaryLines(view({ state: state({ current: version(2) }) }), 80));
		expect(published[0]).toContain("v2");
		expect(published[1]).toContain("I read this as reading 2");

		const deferred = plain(
			buildFrameSummaryLines(
				view({
					state: state({
						deferral: {
							missingInformation: "whether the duplicate charge is per-attempt",
							reason: "one probe cannot separate the two readings",
							sources: [],
							deferredAt: "2026-09-20T10:02:00.000Z",
							answeredThroughEpisodeOrdinal: 1,
						},
					}),
				}),
				80,
			),
		);
		expect(deferred[0]).toContain("deferred");
		expect(deferred[1]).toContain("per-attempt");

		const withCorrection = plain(
			buildFrameSummaryLines(view({ state: state({ current: version(1), corrections: [correction()] }) }), 80),
		);
		expect(withCorrection[0]).toContain("1 correction pending");
		expect(withCorrection[0]).toContain("/frame");
	});

	it("keeps every line inside the terminal, including a Chinese reading", () => {
		const chinese = version(1, {
			content: {
				interpretation: "我目前主要把它理解为 payment identity 与请求生命周期不一致的问题。",
				focus: "我优先关注跨多次尝试存在的 PaymentIntent。",
				tension: "我试图解释：retry 可以跨越请求生命周期，但 payment identity 没有随之保留。",
				implication: "我会先调查身份的归属和生命周期。",
			},
		});
		for (const width of [24, 40, 60]) {
			const lines = [
				...buildFrameSummaryLines(view({ state: state({ current: chinese }) }), width),
				...buildFrameDetailLines(view({ state: state({ current: chinese }), history: [chinese] }), width),
			];
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("frame detail", () => {
	it("shows the version a correction was answered by and the response beside it", () => {
		const answered = correction({
			status: "resolved",
			targetVersionId: "formulation-1",
			response: "kept the identity reading; the correction names the re-arm path",
			recordedVersionId: "formulation-2",
		});
		const lines = plain(
			buildFrameDetailLines(
				view({
					state: state({ current: version(2), corrections: [answered] }),
					history: [version(1), version(2)],
					adopted: { kind: "version", versionId: "formulation-2" },
				}),
				80,
			),
		);
		const text = lines.join("\n");
		expect(text).toContain("HOW I SEE THIS TASK   v2");
		expect(text).toContain("Interpretation");
		expect(text).toContain("Focus");
		expect(text).toContain("What this changes");
		expect(text).toContain("[answered]");
		expect(text).toContain("about v1");
		expect(text).toContain("kept the identity reading");
		// "Which version governed the work" is a different question from "what is current".
		expect(text).toContain("The last experiment ran under v2.");
		expect(text).toContain("How this reading changed");
		expect(text).toContain("reason 1");
	});

	it("distinguishes a first investigation from a version that governed anything", () => {
		const lines = plain(
			buildFrameDetailLines(
				view({
					state: state({ current: version(1) }),
					history: [version(1)],
					adopted: { kind: "unformed" },
				}),
				80,
			),
		);
		expect(lines.join("\n")).toContain("chosen before any version existed");
	});

	it("shows why a deferred reading is deferred, and no history that does not exist", () => {
		const lines = plain(
			buildFrameDetailLines(
				view({
					state: state({
						deferral: {
							missingInformation: "whether the value survives logout",
							reason: "the probe could not reach that path",
							sources: [],
							deferredAt: "2026-09-20T10:02:00.000Z",
							answeredThroughEpisodeOrdinal: 1,
						},
					}),
				}),
				80,
			),
		);
		const text = lines.join("\n");
		expect(text).toContain("Still missing: whether the value survives logout");
		expect(text).toContain("Reason: the probe could not reach that path");
		expect(text).not.toContain("How this reading changed");
	});
});
