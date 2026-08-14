import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

describe("context compiler provider boundary", () => {
	it("captures the exact provider context and emits a selection manifest", async () => {
		const harness = await createHarness({ anchorEnabled: false });
		try {
			harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
			await harness.session.prompt("first prompt");
			await harness.session.prompt("second prompt");

			expect(harness.providerContexts).toHaveLength(2);
			expect(harness.providerContexts[1]!.messages.map(getMessageText)).toEqual([
				"first prompt",
				"first answer",
				"second prompt",
			]);

			const manifest = harness.session.latestContextManifest;
			expect(manifest?.compilerVersion).toBe("pie-phase-0/v1");
			expect(manifest?.inputEventIds).toHaveLength(3);
			expect(manifest?.selectedEventIds).toEqual(manifest?.inputEventIds);
		} finally {
			harness.cleanup();
		}
	});

	it("compiles tool continuation requests with calls paired to results", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: String((params as { text: string }).text) }],
				details: {},
			}),
		};
		const harness = await createHarness({ tools: [echoTool], anchorEnabled: false });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("start");

			expect(harness.providerContexts).toHaveLength(2);
			const continuation = harness.providerContexts[1]!.messages;
			expect(continuation.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(continuation[1]?.role === "assistant" ? continuation[1].content : []).toContainEqual(
				expect.objectContaining({ type: "toolCall", id: "call-1" }),
			);
			expect(continuation[2]?.role === "toolResult" ? continuation[2].toolCallId : undefined).toBe("call-1");
		} finally {
			harness.cleanup();
		}
	});

	it("projects execution depth and epistemic breadth through the production boundary", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			frameHorizonRange: { min: 4, max: 20 },
		});
		try {
			const decision = (value: Record<string, unknown>) => fauxAssistantMessage(JSON.stringify(value));
			const ownership = {
				intent: "Inspect cache ownership",
				completionCondition: "Exact repository results identify the owning process",
			};
			const invalidation = {
				intent: "Inspect cache invalidation",
				completionCondition: "An exact runtime result establishes invalidation behavior",
			};
			harness.setResponses([
				decision({
					kind: "create_frame",
					statement: "Worker cache lifetime controls authorization behavior",
					expectation: "A clean worker restart preserves the authorization failure",
					actions: [
						{
							...ownership,
							expectedEvidenceRounds: 1,
							budgetReason: "One response can issue all known ownership probes",
						},
						{
							...invalidation,
							expectedEvidenceRounds: 1,
							budgetReason: "One response can issue all known invalidation probes",
						},
					],
				}),
				decision({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("first low-level episode trace"),
				decision({ kind: "complete_action", reason: "The owning process was identified" }),
				decision({ kind: "authorize_action", actionContractId: "A2" }),
				fauxAssistantMessage("second episode result"),
				decision({ kind: "complete_action", reason: "Invalidation behavior was established" }),
				decision({ kind: "authorize_final", reason: "Both bounded results satisfy the request" }),
				fauxAssistantMessage("final answer"),
			]);

			await harness.session.prompt("diagnose authorization behavior");

			const epistemicAfterFirst = harness.providerContexts[4]!.messages.map(getMessageText);
			expect(epistemicAfterFirst.join("\n")).toContain("[ACTION OUTCOME");
			expect(epistemicAfterFirst.join("\n")).toContain("Inspect cache ownership");
			expect(epistemicAfterFirst).not.toContain("first low-level episode trace");

			const secondExecution = harness.providerContexts[5]!.messages.map(getMessageText);
			expect(secondExecution.join("\n")).toContain("[CURRENT ACTION]");
			expect(secondExecution.join("\n")).not.toContain("[ACTION OUTCOME");
			expect(secondExecution).not.toContain("first low-level episode trace");

			const finalProjection = harness.providerContexts[8]!.messages.map(getMessageText).join("\n");
			expect(finalProjection.match(/\[ACTION OUTCOME/g)).toHaveLength(2);
			expect(harness.session.latestContextManifest?.projection).toMatchObject({
				role: "finalAnswer",
				policy: "epistemic-breadth/v1",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("bypasses a persisted compaction summary and selects its raw provenance", async () => {
		const harness = await createHarness({ anchorEnabled: false });
		try {
			const firstId = harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "raw old prompt" }],
				timestamp: 1,
			});
			const assistantId = harness.sessionManager.appendMessage(fauxAssistantMessage("raw old answer"));
			harness.sessionManager.appendCompaction("legacy narrative", firstId, 100);
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

			harness.setResponses([fauxAssistantMessage("continued")]);
			await harness.session.prompt("new prompt");

			const providerMessages = harness.providerContexts[0]!.messages;
			expect(providerMessages.map(getMessageText)).toEqual(["raw old prompt", "raw old answer", "new prompt"]);
			expect(providerMessages.map(getMessageText)).not.toContain("legacy narrative");
			expect(harness.sessionManager.getEntry(assistantId)).toBeDefined();
			expect(harness.sessionManager.getEntries()).toHaveLength(5);
			expect(harness.session.latestContextManifest?.omissions).toContainEqual(
				expect.objectContaining({ eventType: "compaction", reason: "historical_summary" }),
			);
		} finally {
			harness.cleanup();
		}
	});
});
