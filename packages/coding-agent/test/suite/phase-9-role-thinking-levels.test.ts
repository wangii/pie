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

function options() {
	return {
		pieProductionLoop: true,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled: true,
		tools: [inspectTool],
		models: [{ id: "reasoning-model", reasoning: true }],
		frameHorizonRange: { min: 6, max: 32 },
	};
}

function runSequence() {
	return [
		control({
			kind: "create_frame",
			statement: "Prompt construction in the loop is produced only by externally injected messages",
			falsifier: "The loop source shows a prompt template or assembly routine inside the class",
			actions: [actionBudget(action)],
		}),
		control({ kind: "authorize_action", actionContractId: "A1" }),
		fauxAssistantMessage("The loop source was read in full."),
		control({ kind: "complete_action", reason: "A single full read established the entry points" }),
		control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
		fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
	];
}

describe("Pie production role thinking levels", () => {
	it("defaults control roles below execution and honors per-role overrides", async () => {
		const harness = await createHarness({ ...options(), pieRoleThinkingLevels: { execution: "high" } });
		try {
			harness.setResponses(runSequence());
			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerReasoningLevels).toContain("low");
			expect(harness.providerReasoningLevels).toContain("high");
		} finally {
			harness.cleanup();
		}
	});

	it("lets an explicit control-role override replace the default low level", async () => {
		const harness = await createHarness({
			...options(),
			pieRoleThinkingLevels: { epistemic: "off", finalAnswer: "off" },
		});
		try {
			harness.setResponses(runSequence());
			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerReasoningLevels).toContain(undefined);
			expect(harness.providerReasoningLevels).not.toContain("low");
		} finally {
			harness.cleanup();
		}
	});
});
