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

		// The routing decision drove the dispatch; it is recorded as a frame decision
		// (RoutingDecided), never as a belief record.
		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(1);

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
			// finalReport writes the conclusion.
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
					beliefId: "belief-1",
					evidence: "the probe kept the value",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// No routing decision, no fast-path distillation: the loop ran normally.
		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(0);
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
					beliefId: "belief-1",
					evidence: "the probe kept the value",
				}),
			]),
			// Propose concludes.
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			// finalReport writes the conclusion.
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
		expect(harness.session.beliefs.find((b) => b.id === "belief-1")?.supportedBy).toHaveLength(1);
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
					beliefId: "belief-1",
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

		// Both routing decisions were consumed mid-task (belief-loop then fast-path), and the
		// task-end reset keeps only the settled product belief as session knowledge.
		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(2);
		expect(harness.session.beliefs.map((b) => b.id)).toEqual(["belief-1"]);

		// The fast-path run was distilled and its answer reached the user.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		expect((custom as { details?: { outcome?: string } }).details?.outcome).toBe("success");
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
	});

	it("hands off mid-task to the fast path even while a framing obligation is open", async () => {
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
			// Second propose turn: a fast-path route is declared; the open framing no longer blocks it.
			routeResponse("fast-path"),
			// Fast execution: answer the user directly, no tool calls.
			fauxAssistantMessage("Done."),
			// Distillation summary.
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The fast-path route dispatched despite the open framing: a distillation summary exists.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		expect((custom as { details?: { outcome?: string } }).details?.outcome).toBe("success");
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
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
					handoffFromBeliefIds: ["belief-1"],
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
					beliefId: "belief-2",
					evidence: "the tool results completed without error",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the outcome establishes the obligation",
					evidenceBeliefIds: ["belief-2"],
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
		expect(details?.parentTaskId).toBe(harness.eventsOfType("TaskOpened")[0].taskId);
		expect(details?.handoffFromBeliefIds).toEqual(["belief-1"]);
		expect(details?.reason).toBe("the remaining framing is execution-only");
		expect(details?.outcomeBeliefId).toBe("belief-2");

		// The framing obligation was discharged (supported via evidenceBeliefIds), not left open:
		// its record remains with a supportedBy entry linking the settled outcome belief.
		const framing = harness.session.beliefs.find((b) => b.id === "belief-1");
		expect(framing?.domain).toBe("framing");
		expect(framing?.supportedBy).toHaveLength(1);
		expect(framing?.supportedBy[0]?.beliefIds).toEqual(["belief-2"]);
		const outcome = harness.session.beliefs.find((b) => b.id === "belief-2");
		expect(outcome?.domain).toBe("product");

		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
		expect(assistantTexts).toContain("the cache survives logout for 30s");
	});

	it("dispatches a mismatched-task-id fast-path route without a frame-open snapshot", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);

		harness.setResponses([
			// First propose turn: a fast-path route naming the WRONG task id still dispatches
			// (the task-id gate is gone), but with no frame-open snapshot because the id mismatches.
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
					handoffFromBeliefIds: ["belief-1"],
					parentTaskId: "task-999",
				}),
			]),
			// Fast execution: answer the user directly, no tool calls.
			fauxAssistantMessage("Done."),
			// Distillation summary.
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The mismatched-task-id fast-path route dispatched: a distillation summary exists, but
		// as a plain (non-frame-open) run — no traceability details, no handoff snapshot.
		const custom = harness.session.messages.find(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toBeDefined();
		expect((custom as { details?: Record<string, unknown> }).details?.outcome).toBe("success");
		expect((custom as { details?: Record<string, unknown> }).details?.parentTaskId).toBeUndefined();
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done.");
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
					beliefId: "belief-1",
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
		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(1);
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
					beliefId: "belief-1",
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
		// Task 1 concluded via the belief loop: its routing decision is recorded as a frame
		// decision, and the settled product belief survives as session knowledge.
		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(1);

		await harness.session.prompt("please echo hi");
		// Task 2 added its own fast-path routing decision; only the settled product belief
		// survives as session knowledge.
		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(2);
		expect(harness.session.beliefs.map((b) => b.id)).toEqual(["belief-1"]);
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
					handoffFromBeliefIds: ["belief-1"],
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
					beliefId: "belief-3",
					evidence: "the tool results completed without error",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the outcome establishes the obligation",
					evidenceBeliefIds: ["belief-3"],
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
		expect(details?.parentTaskId).toBe(harness.eventsOfType("TaskOpened")[0].taskId);
		expect(details?.handoffFromBeliefIds).toEqual(["belief-1"]);

		// The open world hypothesis was NOT auto-settled by the fast path: it stays proposed so
		// the belief loop re-adjudicates it.
		const world = harness.session.beliefs.find((b) => b.id === "belief-2");
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
			// the same turn. The route is evaluated first, so the fast path dispatches; on this
			// path the world hypothesis is never snapshotted, and the task-boundary reset prunes
			// it — the test therefore asserts only the distillation summary.
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
	it("dispatches a stale-task-id fast-path route in the next task without a frame-open snapshot", async () => {
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
					handoffFromBeliefIds: ["belief-1"],
					parentTaskId: "task-1",
				}),
			]),
			fauxAssistantMessage("Done task 1."),
			fauxAssistantMessage("Summary: task 1 done."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the tool results completed without error",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the outcome establishes the obligation",
					evidenceBeliefIds: ["belief-2"],
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("done"),
			// Task 2: a fast-path route using the STALE task-1 id still dispatches (the task-id
			// gate is gone), but without a frame-open snapshot because the id mismatches — it is
			// a plain fast-path run, so the open framing is not carried or discharged.
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
			// Fast execution: answer the user directly, no tool calls.
			fauxAssistantMessage("Done task 2."),
			// Distillation summary for task 2's plain fast-path run.
			fauxAssistantMessage("Summary: task 2 done."),
		]);

		// Task 1.
		await harness.session.prompt("is the cache persistent?");
		// Completed tasks have no active task id; their stable ids remain in the domain snapshot.
		expect(harness.session.taskId).toBeUndefined();
		expect(harness.session.domainSnapshot.activeBranchTasks).toHaveLength(1);

		// Task 2.
		await harness.session.prompt("is the cache persistent again?");
		expect(harness.session.taskId).toBeUndefined();
		expect(harness.session.domainSnapshot.activeBranchTasks).toHaveLength(2);

		// The stale task-1 fast-path route dispatched as a plain run (no frame-open snapshot), so
		// a second fast-path distillation summary exists — task 1's authorized handoff plus task 2's.
		const custom = harness.session.messages.filter(
			(m) => m.role === "custom" && m.customType === "fast_path_distillation",
		);
		expect(custom).toHaveLength(2);
		const assistantTexts = harness.session.messages.filter((m) => m.role === "assistant").map(getMessageText);
		expect(assistantTexts).toContain("Done task 1.");
		expect(assistantTexts).toContain("Done task 2.");
	});
});
