import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { createHarness, type FauxResponse } from "./test-harness.ts";

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

/** The epistemic role's explicit "done" signal, ending the investigation. */
const conclude: FauxResponse = { toolCalls: [{ name: "conclude", args: {} }], stopReason: "toolUse" };

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

	test("getRoleContextUsage returns per-role context estimates when the belief loop is active", async () => {
		const harness = await createHarness({ enableBeliefSet: true });
		try {
			const roleUsage = harness.session.getRoleContextUsage();
			expect(roleUsage).toBeDefined();
			expect(roleUsage!.epistemic.contextWindow).toBeGreaterThan(0);
			expect(roleUsage!.execution.contextWindow).toBe(roleUsage!.epistemic.contextWindow);
			expect(roleUsage!.epistemic.tokens).toBeTypeOf("number");
			expect(roleUsage!.execution.tokens).toBeTypeOf("number");
			expect(roleUsage!.epistemic.percent).toBeTypeOf("number");
			expect(roleUsage!.execution.percent).toBeTypeOf("number");
		} finally {
			harness.cleanup();
		}
	});

	test("getRoleContextUsage is undefined when the belief set is disabled", async () => {
		const harness = await createHarness({ enableBeliefSet: false });
		try {
			expect(harness.session.getRoleContextUsage()).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	test("initial role is epistemic: only belief tools are projected", async () => {
		const harness = await createHarness({ enableBeliefSet: true });
		try {
			// The model-facing tool list is the epistemic role's subset; the full active
			// list (read/bash/…) is still available via `getActiveToolNames`.
			expect(harness.session.agent.state.tools.map((t) => t.name)).toEqual([
				"declare_belief",
				"view_beliefs",
				"conclude",
			]);
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
			expect(prompt).toContain("then call conclude");
			// It must state plainly that experiments run in a separate role, not in this
			// one — otherwise the model burns turns re-deriving how it probes the codebase.
			expect(prompt).toContain("cannot read files or run commands");
			expect(prompt).toContain("separate execution role");
			// The update step is a residual filter: explain → isolate → update, not a full re-read.
			expect(prompt).toContain("epistemic residual");
			expect(prompt).toContain("isolate the residual");
			expect(prompt).toContain("prediction errors");
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
				conclude,
				// finalAnswer.
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
				conclude,
				conclude,
				// finalAnswer.
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
				conclude,
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The raw execution result is NOT omitted from the epistemic role: it sees it
			// (alongside the distilled sentence) so it can update or propose beliefs.
			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
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
				conclude,
				conclude,
				// finalAnswer.
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

	test("execution role masks the declare_belief mutation echo but keeps view_beliefs read-only", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_tc, params: unknown) => ({
				content: [{ type: "text", text: `RAW_${(params as { text: string }).text}` }],
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
								expectation: "a probe keeps the value",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				// Execution: read its hypothesis, then probe.
				{ toolCalls: [{ name: "view_beliefs", args: {} }], stopReason: "toolUse" },
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled sentence.
				"the value persisted",
				// Epistemic: settle the last belief.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				conclude,
				// finalAnswer.
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			const executionContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("echo"));
			expect(executionContexts.length).toBeGreaterThan(0);
			for (const c of executionContexts) {
				// The probe role must not see the belief *mutation* echo — exposing "Applied
				// propose/support" is what tempted it to propose/support beliefs itself.
				expect(contextText(c)).not.toContain("Applied propose");
				expect(contextText(c)).not.toContain("Applied support");
				// …and it must not be able to mutate: no declare_belief in its tool list.
				expect(contextToolNames(c)).not.toContain("declare_belief");
				// …but it holds view_beliefs read-only so it can recall its hypothesis.
				expect(contextToolNames(c)).toContain("view_beliefs");
			}
			// The view_beliefs result (the frame + expectation) is visible, not masked.
			expect(executionContexts.some((c) => contextText(c).includes("[FRAME]"))).toBe(true);
			// …and it still sees the raw probe output (its own operational detail).
			expect(executionContexts.some((c) => contextText(c).includes("RAW_probe"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("epistemic role sees each execution round's raw evidence exactly once", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_tc, params: unknown) => ({
				content: [{ type: "text", text: `RAW_${(params as { text: string }).text}` }],
				details: undefined,
			}),
		};

		const propose = (statement: string): FauxResponse => ({
			toolCalls: [
				{
					name: "declare_belief",
					args: {
						op: "propose",
						statement,
						domain: "product",
						expectation: "a probe keeps the value",
						evidenceRounds: 1,
					},
				},
			],
			stopReason: "toolUse",
		});

		const harness = await createHarness({
			enableBeliefSet: true,
			baseToolsOverride: { echo: echoTool },
			responses: [
				// Frame 1: propose belief-1 → probe → distilled → settle.
				propose("the cache survives logout"),
				{ toolCalls: [{ name: "echo", args: { text: "one" } }], stopReason: "toolUse" },
				"the value persisted",
				// Epistemic: settle belief-1 AND propose belief-2 (next frame).
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
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
				// Frame 2: probe → distilled.
				{ toolCalls: [{ name: "echo", args: { text: "two" } }], stopReason: "toolUse" },
				"no session reuse observed",
				// Epistemic: settle belief-2.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-2", evidence: "no session reuse observed" },
						},
					],
					stopReason: "toolUse",
				},
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
			expect(epistemicContexts.length).toBeGreaterThan(0);

			// Each round's raw evidence was shown at least once…
			expect(epistemicContexts.some((c) => contextText(c).includes("RAW_one"))).toBe(true);
			expect(epistemicContexts.some((c) => contextText(c).includes("RAW_two"))).toBe(true);
			// …but the final epistemic turn sees only the fresh round, never the stale one.
			const last = epistemicContexts[epistemicContexts.length - 1];
			expect(contextText(last)).toContain("RAW_two");
			expect(contextText(last)).not.toContain("RAW_one");
		} finally {
			harness.cleanup();
		}
	});

	test("execution reports the prediction error and the epistemic return asks for the residual", async () => {
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
				// Epistemic: propose.
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
					],
					stopReason: "toolUse",
				},
				// Execution: probe.
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled sentence.
				"the value persisted",
				// Epistemic: settle.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The execution turn's prompt tells it to surface the divergence (the prediction
			// error), which is what the epistemic role updates on.
			const executionContext = harness.faux.contexts.find((c) => contextToolNames(c).includes("echo"));
			expect(executionContext).toBeDefined();
			expect(executionContext!.systemPrompt).toContain("prediction error");

			// The epistemic return steer asks for the residual, not a full re-update.
			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
			expect(epistemicContexts.some((c) => contextText(c).includes("isolate the residual"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("a framing belief does not dispatch, and conclude is gated until it is closed", async () => {
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
				// Epistemic: propose a framing obligation only (no world belief).
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "the answer must establish whether it is one bug or two",
								domain: "framing",
								expectation: "no second independent mechanism",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				// Still epistemic: framing did not dispatch. View beliefs.
				{ toolCalls: [{ name: "view_beliefs", args: {} }], stopReason: "toolUse" },
				// Conclude while the obligation is still open — must be rejected.
				conclude,
				// Epistemic: close the obligation by retracting it.
				{
					toolCalls: [{ name: "declare_belief", args: { op: "retract", beliefId: "belief-1" } }],
					stopReason: "toolUse",
				},
				// Conclude again — now valid.
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.domain).toBe("framing");

			// The turn after the framing-only proposal is still epistemic (no dispatch to the probe role).
			const afterFraming = harness.faux.contexts[1];
			expect(contextToolNames(afterFraming)).toContain("declare_belief");
			expect(contextToolNames(afterFraming)).not.toContain("echo");

			// The turn after the rejected conclude is still epistemic, and carries the rejection steer.
			const afterRejectedConclude = harness.faux.contexts[3];
			expect(contextToolNames(afterRejectedConclude)).toContain("declare_belief");
			expect(contextText(afterRejectedConclude)).toContain("Concluding is premature");

			// The final turn is finalAnswer (no tools), and the loop completed.
			const last = harness.faux.contexts[harness.faux.contexts.length - 1];
			expect(contextToolNames(last)).toEqual([]);
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("done");
		} finally {
			harness.cleanup();
		}
	});

	test("conclude transitions to finalAnswer with no tools", async () => {
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
				// Epistemic: propose.
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
					],
					stopReason: "toolUse",
				},
				// Execution: probe.
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled sentence.
				"the value persisted",
				// Epistemic: settle the last belief.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				// Epistemic: explicitly conclude — the signal that ends the investigation.
				conclude,
				// finalAnswer: conclusion with no tools.
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);

			// The last turn ran in the finalAnswer role: no tools, and its context redacts the
			// raw probe output while keeping the settled beliefs.
			const lastContext = harness.faux.contexts[harness.faux.contexts.length - 1];
			expect(contextToolNames(lastContext)).toEqual([]);
			expect(contextText(lastContext)).not.toContain("echoed");
			expect(contextText(lastContext)).toContain("Applied support");

			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("the conclusion");
		} finally {
			harness.cleanup();
		}
	});

	test("settling the last belief keeps the epistemic role so the model can keep proposing", async () => {
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
				// Frame 1.
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
					],
					stopReason: "toolUse",
				},
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				"the value persisted",
				// Settle the only belief — this must NOT auto-conclude the investigation.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				// Frame 2: the model is still epistemic and keeps proposing.
				{
					toolCalls: [
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
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				"no session reuse observed",
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-2", evidence: "no session reuse observed" },
						},
					],
					stopReason: "toolUse",
				},
				conclude,
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The turn right after settling belief-1 (index 4 = the belief-2 propose) is still the
			// epistemic role — `declare_belief` present — not finalAnswer (empty tools).
			const afterSettle = harness.faux.contexts[4];
			expect(contextToolNames(afterSettle)).toContain("declare_belief");
			expect(contextToolNames(afterSettle)).toContain("conclude");

			// Both frames were settled, so the loop advanced through the full investigation.
			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);
			expect(harness.session.beliefs.find((b) => b.id === "belief-2")?.supportedBy).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	test("view_beliefs on an empty set does not end the epistemic role (bootstrapping)", async () => {
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
				// Epistemic: first action is to check its (empty) belief set.
				{ toolCalls: [{ name: "view_beliefs", args: {} }], stopReason: "toolUse" },
				// Epistemic: now it proposes.
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
					],
					stopReason: "toolUse",
				},
				// Execution: probe.
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				// Execution: distilled sentence.
				"the value persisted",
				// Epistemic: settle.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The turn right after `view_beliefs` must still be the epistemic role — belief
			// tools present so it can propose — not finalAnswer (empty tools).
			const proposeContext = harness.faux.contexts[1];
			expect(contextToolNames(proposeContext)).toContain("declare_belief");
			expect(contextToolNames(proposeContext)).toContain("view_beliefs");

			// And the loop actually completes: belief-1 was proposed and settled.
			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});
});
