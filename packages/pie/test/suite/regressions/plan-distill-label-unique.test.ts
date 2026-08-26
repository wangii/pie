import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression for the "planID/distillationID stays fixed forever" report.
 *
 * The producer (`agent-session.ts`) emits PlanProduced/DistillationProduced with a
 * display `label` that was previously derived only from `taskId` (`P-<taskId>` /
 * `D-<taskId>`), so every plan/distillation in a session rendered the same ID
 * even though the internal `planId` carried a unique counter. These tests drive a
 * loop that emits multiple plans within one task and assert the labels are unique
 * and that each plan's label correlates with its unique `planId`.
 */
describe("plan/distillation display label uniqueness", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits a unique label per PlanProduced and correlates it with the planId counter", async () => {
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

		// Each plan's label must be unique and must embed the same batch counter as its planId.
		const labels = plans.map((p) => p.label);
		expect(new Set(labels).size).toBe(labels.length);
		for (const plan of plans) {
			const counter = plan.planId.split("-")[2];
			expect(plan.label).toBe(`P-${plan.frameId}-${counter}`);
		}

		// A single flow (the current task) must not reuse a label under the previous broken scheme.
		const distillations = harness.eventsOfType("DistillationProduced");
		if (distillations.length > 0) {
			const distLabels = distillations.map((d) => d.label);
			expect(new Set(distLabels).size).toBe(distLabels.length);
			for (const dist of distillations) {
				expect(dist.label).toMatch(/^D-\d+-\d+$/);
			}
		}
	});
});
