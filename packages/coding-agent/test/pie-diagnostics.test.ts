import { beforeAll, describe, expect, it } from "vitest";
import type { EpistemicDiagnostics } from "../src/core/agent-session.ts";
import type { ActionTransitionEntry } from "../src/core/session-manager.ts";
import {
	formatOperationalError,
	formatPieStatus,
	PieDiagnosticsComponent,
	PieProjectionReductionNoticeComponent,
	PieRestorationReceiptComponent,
	PieStateTransitionComponent,
} from "../src/modes/interactive/components/pie-diagnostics.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function plain(lines: string[]): string {
	return lines
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.trim();
}

const diagnostics: EpistemicDiagnostics = {
	enabled: { anchor: true, frame: true, action: true, observation: true },
	state: {
		anchor: { id: "anchor-1", revision: 2, statement: "ship the fix", revisionEntryId: "anchor-event" },
		frame: {
			id: "frame-1",
			version: 3,
			statement: "cache survives logout",
			falsifier: "restart preserves failure",
			revisionEntryId: "frame-event",
			horizon: 24,
			completedModelResponses: 7,
		},
		action: {
			id: "action-1",
			intent: "inspect cache lifetime",
			completionCondition: "identify TTL",
			startEntryId: "action-event",
			completedModelResponses: 2,
		},
		lastAction: { id: "action-1", startEntryId: "action-event" },
		observations: [
			{
				id: "observation-17",
				statement: "TTL is 30 seconds",
				entryId: "observation-event",
				sourceEventIds: ["result-event"],
				provenance: [
					{
						rawEventId: "result-event",
						toolCallId: "call-1",
						toolName: "bash",
						arguments: { command: "npm test" },
						isError: true,
						output: "failed assertion",
					},
				],
			},
		],
	},
	provenance: { rawEventCount: 81, activeBranchEventCount: 64, legacySummaryCount: 2 },
	runtime: {
		loopState: "tool_execution",
		inputReady: false,
		recovery: {
			classification: "completed_negative_result",
			toolCallId: "call-1",
			toolName: "bash",
			attempt: 1,
			maxAttempts: 3,
			actionId: "action-1",
			message: "failed assertion",
			frozenContract: true,
			requiresInspection: false,
		},
	},
	context: {
		compilerVersion: "pie-phase-4-observation/v1",
		selectedEventCount: 23,
		omittedEventCount: 41,
		omissionsByReason: { budget: 37, historical_summary: 2, not_model_facing: 2 },
		availableInputTokens: 12_000,
		outputMessageTokens: 8_400,
	},
};

describe("Pie diagnostics UI projections", () => {
	beforeAll(() => initTheme("dark"));

	it("formats the persistent status from loop and compiler diagnostics", () => {
		const session = { getEpistemicDiagnostics: () => diagnostics };
		const status = formatPieStatus(session as never);
		expect(status).toBe(
			"Pie · TOOL EXECUTION · ACTION running · Frame responses 7/24 · ctx 8.4k/12k · omitted 41 · repair 1/3 completed negative result",
		);
	});

	it("renders budget-pressure notices without compaction language", () => {
		const notice = plain(new PieProjectionReductionNoticeComponent(37).render(120));
		expect(notice).toBe("Projection reduced: 37 older events omitted; raw log unchanged.");
		expect(notice).not.toContain("compact");
		expect(plain(new PieProjectionReductionNoticeComponent(1).render(120))).toContain("1 older event omitted");
	});

	it("renders read-only state, omission reasons, and exact Observation provenance", () => {
		const output = plain(new PieDiagnosticsComponent(diagnostics).render(200));
		expect(output).toContain("Pie diagnostics (read-only)");
		expect(output).toContain("falsifier: restart preserves failure");
		expect(output).toContain("frozen completion: identify TTL");
		expect(output).toContain("source result-event · bash · call call-1");
		expect(output).toContain('args: {"command":"npm test"}');
		expect(output).toContain("retained output:\nfailed assertion");
		expect(output).toContain("budget=37");
		expect(output).toContain("input budget: 12000");
	});

	it("renders collapsible transition markers and restoration receipts without conversation messages", () => {
		const transition: ActionTransitionEntry = {
			type: "action_transition",
			id: "transition-event",
			parentId: "result-event",
			timestamp: new Date(0).toISOString(),
			actionId: "action-1",
			startEntryId: "action-event",
			transition: "unresolvable",
			sourceEventId: "result-event",
			reason: "repair exhausted",
		};
		const marker = new PieStateTransitionComponent(transition);
		expect(plain(marker.render(120))).toBe("Action UNRESOLVABLE");
		marker.setExpanded(true);
		expect(plain(marker.render(120))).toContain("repair exhausted");

		const receipt = new PieRestorationReceiptComponent(diagnostics);
		expect(plain(receipt.render(200))).toContain("action-1 (interrupted persisted Action; not replayed)");
		receipt.setExpanded(true);
		expect(plain(receipt.render(200))).toContain("Legacy summaries ignored for cognition: 2");
	});

	it("states bounded repair and frozen-contract policy", () => {
		const output = formatOperationalError(
			{
				classification: "ambiguous_mutation",
				toolCallId: "write-3",
				toolName: "write",
				attempt: 3,
				maxAttempts: 3,
				actionId: "action-1",
				message: "write may have completed",
				frozenContract: true,
				requiresInspection: true,
			},
			true,
		);
		expect(output).toContain("repair 3/3");
		expect(output).toContain("Action intent and completion condition remain frozen");
		expect(output).toContain("blind replay is blocked");
		expect(output).toContain("UNRESOLVABLE");
	});
});
