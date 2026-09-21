import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
	FormulationAdoption,
	FormulationCorrection,
	FormulationRecheck,
	FormulationState,
	ProblemFormulationVersion,
} from "../../../core/agent-session-domain.ts";
import { theme } from "../theme/theme.ts";

/**
 * The terminal's view of the agent's current problem understanding — the product-facing "Frame".
 *
 * Everything here is a pure function of a `FrameView` snapshot, so what the user reads is exactly
 * what the replayed log holds, and the layout can be tested without standing up a session. The
 * panel is live (it re-reads through `getView` on every render) for the same reason the belief
 * panel is: a correction answered while the user is looking should not need a redraw command.
 *
 * Width handling goes through `truncateToWidth` rather than string slicing, because the content is
 * whatever the agent wrote in the configured belief language and CJK text is double-width.
 */

export interface FrameView {
	readonly state: FormulationState;
	/** This task's versions, oldest first. */
	readonly history: readonly ProblemFormulationVersion[];
	/** What the most recent dispatched round was chosen under, if anything has run. */
	readonly adopted: FormulationAdoption | undefined;
}

/** How many versions the detail view lists before summarizing the rest. */
const MAX_HISTORY_LINES = 6;

function pendingCorrections(state: FormulationState): readonly FormulationCorrection[] {
	return state.corrections.filter((correction) => correction.status === "pending");
}

/** A one-line reading of the current state: version and time, or what is still missing. */
function frameHeadline(state: FormulationState): string {
	if (state.current) {
		return `v${state.current.ordinal}`;
	}
	return state.deferral ? "deferred" : "not yet formed";
}

/**
 * The compact dock panel: what the agent currently takes the task to be, in one or two lines.
 *
 * It is deliberately a summary. The full reading, its history, and propose's answers to
 * corrections live in `FrameDetailPanel`, which the header names — a panel that truncated the
 * content without saying where the rest is would be worse than showing nothing.
 */
export class FramePanel implements Component {
	private visible = true;
	private readonly getView: () => FrameView | undefined;

	constructor(getView: () => FrameView | undefined) {
		this.getView = getView;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const view = this.getView();
		if (!view) return [];
		return buildFrameSummaryLines(view, width);
	}

	invalidate(): void {
		// No cached state — every render reads the live formulation state.
	}
}

export function buildFrameSummaryLines(view: FrameView, width: number): string[] {
	const { state } = view;
	const pending = pendingCorrections(state);
	const markers: string[] = [];
	if (pending.length > 0) {
		markers.push(theme.fg("warning", `${pending.length} correction${pending.length === 1 ? "" : "s"} pending`));
	}
	if (state.review && !state.review.responseCorrectionId) {
		markers.push(theme.fg("warning", "awaiting your response"));
	} else if (state.review && !state.review.focusReviewed) {
		markers.push(theme.fg("warning", "focus review owed"));
	}
	// One marker, describing the last round: either nobody has said what it means for the reading
	// yet, or somebody has and this is what they said. Showing a past "rechecked" beside an owed
	// one would read as two answers about the same round.
	if (state.recheckOwed) {
		markers.push(theme.fg("muted", "recheck owed"));
	} else if (state.recheck) {
		markers.push(theme.fg("muted", `rechecked · ${recheckVerdictText(state.recheck)}`));
	} else if (state.decisionOwed) {
		markers.push(theme.fg("muted", "decision owed"));
	}
	const head = [theme.bold("Frame"), theme.fg("accent", frameHeadline(state)), ...markers].join(" ");
	const lines = [truncateToWidth(`${head} ${theme.fg("dim", "· /frame")}`, width)];
	if (state.current) {
		lines.push(truncateToWidth(`  ${theme.fg("muted", state.current.content.interpretation)}`, width));
	} else if (state.deferral) {
		lines.push(
			truncateToWidth(`  ${theme.fg("muted", `still missing: ${state.deferral.missingInformation}`)}`, width),
		);
	} else {
		lines.push(truncateToWidth(`  ${theme.fg("dim", "the agent has not yet said how it reads this task")}`, width));
	}
	return lines;
}

/**
 * The full view: the current reading in its own terms, why it changed, which version governed the
 * last round, and what became of each correction the user submitted.
 *
 * It is the answer to "the agent misunderstood me — what happened?", so the correction section
 * keeps answered corrections beside their response rather than dropping them once handled.
 */
