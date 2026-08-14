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
					reason: "The boundary is runtime config, so the frozen condition cannot be met here",
				}),
				control({ kind: "report_inability", reason: "A corrected Frame must be authorized separately" }),
				fauxAssistantMessage("reconsider under a corrected commitment"),
			]);

			await harness.session.prompt("inspect the boundary");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				statement: "The boundary is runtime config, so the frozen condition cannot be met here",
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
					reason: "The exact result contradicts the Frame relation",
				}),
				control({ kind: "falsify_frame", reason: "The expectation is established by the escalated result" }),
				control({ kind: "report_inability", reason: "A corrected Frame must be authorized separately" }),
				fauxAssistantMessage("reconsider under a corrected commitment"),
			]);

			await harness.session.prompt("inspect the boundary");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				statement: "The exact result contradicts the Frame relation",
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
					reason: "The frozen condition cannot be met before any probe runs",
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

	it("materializes no Observation for complete_action", async () => {
		const harness = await createHarness(options());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "boundary-established" }, { id: "call-c" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The probe result is finalized."),
				control({ kind: "complete_action", reason: "The boundary is established" }),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(harness.sessionManager.getBranch().some((entry) => entry.type === "observation")).toBe(false);
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
					reason: "The boundary is runtime config, so the frozen condition cannot be met here",
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
						},
					],
				}),
				control(authorizeAction),
				fauxAssistantMessage("re-discovered nothing; the prior result is already materialized"),
				control({ kind: "complete_action", reason: "The configuration source is located" }),
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
					.some((text) =>
						text.includes("The boundary is runtime config, so the frozen condition cannot be met here"),
					),
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
				control({ kind: "unresolvable_action", reason: "The frozen condition cannot be met" }),
				control({ kind: "report_inability", reason: "Reconsider" }),
				fauxAssistantMessage("reconsider"),
			]);

			await harness.session.prompt("inspect the boundary");

			expect(harness.sessionManager.getBranch().some((entry) => entry.type === "observation")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
