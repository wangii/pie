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
	expectation: "The loop source shows the prompt template and assembly routine inside the class",
} as const;

function actionBudget(
	definition: { intent: string; completionCondition: string; expectation: string },
	expectedEvidenceRounds = 1,
) {
	return {
		...definition,
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
			expectation: "The loop source shows a prompt template or assembly routine inside the class",
			actions: [actionBudget(action)],
		}),
		control({ kind: "authorize_action", actionContractId: "A1" }),
		fauxAssistantMessage("The loop source was read in full."),
		control({
			kind: "complete_action",
			predictionError: {
				sign: "confirmed",
				detail: "A single full read established the prompt entry points in the loop source",
			},
		}),
		control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
		fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
	];
}

describe("Pie production role thinking levels", () => {
	it("disables control reasoning by default, keeps final answer low, and honors overrides", async () => {
		const harness = await createHarness({ ...options(), pieRoleThinkingLevels: { execution: "high" } });
		try {
			harness.setResponses(runSequence());
			await harness.session.prompt("locate the prompt entry sites in the loop");

			// Epistemic control emits structured JSON, so it disables reasoning
			// (undefined) rather than reasoning at "low"; finalAnswer keeps "low".
			expect(harness.providerReasoningLevels).toContain(undefined);
			expect(harness.providerReasoningLevels).toContain("low");
			expect(harness.providerReasoningLevels).toContain("high");
		} finally {
			harness.cleanup();
		}
	});

	it("lets an explicit override disable reasoning for both control and final answer", async () => {
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

describe("Pie production control token cap", () => {
	it("caps epistemic control requests and leaves execution uncapped", async () => {
		const harness = await createHarness({ ...options() });
		try {
			harness.setResponses(runSequence());
			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerMaxTokens).toContain(8000);
			expect(harness.providerMaxTokens).toContain(undefined);
		} finally {
			harness.cleanup();
		}
	});

	it("honors an explicit controlMaxTokens override", async () => {
		const harness = await createHarness({ ...options(), controlMaxTokens: 1234 });
		try {
			harness.setResponses(runSequence());
			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerMaxTokens).toContain(1234);
			expect(harness.providerMaxTokens).not.toContain(8000);
		} finally {
			harness.cleanup();
		}
	});
});
