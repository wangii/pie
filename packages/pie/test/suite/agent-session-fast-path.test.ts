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

		// The routing belief drove the dispatch and was pruned at the task-end reset:
		// routing records are task ephemera, not session knowledge.
		expect(harness.session.beliefs.filter((b) => b.domain === "routing")).toHaveLength(0);

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

		// The belief-loop route was consumed mid-task, and the task-end reset pruned both
		// routing records — only the settled product belief survives as session knowledge.
		expect(harness.session.beliefs.filter((b) => b.domain === "routing")).toHaveLength(0);
		expect(harness.session.beliefs.map((b) => b.id)).toEqual(["belief-2"]);

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

	it("hands off a frame-open task to the fast path only when the framing is explicitly covered", async () => {
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
			// Second propose turn: an authorized fast-path handoff covering the open framing.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "route",
					statement: "本请求适合 fast path 执行",
					expectation: "该请求为简单任务",
					decision: "fast-path",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
					handoffFromBeliefIds: ["belief-2"],
					parentTaskId: "task-1",
					reason: "the remaining framing is execution-only",
				}),
			]),
			// Fast execution: answer directly, no tool calls.
			fauxAssistantMessage("Done."),
			// Distillation summary.
			fauxAssistantMessage("Summary: completed the request."),
			// Distill: support the synthesized outcome belief and discharge the framing.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-4",
					evidence: "the tool results completed without error",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the outcome establishes the obligation",
					evidenceBeliefIds: ["belief-4"],
				}),
			]),
			// Conclude.
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The authorized frame-open handoff dispatched the fast path and produced a distillation summary
		// with traceability details (parentTaskId, handoffFromBeliefIds, reason, outcomeBeliefId).
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		const details = (custom as { details?: Record<string, unknown> })?.details;
		expect(details?.outcome).toBe("success");
		expect(details?.parentTaskId).toBe("task-1");
		expect(details?.handoffFromBeliefIds).toEqual(["belief-2"]);
		expect(details?.reason).toBe("the remaining framing is execution-only");
		expect(details?.outcomeBeliefId).toBe("belief-4");

		// The framing obligation was discharged (supported via evidenceBeliefIds), not left open:
		// its record remains with a supportedBy entry linking the settled outcome belief.
		const framing = harness.session.beliefs.find((b) => b.id === "belief-2");
		expect(framing?.domain).toBe("framing");
		expect(framing?.supportedBy).toHaveLength(1);
		expect(framing?.supportedBy[0]?.beliefIds).toEqual(["belief-4"]);
		const outcome = harness.session.beliefs.find((b) => b.id === "belief-4");
		expect(outcome?.domain).toBe("product");

		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
		expect(assistantTexts).toContain("the cache survives logout for 30s");
	});

	it("does not hand off a frame-open task when the route names a mismatched task id", async () => {
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
			// Second propose turn: a fast-path route naming the WRONG task id — the gate rejects it.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "route",
					statement: "本请求适合 fast path 执行",
					expectation: "该请求为简单任务",
					decision: "fast-path",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
					handoffFromBeliefIds: ["belief-2"],
					parentTaskId: "task-999",
				}),
			]),
			// The belief loop continues normally: probe and settle the world belief, then the framing.
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
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The mismatched-task-id fast-path route was never dispatched: no fast-path distillation.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeUndefined();
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

	it("retains supported product/code knowledge across tasks and prunes ephemera at the next task boundary", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// Task 1: belief-loop route, propose a product belief, probe, settle, conclude.
			routeResponse("belief-loop"),
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
			// Task 2: routes to the fast path and answers the new request.
			routeResponse("fast-path"),
			fauxAssistantMessage("Done with task 2."),
			fauxAssistantMessage("Summary: task 2 done."),
		]);

		await harness.session.prompt("is the cache persistent?");
		// Task 1 concluded via the belief loop: ephemera are still present until the next
		// task's reset (no prune at conclude — the finalAnswer snapshot needs them).
		expect(harness.session.beliefs.filter((b) => b.domain === "routing")).toHaveLength(1);

		await harness.session.prompt("please echo hi");
		// Task 2's boundary reset pruned task 1's ephemera; only the settled product belief
		// survives as session knowledge, and task 2's own routing record is pruned too.
		expect(harness.session.beliefs.filter((b) => b.domain === "routing")).toHaveLength(0);
		expect(harness.session.beliefs.map((b) => b.id)).toEqual(["belief-2"]);
	});

	it("hands off with open world beliefs: fast path dispatches and leaves them un-settled", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// First propose turn: belief-loop route + open framing.
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
			// Second propose turn: an authorized frame-open fast-path handoff AND an open world
			// hypothesis declared in the same turn. The route is evaluated first (propose branch
			// order), so the handoff dispatches and the world hypothesis is snapshotted, not
			// dispatched to the belief loop.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "route",
					statement: "本请求适合 fast path 执行",
					expectation: "该请求为简单任务",
					decision: "fast-path",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
					handoffFromBeliefIds: ["belief-2"],
					parentTaskId: "task-1",
					reason: "the remaining framing is execution-only",
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a probe keeps the cached value",
					evidenceRounds: 1,
				}),
			]),
			// Fast execution: answer directly, no tool calls.
			fauxAssistantMessage("Done."),
			// Distillation summary.
			fauxAssistantMessage("Summary: completed the request."),
			// Distill: support the synthesized outcome belief and discharge the framing.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-5",
					evidence: "the tool results completed without error",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the outcome establishes the obligation",
					evidenceBeliefIds: ["belief-5"],
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The handoff dispatched despite the open world hypothesis: a distillation summary exists
		// with the traceability details.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		const details = (custom as { details?: Record<string, unknown> })?.details;
		expect(details?.outcome).toBe("success");
		expect(details?.parentTaskId).toBe("task-1");
		expect(details?.handoffFromBeliefIds).toEqual(["belief-2"]);

		// The open world hypothesis was NOT auto-settled by the fast path: it stays proposed so
		// the belief loop re-adjudicates it.
		const world = harness.session.beliefs.find((b) => b.id === "belief-4");
		expect(world?.domain).toBe("product");
		expect(world?.supportedBy ?? []).toHaveLength(0);
		expect(world?.refutedBy ?? []).toHaveLength(0);

		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
	});

	it("dispatches a one-shot fast path with an open world belief when no framing is open", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// First propose turn: belief-loop route, no framing.
			routeResponse("belief-loop"),
			// Second propose turn: a one-shot fast-path route PLUS an open world hypothesis in
			// the same turn. The route is evaluated first, so the fast path dispatches and the
			// world hypothesis stays open as an unverified snapshot.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "route",
					statement: "本请求适合 fast path 执行",
					expectation: "该请求为简单任务",
					decision: "fast-path",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a probe keeps the cached value",
					evidenceRounds: 1,
				}),
			]),
			// Fast execution: answer directly.
			fauxAssistantMessage("Done."),
			// Distillation summary.
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("please echo hello");

		// The one-shot route dispatched despite the open world belief: a distillation summary exists.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		expect((custom as { details?: { outcome?: string } }).details?.outcome).toBe("success");
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
	});
	it("rotates the task id at the boundary so a stale parentTaskId is rejected in the next task", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// Task 1: belief-loop route + open framing, then an authorized frame-open handoff.
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
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "route",
					statement: "本请求适合 fast path 执行",
					expectation: "该请求为简单任务",
					decision: "fast-path",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
					handoffFromBeliefIds: ["belief-2"],
					parentTaskId: "task-1",
				}),
			]),
			fauxAssistantMessage("Done task 1."),
			fauxAssistantMessage("Summary: task 1 done."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-4",
					evidence: "the tool results completed without error",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the outcome establishes the obligation",
					evidenceBeliefIds: ["belief-4"],
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("done"),
			// Task 2: a frame-open handoff using the STALE task-1 id must be rejected.
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
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "route",
					statement: "本请求适合 fast path 执行",
					expectation: "该请求为简单任务",
					decision: "fast-path",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
					handoffFromBeliefIds: ["belief-5"],
					parentTaskId: "task-1",
				}),
			]),
			// The loop continues normally (rejected): settle the world belief and framing.
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
					beliefId: "belief-6",
					evidence: "the probe kept the value",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-4",
					evidence: "the probed behavior establishes the obligation",
					evidenceBeliefIds: ["belief-6"],
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("done"),
		]);

		// Task 1.
		await harness.session.prompt("is the cache persistent?");
		// Task 1's frame-open handoff did NOT reset the loop (it routed to distill), so the task
		// id is still "task-1" after task 1's own handoff.
		expect(harness.session.taskId).toBe("task-1");

		// Task 2.
		await harness.session.prompt("is the cache persistent again?");
		// Task 2's boundary reset rotated the task id to "task-2" before its own loop.
		expect(harness.session.taskId).toBe("task-2");

		// The stale task-1 handoff was rejected even though the framing is open: no fast-path
		// distillation for the stale route; the loop concluded normally instead.
		const custom = harness.session.messages.filter(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toHaveLength(1); // only task 1's handoff distilled a summary.
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done task 1.");
	});
});
