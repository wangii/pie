import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("plan/distillation domain identity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("emits unique occurrence ids across coherent execution episodes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "logout keeps the cached value",
					evidenceRounds: 1,
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache has a bounded TTL",
					domain: "code",
					expectation: "the configuration defines a finite TTL",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("Observed:\n- logout kept the value.\n- the configured TTL is 30s."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "logout kept the value",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the configured TTL is 30s",
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "memory pressure can evict the cache before its TTL",
					domain: "product",
					expectation: "a pressure probe evicts the value before 30s",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("The residual eviction uncertainty is material."),
			fauxAssistantMessage("Observed:\n- memory pressure evicted the value after 4s."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-3",
					evidence: "memory pressure evicted the value after 4s",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache has bounded and pressure-sensitive persistence"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const plans = harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0);
		expect(plans).toHaveLength(2);
		expect(new Set(plans.map((event) => event.plan.id)).size).toBe(plans.length);
		expect(new Set(plans.map((event) => event.frameId)).size).toBe(plans.length);

		const distillations = harness.eventsOfType("DistillationProduced");
		expect(new Set(distillations.map((event) => event.distillation.id)).size).toBe(distillations.length);
		for (const event of distillations) expect(typeof event.frameId).toBe("string");
	});
});
