import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { BeliefSet, statusOf } from "../src/core/belief-set.ts";
import { createHarness, type FauxResponse, type FauxResponseInput } from "./test-harness.ts";

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

/** Concatenate the thinking blocks across a captured LLM context's messages. */
function contextThinking(ctx: { messages: Array<{ content: unknown }> }): string {
	return ctx.messages
		.flatMap((m) => {
			const content = (m as { content: string | Array<{ type: string; thinking?: string }> }).content;
			if (!Array.isArray(content)) return [];
			return content
				.filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking")
				.map((part) => part.thinking);
		})
		.join("\n");
}

/** The tool calls (name + arguments) present across a captured LLM context's messages. */
function contextToolCalls(ctx: { messages: Array<{ content: unknown }> }): Array<{ name: string; arguments: unknown }> {
	return ctx.messages.flatMap((m) => {
		const content = (m as { content: string | Array<{ type: string; name?: string; arguments?: unknown }> }).content;
		if (!Array.isArray(content)) return [];
		return content
			.filter((part): part is { type: "toolCall"; name: string; arguments: unknown } => part.type === "toolCall")
			.map((part) => ({ name: part.name, arguments: part.arguments }));
	});
}

/** Tool-call ids orphaned in a projected context: a `toolResult` whose immediately preceding
 *  message is not an assistant turn carrying a matching `toolCall`. Strict providers reject such
 *  a sequence ("tool must be a response to tool_calls"), so this must stay empty. */
