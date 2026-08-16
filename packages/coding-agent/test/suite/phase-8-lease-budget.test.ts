import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { deriveFrameLease, type ProvisionalActionContract } from "../../src/core/frame-lease-budget.ts";
import { createHarness } from "./harness.ts";

function control(decision: Record<string, unknown>) {
	return fauxAssistantMessage(JSON.stringify(decision));
}

const inspectTool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "Return deterministic evidence",
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

const firstAction = {
	intent: "Discover source locations for the implementation entry point",
	completionCondition: "Exact paths identify the implementation entry point",
	expectation: "Exact paths identify the implementation entry point",
};
const secondAction = {
	intent: "Inspect behavior at the located entry point",
	completionCondition: "Exact source evidence establishes the implementation behavior",
	expectation: "Exact source evidence establishes the implementation behavior",
};

function budget(
	action: { intent: string; completionCondition: string; expectation: string },
	expectedEvidenceRounds: number,
): ProvisionalActionContract {
	return {
		...action,
		expectedEvidenceRounds,
		budgetReason:
			expectedEvidenceRounds === 1
				? "All known independent probes can be issued in one response"
				: "The later probe path depends on the location returned by the preceding result",
	};
}

function frame(actions: ProvisionalActionContract[]) {
	return {
		kind: "create_frame",
		statement: "Repository behavior is controlled by one implementation boundary",
		expectation: "A runtime trace shows behavior bypasses that implementation boundary",
		actions,
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
	};
}

