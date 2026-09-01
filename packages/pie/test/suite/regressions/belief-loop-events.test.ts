import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { statusOfDomainBelief } from "../../../src/core/agent-session-domain.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("belief-loop event family", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("emits task/frame lifecycle, belief deltas, plans, and distillation correlations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a post-logout read keeps the value",
					evidenceRounds: 1,
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache evicts under memory pressure",
					domain: "code",
					expectation: "a pressure probe observes eviction",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("Observed:\n- logout kept the value.\n- memory pressure was not applied."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "logout kept the value as predicted",
				}),
				fauxToolCall("declare_belief", {
					op: "inconclusive",
					beliefId: "belief-2",
					evidence: "memory pressure was not applied",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("declare_belief", { op: "retract", beliefId: "belief-2" })]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const taskOpened = harness.eventsOfType("TaskOpened");
		expect(taskOpened).toHaveLength(1);
		expect(harness.eventsOfType("TargetDefined")[0].taskId).toBe(taskOpened[0].taskId);
		expect(harness.eventsOfType("FrameOpened")[0].taskId).toBe(taskOpened[0].taskId);

		const deltas = harness.eventsOfType("BeliefDeltaApplied");
		expect(deltas.length).toBeGreaterThan(0);
		for (const event of deltas) {
			expect(event.delta.frameId).toBe(event.frameId);
			expect(event.delta.resultingBeliefs.length).toBeGreaterThan(0);
			expect(event.delta.resultingBeliefs.some((belief) => belief.id === event.delta.resultBeliefId)).toBe(true);
		}

		const plans = harness.eventsOfType("PlanProduced");
		expect(plans.some((event) => event.plan.selectedToExplore.length > 0)).toBe(true);
		const distillations = harness.eventsOfType("DistillationProduced");
		expect(distillations.length).toBeGreaterThan(0);
		const firstFrameDeltas = deltas.filter((event) => event.frameId === distillations[0].frameId);
		expect(distillations[0].distillation.outputs).toEqual(
			firstFrameDeltas.filter((event) => event.delta.producerPhase === "distill").map((event) => event.delta.id),
		);
		expect(distillations[0].distillation.outputs).not.toContain(
			firstFrameDeltas.find((event) => event.delta.producerPhase === "propose")?.delta.id,
		);
	});

	it("records both immutable belief records changed by evidence-supported refine", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "the result states the cache behavior",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("Observed:\n- the cache survives logout for 30s."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "refine",
					beliefId: "belief-1",
					statement: "the cache survives logout for 30s",
					expectation: "the configured TTL is 30s",
					evidence: "the execution observed a 30s TTL",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("how long does the cache survive logout?");

		const refine = harness.eventsOfType("BeliefDeltaApplied").find((event) => event.delta.operation === "refine");
		expect(refine?.delta.resultingBeliefs).toHaveLength(2);
		expect(refine?.delta.resultingBeliefs.map(statusOfDomainBelief)).toEqual(["superseded", "supported"]);
		expect(refine?.delta.producerPhase).toBe("distill");
		expect(refine?.delta.sourceBeliefId).toBe("belief-1");
		expect(refine?.delta.resultBeliefId).toBe("belief-2");
	});

	it("records routing as a frame decision rather than a belief", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("route_task", {
					decision: "fast-path",
					reason: "no unresolved uncertainty can change the action or its safety",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
				}),
			]),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("please echo hello");

		const routing = harness.eventsOfType("RoutingDecided");
		expect(routing).toHaveLength(1);
		expect(routing[0].routing.decision).toBe("fast-path");
		expect(harness.eventsOfType("BeliefDeltaApplied")).toHaveLength(0);
		expect(harness.eventsOfType("FrameBodySelected")[0].body).toBe("fast-path");
	});
});
