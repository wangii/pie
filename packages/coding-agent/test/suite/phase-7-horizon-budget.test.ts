import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

function control(decision: Record<string, unknown>) {
	return fauxAssistantMessage(JSON.stringify(decision));
}

describe("Phase 8 production model-response lease budgeting", () => {
	it("derives the Frame lease from provisional serial evidence rounds", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
		});
		try {
			const action = {
				intent: "Discover source locations for the production prompt construction entry points",
				completionCondition: "Exact file locations identify each production prompt construction entry point",
				expectation: "Exact file locations in the source show each production prompt construction entry point",
			};
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction paths determine which constraints reach each model role",
					expectation: "A provider payload shows every model role receives one identical constraint source",
					actions: [
						{
							...action,
							expectedEvidenceRounds: 2,
							budgetReason: "The second read path depends on the source location returned by the first result",
						},
					],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The exact entry points are established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The exact production prompt construction entry points were established in the source",
					},
				}),
				control({ kind: "authorize_final", reason: "The bounded prompt audit satisfies the request" }),
				fauxAssistantMessage("Prompt audit complete."),
			]);

			await harness.session.prompt("audit the production prompts");

			const frame = harness.sessionManager.getBranch().find((entry) => entry.type === "frame_revision");
			if (!frame) throw new Error("Expected the production controller to create a Frame.");
			expect(frame).toMatchObject({ horizon: 7 });
			const initialPrompt = harness.providerContexts[0]!.systemPrompt;
			// Mechanics (horizon formula, advance limits, evidence-round budgets) are the
			// harness's to enforce, not the model's to reason about.
			expect(initialPrompt).toContain("The harness derives and enforces the Frame horizon");
			expect(initialPrompt).not.toContain("initial control");
			expect(initialPrompt).not.toContain("parallel read-only calls in that response count once");
			expect(initialPrompt).not.toContain("integer 1-5");
		} finally {
			harness.cleanup();
		}
	});
});
