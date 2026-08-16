import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentSession, EpistemicDiagnostics, OperationalErrorStatus } from "../../../core/agent-session.ts";
import type { ContextOmissionReason } from "../../../core/context-compiler.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";

function formatTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function singleLine(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatUnknown(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

function loopLabel(state: NonNullable<EpistemicDiagnostics["runtime"]>["loopState"]): string {
	return state.replaceAll("_", " ").toUpperCase();
}

/** Spinner label reflecting what Pie's production loop is currently doing. */
export function formatPieWorkingMessage(runtime: NonNullable<EpistemicDiagnostics["runtime"]>): string {
	if (runtime.requestRole === "finalAnswer") return "Writing final answer...";
	if (runtime.requestRole === "epistemic") return "Deciding anchor & frame...";
	if (runtime.loopState === "tool_execution") return "Running tools...";
	return "Executing action...";
}

const OMISSION_LABELS: Record<ContextOmissionReason, string> = {
	budget: "budget pressure",
	historical_summary: "legacy summary",
	not_model_facing: "non-model-facing event",
	runtime_excluded: "failed/truncated runtime response",
	invalid_tool_sequence: "invalid tool sequence",
	outside_action_episode: "outside Action episode",
	role_projection: "request-role projection",
};

function formatOmissionReasons(omissions: NonNullable<EpistemicDiagnostics["context"]>["omissionsByReason"]): string {
	return Object.entries(omissions)
		.map(([reason, count]) => `${OMISSION_LABELS[reason as keyof typeof OMISSION_LABELS]}=${count}`)
		.join(", ");
}

export function formatPieStatus(session: AgentSession): string | undefined {
	const source = session as { getEpistemicDiagnostics?: () => EpistemicDiagnostics; retryAttempt?: number };
	if (!source.getEpistemicDiagnostics) return undefined;
	const diagnostics = source.getEpistemicDiagnostics();
	if (!diagnostics.runtime) return undefined;
	const parts = [`Pie · ${loopLabel(diagnostics.runtime.loopState)}`];
	if (diagnostics.state.action) {
		parts.push("ACTION running");
	} else if (diagnostics.state.lastAction?.transition) {
		parts.push(`ACTION ${diagnostics.state.lastAction.transition.toUpperCase()}`);
	}
	if (diagnostics.state.frame) {
		parts.push(
			`Frame responses ${diagnostics.state.frame.completedModelResponses}/${diagnostics.state.frame.horizon}`,
		);
	}
	if (diagnostics.state.action && diagnostics.leaseBudget?.derivation === "available") {
		parts.push(
			`evidence rounds ${diagnostics.leaseBudget.consumedEvidenceRounds ?? 0}/${diagnostics.leaseBudget.activeExpectedEvidenceRounds ?? "?"}`,
		);
	}
	if (diagnostics.context) {
		parts.push(
			`ctx ${formatTokenCount(diagnostics.context.outputMessageTokens)}/${formatTokenCount(diagnostics.context.availableInputTokens)}`,
		);
		parts.push(`events ${diagnostics.context.selectedEventCount}/${diagnostics.context.inputEventCount}`);
		if (diagnostics.context.excludedEventCount > 0) {
			parts.push(`excluded ${diagnostics.context.excludedEventCount}`);
		}
	}
	if ((source.retryAttempt ?? 0) > 0) parts.push(`provider retry ${source.retryAttempt}`);
	if (diagnostics.runtime.recovery) {
		parts.push(
			`repair ${diagnostics.runtime.recovery.attempt}/${diagnostics.runtime.recovery.maxAttempts} ${diagnostics.runtime.recovery.classification.replaceAll("_", " ")}`,
		);
	}
	if (diagnostics.runtime.inputReady) parts.push("input ready");
	return parts.join(" · ");
}

export class PieStatusComponent implements Component {
	private session: AgentSession;

	constructor(session: AgentSession) {
		this.session = session;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	render(width: number): string[] {
		const status = formatPieStatus(this.session);
		return status ? [truncateToWidth(theme.fg("dim", status), width, theme.fg("dim", "..."))] : [];
	}

	invalidate(): void {}
}

function formatDiagnostics(diagnostics: EpistemicDiagnostics): string {
	const lines = [theme.bold(theme.fg("accent", "Pie diagnostics (read-only)"))];
	if (diagnostics.runtime) {
		lines.push(
			`${theme.fg("dim", "Loop:")} ${loopLabel(diagnostics.runtime.loopState)} · ${diagnostics.runtime.inputReady ? "input ready" : "busy"}`,
		);
	}
	const anchor = diagnostics.state.anchor;
	lines.push(
		anchor
			? `${theme.fg("dim", "Anchor:")} ${anchor.id} · r${anchor.revision}\n  ${anchor.statement}\n  revision event: ${anchor.revisionEntryId}`
			: `${theme.fg("dim", "Anchor:")} none`,
	);
	const frame = diagnostics.state.frame;
	lines.push(
		frame
			? `${theme.fg("dim", "Frame:")} ${frame.id} · v${frame.version} · responses ${frame.completedModelResponses}/${frame.horizon}\n  ${frame.statement}\n  expectation: ${frame.expectation}\n  revision event: ${frame.revisionEntryId}`
			: `${theme.fg("dim", "Frame:")} none`,
	);
	const action = diagnostics.state.action;
	if (action) {
		const evidenceRounds =
			diagnostics.leaseBudget?.derivation === "available"
				? `\n  evidence rounds: ${diagnostics.leaseBudget.consumedEvidenceRounds ?? 0}/${diagnostics.leaseBudget.activeExpectedEvidenceRounds ?? "?"}${diagnostics.leaseBudget.activeBudgetReason ? `\n  serial dependency: ${diagnostics.leaseBudget.activeBudgetReason}` : ""}`
				: "";
		lines.push(
			`${theme.fg("dim", "Action:")} ${action.id} · active · ${action.completedModelResponses} model responses\n  intent: ${action.intent}\n  frozen completion: ${action.completionCondition}${evidenceRounds}\n  start event: ${action.startEntryId}`,
		);
	} else if (diagnostics.state.lastAction) {
		const terminal = diagnostics.state.lastAction;
		lines.push(
			`${theme.fg("dim", "Action:")} ${terminal.id} · ${terminal.transition ?? "interrupted persisted action"}\n  start event: ${terminal.startEntryId}${terminal.transitionEntryId ? `\n  transition event: ${terminal.transitionEntryId}` : ""}${terminal.reason ? `\n  reason: ${terminal.reason}` : ""}`,
		);
	} else {
		lines.push(`${theme.fg("dim", "Action:")} none`);
	}
	if (diagnostics.leaseBudget) {
		if (diagnostics.leaseBudget.derivation === "available" && diagnostics.leaseBudget.costs) {
			const costs = diagnostics.leaseBudget.costs;
			lines.push(
				`${theme.fg("dim", "Model-response lease:")} derived · ${diagnostics.leaseBudget.provisionalActionCount} provisional Actions · evidence rounds ${(diagnostics.leaseBudget.expectedEvidenceRounds ?? []).join(" + ")}\n  costs: initial control ${costs.initialControl} · authorization ${costs.actionAuthorization} · execution ${costs.execution} · terminal adjudication ${costs.actionTerminalAdjudication} · Frame adjudication ${costs.finalFrameAdjudication}\n  unused evidence rounds returned: ${diagnostics.leaseBudget.unusedEvidenceRounds ?? 0}`,
			);
		} else {
			lines.push(
				`${theme.fg("dim", "Model-response lease:")} derivation unavailable (restored or legacy Frame); numeric horizon preserved`,
			);
		}
	}
	lines.push(`${theme.fg("dim", "Observations:")} ${diagnostics.state.observations.length}`);
	for (const observation of diagnostics.state.observations) {
		lines.push(`  ${observation.id} · ${observation.entryId}\n    ${observation.statement}`);
		for (const source of observation.provenance) {
			lines.push(
				`    source ${source.rawEventId} · ${source.toolName}${source.toolCallId ? ` · call ${source.toolCallId}` : ""}`,
			);
			if (source.arguments !== undefined) lines.push(`      args: ${formatUnknown(source.arguments)}`);
			if (source.command !== undefined) lines.push(`      command: ${source.command}`);
			lines.push(
				`      status: ${source.cancelled ? "cancelled" : source.isError ? "error" : "completed"}${source.exitCode !== undefined ? ` · exit ${source.exitCode}` : ""}`,
			);
			lines.push(`      retained output:\n${source.output}`);
		}
	}
	lines.push(
		`${theme.fg("dim", "Provenance:")} raw ${diagnostics.provenance.rawEventCount} · branch ${diagnostics.provenance.activeBranchEventCount} · legacy summaries ignored ${diagnostics.provenance.legacySummaryCount}`,
	);
	if (diagnostics.context) {
		const omissions = formatOmissionReasons(diagnostics.context.omissionsByReason);
		lines.push(
			`${theme.fg("dim", "Compiler:")} ${diagnostics.context.compilerVersion}\n  input events: ${diagnostics.context.inputEventCount}\n  selected raw events: ${diagnostics.context.selectedEventCount}\n  excluded raw events: ${diagnostics.context.excludedEventCount}${omissions ? `\n  exclusions by policy: ${omissions}` : ""}\n  selected token estimate: ${diagnostics.context.outputMessageTokens}\n  input budget: ${diagnostics.context.availableInputTokens}`,
		);
	} else {
		lines.push(`${theme.fg("dim", "Compiler:")} no request compiled yet`);
	}
	if (diagnostics.runtime?.recovery) {
		lines.push(formatOperationalError(diagnostics.runtime.recovery, true));
	}
	return lines.join("\n");
}

export class PieProjectionReductionNoticeComponent extends Text {
	constructor(omittedEventCount: number) {
		const events = omittedEventCount === 1 ? "event" : "events";
		super(
			theme.fg("dim", `Projection reduced: ${omittedEventCount} older ${events} omitted; raw log unchanged.`),
			1,
			0,
		);
	}
}

export class PieDiagnosticsComponent extends Text implements Expandable {
	private readonly diagnostics: EpistemicDiagnostics;

	constructor(diagnostics: EpistemicDiagnostics, expanded = true) {
		super("", 1, 0);
		this.diagnostics = diagnostics;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.setText(
			expanded
				? formatDiagnostics(this.diagnostics)
				: `Pie diagnostics · Anchor ${this.diagnostics.state.anchor?.id ?? "none"} · Frame ${this.diagnostics.state.frame?.id ?? "none"} · Action ${this.diagnostics.state.action?.id ?? this.diagnostics.state.lastAction?.id ?? "none"}`,
		);
	}
}

function markerText(entry: SessionEntry): { collapsed: string; expanded: string } | undefined {
	if (entry.type === "anchor_revision") {
		const label = entry.revision === 1 ? "Anchor created" : "Anchor revised";
		return {
			collapsed: `${label} · r${entry.revision}`,
			expanded: `${label} · r${entry.revision}\n  ${entry.statement}\n  id: ${entry.anchorId}\n  event: ${entry.id}\n  source: ${entry.sourceEventId}`,
		};
	}
	if (entry.type === "frame_revision") {
		const label = entry.version === 1 ? "Frame created" : "Frame revised";
		return {
			collapsed: `${label} · v${entry.version}`,
			expanded: `${label} · v${entry.version}\n  ${entry.statement}\n  expectation: ${entry.expectation}\n  response lease: ${entry.horizon}\n  id: ${entry.frameId}\n  event: ${entry.id}`,
		};
	}
	if (entry.type === "frame_transition") {
		return {
			collapsed: `Frame ${entry.transition} · v${entry.version}`,
			expanded: `Frame ${entry.transition} · v${entry.version}\n  ${entry.reason}\n  id: ${entry.frameId}\n  event: ${entry.id}\n  source: ${entry.sourceEventId}`,
		};
	}
	if (entry.type === "action_start") {
		return {
			collapsed: "Action started",
			expanded: `Action started\n  intent: ${entry.intent}\n  frozen completion: ${entry.completionCondition}\n  id: ${entry.actionId}\n  event: ${entry.id}`,
		};
	}
	if (entry.type === "action_transition") {
		const terminal = entry.transition === "unresolvable" ? "UNRESOLVABLE" : entry.transition;
		return {
			collapsed: `Action ${terminal}`,
			expanded: `Action ${terminal}\n  ${entry.reason}\n  id: ${entry.actionId}\n  event: ${entry.id}\n  source: ${entry.sourceEventId}`,
		};
	}
	if (entry.type === "observation") {
		return {
			collapsed: `Observation materialized · ${entry.observationId}`,
			expanded: `Observation materialized · ${entry.observationId}\n  ${entry.statement}\n  event: ${entry.id}\n  sources: ${entry.sourceEventIds.join(", ")}`,
		};
	}
	return undefined;
}

export class PieStateTransitionComponent extends Text implements Expandable {
	private readonly collapsed: string;
	private readonly expanded: string;

	constructor(entry: SessionEntry, expanded = false) {
		const marker = markerText(entry);
		if (!marker) throw new Error(`Session entry ${entry.type} is not a Pie state transition.`);
		super("", 1, 0);
		this.collapsed = marker.collapsed;
		this.expanded = marker.expanded;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.setText(theme.fg("dim", expanded ? this.expanded : this.collapsed));
	}
}

export function isPieStateTransitionEntry(entry: SessionEntry): boolean {
	return markerText(entry) !== undefined;
}

export class PieRestorationReceiptComponent extends Text implements Expandable {
	private readonly collapsed: string;
	private readonly expanded: string;

	constructor(diagnostics: EpistemicDiagnostics, expanded = false) {
		const action = diagnostics.state.action
			? `${diagnostics.state.action.id} (interrupted persisted Action; not replayed)`
			: diagnostics.state.lastAction
				? `${diagnostics.state.lastAction.id} (${diagnostics.state.lastAction.transition ?? "terminal state unavailable"})`
				: "none";
		const collapsed = `Pie restored · Anchor ${diagnostics.state.anchor?.id ?? "none"} · Frame ${diagnostics.state.frame?.id ?? "none"} · Action ${action}`;
		const receipt = `${collapsed}\n  Observations: ${diagnostics.state.observations.map((observation) => observation.id).join(", ") || "none"}\n  Raw events: ${diagnostics.provenance.rawEventCount}\n  Active branch events: ${diagnostics.provenance.activeBranchEventCount}\n  Legacy summaries ignored for cognition: ${diagnostics.provenance.legacySummaryCount}`;
		super("", 1, 0);
		this.collapsed = collapsed;
		this.expanded = receipt;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.setText(theme.fg("dim", expanded ? this.expanded : this.collapsed));
	}
}

export function formatOperationalError(status: OperationalErrorStatus, expanded = false): string {
	const classification = status.classification.replaceAll("_", " ");
	const base = `Execution ${classification} · ${status.toolName} · repair ${status.attempt}/${status.maxAttempts}`;
	if (!expanded) return base;
	const policy = status.requiresInspection
		? "Ambiguous mutation will be inspected; blind replay is blocked."
		: "Local repair may change command, arguments, path, or tool choice.";
	const contract = status.frozenContract
		? "The Action intent and completion condition remain frozen."
		: "No active Action contract was found.";
	return `${base}\n  ${singleLine(status.message)}\n  ${contract}\n  ${policy}${status.attempt >= status.maxAttempts ? "\n  Repair exhausted: control returned as UNRESOLVABLE." : ""}`;
}
