import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

function control(decision: Record<string, unknown>) {
	if (
		(decision.kind === "create_frame" || decision.kind === "revise_frame" || decision.kind === "replace_frame") &&
		!("actions" in decision)
	) {
		const { horizon: _legacyHorizon, ...withoutHorizon } = decision;
		return fauxAssistantMessage(JSON.stringify({ ...withoutHorizon, actions: [actionBudget(action)] }));
	}
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

const action = {
	intent: "Read the loop source in full to locate where prompts enter",
	completionCondition: "A single full read of the loop source establishes where its prompts enter",
} as const;

function actionBudget(definition: { intent: string; completionCondition: string }, expectedEvidenceRounds = 1) {
	return {
		intent: definition.intent,
		completionCondition: definition.completionCondition,
		expectedEvidenceRounds,
		budgetReason:
			expectedEvidenceRounds === 1
				? "One response can issue all independent known probes"
				: "Each later probe depends on the path or runtime result returned by the preceding probe",
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
		frameHorizonRange: { min: 6, max: 32 },
	};
}

describe("completion condition bounds", () => {
	it("rejects a completion condition that enumerates every occurrence and accepts the bounded rewrite", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					falsifier: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [
						actionBudget({
							intent: "Record every prompt site in the loop source",
							completionCondition:
								"A recorded list of exact file paths and line ranges covers the loop class and every prompt literal, template function, or prompt-building call it uses",
						}),
					],
				}),
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					falsifier: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full; prompts enter only via injected messages."),
				control({ kind: "complete_action", reason: "A single full read established where prompts enter" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "frame_revision")).toEqual([
				expect.objectContaining({
					statement: "Prompt construction in the loop is produced only by externally injected messages",
				}),
			]);
			expect(branch.filter((entry) => entry.type === "action_start")).toEqual([
				expect.objectContaining({
					intent: action.intent,
					completionCondition: action.completionCondition,
				}),
			]);
			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Action completion condition must be confirmable by one bounded observable result",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("instructs control and execution prompts to bound completion and narrow scope", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					falsifier: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full; prompts enter only via injected messages."),
				control({ kind: "complete_action", reason: "A single full read established where prompts enter" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const contexts = harness.providerContexts.map((context) => context.systemPrompt ?? "");
			expect(
				contexts.some((prompt) =>
					prompt.includes("A completion condition is bounded only when one observable result"),
				),
			).toBe(true);
			expect(contexts.some((prompt) => prompt.includes("controlled scope-narrowing exit"))).toBe(true);
			expect(
				contexts.some((prompt) => prompt.includes("A Frame must not assert an unbounded completeness claim")),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a frame statement that asserts an unbounded completeness claim and accepts the bounded rewrite", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "All prompt sources for the loop are defined locally in exactly two files",
					falsifier: "A full read of one file shows a referenced symbol is imported from a further module",
					actions: [actionBudget(action)],
				}),
				control({
					kind: "create_frame",
					statement: "The loop's LLM call entry points are in two files",
					falsifier: "A full read of one file shows a referenced symbol is imported from a further module",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The entry point files were read in full."),
				control({ kind: "complete_action", reason: "A single full read established the entry points" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("The loop's LLM call entry points are in two files."),
			]);

			await harness.session.prompt("check the prompt entry sites in the loop");

			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "frame_revision")).toEqual([
				expect.objectContaining({
					statement: "The loop's LLM call entry points are in two files",
				}),
			]);
			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Frame statement must assert one bounded slice of the Anchor",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("terminates gracefully with a final report when the epistemic budget is exhausted", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			const frame = {
				kind: "create_frame",
				statement: "The loop's LLM call entry points are in two files",
				falsifier: "A full read of one file shows a referenced symbol is imported from a further module",
			};
			const revise = {
				kind: "revise_frame",
				statement: "The loop's LLM call entry points are in two files",
				falsifier: "A full read of one file shows a referenced symbol is imported from a further module",
				reason: "keep investigating",
			};
			harness.setResponses([
				control(frame),
				...Array.from({ length: 24 }, () => control(revise)),
				fauxAssistantMessage("The epistemic budget was exhausted; partial report follows."),
			]);

			await harness.session.prompt("check the prompt entry sites in the loop");

			expect(harness.session.getLastAssistantText()).toBe(
				"The epistemic budget was exhausted; partial report follows.",
			);
			expect(harness.session.state.errorMessage).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("honors a configured epistemic control budget", async () => {
		const harness = await createHarness({ ...fullStackOptions(), maxControlResponses: 2 });
		try {
			const frame = {
				kind: "create_frame",
				statement: "The loop's LLM call entry points are in two files",
				falsifier: "A full read of one file shows a referenced symbol is imported from a further module",
			};
			const revise = {
				kind: "revise_frame",
				statement: "The loop's LLM call entry points are in two files",
				falsifier: "A full read of one file shows a referenced symbol is imported from a further module",
				reason: "keep investigating",
			};
			harness.setResponses([
				control(frame),
				control(revise),
				control(revise),
				fauxAssistantMessage("budget 2 exhausted"),
			]);

			await harness.session.prompt("check the prompt entry sites in the loop");

			expect(harness.session.getLastAssistantText()).toBe("budget 2 exhausted");
			expect(harness.session.state.errorMessage).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a discovery-probe falsifier and accepts a grounded rewrite", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					falsifier: "The discovery rg over packages for prompt tokens returns zero matches anywhere",
					actions: [actionBudget(action)],
				}),
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					falsifier: "Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({ kind: "complete_action", reason: "A single full read established the entry points" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Frame falsifier must not be a discovery probe",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a completion condition that demands full output be materialized in the transcript", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					falsifier: "Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [
						actionBudget({
							intent: "Run one broad discovery search over the package sources",
							completionCondition:
								"The search command completes and its full output is present in the transcript",
						}),
					],
				}),
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					falsifier: "Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({ kind: "complete_action", reason: "A single full read established the entry points" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Action completion condition must not require the full output",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("converges to a final report instead of erroring when control decisions are repeatedly invalid", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					falsifier: "Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [actionBudget(action)],
				}),
				control({ kind: "revise_frame", statement: "A different statement", reason: "fix missing falsifier" }),
				control({ kind: "revise_frame", statement: "A different statement", reason: "fix missing falsifier" }),
				control({ kind: "revise_frame", statement: "A different statement", reason: "fix missing falsifier" }),
				fauxAssistantMessage("Control decisions kept failing; here is a bounded report."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.session.getLastAssistantText()).toBe(
				"Control decisions kept failing; here is a bounded report.",
			);
			expect(harness.session.state.errorMessage).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("injects a deterministic codebase grounding map while forming the initial Frame", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			mkdirSync(join(harness.tempDir, "src", "core"), { recursive: true });
			writeFileSync(join(harness.tempDir, "src", "core", "agent-session.ts"), "a".repeat(2048));
			writeFileSync(join(harness.tempDir, "src", "small.ts"), "b");

			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					falsifier: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({ kind: "complete_action", reason: "A single full read established the entry points" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const initialMessages = harness.providerContexts[0]!.messages.map(getMessageText);
			expect(initialMessages).toEqual(expect.arrayContaining([expect.stringContaining("[CODEBASE GROUNDING]")]));
			expect(initialMessages).toEqual(expect.arrayContaining([expect.stringContaining("agent-session.ts")]));
			// Grounding is a frame-formation aid only: no later turn (authorize/execute/complete) carries it.
			const groundingContexts = harness.providerContexts.filter((context) =>
				context.messages.some((message) => getMessageText(message).includes("[CODEBASE GROUNDING]")),
			);
			expect(groundingContexts).toHaveLength(1);
			expect(groundingContexts[0]).toBe(harness.providerContexts[0]);
		} finally {
			harness.cleanup();
		}
	});
});