export function buildFrameDetailLines(view: FrameView, width: number): string[] {
	const { state, history, adopted } = view;
	const lines: string[] = [];
	const title = state.current ? `HOW I SEE THIS TASK   v${state.current.ordinal}` : "HOW I SEE THIS TASK";
	lines.push(truncateToWidth(theme.bold(title), width));
	lines.push("");

	if (state.current) {
		const version = state.current;
		lines.push(truncateToWidth(theme.fg("muted", `published ${version.recordedAt} · ${version.reason}`), width));
		lines.push("");
		for (const [label, value] of [
			["Interpretation", version.content.interpretation],
			["Focus", version.content.focus],
			["Core tension", version.content.tension],
			["Not currently prioritizing", version.content.alternative],
			["What this changes", version.content.implication],
		] as const) {
			if (!value) continue;
			lines.push(truncateToWidth(theme.fg("accent", label), width));
			lines.push(...wrapTextWithAnsi(`  ${value}`, width));
			lines.push("");
		}
		const sources = describeSources(version);
		if (sources) {
			lines.push(truncateToWidth(theme.fg("muted", `Formed from: ${sources}`), width));
			lines.push("");
		}
	} else if (state.deferral) {
		lines.push(truncateToWidth(theme.fg("warning", "The agent has not stated a reading, and recorded why:"), width));
		lines.push(...wrapTextWithAnsi(`  Still missing: ${state.deferral.missingInformation}`, width));
		lines.push(...wrapTextWithAnsi(`  Reason: ${state.deferral.reason}`, width));
		lines.push(truncateToWidth(theme.fg("muted", `  Deferred at ${state.deferral.deferredAt}`), width));
		lines.push("");
	} else {
		lines.push(
			truncateToWidth(
				theme.fg("muted", "Not yet formed: no investigation has settled how to read this task."),
				width,
			),
		);
		lines.push("");
	}

	if (state.review && !state.review.responseCorrectionId) {
		lines.push(
			...wrapTextWithAnsi(
				"Paused: reply to confirm, correct, or clarify this revised Frame. The agent will answer and review focus before continuing.",
				width,
			),
		);
		lines.push("");
	} else if (state.review && !state.review.focusReviewed) {
		lines.push(
			...wrapTextWithAnsi(
				"User response received; the agent must answer pending corrections and review focus before continuing.",
				width,
			),
		);
		lines.push("");
	}

	if (adopted) {
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					adopted.kind === "version"
						? `The last experiment ran under ${versionLabel(history, adopted)}.`
						: "The last experiment was chosen before any version existed.",
				),
				width,
			),
		);
		lines.push("");
	}

	lines.push(...recheckLines(state, history, width));

	if (state.corrections.length > 0) {
		lines.push(truncateToWidth(theme.bold("Corrections"), width));
		for (const correction of state.corrections) {
			const mark =
				correction.status === "pending" ? theme.fg("warning", "[pending]") : theme.fg("success", "[answered]");
			lines.push(truncateToWidth(`${mark} ${correctionText(correction)}`, width));
			if (correction.targetVersionId) {
				lines.push(
					truncateToWidth(
						theme.fg(
							"dim",
							`  about ${versionLabel(history, { kind: "version", versionId: correction.targetVersionId })}`,
						),
						width,
					),
				);
			}
			if (correction.response) {
				lines.push(...wrapTextWithAnsi(`  ${theme.fg("muted", correction.response)}`, width));
			}
		}
		lines.push("");
	}

	if (history.length > 1) {
		lines.push(truncateToWidth(theme.bold("How this reading changed"), width));
		const shown = history.slice(-MAX_HISTORY_LINES);
		if (shown.length < history.length) {
			lines.push(
				truncateToWidth(theme.fg("dim", `  … and ${history.length - shown.length} earlier version(s)`), width),
			);
		}
		for (const version of shown) {
			const current = state.current?.id === version.id ? theme.fg("accent", " (current)") : "";
			lines.push(truncateToWidth(`  v${version.ordinal}${current} ${theme.fg("muted", version.reason)}`, width));
			lines.push(truncateToWidth(theme.fg("dim", `     ${version.content.interpretation}`), width));
		}
	}

	return lines;
}

/** The compact marker's word for a reconsideration: short, because it shares a line with the
 *  version and the panel's other markers. The reason lives in the detail view. */
function recheckVerdictText(recheck: FormulationRecheck): string {
	switch (recheck.verdict) {
		case "maintained":
			return "kept the reading";
		case "revised":
			return "reading revised";
		default:
			return "deferred";
	}
}

/**
 * The detail view's account of the last reconsideration, or the fact that there has not been one.
 *
 * It states the verdict and the agent's own reason, and nothing else: residual is not recorded, so
 * a list of "unexplained observations" here would be an artifact of the panel rather than a fact
 * from the log.
 *
 * The owed state comes first because a record can outlive the round it answered: once a new round
 * has distilled, the stored verdict belongs to an earlier one, and presenting it as the answer to
 * this round would report a check nobody has made. Such a record is still shown, but as what it
 * is — an earlier round's answer.
 */
