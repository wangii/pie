import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
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
	expectation: "The loop source shows the prompt template and the assembly routine that builds prompts",
} as const;

function actionBudget(
	definition: { intent: string; completionCondition: string; expectation: string },
	expectedEvidenceRounds = 1,
) {
	return {
		...definition,
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
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [
						actionBudget({
							intent: "Record every prompt site in the loop source",
							completionCondition:
								"A recorded list of exact file paths and line ranges covers the loop class and every prompt literal, template function, or prompt-building call it uses",
							expectation: "The read result shows every prompt site with its exact file path and line range",
						}),
					],
				}),
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full; prompts enter only via injected messages."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established where prompts enter in the loop source",
					},
				}),
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
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full; prompts enter only via injected messages."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established where prompts enter in the loop source",
					},
				}),
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
					expectation: "A full read of one file shows a referenced symbol is imported from a further module",
					actions: [actionBudget(action)],
				}),
				control({
					kind: "create_frame",
					statement: "The loop's LLM call entry points are in two files",
					expectation: "A full read of one file shows a referenced symbol is imported from a further module",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The entry point files were read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established the exact entry points in the loop",
					},
				}),
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
				expectation: "A full read of one file shows a referenced symbol is imported from a further module",
			};
			const revise = {
				kind: "revise_frame",
				statement: "The loop's LLM call entry points are in two files",
				expectation: "A full read of one file shows a referenced symbol is imported from a further module",
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
				expectation: "A full read of one file shows a referenced symbol is imported from a further module",
			};
			const revise = {
				kind: "revise_frame",
				statement: "The loop's LLM call entry points are in two files",
				expectation: "A full read of one file shows a referenced symbol is imported from a further module",
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

	it("rejects a discovery-probe expectation and accepts a grounded rewrite", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					expectation: "The discovery rg over packages for prompt tokens returns zero matches anywhere",
					actions: [actionBudget(action)],
				}),
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					expectation:
						"Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established the exact entry points in the loop",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Frame expectation must not be a discovery probe",
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
					expectation:
						"Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [
						actionBudget({
							intent: "Run one broad discovery search over the package sources",
							completionCondition:
								"The search command completes and its full output is present in the transcript",
							expectation: "The search result lists the package source files that define prompt literals",
						}),
					],
				}),
				control({
					kind: "create_frame",
					statement:
						"Prompt text used by the loop is concentrated in identifiable files a single search can surface",
					expectation:
						"Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established the exact entry points in the loop",
					},
				}),
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
					expectation:
						"Reading the surfaced files shows each prompt literal is independent with no shared template",
					actions: [actionBudget(action)],
				}),
				control({ kind: "revise_frame", statement: "A different statement", reason: "fix missing expectation" }),
				control({ kind: "revise_frame", statement: "A different statement", reason: "fix missing expectation" }),
				control({ kind: "revise_frame", statement: "A different statement", reason: "fix missing expectation" }),
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
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established the exact entry points in the loop",
					},
				}),
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

	it("injects a harness-derived state snapshot into epistemic control turns", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established where prompts enter in the loop source",
					},
				}),
				control({
					kind: "replace_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					reason: "advance to the next slice",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established where prompts enter in the loop source",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const controlTexts = harness.providerContexts.map((context) => context.systemPrompt ?? "");
			// The initial control turn carries the Anchor (no Frame yet).
			expect(controlTexts.some((text) => text.includes("Anchor (revision 1)"))).toBe(true);
			// Once a Frame exists it is restated with its expectation and lease.
			expect(controlTexts.some((text) => text.includes("Frame v1"))).toBe(true);
			// After the first Action completes, the next control turn names the last
			// Action and its outcome instead of forcing the model to re-derive it.
			expect(controlTexts.some((text) => text.includes("Last Action:"))).toBe(true);
			expect(controlTexts.some((text) => text.includes("Outcome: completed"))).toBe(true);
			// The snapshot is always prefixed with the explicit use-directly directive.
			expect(controlTexts.some((text) => text.includes("[CURRENT EPISTEMIC STATE"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("advances a Frame to new Actions without re-asserting its proposition", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established where prompts enter in the loop source",
					},
				}),
				control({
					kind: "advance_frame",
					reason: "read the next prompt site",
					actions: [
						actionBudget({
							intent: "Read the next prompt site file in full",
							completionCondition: "One read returns that file in full with its path shown in the result",
							expectation: "The read result shows the next prompt site file in full with its path",
						}),
					],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The next file was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established the next prompt site in the loop",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const revisions = harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_revision");
			expect(revisions).toHaveLength(2);
			const [created, advanced] = revisions;
			// advance_frame keeps the Frame identity and proposition, opening only a new version.
			expect(advanced.frameId).toBe(created.frameId);
			expect(advanced.statement).toBe(created.statement);
			expect(advanced.expectation).toBe(created.expectation);
			expect(advanced.version).toBe(created.version + 1);
			// The new provisional Action contract is what actually changed.
			const starts = harness.sessionManager.getBranch().filter((entry) => entry.type === "action_start");
			expect(starts[1]).toMatchObject({ intent: "Read the next prompt site file in full" });
		} finally {
			harness.cleanup();
		}
	});

	it("explores comprehension before any Frame and rejects a duplicate target", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			const explore = (intent: string) =>
				control({
					kind: "explore",
					expectation: `Reading the prompt-construction surface shows ${intent}`,
					intent,
					completionCondition: "One grep records file locations and per-file match counts for the prompt markers",
					expectedEvidenceRounds: 1,
					budgetReason: "A single grep over the package tree is one independent evidence round",
				});
			harness.setResponses([
				explore("Grep packages/coding-agent/src for prompt-definition markers"),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "prompt-sites" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("grep recorded the prompt sites"),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The grep recorded the prompt sites in system-prompt.ts and agent-session.ts",
					},
				}),
				explore("Grep packages/coding-agent/src for prompt-definition markers"),
				control({ kind: "authorize_final", reason: "Comprehension is sufficient; the Anchor is satisfied" }),
				fauxAssistantMessage("The prompt sites are system-prompt.ts and agent-session.ts."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			const branch = harness.sessionManager.getBranch();
			// explore never required a Frame: exactly one comprehension episode, no frame revision.
			expect(branch.filter((entry) => entry.type === "action_start")).toHaveLength(1);
			expect(branch.filter((entry) => entry.type === "frame_revision")).toHaveLength(0);
			// The completed explore is durable: its predicted fact became an Anchor Observation.
			const observations = branch.filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				statement: expect.stringContaining("prompt-construction surface"),
			});
			expect(observations[0].anchorRevisionEntryId).toBeDefined();
			expect(observations[0].frameRevisionEntryId).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe(
				"The prompt sites are system-prompt.ts and agent-session.ts.",
			);
			// The duplicate explore was rejected by the information-gain gate.
			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes("explore must add new information"),
				),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an explore whose predicted fact is already established (result-level information gain)", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			const explore = (intent: string, expectation: string) =>
				control({
					kind: "explore",
					expectation,
					intent,
					completionCondition: "One grep records file locations and per-file match counts for the prompt markers",
					expectedEvidenceRounds: 1,
					budgetReason: "A single grep over the package tree is one independent evidence round",
				});
			harness.setResponses([
				explore("Grep for prompt strings", "Prompt literals live in system-prompt.ts and agent-session.ts"),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "prompt-sites" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("grep recorded the prompt sites"),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The prompt sites were recorded in system-prompt.ts and agent-session.ts",
					},
				}),
				// Different intent, but the expectation repeats the already-established fact.
				explore("List files that define prompts", "Prompt literals live in system-prompt.ts and agent-session.ts"),
				control({ kind: "authorize_final", reason: "Comprehension is sufficient" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("find the prompts");

			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes("explore must add new information"),
				),
			).toBe(true);
			// Only the first explore survived; the redundant one never started an episode.
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_start")).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("asks a clarifying question before committing a Frame", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "ask",
					question: "Should 'all prompts' mean an exhaustive inventory or a representative analysis?",
				}),
				fauxAssistantMessage("Should 'all prompts' mean an exhaustive inventory or a representative analysis?"),
			]);

			await harness.session.prompt("check all the prompts");

			expect(harness.session.getLastAssistantText()).toBe(
				"Should 'all prompts' mean an exhaustive inventory or a representative analysis?",
			);
			expect(harness.session.state.errorMessage).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("decomposes the Anchor into explicit subgoals", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "decompose",
					subgoals: ["Identify the base system prompt", "Identify the per-role control prompts"],
					reason: "split the inventory into checkable slices",
				}),
				control({ kind: "authorize_final", reason: "slices established" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("check all the prompts");

			const anchors = harness.sessionManager.getBranch().filter((entry) => entry.type === "anchor_revision");
			expect(anchors).toHaveLength(2);
			expect(anchors[1].statement).toContain("1. Identify the base system prompt");
			expect(anchors[1].statement).toContain("2. Identify the per-role control prompts");
		} finally {
			harness.cleanup();
		}
	});

	it("materializes an explore's concrete tool result, not only its prediction", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "explore",
					expectation: "The prompt-construction surface lives in a few identifiable files",
					intent: "Grep packages/coding-agent/src for prompt-definition markers",
					completionCondition: "One grep records file locations and per-file match counts for the prompt markers",
					expectedEvidenceRounds: 1,
					budgetReason: "A single grep over the package tree is one independent evidence round",
				}),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "agent-session.ts:39" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("grep recorded the prompt sites"),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The grep recorded the prompt sites in system-prompt.ts and agent-session.ts",
					},
				}),
				control({ kind: "authorize_final", reason: "Comprehension is sufficient" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("find the prompts");

			const observations = harness.sessionManager.getBranch().filter((entry) => entry.type === "observation");
			expect(observations).toHaveLength(1);
			// The frozen expectation is restated at the head of the canonical statement…
			expect(observations[0].statement).toContain(
				"Expectation: The prompt-construction surface lives in a few identifiable files",
			);
			// …and the confirmed prediction error names the concrete established result.
			expect(observations[0].statement).toContain("Prediction error: confirmed: The grep recorded the prompt sites");
			// The raw tool output is never inlined into the statement; it is referenced
			// only through the exact provenance pointer.
			expect(observations[0].statement).not.toContain("observed:agent-session.ts:39");
			const resultEntry = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(resultEntry).toBeDefined();
			expect((observations[0] as { sourceEventIds: string[] }).sourceEventIds).toEqual([resultEntry!.id]);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a single-round Action that derives its target instead of naming it", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "The epistemic/execution-loop prompt is assembled by one primary assembly function",
					expectation: "Reading the top marker-matching source file shows a single assembly function",
					actions: [
						actionBudget({
							intent:
								"Read in full the source file from the prior grep result with the highest total count of prompt-marker terms",
							completionCondition:
								"The read completes and establishes whether that file contains a prompt-assembly function",
							expectation:
								"The read result shows the top marker-matching file contains a prompt-assembly function",
						}),
					],
				}),
				control({
					kind: "create_frame",
					statement: "The epistemic/execution-loop prompt is assembled by one primary assembly function",
					expectation: "Reading the top marker-matching source file shows a single assembly function",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established where prompts enter in the loop source",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: A single-round Action must name its probe target directly",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("gives a targeted repair hint when control emits a tool call as text", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "Prompt construction in the loop is produced only by externally injected messages",
					expectation: "The loop source shows a prompt template or assembly routine inside the class",
					actions: [actionBudget(action)],
				}),
				control({ kind: "authorize_action", actionContractId: "A1" }),
				fauxAssistantMessage("The loop source was read in full."),
				// The control model should adjudicate the finished episode but instead
				// emits a tool call as inert text (the epistemic role has no tools).
				fauxAssistantMessage(
					'Reading agent-session.ts now.\n\n<invoke name="bash">\n<parameter name="command" string="true">wc -l agent-session.ts</parameter>\n</invoke>',
				),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "A single full read established where prompts enter in the loop source",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("Prompts enter the loop only through externally injected messages."),
			]);

			await harness.session.prompt("locate the prompt entry sites in the loop");

			expect(
				harness.providerContexts.some((context) =>
					(context.systemPrompt ?? "").includes("emitted a tool call as text"),
				),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("strips tool-call markup from a final answer that emits it as text", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({ kind: "ask", question: "Should this be an exhaustive inventory or a representative analysis?" }),
				fauxAssistantMessage(
					'Let me check the sources first.\n\n<invoke name="bash">\n<parameter name="command" string="true">rg -l prompt packages</parameter>\n</invoke>',
				),
			]);

			await harness.session.prompt("check the prompts");

			// The fake <invoke> block is gone, the surrounding prose is kept.
			expect(harness.session.getLastAssistantText()).toBe("Let me check the sources first.");
			expect(harness.session.state.errorMessage).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to a bounded report when the final answer is only a tool call", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({ kind: "ask", question: "Should this be an exhaustive inventory or a representative analysis?" }),
				fauxAssistantMessage(
					'<invoke name="bash">\n<parameter name="command" string="true">rg -l prompt packages</parameter>\n</invoke>',
				),
			]);

			await harness.session.prompt("check the prompts");

			// No prose survived the strip, so the authorized clarifying question is
			// substituted instead of an empty or broken answer.
			expect(harness.session.getLastAssistantText()).toBe(
				"Should this be an exhaustive inventory or a representative analysis?",
			);
			expect(harness.session.state.errorMessage).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
