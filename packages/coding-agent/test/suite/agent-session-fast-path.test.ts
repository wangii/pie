import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * Fast-path routing: the propose role declares a `route` belief; a `fast-path` decision
 * dispatches the execution role directly (it answers the user), the run is settled with a
 * `fast_path_distillation` custom summary, and the loop resets to propose. A failure hands the
 * same task back to propose without resetting the task ledger; a `belief-loop` decision keeps
 * the normal protocol.
 */
describe("AgentSession fast path", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	const routeResponse = (decision: "fast-path" | "belief-loop") =>
		fauxAssistantMessage([
			fauxToolCall("declare_belief", {
				op: "route",
				statement: "本请求适合 fast path 执行",
				expectation: "该请求为简单任务",
				decision,
				suitabilityProbability: decision === "fast-path" ? 0.9 : 0.2,
				successProbability: decision === "fast-path" ? 0.9 : 0.2,
				estimatedSteps: 1,
				difficulty: "low",
			}),
		]);

	const fastHarnessOptions = {
		enableBeliefSet: true,
		models: [{ id: "default" }, { id: "fast" }, { id: "distill" }],
		settings: {
			defaultModel: "faux/default",
			pie: {
				fastPathModel: "faux/fast",
				distillationModel: "faux/distill",
			},
		},
	};

	it("routes a simple request to the fast path, distills a summary, and resets to propose", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			routeResponse("fast-path"),
			// Fast execution: answer the user directly, no tool calls.
			fauxAssistantMessage("Done."),
			// Distillation summary (completeSimple consumes this response).
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("please echo hello");

		// The routing belief is settled and carries the structured fields.
		const routing = harness.session.beliefs.find((b) => b.domain === "routing");
		expect(routing?.decision).toBe("fast-path");
		expect(routing?.suitabilityProbability).toBe(0.9);
		expect(routing?.estimatedSteps).toBe(1);

		// The execution answer reached the user.
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");

		// The distilled summary was persisted as a custom message.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		expect(getMessageText(custom!)).toContain("Summary: completed the request.");
		expect((custom as { details?: { outcome?: string } }).details?.outcome).toBe("success");

		// The loop reset to the next task's propose default state.
		expect(harness.session.getActiveToolNames()).toContain("declare_belief");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("hands a failed fast-path run back to propose with a failure summary", async () => {
		const boomTool: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "Always fails",
			parameters: Type.Object({}),
			execute: async () => {
				// A thrown error is the only way `executePreparedToolCall` marks the result
				// `isError: true` (a returned `isError` field is ignored — `AgentToolResult`
				// has none).
				throw new Error("boom");
			},
		};
		const harness = await createHarness({
			...fastHarnessOptions,
			tools: [boomTool],
		});
		harnesses.push(harness);

		harness.setResponses([
			routeResponse("fast-path"),
			// Fast execution: a tool call that errors.
			fauxAssistantMessage([fauxToolCall("boom", {})]),
			// Fast execution concludes with a final answer (no tool results this turn).
			fauxAssistantMessage("I failed."),
			// Distillation summary for the failed run.
			fauxAssistantMessage("Summary: failed at boom."),
			// Handed back to propose: conclude the same task in the belief loop.
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			// finalAnswer writes the conclusion.
			fauxAssistantMessage("belief loop took over"),
		]);

		await harness.session.prompt("run boom");

		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		expect(getMessageText(custom!)).toContain("Summary: failed at boom.");
		expect((custom as { details?: { outcome?: string } }).details?.outcome).toBe("failure");

		// The same task continued in the belief loop and concluded.
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("belief loop took over");
	});

	it("falls back to the belief loop when the propose turn declares no routing belief", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// No route: the propose turn goes straight to the normal protocol.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a probe keeps the cached value",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("the value persisted"),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the probe kept the value",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// No routing belief, no fast-path distillation: the loop ran normally.
		expect(harness.session.beliefs.some((b) => b.domain === "routing")).toBe(false);
		expect(
			harness.session.messages.find((m) => m.role === "custom" && m.customType === "fast_path_distillation"),
		).toBeUndefined();
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("the cache survives logout for 30s");
	});

	it("keeps the normal belief-loop flow for a belief-loop routing decision", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			routeResponse("belief-loop"),
			// Propose continues with the normal protocol: a task belief.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a probe keeps the cached value",
					evidenceRounds: 1,
				}),
			]),
			// Execution probes.
			fauxAssistantMessage("the value persisted"),
			// Distill settles the frame.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the probe kept the value",
				}),
			]),
			// Propose concludes.
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			// finalAnswer writes the conclusion.
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// No fast-path distillation summary for a belief-loop routed task.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeUndefined();

		// The normal belief loop ran to a conclusion.
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("the cache survives logout for 30s");
		expect(harness.session.beliefs.find((b) => b.id === "belief-2")?.supportedBy).toHaveLength(1);
	});
});
