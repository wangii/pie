import { Container, Text } from "@earendil-works/pi-tui";
import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

interface StreamedToolUpdate {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
}

type ActionTraceTerminalStatus = "completed" | "unresolvable" | "escalated";

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function formatDetails(details: unknown): string | undefined {
	if (details === undefined) return undefined;
	try {
		return JSON.stringify(details);
	} catch {
		return "[unserializable details]";
	}
}

/**
 * Read-only projection of one Action's execution-local trace.
 *
 * Assistant messages remain outside this component so collapsing execution noise
 * never hides the user-visible answer. Streamed updates are retained as deltas
 * where possible to avoid storing repeated cumulative snapshots.
 */
export class ActionExecutionTraceComponent extends Container {
	readonly actionId: string;
	private readonly summary: Text;
	private readonly details: Container;
	private readonly attempts = new Map<string, ToolExecutionComponent>();
	private readonly lastStreamedText = new Map<string, string>();
	private expanded: boolean;
	private repairCount = 0;
	private streamedUpdateCount = 0;
	private finalizedAttemptCount = 0;
	private toolErrorCount = 0;
	private terminalStatus: ActionTraceTerminalStatus | undefined;

	constructor(actionId: string, expanded = false) {
		super();
		this.actionId = actionId;
		this.expanded = expanded;
		this.summary = new Text("", 1, 0);
		this.details = new Container();
		this.addChild(this.summary);
		this.addChild(this.details);
		this.updateSummary();
	}

	addAttempt(toolCallId: string, toolName: string, component: ToolExecutionComponent): void {
		if (this.attempts.has(toolCallId)) return;
		this.attempts.set(toolCallId, component);
		component.setExpanded(this.expanded);
		this.details.addChild(
			new Text(theme.fg("dim", `Attempt ${this.attempts.size} started · ${toolName} · call ${toolCallId}`), 1, 0),
		);
		this.details.addChild(component);
		this.updateSummary();
	}

	recordStreamedUpdate(toolCallId: string, toolName: string, update: StreamedToolUpdate): void {
		this.streamedUpdateCount++;
		const snapshot = getTextOutput(update, false);
		const previous = this.lastStreamedText.get(toolCallId) ?? "";
		let retainedText: string;
		if (!snapshot) {
			retainedText = "(no text output)";
		} else if (snapshot.startsWith(previous)) {
			retainedText = snapshot.slice(previous.length) || "(no new text output)";
		} else {
			retainedText = `(replacement snapshot)\n${snapshot}`;
		}
		this.lastStreamedText.set(toolCallId, snapshot);
		const details = formatDetails(update.details);
		const body = details ? `${retainedText}\n  details: ${details}` : retainedText;
		const component = this.attempts.get(toolCallId);
		if (component) this.details.removeChild(component);
		this.details.addChild(
			new Text(
				theme.fg(
					"dim",
					`Stream update ${this.streamedUpdateCount} · ${toolName} · call ${toolCallId}\n${indent(body)}`,
				),
				1,
				0,
			),
		);
		if (component) this.details.addChild(component);
		this.updateSummary();
	}

	finishAttempt(toolCallId: string, isError: boolean): void {
		if (!this.attempts.has(toolCallId)) return;
		this.finalizedAttemptCount++;
		if (isError) this.toolErrorCount++;
		this.updateSummary();
	}

	recordRepair(component: ComponentWithExpansion): void {
		this.repairCount++;
		component.setExpanded(this.expanded);
		this.details.addChild(component);
		this.updateSummary();
	}

	markTerminal(status: ActionTraceTerminalStatus): void {
		this.terminalStatus = status;
		this.updateSummary();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const component of this.attempts.values()) component.setExpanded(expanded);
		for (const child of this.details.children) {
			if (isExpandable(child)) child.setExpanded(expanded);
		}
		this.updateSummary();
	}

	setShowImages(show: boolean): void {
		for (const component of this.attempts.values()) component.setShowImages(show);
	}

	setImageWidthCells(width: number): void {
		for (const component of this.attempts.values()) component.setImageWidthCells(width);
	}

	override render(width: number): string[] {
		const summaryLines = this.summary.render(width);
		return this.expanded ? [...summaryLines, ...this.details.render(width)] : summaryLines;
	}

	private updateSummary(): void {
		const attemptCount = this.attempts.size;
		const attemptStatus =
			this.finalizedAttemptCount > 0
				? ` (${this.finalizedAttemptCount} finalized, ${countLabel(this.toolErrorCount, "tool error")})`
				: "";
		const status = this.terminalStatus ?? "active";
		const id = this.expanded ? ` · ${this.actionId}` : "";
		this.summary.setText(
			theme.fg(
				"dim",
				`Action trace${id} · ${countLabel(attemptCount, "attempt")}${attemptStatus} · ${countLabel(this.repairCount, "repair")} · ${countLabel(this.streamedUpdateCount, "streamed update")} · ${status}`,
			),
		);
	}
}

interface ComponentWithExpansion {
	render(width: number): string[];
	invalidate(): void;
	setExpanded(expanded: boolean): void;
}

function isExpandable(component: unknown): component is ComponentWithExpansion {
	return (
		typeof component === "object" &&
		component !== null &&
		"setExpanded" in component &&
		typeof component.setExpanded === "function"
	);
}