function orphanedToolResultIds(ctx: {
	messages: Array<{ role: string; content: unknown; toolCallId?: string }>;
}): string[] {
	const orphaned: string[] = [];
	for (let i = 0; i < ctx.messages.length; i++) {
		const msg = ctx.messages[i];
		if (msg.role !== "toolResult") continue;
		const prev = ctx.messages[i - 1];
		const prevContent = (prev?.content ?? []) as Array<{ type: string; id?: string }>;
		const matched =
			prev?.role === "assistant" &&
			Array.isArray(prevContent) &&
			prevContent.some((part) => part.type === "toolCall" && part.id === msg.toolCallId);
		if (!matched) orphaned.push(msg.toolCallId ?? `index-${i}`);
	}
	return orphaned;
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

	test("propose prompt describes the belief-action cycle and never advertises file/command tools", async () => {
		const harness = await createHarness({ enableBeliefSet: true });
		try {
			const prompt = harness.session.agent.state.systemPrompt;
			// The propose role has no read/bash/edit/write, so the prompt must not
			// claim them (the coding-agent preamble did, which drove the model to call
			// `bash` and get "Tool bash not found").
			expect(prompt).not.toContain("reading files");
			expect(prompt).not.toContain("executing commands");
			expect(prompt).not.toContain("expert coding assistant");
			expect(prompt).not.toContain("In addition to the tools above");
			expect(prompt).not.toContain("Pi documentation");
			// It frames the role as a scientific mind following the belief → experiment
			// → update protocol, rather than "start working" blindly.
			expect(prompt).toContain("scientific mind");
			expect(prompt).toContain("belief → experiment → update protocol");
			expect(prompt).toContain("falsifiable expectation");
			expect(prompt).toContain("then call conclude");
			// It must state plainly that experiments run in a separate role, not in this
			// one — otherwise the model burns turns re-deriving how it probes the codebase.
			expect(prompt).toContain("separate execution role");
			expect(prompt).toContain("You never do the probing");
			// It must not name the probe tools even in the negative — listing "read files / run
			// commands / read/bash/edit/write" primes the model to call them.
			expect(prompt).not.toContain("read files");
			expect(prompt).not.toContain("run commands");
			expect(prompt).not.toContain("read/bash");
			// The belief vocabulary is typed and written in Chinese: each referent is tagged by
			// one of four kinds, and belief content is Chinese.
			expect(prompt).toContain("[code]");
			expect(prompt).toContain("[prod]");
			expect(prompt).toContain("[user]");
			expect(prompt).toContain("[convention]");
			expect(prompt).toContain("in Chinese");
			// The framing obligation must also surface the question's own implicit frame — the
			// partition its wording imposes — as a presupposition to falsify, not a given.
			expect(prompt).toContain("implicit frame");
			expect(prompt).toContain("contradicts its own body");
			// User-named concepts are presuppositions too: a container/umbrella name must be
			// resolved through a scope-discovery belief, not treated as an atomic referent.
			expect(prompt).toContain("scope-discovery");
			expect(prompt).toContain("atomic entity");
			// The residual filter — explain → isolate → update — is the distill role's step, not the
			// propose role's, so the propose prompt must hand it off rather than fold it in.
			expect(prompt).toContain("separate distill step");
			expect(prompt).not.toContain("epistemic residual");
		} finally {
			harness.cleanup();
		}
	});

	test("belief language follows pie.beliefLang in the role prompt", async () => {
		const harness = await createHarness({
			enableBeliefSet: true,
			settings: { pie: { beliefLang: "English" } },
		});
		try {
			const prompt = harness.session.agent.state.systemPrompt;
			expect(prompt).toContain("in English");
			expect(prompt).not.toContain("in Chinese");
			expect(prompt).not.toContain("{beliefLang}");
		} finally {
			harness.cleanup();
		}
	});

	test("four-phase flow: propose dispatches to execution, then adjudication settles the frame", async () => {
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

	test("epistemic role masks raw execution evidence, keeping the distilled report", async () => {
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
				// Epistemic: support — settles from the distilled sentence (raw evidence is masked).
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

			// The raw execution result is masked from the epistemic role so the projected
			// transcript stays append-only and cacheable; only the distilled sentence survives.
			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
			expect(epistemicContexts.length).toBeGreaterThan(0);
			expect(epistemicContexts.some((c) => contextText(c).includes("RAW_SENSITIVE_OUTPUT"))).toBe(false);
			expect(epistemicContexts.some((c) => contextText(c).includes("the value persisted"))).toBe(true);
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
				// Execution: read its belief, then probe.
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
				// …but it holds view_beliefs read-only so it can recall its belief.
				expect(contextToolNames(c)).toContain("view_beliefs");
			}
			// The view_beliefs result (the frame + expectation) is visible, not masked.
			expect(executionContexts.some((c) => contextText(c).includes("[FRAME]"))).toBe(true);
			// …and it still sees the raw probe output (its own operational detail).
			expect(executionContexts.some((c) => contextText(c).includes("RAW_probe"))).toBe(true);
			// The epistemic role's declare_belief tool-call blocks are elided entirely — seeing a
			// tool call in the transcript is what drives the probe role to imitate the mutation it
			// must not perform, and a masked placeholder name would still leave a call to imitate.
			expect(executionContexts.some((c) => contextToolCalls(c).some((t) => t.name === "declare_belief"))).toBe(
				false,
			);
			expect(executionContexts.some((c) => contextToolCalls(c).some((t) => t.name === "[belief]"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	test("belief-side roles fold a view_beliefs result whose call was elided from a probe turn", async () => {
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
				// Execution: read its belief AND probe in the same turn — the mixed turn whose
				// view_beliefs call is elided from the belief-side view (the orphan trigger).
				{
					toolCalls: [
						{ name: "view_beliefs", args: {} },
						{ name: "echo", args: { text: "probe" } },
					],
					stopReason: "toolUse",
				},
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
				conclude,
				// finalAnswer.
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The belief-side roles (propose + distill) must never see an orphaned `tool` message —
			// the execution turn's view_beliefs call is elided, so its result must be folded too.
			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
			expect(epistemicContexts.length).toBeGreaterThan(0);
			for (const c of epistemicContexts) {
				expect(orphanedToolResultIds(c)).toEqual([]);
			}
			// The execution turn's view_beliefs result is folded to a plain note, not left as a raw
			// `toolResult` (the epistemic role never calls view_beliefs itself in this script).
			expect(
				epistemicContexts.some((c) =>
					c.messages.some(
						(m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "view_beliefs",
					),
				),
			).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	test("epistemic role masks each execution round's raw evidence", async () => {
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
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
			expect(epistemicContexts.length).toBeGreaterThan(0);

			// Each round's raw tool output is masked from the belief-side view (never shown), so
			// the projected transcript is append-only and cacheable; only the distilled text
			// report survives.
			expect(epistemicContexts.some((c) => contextText(c).includes("RAW_one"))).toBe(false);
			expect(epistemicContexts.some((c) => contextText(c).includes("RAW_two"))).toBe(false);
			const last = epistemicContexts[epistemicContexts.length - 1];
			expect(contextText(last)).toContain("the value persisted");
			expect(contextText(last)).toContain("no session reuse observed");
			expect(contextText(last)).not.toContain("RAW_one");
			expect(contextText(last)).not.toContain("RAW_two");
		} finally {
			harness.cleanup();
		}
	});

	test("epistemic role always distills the probe role's thinking", async () => {
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
				propose("the cache survives logout"),
				{
					thinking: "EXEC_THINKING_ONE",
					toolCalls: [{ name: "echo", args: { text: "one" } }],
					stopReason: "toolUse",
				},
				"the value persisted",
				// Settle belief-1 AND propose belief-2 (the next frame).
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
				{
					thinking: "EXEC_THINKING_TWO",
					toolCalls: [{ name: "echo", args: { text: "two" } }],
					stopReason: "toolUse",
				},
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
				conclude,
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
			expect(epistemicContexts.length).toBeGreaterThan(0);
			const last = epistemicContexts[epistemicContexts.length - 1];

			// The probe role's internal reasoning is distilled regardless of age — that is the
			// imitation trigger, so it is always stripped — while its distilled text report survives.
			expect(contextThinking(last)).not.toContain("EXEC_THINKING_ONE");
			expect(contextText(last)).toContain("the value persisted");
			expect(contextThinking(last)).not.toContain("EXEC_THINKING_TWO");
			expect(contextText(last)).toContain("no session reuse observed");

			// The execution role itself still sees its own raw reasoning.
			const executionContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("echo"));
			expect(executionContexts.some((c) => contextThinking(c).includes("EXEC_THINKING_ONE"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("finalAnswer distills the probe role's thinking and tool arguments", async () => {
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
				// Execution: probe with internal reasoning and a verbose tool call.
				{
					thinking: "EXEC_THINKING",
					toolCalls: [{ name: "echo", args: { text: "probe" } }],
					stopReason: "toolUse",
				},
				// Execution: distilled report.
				"the value persisted",
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
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			const lastContext = harness.faux.contexts[harness.faux.contexts.length - 1];
			// finalAnswer: no tools, and the probe role's internal reasoning is distilled.
			expect(contextToolNames(lastContext)).toEqual([]);
			expect(contextThinking(lastContext)).not.toContain("EXEC_THINKING");
			// The echo tool-call is elided entirely: dropping it (rather than renaming it to a
			// placeholder) is what stops the finalAnswer role from imitating it — and keeps the
			// transcript free of a tool-call name the provider would reject.
			expect(contextToolCalls(lastContext).some((t) => t.name === "[probe]")).toBe(false);
			// The real tool name never leaks into the distilled projection.
			expect(contextToolCalls(lastContext).some((t) => t.name === "echo")).toBe(false);
			// The distilled text report survives, but the belief tools' echo is masked: the
			// finalAnswer role reads the explicit final-answer context instead of incidental
			// declare_belief/view_beliefs results.
			expect(contextText(lastContext)).toContain("the value persisted");
			expect(contextText(lastContext)).not.toContain("Applied support");
			expect(contextText(lastContext)).toContain("[belief bookkeeping omitted]");
			expect(contextText(lastContext)).toContain("<final_answer_context>");
			expect(contextText(lastContext)).toContain("the cache survives logout");

			// The execution role itself still sees its own raw reasoning (the probe turn's
			// thinking enters the execution context of the following report turn).
			const executionContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("echo"));
			expect(executionContexts.some((c) => contextThinking(c).includes("EXEC_THINKING"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("execution reports raw observations and the epistemic return asks for the residual", async () => {
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
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The execution turn's prompt tells it to report raw observations in one sentence and
			// leaves the prediction-error distillation to the epistemic role (which updates on it).
			const executionContext = harness.faux.contexts.find((c) => contextToolNames(c).includes("echo"));
			expect(executionContext).toBeDefined();
			expect(executionContext!.systemPrompt).toContain("prediction-error");
			expect(executionContext!.systemPrompt).toContain("distill role's step");
			// It must still surface what the belief did not name — inconsistencies or staleness
			// beyond the probed hypothesis — as raw observations, so the epistemic role can expand
			// its beliefs horizontally instead of only confirming the narrow hypotheses it proposed.
			expect(executionContext!.systemPrompt).toContain("contradiction");

			// The epistemic return steer asks for the residual, not a full re-update.
			const epistemicContexts = harness.faux.contexts.filter((c) => contextToolNames(c).includes("declare_belief"));
			expect(epistemicContexts.some((c) => contextText(c).includes("isolate the residual"))).toBe(true);

			// The distill role's own prompt carries the residual accounting that the propose role
			// hands off — the split is what lets the two steps run on different models.
			const distillContext = harness.faux.contexts.find((c) => c.systemPrompt?.includes("You are the distill role"));
			expect(distillContext).toBeDefined();
			expect(distillContext!.systemPrompt).toContain("epistemic residual");
			expect(distillContext!.systemPrompt).toContain("isolate the residual");
			expect(distillContext!.systemPrompt).toContain("prediction errors");
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

	test("framing support requires evidenceBeliefIds referencing supported world beliefs", () => {
		const set = new BeliefSet();
		const world = set.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a probe keeps the value",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: world.id, evidence: "the value persisted" });
		const framing = set.apply({
			op: "propose",
			statement: "the task is one root-cause bug",
			domain: "framing",
			expectation: "no second independent mechanism appears",
			evidenceRounds: 1,
		});
		// No references: rejected with an actionable message.
		expect(() => set.apply({ op: "support", beliefId: framing.id, evidence: "two mechanisms established" })).toThrow(
			/evidenceBeliefIds/,
		);
		// Unknown reference id: rejected.
		expect(() =>
			set.apply({ op: "support", beliefId: framing.id, evidence: "x", evidenceBeliefIds: ["belief-99"] }),
		).toThrow(/Unknown belief id/);
		// Framing→framing reference: rejected (only product/code beliefs may discharge an obligation).
		expect(() =>
			set.apply({ op: "support", beliefId: framing.id, evidence: "x", evidenceBeliefIds: [framing.id] }),
		).toThrow(/product\/code/);
		// Unsupported (still proposed) world reference: rejected.
		const open = set.apply({
			op: "propose",
			statement: "login is stateless",
			domain: "product",
			expectation: "a probe sees no session state",
			evidenceRounds: 1,
		});
		expect(() =>
			set.apply({ op: "support", beliefId: framing.id, evidence: "x", evidenceBeliefIds: [open.id] }),
		).toThrow(/not supported/);
		// Valid discharge: accepted, and the references are persisted on the evidence entry.
		const discharged = set.apply({
			op: "support",
			beliefId: framing.id,
			evidence: "two mechanisms established",
			evidenceBeliefIds: [world.id],
		});
		expect(statusOf(discharged)).toBe("supported");
		expect(discharged.supportedBy[0].beliefIds).toEqual([world.id]);
	});

	test("evidenceBeliefIds is ignored for non-framing support", () => {
		const set = new BeliefSet();
		const world = set.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a probe keeps the value",
			evidenceRounds: 1,
		});
		// Unknown ids are not validated for world beliefs: the field only gates framing discharge.
		const supported = set.apply({
			op: "support",
			beliefId: world.id,
			evidence: "the value persisted",
			evidenceBeliefIds: ["belief-99"],
		});
		expect(statusOf(supported)).toBe("supported");
		expect(supported.supportedBy[0].beliefIds).toBeUndefined();
	});

	test("conclude is gated until open world beliefs are resolved", async () => {
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
				// Epistemic: propose a world belief.
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
				// Epistemic: conclude while the belief is still open — must be rejected.
				conclude,
				// Epistemic: settle the belief.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				// Epistemic: conclude again — now valid.
				conclude,
				conclude,
				// finalAnswer.
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The rejected conclude steers back to the epistemic role and names the unresolved
			// world belief (previously only framing obligations blocked conclusion).
			const afterRejectedConclude = harness.faux.contexts[4];
			expect(contextToolNames(afterRejectedConclude)).toContain("declare_belief");
			expect(contextText(afterRejectedConclude)).toContain("Concluding is premature");
			expect(contextText(afterRejectedConclude)).toContain("the cache survives logout");

			// The loop still completes once the belief is settled.
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
				conclude,
				// finalAnswer: conclusion with no tools.
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);

			// The last turn ran in the finalAnswer role: no tools, and its context redacts the
			// raw probe output and the belief tools' echo, replacing them with the explicit
			// final-answer context.
			const lastContext = harness.faux.contexts[harness.faux.contexts.length - 1];
			expect(contextToolNames(lastContext)).toEqual([]);
			expect(contextText(lastContext)).not.toContain("echoed");
			expect(contextText(lastContext)).not.toContain("Applied support");
			expect(contextText(lastContext)).toContain("<final_answer_context>");
			expect(contextText(lastContext)).toContain("the cache survives logout");

			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("the conclusion");
		} finally {
			harness.cleanup();
		}
	});

	test("a settled conclude reflects once on the belief set before finalAnswer", async () => {
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
				// Epistemic: propose three beliefs so the settled set crosses the reflection
				// threshold.
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
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "logout clears the token",
								domain: "product",
								expectation: "the token is gone",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				"the value persisted",
				// Epistemic: settle all three beliefs.
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
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-3", evidence: "the token was cleared" },
						},
					],
					stopReason: "toolUse",
				},
				// First conclude: settled, so it does not reach finalAnswer yet — it fires the
				// one-round reflection steer and stays epistemic.
				conclude,
				// Reflection finds nothing to add: conclude again — now finalAnswer.
				conclude,
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The turn after the first conclude is still epistemic (declare_belief present) and
			// carries the reflection steer, which treats the belief set as the object.
			const reflectionContext = harness.faux.contexts[5];
			expect(contextToolNames(reflectionContext)).toContain("declare_belief");
			expect(contextText(reflectionContext)).toContain("reflect on the belief set");
			expect(contextText(reflectionContext)).toContain("Coverage");
			// Coverage now also resolves user-named concepts (atomic / decomposed / excluded), not just paths.
			expect(contextText(reflectionContext)).toContain("user-named concept");

			// The final turn is finalAnswer (no tools), and the conclusion was written.
			const last = harness.faux.contexts[harness.faux.contexts.length - 1];
			expect(contextToolNames(last)).toEqual([]);
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("the conclusion");
		} finally {
			harness.cleanup();
		}
	});

	test("a small settled set skips the reflection round and concludes directly", async () => {
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
				// Epistemic: propose a single belief.
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
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
					],
					stopReason: "toolUse",
				},
				// One conclude: a single settled belief is below the reflection threshold, so the
				// loop goes straight to finalAnswer instead of firing the reflection round.
				conclude,
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			// No context ever carries the reflection steer — the small set skipped the ceremony.
			for (const ctx of harness.faux.contexts) {
				expect(contextText(ctx)).not.toContain("reflect on the belief set");
			}

			// The final turn is finalAnswer (no tools), and the conclusion was written.
			const last = harness.faux.contexts[harness.faux.contexts.length - 1];
			expect(contextToolNames(last)).toEqual([]);
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("the conclusion");
		} finally {
			harness.cleanup();
		}
	});

	test("conclude in the same turn as the final settle is honored", async () => {
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
				// Settle and conclude in the SAME turn — the transition honors the conclude and
				// hands straight to finalAnswer without a redundant "deepen or conclude" round.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-1", evidence: "the value persisted" },
						},
						{ name: "conclude", args: {} },
					],
					stopReason: "toolUse",
				},
				"the conclusion",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The settle+conclude turn moved straight to finalAnswer (no tools on the last turn),
			// and the conclusion was written.
			const last = harness.faux.contexts[harness.faux.contexts.length - 1];
			expect(contextToolNames(last)).toEqual([]);
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("the conclusion");
		} finally {
			harness.cleanup();
		}
	});

	test("the reflection round can propose a new belief that is probed before concluding", async () => {
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
				// Epistemic: propose and settle three beliefs so the first conclude crosses the
				// reflection threshold.
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
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "logout clears the token",
								domain: "product",
								expectation: "the token is gone",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				"the value persisted",
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
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-3", evidence: "the token was cleared" },
						},
					],
					stopReason: "toolUse",
				},
				// First conclude → reflection steer.
				conclude,
				// Reflection surfaces a missing check as a new belief → auto-dispatches.
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: {
								op: "propose",
								statement: "re-auth revokes old sessions",
								domain: "product",
								expectation: "a re-auth invalidates the prior token",
								evidenceRounds: 1,
							},
						},
					],
					stopReason: "toolUse",
				},
				{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
				"the prior token was invalidated",
				{
					toolCalls: [
						{
							name: "declare_belief",
							args: { op: "support", beliefId: "belief-4", evidence: "the prior token was invalidated" },
						},
					],
					stopReason: "toolUse",
				},
				// Second conclude: already reflected, so finalAnswer.
				conclude,
				"done",
			],
		});
		try {
			await harness.session.prompt("hi");

			// The reflection turn proposed belief-4, which was probed and settled — the loop
			// expanded instead of concluding on the narrowed first frame.
			expect(harness.session.beliefs.find((b) => b.id === "belief-4")?.supportedBy).toHaveLength(1);

			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("done");
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

	test("a follow-up message after conclusion re-enters the loop and retains the belief set", async () => {
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

		// One full propose → probe → settle → conclude cycle, parameterized so the second
		// task's belief id can be distinct (the belief set is retained, so ids keep counting).
		const task = (beliefId: string, statement: string, conclusion: string): FauxResponseInput[] => [
			{
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
			},
			{ toolCalls: [{ name: "echo", args: { text: "probe" } }], stopReason: "toolUse" },
			"the value persisted",
			{
				toolCalls: [{ name: "declare_belief", args: { op: "support", beliefId, evidence: "the value persisted" } }],
				stopReason: "toolUse",
			},
			conclude,
			conclude,
			conclusion,
		];

		const harness = await createHarness({
			enableBeliefSet: true,
			baseToolsOverride: { echo: echoTool },
			responses: [
				...task("belief-1", "the cache survives logout", "conclusion one"),
				...task("belief-2", "login is stateless", "conclusion two"),
			],
		});
		try {
			await harness.session.prompt("task one");
			await harness.session.prompt("task two");

			// The belief set is the session's accumulated knowledge: the second task re-entered
			// the loop (its belief was proposed and settled) without discarding the first task's.
			expect(harness.session.beliefs.map((b) => b.statement)).toEqual([
				"the cache survives logout",
				"login is stateless",
			]);
			expect(harness.session.beliefs.every((b) => b.supportedBy.length === 1)).toBe(true);

			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("conclusion one");
			expect(assistantTexts).toContain("conclusion two");
		} finally {
			harness.cleanup();
		}
	});

	test("a stray probe tool call from the epistemic role is steered back, not silently swallowed", async () => {
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
				// Epistemic: emits `bash`, which is not in its tool list (it imitated a prior
				// execution turn). The dispatch layer would reject it with "Tool bash not found";
				// the loop must steer the role back instead of letting the error vanish.
				{ toolCalls: [{ name: "bash", args: { command: "true" } }], stopReason: "toolUse" },
				// After the corrective steer, the epistemic role proposes properly.
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
				"done",
			],
		});
		try {
			await harness.session.prompt("investigate");

			// The corrective steer reached the transcript as a user message naming the stray
			// tool and re-stating the propose role's own tools — the error was not swallowed.
			const userTexts = harness.session.messages.filter((m) => m.role === "user").map(messageText);
			expect(userTexts.some((t) => t.includes('"bash"') && t.includes("propose role does not have"))).toBe(true);

			// The loop recovered: the belief was proposed and settled, and the task concluded.
			expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);
			const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(messageText);
			expect(assistantTexts).toContain("done");
		} finally {
			harness.cleanup();
		}
	});
});
