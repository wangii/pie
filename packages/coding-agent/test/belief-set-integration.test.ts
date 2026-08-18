import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { createHarness } from "./test-harness.ts";

function messageText(message: { content: unknown }): string {
	const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

describe("declare_belief integration", () => {
	test("declare_belief is active when enabled", async () => {
		const harness = await createHarness({ enableBeliefSet: true });
		try {
			expect(harness.session.getActiveToolNames()).toContain("declare_belief");
			expect(harness.session.getAllTools().map((t) => t.name)).toContain("declare_belief");
			expect(harness.session.systemPrompt).toContain("Record or update what you currently believe");
		} finally {
			harness.cleanup();
		}
	});

	test("enableBeliefSet: false disables declare_belief", async () => {
		const harness = await createHarness({ enableBeliefSet: false });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("declare_belief");
			expect(harness.session.getAllTools().map((t) => t.name)).not.toContain("declare_belief");
		} finally {
			harness.cleanup();
		}
	});

	test("declare_belief stays active when the CLI supplies a tool list without it", async () => {
		const harness = await createHarness({
			enableBeliefSet: true,
			initialActiveToolNames: ["read", "bash", "edit", "write"],
		});
		try {
			expect(harness.session.getActiveToolNames()).toContain("declare_belief");
		} finally {
			harness.cleanup();
		}
	});

	test("entry gate: blocks dispatch while the belief set is empty", async () => {
		const harness = await createHarness({
			enableBeliefSet: true,
			responses: [{ toolCalls: [{ name: "bash", args: { command: "ls" } }], stopReason: "toolUse" }, "done"],
		});
		try {
			await harness.session.prompt("hi");

			const result = harness.session.messages.find((m) => m.role === "toolResult");
			expect(result?.role === "toolResult" ? result.isError : false).toBe(true);
			expect(result ? messageText(result) : "").toContain("You hold no beliefs");
		} finally {
			harness.cleanup();
		}
	});

	test("exit gate: blocks the answer while beliefs are proposed", async () => {
		const harness = await createHarness({
			enableBeliefSet: true,
			responses: [
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "propose", statement: "the cache survives logout", domain: "product" },
						},
					],
					stopReason: "toolUse",
				},
				"premature answer",
				{
					toolCalls: [{ name: "declare_belief", args: { op: "support", beliefId: "belief-1" } }],
					stopReason: "toolUse",
				},
				"final answer",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The premature stop was blocked and the model was steered to resolve the belief.
			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.status).toBe("supported");
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("final answer");
		} finally {
			harness.cleanup();
		}
	});

	test("middle gate: blocks dispatch after evidence piles up without reconciliation", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({
				content: [{ type: "text", text: "echoed" }],
				details: undefined,
			}),
		};

		const harness = await createHarness({
			enableBeliefSet: true,
			baseToolsOverride: { echo: echoTool },
			responses: [
				// Propose a belief (satisfies the entry gate).
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "propose", statement: "the cache survives logout", domain: "product" },
						},
					],
					stopReason: "toolUse",
				},
				// Evidence 1.
				{ toolCalls: [{ name: "echo", args: { text: "a" } }], stopReason: "toolUse" },
				// Evidence 2 — threshold crossed.
				{ toolCalls: [{ name: "echo", args: { text: "b" } }], stopReason: "toolUse" },
				// This dispatch is blocked by the middle gate.
				{ toolCalls: [{ name: "echo", args: { text: "c" } }], stopReason: "toolUse" },
				// Reconcile.
				{
					toolCalls: [{ name: "declare_belief", args: { op: "support", beliefId: "belief-1" } }],
					stopReason: "toolUse",
				},
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			const errorResults = harness.session.messages
				.filter((m) => m.role === "toolResult")
				.filter((m) => m.isError === true);
			expect(errorResults.length).toBe(1);
			expect(messageText(errorResults[0])).toContain("your belief set is stale");

			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.status).toBe("supported");
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("done");
		} finally {
			harness.cleanup();
		}
	});
});
