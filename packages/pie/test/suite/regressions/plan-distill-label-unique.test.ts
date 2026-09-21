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
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1", "belief-2"] }),
				fauxToolCall("select_experiment", {
					intent: "whether the final answer calls the cache persistent",
					beliefIds: ["belief-1", "belief-2"],
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
			// The first round is done, so propose owes its reading before choosing again. Publishing
			// here also voids nothing: no experiment is selected at this point, and the selection in
			// the next turn is recorded against this version.
			fauxAssistantMessage([
				fauxToolCall("set_formulation", {
					interpretation: "I read this as a question about how far persistence actually extends",
					focus: "the conditions under which the cached value survives",
					tension: "the TTL is bounded but nothing yet says whether eviction preempts it",
					implication: "the answer must qualify persistence rather than assert it",
					reason: "the first round settled persistence but raised eviction",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-3"] }),
				fauxToolCall("select_experiment", {
					intent: "whether the final answer must qualify persistence under pressure",
					beliefIds: ["belief-3"],
				}),
			]),
			fauxAssistantMessage("Observed:\n- memory pressure evicted the value after 4s."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-3",
					evidence: "memory pressure evicted the value after 4s",
				}),
			]),
			// The second round distilled too, so propose owes a result for it before concluding.
			fauxAssistantMessage([
				fauxToolCall("recheck_formulation", {
					reason: "the reading still qualifies persistence rather than asserting it",
				}),
				fauxToolCall("conclude", { result: "delivered", evidence: "observed" }),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("the cache has bounded and pressure-sensitive persistence"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const plans = harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0);
		expect(plans).toHaveLength(2);
		expect(new Set(plans.map((event) => event.plan.id)).size).toBe(plans.length);
		expect(new Set(plans.map((event) => event.episodeId)).size).toBe(plans.length);

		const distillations = harness.eventsOfType("DistillationProduced");
		expect(new Set(distillations.map((event) => event.distillation.id)).size).toBe(distillations.length);
		for (const event of distillations) expect(typeof event.episodeId).toBe("string");
	});
});
