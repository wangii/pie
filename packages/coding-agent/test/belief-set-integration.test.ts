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

/** Concatenate every text block across a captured LLM context's messages. */
function contextText(ctx: { messages: Array<{ content: unknown }> }): string {
	return ctx.messages.map((m) => messageText(m)).join("\n");
}

/** The tool names present in a captured LLM context. */
function contextToolNames(ctx: { tools?: Array<{ name: string }> }): string[] {
	return (ctx.tools ?? []).map((t) => t.name);
}

describe("declare_belief integration", () => {
	test("declare_belief and view_beliefs are active when enabled", async () => {
		const harness = await createHarness({ enableBeliefSet: true });
		try {
			expect(harness.session.getActiveToolNames()).toContain("declare_belief");
			expect(harness.session.getAllTools().map((t) => t.name)).toContain("declare_belief");
			expect(harness.session.getAllTools().map((t) => t.name)).toContain("view_beliefs");
			expect(harness.session.systemPrompt).toContain("Record or update what you currently believe");
		} finally {
			harness.cleanup();
		}
	});

	test("enableBeliefSet: false disables the belief tools", async () => {
		const harness = await createHarness({ enableBeliefSet: false });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("declare_belief");
			expect(harness.session.getActiveToolNames()).not.toContain("view_beliefs");
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

	test("initial role is epistemic: only belief tools are projected", async () => {
		const harness = await createHarness({ enableBeliefSet: true });
		try {
			// The model-facing tool list is the epistemic role's subset; the full active
			// list (read/bash/…) is still available via `getActiveToolNames`.
			expect(harness.session.agent.state.tools.map((t) => t.name)).toEqual(["declare_belief", "view_beliefs"]);
		} finally {
			harness.cleanup();
		}
	});

	test("epistemic prompt describes the belief-action cycle and never advertises file/command tools", async () => {
		const harness = await createHarness({ enableBeliefSet: true });
		try {
			const prompt = harness.session.agent.state.systemPrompt;
			// The epistemic role has no read/bash/edit/write, so the prompt must not
			// claim them (the coding-agent preamble did, which drove the model to call
			// `bash` and get "Tool bash not found").
			expect(prompt).not.toContain("reading files");
			expect(prompt).not.toContain("executing commands");
			expect(prompt).not.toContain("expert coding assistant");
			expect(prompt).not.toContain("In addition to the tools above");
			expect(prompt).not.toContain("Pi documentation");
			// It frames the role as a scientific mind following the hypothesis → experiment
			// → update protocol, rather than "start working" blindly.
			expect(prompt).toContain("scientific mind");
			expect(prompt).toContain("hypothesis → experiment → update protocol");
			expect(prompt).toContain("falsifiable expectation");
			expect(prompt).toContain("Settle each hypothesis before proposing the next");
		} finally {
			harness.cleanup();
		}
	});

	test("two-role flow: propose dispatches to execution, then adjudication settles the frame", async () => {
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
				// Epistemic: propose a frame.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "the cache survives logout",
								domain: "product",
								expectation: "a probe keeps the cached value",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				// Propose auto-dispatches to the execution (action) step.
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled result.
				"the value persisted",
				// Epistemic: adjudicate with evidence.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the probe kept the value" },
						},
					],
					stopReason: "toolUse",
				},
				// Epistemic: finalize.
				"the cache survives logout for 30s",
			],
		});
		try {
			await harness.session.prompt("hi");

			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("the cache survives logout for 30s");
		} finally {
			harness.cleanup();
		}
	});

	test("proposing a frame auto-dispatches to the execution role on the next turn", async () => {
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
				// Epistemic: propose a frame.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "the cache survives logout",
								domain: "product",
								expectation: "a probe keeps the cached value",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				// The very next turn is already the execution (action) step — probe tools
				// present, `declare_belief` absent. The epistemic role does not get another
				// turn to "explore" on its own.
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled result.
				"the value persisted",
				// Epistemic: settle with evidence.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the probe kept the value" },
						},
					],
					stopReason: "toolUse",
				},
				// Epistemic: finalize.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The turn immediately after propose is execution: echo present, declare_belief not.
			const executionContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("echo"));
			expect(executionContexts.length).toBeGreaterThan(0);
			for (const c of executionContexts) {
				expect(contextToolNames(c)).not.toContain("declare_belief");
			}
			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	test("epistemic role sees raw execution evidence so it can update beliefs", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({
				content: [{ type: "text", text: "RAW_SENSITIVE_OUTPUT" }],
				details: undefined,
			}),
		};

		const harness = await createHarness({
			enableBeliefSet: true,
			baseToolsOverride: { echo: echoTool },
			responses: [
				// Epistemic: propose.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "the cache survives logout",
								domain: "product",
								expectation: "a probe keeps the cached value",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				// Propose auto-dispatches to execution; probe produces raw output here.
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled sentence.
				"the value persisted",
				// Epistemic: support — this turn must see the raw evidence to settle the belief.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				// Epistemic: finalize.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The raw execution result is NOT omitted from the epistemic role: it sees it
			// (alongside the distilled sentence) so it can update or propose beliefs.
			const epistemicContexts = harness.faux.contexts.filter((c) =>
				contextToolNames(c).includes("declare_belief"),
			);
			expect(epistemicContexts.length).toBeGreaterThan(0);
			expect(epistemicContexts.some((c) => contextText(c).includes("RAW_SENSITIVE_OUTPUT"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("proposes and settles multiple beliefs in one batch", async () => {
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
				// Epistemic: propose TWO beliefs in one turn.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "the cache survives logout",
								domain: "product",
								expectation: "a probe keeps the value",
								evidenceRounds: 1,
							},
						},
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "login is stateless",
								domain: "product",
								expectation: "no session reuse",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				// Execution: probe.
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled sentence.
				"the value persisted",
				// Epistemic: support both beliefs in one turn.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-2", evidence: "no session reuse observed" },
						},
					],
					stopReason: "toolUse",
				},
				// Epistemic: finalize.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);
			expect(harness.session.beliefs.find((b) => b.id === "belief-2")?.supportedBy).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});
});
