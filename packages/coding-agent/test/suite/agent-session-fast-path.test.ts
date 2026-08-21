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

	it("hands the remaining work to the fast path when propose re-routes mid-task", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// First propose turn: the initial route is belief-loop.
			routeResponse("belief-loop"),
			// The belief loop continues: propose a task belief, probe it, settle it.
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
			// Second propose turn: the belief set is quiescent, so re-route to the fast path.
			routeResponse("fast-path"),
			// Fast execution answers the user directly.
			fauxAssistantMessage("Done."),
			// Distillation summary for the fast-path run.
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("is the cache persistent?");

		// Both routing decisions are preserved in the history.
		const routing = harness.session.beliefs.filter((b) => b.domain === "routing");
		expect(routing.map((b) => b.decision)).toEqual(["belief-loop", "fast-path"]);

		// The fast-path run was distilled and its answer reached the user.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		expect((custom as { details?: { outcome?: string } }).details?.outcome).toBe("success");
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
	});

	it("does not hand off mid-task while a framing obligation is open", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// First propose turn: belief-loop route plus an open framing obligation.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "route",
					statement: "本请求适合 fast path 执行",
					expectation: "该请求为简单任务",
					decision: "belief-loop",
					suitabilityProbability: 0.2,
					successProbability: 0.2,
					estimatedSteps: 1,
					difficulty: "low",
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the final answer must establish that the cache survives logout",
					domain: "framing",
					expectation: "the conclusion states the cache behavior",
					evidenceRounds: 1,
				}),
			]),
			// Second propose turn: a fast-path route is declared but the open framing blocks it.
			routeResponse("fast-path"),
			// The belief loop continues: probe and settle the world belief, then the framing.
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
					beliefId: "belief-4",
					evidence: "the probe kept the value",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the probed behavior establishes the obligation",
					evidenceBeliefIds: ["belief-4"],
				}),
			]),
			// Conclude: the reflection round fires (enough settled beliefs), then passes.
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The fast-path route was declared but never dispatched: no distillation, normal conclusion.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeUndefined();
		const routing = harness.session.beliefs.filter((b) => b.domain === "routing");
		expect(routing.map((b) => b.decision)).toEqual(["belief-loop", "fast-path"]);
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("the cache survives logout for 30s");
	});

	it("does not re-dispatch a consumed fast-path route after a failed run", async () => {
		const boomTool: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "Always fails",
			parameters: Type.Object({}),
			execute: async () => {
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
			// Fast execution: a tool call that errors, then a final answer.
			fauxAssistantMessage([fauxToolCall("boom", {})]),
			fauxAssistantMessage("I failed."),
			// Handed back to propose: it does not re-declare a route, and the consumed route
			// must not re-dispatch — the belief loop continues.
			fauxAssistantMessage("let me keep investigating"),
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
			fauxAssistantMessage("belief loop took over"),
		]);

		await harness.session.prompt("run boom");

		// Exactly one fast-path run: the failed one. The consumed route was not re-dispatched.
		const customMessages = harness.session.messages.filter(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(customMessages).toHaveLength(1);
		expect((customMessages[0] as { details?: { outcome?: string } }).details?.outcome).toBe("failure");
		expect(harness.session.beliefs.filter((b) => b.domain === "routing")).toHaveLength(1);
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("belief loop took over");
	});
});