function recheckLines(state: FormulationState, history: readonly ProblemFormulationVersion[], width: number): string[] {
	const recheck = state.recheck;
	if (state.recheckOwed) {
		return [
			truncateToWidth(theme.bold("Reconsidered"), width),
			...wrapTextWithAnsi(
				"  Not yet: distillation has reported on the last round, and the agent has not said what it means for this reading.",
				width,
			),
			...(recheck
				? [
						...wrapTextWithAnsi(
							`  This record answers an earlier round: ${recheckOutcome(recheck, history)}. The basis stated then:`,
							width,
						),
						...wrapTextWithAnsi(`    ${recheck.reason}`, width),
					]
				: []),
			"",
		];
	}
	if (!recheck) return [];
	return [
		truncateToWidth(theme.bold("Reconsidered"), width),
		...wrapTextWithAnsi(
			`  ${recheckOutcome(recheck, history)} after the last round. The agent's stated basis:`,
			width,
		),
		...wrapTextWithAnsi(`    ${recheck.reason}`, width),
		"",
	];
}

/** The verdict phrased as what the agent did with the reading, without naming the round it happened in. */
function recheckOutcome(recheck: FormulationRecheck, history: readonly ProblemFormulationVersion[]): string {
	if (recheck.verdict === "maintained") return "Kept the reading";
	if (recheck.verdict === "revised") {
		return `Changed the reading; ${
			recheck.versionId
				? versionLabel(history, { kind: "version", versionId: recheck.versionId })
				: "a published version"
		} carries it`;
	}
	return "No reading could be stated";
}

function versionLabel(history: readonly ProblemFormulationVersion[], adoption: FormulationAdoption): string {
	if (adoption.kind === "unformed") return "no version";
	const version = history.find((candidate) => candidate.id === adoption.versionId);
	return version ? `v${version.ordinal}` : adoption.versionId;
}

function describeSources(version: ProblemFormulationVersion): string {
	const labels: string[] = [];
	for (const source of version.sources) {
		if (source.kind === "prompt") labels.push("the request");
		else if (source.kind === "belief") labels.push(`belief ${source.beliefId}`);
		else if (source.kind === "correction") labels.push("a correction");
		else if (source.kind === "distillation") labels.push("a distillation");
		else if (source.kind === "execution") labels.push("an execution");
		else labels.push("an intervention");
	}
	return labels.join(", ");
}

function correctionText(correction: FormulationCorrection): string {
	if (typeof correction.original === "string") return correction.original.trim();
	return correction.original
		.map((part) => {
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n")
		.trim();
}

/**
 * The full reading as a dock region above the editor.
 *
 * It is a region and not a modal: the editor stays mounted and focused underneath, so the user
 * reads the reading and replies on the same screen, and a correction answered while the region is
 * open shows up on the next render. Nothing here ever takes focus, so it cannot swallow keys that
 * belong to the editor. `/frame close` is the way out: the region deliberately does not claim
 * Escape, which the editor already uses to abort streaming and restore queued messages.
 *
 * The region is capped at `MAX_DETAIL_REGION_LINES`, so a long reading keeps the editor on screen;
 * the lines it elides stay reachable through `/frame full`, which writes them to the transcript.
 */
export class FrameDetailPanel implements Component {
	private visible = false;
	private readonly getView: () => FrameView | undefined;

	constructor(getView: () => FrameView | undefined) {
		this.getView = getView;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const view = this.getView();
		if (!view) {
			return [
				truncateToWidth(
					`${theme.fg("muted", "No task is open.")} ${theme.fg("dim", "· /frame close to hide")}`,
					width,
				),
			];
		}
		return buildFrameDetailRegionLines(view, width);
	}

	invalidate(): void {
		// No cached state — every render reads the live formulation state.
	}
}

/**
 * How many lines the region may occupy before it elides the rest.
 *
 * The region shares the dock with the transcript and the editor, and one reading plus its history
 * is longer than a small terminal. Bounding the region is what keeps the input box's three lines on
 * screen, which is the reason to put the detail beside the editor rather than in its place.
 */
const MAX_DETAIL_REGION_LINES = 16;

/**
 * The detail lines, with the commands on their own line.
 *
 * Both hints have to survive what the layout does to the region: it clips from the bottom on a short
 * terminal and truncates every line on a narrow one. So the title keeps line 0, the commands get
 * line 1 of their own (a hint appended to the title would be cut by the title's own length — at 40
 * columns `HOW I SEE THIS TASK   v3 · /frame clo…` names neither command), and the elision note
 * comes directly under that.
 */
export function buildFrameDetailRegionLines(
	view: FrameView,
	width: number,
	maxLines: number = MAX_DETAIL_REGION_LINES,
): string[] {
	const [title = "", ...rest] = buildFrameDetailLines(view, width);
	const hint = truncateToWidth(theme.fg("dim", "/frame close to hide · /frame full"), width);
	const budget = Math.max(1, maxLines - 2);
	if (rest.length <= budget) return [title, hint, ...rest];
	const shown = rest.slice(0, Math.max(0, budget - 1));
	const note = truncateToWidth(theme.fg("dim", `… ${rest.length - shown.length} more line(s)`), width);
	return [title, hint, note, ...shown];
}
