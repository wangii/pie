import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

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

const actionContract = {
	intent: "Inspect the implementation boundary",
	completionCondition: "Exact repository results establish the boundary",
	expectation: "The inspect result shows the implementation boundary is runtime configuration",
} as const;

const frame = {
	kind: "create_frame",
	statement: "The implementation boundary controls the observed behavior",
	expectation: "An exact result shows the behavior is controlled by runtime config, not a static boundary",
	actions: [
		{
			...actionContract,
			expectedEvidenceRounds: 2,
			budgetReason: "The first probe locates the boundary; the second reads it",
		},
	],
} as const;

const authorizeAction = { kind: "authorize_action", actionContractId: "A1" } as const;

function options(overrides: Partial<Parameters<typeof createHarness>[0]> = {}) {
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

describe("Phase 10 execution feedback observation", () => {
	it("materializes an unresolvable episode as a frame-targeted Observation with exact provenance", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "no-static-boundary" }, { id: "call-u" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				control({
					kind: "unresolvable_action",
					predictionError: {
						sign: "refuted",
						detail: "The boundary is runtime config, so the frozen condition cannot be met here",
					},
					observation: {
						statement: "The implementation boundary is runtime configuration",
						affects: "anchor_and_frame",
					},
				}),
				control({ kind: "report_inability", reason: "A corrected Frame must be authorized separately" }),
				fauxAssistantMessage("reconsider under a corrected commitment"),
			]);

			await harness.session.prompt("inspect the boundary");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				statement: "The implementation boundary is runtime configuration",
				frameId: expect.any(String),
				frameRevisionEntryId: expect.any(String),
				anchorId: expect.any(String),
				anchorRevisionEntryId: expect.any(String),
			});
			const resultEntry = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(resultEntry).toBeDefined();
			expect((observations[0] as { sourceEventIds: string[] }).sourceEventIds).toEqual([resultEntry!.id]);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "unresolvable" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("materializes an escalation as an Observation targeting the challenged object", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "contradicts-frame" }, { id: "call-e" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				control({
					kind: "escalate_action",
					challenge: "frame",
					predictionError: {
						sign: "refuted",
						detail: "The exact result contradicts the Frame relation",
					},
					observation: {
						statement: "The implementation boundary is runtime configuration, not a static boundary",
						affects: "frame",
					},
				}),
				control({ kind: "falsify_frame", reason: "The expectation is established by the escalated result" }),
				control({ kind: "report_inability", reason: "A corrected Frame must be authorized separately" }),
				fauxAssistantMessage("reconsider under a corrected commitment"),
			]);

			await harness.session.prompt("inspect the boundary");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				statement: "The implementation boundary is runtime configuration, not a static boundary",
				frameId: expect.any(String),
			});
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_transition")).toEqual([
				expect.objectContaining({ transition: "falsified" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("materializes no Observation for an episode with no finalized execution result", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage("no probe ran"),
				control({
					kind: "unresolvable_action",
					predictionError: {
						sign: "refuted",
						detail: "The frozen condition cannot be met before any probe runs",
					},
				}),
				control({ kind: "report_inability", reason: "A corrected Frame must be authorized separately" }),
				fauxAssistantMessage("reconsider"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(harness.sessionManager.getBranch().some((entry) => entry.type === "observation")).toBe(false);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "unresolvable" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("materializes a frame-targeted Observation for complete_action", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "boundary-established" }, { id: "call-c" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The implementation boundary is established in the runtime configuration",
					},
					observation: {
						statement: "The implementation boundary is runtime configuration",
						affects: "frame",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				statement: "The implementation boundary is runtime configuration",
				frameId: expect.any(String),
				frameRevisionEntryId: expect.any(String),
			});
			// complete_action confirms its frozen expectation, so the evidence targets
			// the Frame only — never the Anchor.
			expect((observations[0] as { anchorId?: string }).anchorId).toBeUndefined();
			expect((observations[0] as { anchorRevisionEntryId?: string }).anchorRevisionEntryId).toBeUndefined();
			// The raw tool output is never inlined into the statement; only the named
			// conclusion crosses the execution/epistemic boundary.
			expect((observations[0] as { statement: string }).statement).not.toContain("observed:");
			const resultEntry = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(resultEntry).toBeDefined();
			expect((observations[0] as { sourceEventIds: string[] }).sourceEventIds).toEqual([resultEntry!.id]);
		} finally {
			harness.cleanup();
		}
	});

	it("projects the feedback Observation into the next epistemic request and survives Frame death", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "runtime-config" }, { id: "call-p" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				control({
					kind: "unresolvable_action",
					predictionError: {
						sign: "refuted",
						detail: "The boundary is runtime config, so the frozen condition cannot be met here",
					},
					observation: {
						statement: "The implementation boundary is runtime configuration",
						affects: "anchor_and_frame",
					},
				}),
				control({ kind: "kill_frame", reason: "The Frame premise is contradicted by the observed result" }),
				control({
					kind: "create_frame",
					statement: "The boundary is supplied at runtime by configuration",
					expectation: "An exact result shows the boundary is statically defined",
					actions: [
						{
							...actionContract,
							intent: "Inspect the runtime configuration source",
							completionCondition: "The configuration source is located",
							expectedEvidenceRounds: 1,
							budgetReason: "One response can read the configuration source",
						},
					],
				}),
				control(authorizeAction),
				fauxAssistantMessage("re-discovered nothing; the prior result is already materialized"),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The configuration source is located in the runtime configuration file",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			// After the Frame dies and a successor Frame is created, the feedback
			// Observation remains durable and is still projected for the epistemic decision.
			const projectingContext = harness.providerContexts.find((context) =>
				context.messages
					.map(getMessageText)
					.some((text) => text.includes("The implementation boundary is runtime configuration")),
			);
			expect(projectingContext).toBeDefined();
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_transition")).toEqual([
				expect.objectContaining({ transition: "died" }),
			]);
			expect(harness.session.getEpistemicDiagnostics().state.observations).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("materializes nothing when observation is disabled (Phase 4 ablation)", async () => {
		const harness = await createHarness(options({ observationEnabled: false }));
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "any" }, { id: "call-a" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				control({
					kind: "unresolvable_action",
					predictionError: {
						sign: "refuted",
						detail: "The frozen condition cannot be met because the boundary is runtime configuration",
					},
				}),
				control({ kind: "report_inability", reason: "Reconsider" }),
				fauxAssistantMessage("reconsider"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(harness.sessionManager.getBranch().some((entry) => entry.type === "observation")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an escalate_action whose prediction error is confirmed", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "contradicts-frame" }, { id: "call-rej-e" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				// escalate_action may only carry a refuted prediction error.
				control({
					kind: "escalate_action",
					challenge: "frame",
					predictionError: {
						sign: "confirmed",
						detail: "The result confirms the Frame relation in source",
					},
				}),
				// The controller recovers with a valid terminal decision.
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The probe result establishes the boundary in source",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes("escalate_action prediction error must be refuted"),
				),
			).toBe(true);
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});

	it("accepts a completed Action whose refuted result disproves the Frame premise", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "boundary-established" }, { id: "call-rej-c" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				// Phase 11: execution outcome and epistemic effect are orthogonal. A
				// completed episode whose result disproves the Frame premise carries a
				// refuted prediction error and an explicit material Observation.
				control({
					kind: "complete_action",
					predictionError: {
						sign: "refuted",
						detail: "The result contradicts the frozen expectation in source",
					},
					observation: {
						statement: "The implementation boundary is statically defined in source, not runtime configuration",
						affects: "anchor_and_frame",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				statement: "The implementation boundary is statically defined in source, not runtime configuration",
				predictionErrorSign: "refuted",
				anchorId: expect.any(String),
				frameId: expect.any(String),
			});
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "completed" }),
			]);
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a confirmed prediction error whose detail is a bare confirmation token", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "boundary-established" }, { id: "call-rej-b" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				// A confirmed detail must name the concrete conclusion, not just "confirmed".
				control({
					kind: "complete_action",
					predictionError: { sign: "confirmed", detail: "confirmed" },
				}),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The probe result establishes the boundary in source",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes("A confirmed prediction error must name the concrete conclusion"),
				),
			).toBe(true);
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a refined prediction error that negates its expectation's claim", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "loader-only" }, { id: "call-rej-r" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				// A refined sign must still claim the expectation held; negating the predicate is a refutation.
				control({
					kind: "complete_action",
					predictionError: {
						sign: "refined",
						detail: "the module contains no literal prompt text; it is a loader",
					},
				}),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "refined",
						detail: "the module holds the boundary and adds the exact export names",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes(
						"A refined prediction error must still claim its expectation held",
					),
				),
			).toBe(true);
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a process-record Observation statement", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "boundary-established" }, { id: "call-pr" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				// A process record narrates what the episode did, not a world relation.
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The boundary is established in source",
					},
					observation: {
						statement: "we did not prove the boundary within budget",
						affects: "frame",
					},
				}),
				// The controller recovers with a valid relation assertion.
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The boundary is established in source",
					},
					observation: {
						statement: "The implementation boundary is runtime configuration",
						affects: "frame",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes("must name a world relation between project referents"),
				),
			).toBe(true);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "observation")).toHaveLength(1);
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an experiment-record Observation statement", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "boundary-established" }, { id: "call-er" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				// An experiment record restates the probe instead of the fact it established.
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The boundary is established in source",
					},
					observation: {
						statement:
							"Expectation: the boundary is runtime config\nPrediction error: confirmed: the boundary is runtime config",
						affects: "frame",
					},
				}),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The boundary is established in source",
					},
					observation: {
						statement: "The implementation boundary is runtime configuration",
						affects: "frame",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes("must be the fact itself, not an experiment record"),
				),
			).toBe(true);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "observation")).toHaveLength(1);
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});
});
