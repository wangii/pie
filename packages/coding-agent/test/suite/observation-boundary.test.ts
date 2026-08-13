import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

const frame = {
	type: "create" as const,
	statement: "worker-local state survives logout",
	falsifier: "a worker restart preserves the authorization failure",
	horizon: 5,
};

const action = {
	type: "start" as const,
	intent: "determine whether logout invalidates worker-local authorization state",
	completionCondition: "the worker cache lifetime is identified or cache survival is ruled out",
};

const inspectTool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "Inspect worker state",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: "worker cache TTL is 30 seconds" }],
		details: {},
	}),
};

describe("Phase 4 Observation provider boundary", () => {
	it("materializes selected evidence and projects it with exact raw provenance", async () => {
		const harness = await createHarness({
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			tools: [inspectTool],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "call-1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("evidence collected"),
				fauxAssistantMessage("reconsider the frame"),
			]);
			await harness.session.prompt("diagnose logout authorization", {
				anchor: { statement: "logout must revoke authorization" },
				frame,
				action,
			});
			const resultEntry = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(resultEntry).toBeDefined();

			await harness.session.prompt("adjudicate the execution result", {
				observation: {
					statement: "worker-local authorization cache survives logout for 30 seconds",
					affects: "anchor_and_frame",
					sourceEventIds: [resultEntry!.id],
				},
			});

			const observation = harness.session.observations[0]!;
			expect(harness.providerContexts).not.toHaveLength(0);
			expect(harness.providerContexts.at(-1)!.messages.map(getMessageText).slice(0, 4)).toEqual([
				"[ANCHOR]\nlogout must revoke authorization",
				"[CURRENT FRAME]\nCommitment: worker-local state survives logout\n" +
					"Falsifier: a worker restart preserves the authorization failure\n" +
					"Horizon: 3 of 5 model responses remain",
				`[OBSERVATION ${observation.id}]\nworker-local authorization cache survives logout for 30 seconds\n` +
					"Relevance: current Frame and Anchor",
				"[CURRENT ACTION]\n" +
					"Intent: determine whether logout invalidates worker-local authorization state\n" +
					"Completion condition: the worker cache lifetime is identified or cache survival is ruled out\n" +
					"Contract: frozen for this episode. Tools and execution strategy may change; intent and completion condition may not. " +
					"If the condition cannot be met under the current Frame and constraints, return exactly UNRESOLVABLE.",
			]);
			expect(harness.session.latestContextManifest).toMatchObject({
				compilerVersion: "pie-phase-4-observation/v1",
				epistemicState: {
					observations: {
						selected: [
							{
								id: observation.id,
								sourceEventIds: [resultEntry!.id],
								anchorRelevant: true,
								frameRelevant: true,
							},
						],
					},
				},
			});
		} finally {
			harness.cleanup();
		}
	});

	it("keeps routine tool errors raw and does not escalate them automatically", async () => {
		const failingTool: AgentTool = {
			...inspectTool,
			execute: async () => {
				throw new Error("unknown option");
			},
		};
		const harness = await createHarness({
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			tools: [failingTool],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "call-error" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("repair locally"),
			]);
			await harness.session.prompt("run the bounded investigation", {
				anchor: { statement: "identify the defect" },
				frame,
				action,
			});

			expect(harness.session.observations).toEqual([]);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "observation")).toBe(false);
			expect(harness.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ role: "toolResult", isError: true }),
				}),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves Phase 3 as the Observation ablation", async () => {
		const harness = await createHarness({
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: false,
		});
		try {
			harness.setResponses([fauxAssistantMessage("baseline")]);
			await harness.session.prompt("baseline", {
				anchor: { statement: "finish baseline" },
				frame,
				action,
			});

			expect(harness.session.latestContextManifest?.compilerVersion).toBe("pie-phase-3-action/v1");
			expect(harness.session.latestContextManifest?.epistemicState.observations).toBeUndefined();
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "observation")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