describe("Phase 8 model-response lease derivation", () => {
	it("derives the same Frame horizon from the same serial evidence rounds", () => {
		const actions = [budget(firstAction, 2), budget(secondAction, 3)];
		const first = deriveFrameLease(actions);
		const second = deriveFrameLease(structuredClone(actions));

		expect(first).toEqual(second);
		expect(first).toEqual({
			horizon: 13,
			provisionalActionCount: 2,
			expectedEvidenceRounds: [2, 3],
			costs: {
				initialControl: 0,
				actionAuthorization: 2,
				execution: 5,
				actionTerminalAdjudication: 4,
				finalFrameAdjudication: 2,
			},
		});
	});

	it("rejects a direct horizon and unsupported round estimates without silent clamping", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({ ...frame([budget(firstAction, 1)]), horizon: 24 }),
				control(frame([{ ...budget(firstAction, 1), expectedEvidenceRounds: 6 }])),
				control(frame([budget(firstAction, 1)])),
				control({ kind: "report_inability", reason: "Validation paths were exercised" }),
				fauxAssistantMessage("The invalid budgets were rejected."),
			]);

			await harness.session.prompt("exercise deterministic lease validation");

			const revision = harness.sessionManager.getBranch().find((entry) => entry.type === "frame_revision");
			expect(revision).toMatchObject({ horizon: 6 });
			expect(harness.providerContexts[1]!.systemPrompt).toContain("do not supply horizon directly");
			expect(harness.providerContexts[2]!.systemPrompt).toContain("split or narrow larger Actions");
		} finally {
			harness.cleanup();
		}
	});

	it("authorizes a projected-out provisional contract by its visible stable ID", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame([budget(firstAction, 1)])),
				(context) => {
					const rawMessages = context.messages.map((message) => JSON.stringify(message)).join("\n");
					expect(rawMessages).not.toContain('"kind":"create_frame"');
					expect(context.systemPrompt).toContain('"actionContractId":"A1"');
					expect(context.systemPrompt).toContain(firstAction.intent);
					return control({ kind: "authorize_action", actionContractId: "A1" });
				},
				fauxAssistantMessage("The exact path is established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The listed contract condition was established by the exact path result",
					},
				}),
				control({ kind: "authorize_final", reason: "The bounded request is satisfied" }),
				fauxAssistantMessage("Located."),
			]);

			await harness.session.prompt("locate the implementation boundary");

			expect(harness.sessionManager.getBranch().find((entry) => entry.type === "action_start")).toMatchObject(
				firstAction,
			);
			expect(harness.providerContexts[1]!.systemPrompt).not.toContain("ensure its exact contract matches");
		} finally {
			harness.cleanup();
		}
	});

	it("counts parallel tool calls as one evidence round and dependent probes as another", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame([budget(firstAction, 2)])),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage(
					[
						fauxToolCall("inspect", { value: "a" }, { id: "parallel-a" }),
						fauxToolCall("inspect", { value: "b" }, { id: "parallel-b" }),
						fauxToolCall("inspect", { value: "c" }, { id: "parallel-c" }),
					],
					{ stopReason: "toolUse" },
				),
				(context) =>
					fauxAssistantMessage(
						context.systemPrompt?.includes("1/2 serial evidence rounds")
							? fauxToolCall("inspect", { value: "dependent" }, { id: "dependent" })
							: "round count missing",
						{ stopReason: "toolUse" },
					),
				control({
					kind: "unresolvable_action",
					predictionError: {
						sign: "refuted",
						detail: "The accepted two-round estimate is exhausted without the dependent result",
					},
				}),
				control({ kind: "report_inability", reason: "The bounded probe remains inconclusive" }),
				fauxAssistantMessage("Bounded evidence gathering ended."),
			]);

			await harness.session.prompt("inspect parallel and dependent probes");

			const transition = harness.sessionManager.getBranch().find((entry) => entry.type === "action_transition");
			expect(transition).toMatchObject({ transition: "unresolvable" });
			const diagnostics = harness.session.getEpistemicDiagnostics().leaseBudget;
			expect(diagnostics).toMatchObject({
				derivation: "available",
				expectedEvidenceRounds: [2],
			});
			expect(diagnostics?.unusedEvidenceRounds).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("returns unused evidence-round lease when an Action completes early", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame([budget(firstAction, 3)])),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "entry" }, { id: "early" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The exact path is established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The completion condition was established early by the exact entry result",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested location is established" }),
				fauxAssistantMessage("Located."),
			]);

			await harness.session.prompt("locate the implementation entry point");

			expect(harness.session.getEpistemicDiagnostics().leaseBudget).toMatchObject({
				derivation: "available",
				expectedEvidenceRounds: [3],
				unusedEvidenceRounds: 2,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("revises a Frame with a newly derived append-only lease", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame([budget(firstAction, 1)])),
				control({
					kind: "revise_frame",
					statement: "Repository behavior is controlled by a revised implementation boundary",
					expectation: "A runtime trace shows behavior bypasses the revised implementation boundary",
					actions: [budget(secondAction, 2)],
					reason: "New evidence changed the bounded candidate set",
				}),
				control({ kind: "report_inability", reason: "The append-only revision was verified" }),
				fauxAssistantMessage("Revised."),
			]);

			await harness.session.prompt("revise the bounded investigation");

			const revisions = harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_revision");
			expect(revisions).toHaveLength(2);
			expect(revisions[0]).toMatchObject({ version: 1, horizon: 6, previousRevisionId: null });
			expect(revisions[1]).toMatchObject({
				version: 2,
				horizon: 7,
				previousRevisionId: revisions[0]!.id,
				revisionReason: "New evidence changed the bounded candidate set",
			});
			expect(harness.session.getEpistemicDiagnostics().leaseBudget).toMatchObject({
				derivation: "available",
				expectedEvidenceRounds: [2],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("does not persist or recreate a transient lease plan on restart", async () => {
		const first = await createHarness(fullStackOptions());
		const manager = first.sessionManager;
		try {
			first.setResponses([
				control(frame([budget(firstAction, 1)])),
				control({ kind: "report_inability", reason: "Leave the derived Frame active" }),
				fauxAssistantMessage("Paused."),
			]);
			await first.session.prompt("create a bounded investigation");
			expect(first.session.getEpistemicDiagnostics().leaseBudget?.derivation).toBe("available");
			expect(manager.getEntries().filter((entry) => entry.type !== "message")).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ expectedEvidenceRounds: expect.anything() })]),
			);
		} finally {
			first.cleanup();
		}

		const resumed = await createHarness({ ...fullStackOptions(), sessionManager: manager });
		try {
			expect(resumed.session.getEpistemicDiagnostics().leaseBudget).toMatchObject({
				derivation: "unavailable",
			});
			expect(resumed.session.frame?.horizon).toBe(6);
			expect(resumed.providerContexts).toHaveLength(0);
		} finally {
			resumed.cleanup();
		}
	});
});
