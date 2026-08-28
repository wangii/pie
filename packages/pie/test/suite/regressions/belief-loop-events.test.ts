import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { statusOfDomainBelief } from "../../../src/core/agent-session-domain.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Exercise the durable domain-event family. The runtime owns ids and correlations;
 * consumers replay these events instead of reconstructing frames from phase adjacency.
 */
describe("belief-loop event family", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits task/frame lifecycle, belief deltas, plan, and distillation correlations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			// Propose role: declare two open world beliefs, no routing.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "the result states the cache behavior",
					evidenceRounds: 1,
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache evicts under memory pressure",
					domain: "code",
					expectation: "the result states the eviction policy",
					evidenceRounds: 1,
				}),
			]),
			// Planner role: select both beliefs as the next batch.
			fauxAssistantMessage("Batch: belief-1, belief-2"),
			// Execution role: answer directly with plain text (no tool) so the loop advances.
			fauxAssistantMessage("the cache persists"),
			// Distill role: settle one belief to trigger a real status change.
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
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const taskOpened = harness.eventsOfType("TaskOpened");
		const targetDefined = harness.eventsOfType("TargetDefined");
		const frameOpened = harness.eventsOfType("FrameOpened");
		expect(taskOpened).toHaveLength(1);
		expect(targetDefined[0].taskId).toBe(taskOpened[0].taskId);
		expect(frameOpened[0].taskId).toBe(taskOpened[0].taskId);
		expect(typeof frameOpened[0].frameId).toBe("string");

		const deltas = harness.eventsOfType("BeliefDeltaApplied");
		expect(deltas.length).toBeGreaterThan(0);
		for (const event of deltas) {
			expect(event.taskId).toBe(taskOpened[0].taskId);
			expect(event.delta.frameId).toBe(event.frameId);
			expect(event.delta.resultingBeliefs.length).toBeGreaterThan(0);
		}
		expect(deltas.flatMap((event) => event.delta.resultingBeliefs).some((belief) => belief.id === "belief-1")).toBe(
			true,
		);

		const plans = harness.eventsOfType("PlanProduced");
		expect(plans.length).toBeGreaterThan(0);
		for (const plan of plans) {
			expect(plan.plan.id).toBeTruthy();
			expect(plan.plan.selectedToExplore.length).toBeGreaterThan(0);
		}

		const cursors = harness.eventsOfType("CursorChanged");
		expect(cursors.length).toBeGreaterThan(0);
		for (const cursor of cursors) {
			expect(cursor.taskId).toBe(taskOpened[0].taskId);
			expect(typeof cursor.frameId).toBe("string");
		}

		const distillations = harness.eventsOfType("DistillationProduced");
		expect(distillations.length).toBeGreaterThan(0);
		for (const dist of distillations) {
			expect(dist.distillation.id).toMatch(/^distillation-/);
			expect(dist.distillation.contents).toBeTruthy();
			expect(dist.distillation.outputs.length).toBeGreaterThan(0);
		}
	});

	it("records both immutable belief records changed by refine", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			// Propose role: declare two open world beliefs, no routing.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "the result states the cache behavior",
					evidenceRounds: 1,
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache evicts under memory pressure",
					domain: "code",
					expectation: "the result states the eviction policy",
					evidenceRounds: 1,
				}),
			]),
			// Planner role: select both beliefs as the next batch.
			fauxAssistantMessage("Batch: belief-1, belief-2"),
			// Execution role: answer directly with plain text (no tool) so the loop advances to distill.
			fauxAssistantMessage("the cache persists"),
			// Distill role: refine one of the dispatched beliefs.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "refine",
					beliefId: "belief-1",
					statement: "the cache survives logout for 30s",
					expectation: "the result states the cache TTL",
					evidenceRounds: 1,
				}),
			]),
			// Propose concludes.
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			// finalReport writes the conclusion.
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("how long does the cache survive logout?");

		const refine = harness.eventsOfType("BeliefDeltaApplied").find((event) => event.delta.operation === "refine");
		expect(refine).toBeDefined();
		expect(refine?.delta.resultingBeliefs).toHaveLength(2);
		expect(refine?.delta.resultingBeliefs.map(statusOfDomainBelief)).toEqual(["superseded", "proposed"]);
	});

	it("records routing as a frame decision rather than a belief", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			// Propose role: declare a fast-path routing decision.
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
			]),
			// Fast execution: answer the user directly, no tool calls.
			fauxAssistantMessage("Done."),
			// Distillation summary.
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("please echo hello");

		const routing = harness.eventsOfType("RoutingDecided");
		expect(routing).toHaveLength(1);
		expect(routing[0].routing.id).toMatch(/^routing-/);
		expect(routing[0].routing.decision).toBe("fast-path");
		expect(harness.eventsOfType("BeliefDeltaApplied")).toHaveLength(0);
		expect(harness.eventsOfType("FrameBodySelected")[0].body).toBe("fast-path");
	});
});
