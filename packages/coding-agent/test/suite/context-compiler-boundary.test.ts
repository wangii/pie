import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

describe("context compiler provider boundary", () => {
	it("captures the exact provider context and emits a selection manifest", async () => {
		const harness = await createHarness();
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
		const harness = await createHarness({ tools: [echoTool] });
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

	it("bypasses a persisted compaction summary and selects its raw provenance", async () => {
		const harness = await createHarness();
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
