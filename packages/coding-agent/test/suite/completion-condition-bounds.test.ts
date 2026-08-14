import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

function control(decision: Record<string, unknown>) {
	if (
		(decision.kind === "create_frame" || decision.kind === "revise_frame" || decision.kind === "replace_frame") &&
		!("actions" in decision)
	) {
		const { horizon: _legacyHorizon, ...withoutHorizon } = decision;
		return fauxAssistantMessage(JSON.stringify({ ...withoutHorizon, actions: [actionBudget(action)] }));
	}
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

const action = {
	intent: "Read the loop source in full to locate where prompts enter",
	completionCondition: "A single full read of the loop source establishes where its prompts enter",
} as const;

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

function fullStackOptions() {
	return {
		pieProductionLoop: true,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled: true,
		tools: [inspectTool],
		frameHorizonRange: { min: 6, max: 32 },
	};
}

describe("completion condition bounds", () => {
	it("rejects a completion condition that enumerates every occurrence and accepts the bounded rewrite", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					falsifier: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [
						actionBudget({
							intent: "Record every prompt site in the loop source",
							completionCondition:
								"A recorded list of exact file paths and line ranges covers the loop class and every prompt literal, template function, or prompt-building call it uses",
						}),
					],
				}),
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					falsifier: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full; prompts enter only via injected messages."),
				control({ kind: "complete_action", reason: "A single full read established where prompts enter" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "frame_revision")).toEqual([
				expect.objectContaining({
					statement: "Prompt construction in the loop is produced only by externally injected messages",
				}),
			]);
			expect(branch.filter((entry) => entry.type === "action_start")).toEqual([
				expect.objectContaining({
					intent: action.intent,
					completionCondition: action.completionCondition,
				}),
			]);
			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Action completion condition must be confirmable by one bounded observable result",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("instructs control and execution prompts to bound completion and narrow scope", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					falsifier: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full; prompts enter only via injected messages."),
				control({ kind: "complete_action", reason: "A single full read established where prompts enter" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const contexts = harness.providerContexts.map((context) => context.systemPrompt ?? "");
			expect(
				contexts.some((prompt) =>
					prompt.includes("A completion condition is bounded only when one observable result"),
				),
			).toBe(true);
			expect(contexts.some((prompt) => prompt.includes("controlled scope-narrowing exit"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
