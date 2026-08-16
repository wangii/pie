import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

function control(decision: Record<string, unknown>) {
	return fauxAssistantMessage(JSON.stringify(decision));
}

const inspectTool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "Return a deterministic world result",
	parameters: Type.Object({ value: Type.String() }),
	execute: async (_toolCallId, params) => ({
		content: [
			{
				type: "text",
				text: `observed:${typeof params === "object" && params !== null && "value" in params ? String(params.value) : ""}`,
			},
		],
		details: {},
	}),
};

function actionBudget(definition: { intent: string; completionCondition: string }, expectedEvidenceRounds = 1) {
	return {
		intent: definition.intent,
		completionCondition: definition.completionCondition,
		expectedEvidenceRounds,
		budgetReason:
			expectedEvidenceRounds === 1
				? "One response can issue all independent known probes"
				: "Each later probe depends on the path or runtime result returned by the preceding probe",
	};
}

const firstAction = {
	intent: "Read the loop source in full to locate where prompts enter",
	completionCondition: "A single full read of the loop source establishes where its prompts enter",
};
const nextAction = {
	intent: "Read the system-prompt template in full to record its structure",
	completionCondition: "A single full read of the system-prompt template establishes its structure",
};

function fullStackOptions(overrides: Record<string, unknown> = {}) {
	return {
		pieProductionLoop: true,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled: true,
		tools: [inspectTool],
		frameHorizonRange: { min: 6, max: 32 },
		...overrides,
	};
}

describe("rolling planning", () => {
	it("bounds a Frame to maxFrameAdvances re-plannings before falsify/replace", async () => {
		const harness = await createHarness(fullStackOptions({ maxFrameAdvances: 1 }));
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(firstAction)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({ kind: "complete_action", reason: "A single full read established where prompts enter" }),
				// First advance: version 1 -> 2, within the limit.
				control({ kind: "advance_frame", reason: "read the next site", actions: [actionBudget(nextAction)] }),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The template was read in full."),
				control({ kind: "complete_action", reason: "A single full read established the template structure" }),
				// Second advance: rejected (limit reached), then control recovers by falsifying.
				control({ kind: "advance_frame", reason: "keep rolling", actions: [actionBudget(firstAction)] }),
				control({ kind: "falsify_frame", reason: "The proposition was re-planned past its bounded allowance" }),
				control({ kind: "report_inability", reason: "The bounded rolling exercise completed" }),
				fauxAssistantMessage("Done."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const transition = harness.sessionManager.getBranch().find((entry) => entry.type === "frame_transition");
			expect(transition).toMatchObject({ transition: "falsified" });
			// The rejected advance is surfaced to the control model as the repair nudge.
			const nudge = harness.providerContexts
				.map((context) => context.systemPrompt)
				.some((prompt) => (prompt ?? "").includes("advanced 1 time(s) (limit 1)"));
			expect(nudge).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an advance_frame that re-plans an already-consumed Action", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(firstAction)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({ kind: "complete_action", reason: "A single full read established where prompts enter" }),
				// Re-plan the exact same episode: rejected by the consumed-action ledger.
				control({ kind: "advance_frame", reason: "re-read it", actions: [actionBudget(firstAction)] }),
				// Then advance to a genuinely new wave, which is accepted.
				control({ kind: "advance_frame", reason: "read the next site", actions: [actionBudget(nextAction)] }),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The template was read in full."),
				control({ kind: "complete_action", reason: "A single full read established the template structure" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			// The consumed-action list is injected into the control prompt after the first wave.
			const controlPrompts = harness.providerContexts.map((context) => context.systemPrompt);
			expect(controlPrompts.some((prompt) => (prompt ?? "").includes("Already-consumed Actions"))).toBe(true);
			// Only the genuinely new wave was started, never the re-planned firstAction a second time.
			const starts = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "action_start")
				.map((entry) => entry.intent);
			expect(starts).toHaveLength(2);
			expect(starts[0]).toBe(firstAction.intent);
			expect(starts[1]).toBe(nextAction.intent);
		} finally {
			harness.cleanup();
		}
	});

	it("instructs create_frame to emit only the first wave and names the rolling operators", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(firstAction)],
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const initialPrompt = harness.providerContexts[0]!.systemPrompt;
			expect(initialPrompt).toContain("first wave of independent Actions");
			expect(initialPrompt).toContain("advance_frame");
			expect(initialPrompt).toContain("never re-enumerate an already-consumed Action");
		} finally {
			harness.cleanup();
		}
	});
});
