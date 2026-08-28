import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * A Task may contain several Frames. Every Plan and Distillation occurrence owns a
 * stable opaque id and correlates to exactly one runtime-assigned Frame id.
 */
describe("plan/distillation domain identity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits unique occurrence ids and explicit frame correlations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			// Propose role: declare four open world beliefs so the planner can split them into two batches.
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
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache is thread-safe",
					domain: "code",
					expectation: "the result states the concurrency guarantees",
					evidenceRounds: 1,
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache persists to disk",
					domain: "product",
					expectation: "the result states the persistence behavior",
					evidenceRounds: 1,
				}),
			]),
			// Planner: pick the first two beliefs as batch 1.
			fauxAssistantMessage("Batch: belief-1, belief-2"),
			// Execution: answer directly, no tools.
			fauxAssistantMessage("the cache persists"),
			// Distill: support the first previously-dispatched belief and add a fresh one so the
			// remaining open beliefs re-open the frame and force a second planner batch.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the probe kept the value",
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache is off-by-default",
					domain: "product",
					expectation: "the result states the default",
					evidenceRounds: 1,
				}),
			]),
			// Planner: pick the remaining open beliefs as batch 2.
			fauxAssistantMessage("Batch: belief-3, belief-4"),
			// Execution: answer directly.
			fauxAssistantMessage("the cache is bounded"),
			// Distill: settle a belief.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-3",
					evidence: "the probe confirmed it",
				}),
			]),
			// Propose concludes.
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			// finalReport writes the conclusion.
			fauxAssistantMessage("the cache behavior is settled"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const plans = harness.eventsOfType("PlanProduced");
		expect(plans.length).toBeGreaterThan(1);

		const planIds = plans.map((event) => event.plan.id);
		expect(new Set(planIds).size).toBe(planIds.length);
		for (const plan of plans) {
			expect(plan.plan.id).toMatch(/^plan-/);
			expect(typeof plan.frameId).toBe("string");
			expect(plan.plan.selectedToExplore.length).toBeGreaterThan(0);
		}
		expect(new Set(plans.map((event) => event.frameId)).size).toBe(plans.length);

		const distillations = harness.eventsOfType("DistillationProduced");
		if (distillations.length > 0) {
			const distillationIds = distillations.map((event) => event.distillation.id);
			expect(new Set(distillationIds).size).toBe(distillationIds.length);
			for (const dist of distillations) {
				expect(dist.distillation.id).toMatch(/^distillation-/);
				expect(typeof dist.frameId).toBe("string");
			}
		}
	});
});
