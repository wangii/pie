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
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1", "belief-2"] }),
				fauxToolCall("select_experiment", {
					intent: "which behavior the final answer must report",
					beliefIds: ["belief-1", "belief-2"],
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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

		// Task scope and task delivery are task-level, so both events carry taskId and land inside
		// the task's lifetime: the focus declaration precedes the plan it scopes, and the outcome
		// precedes the close.
		const focus = harness.eventsOfType("FocusDeclared");
		expect(focus).toHaveLength(1);
		expect(focus[0].taskId).toBe(taskOpened[0].taskId);
		expect(focus[0].beliefIds).toEqual(["belief-1", "belief-2"]);
		expect(harness.events.indexOf(focus[0])).toBeLessThan(
			harness.events.indexOf(plans.find((event) => event.plan.selectedToExplore.length > 0)!),
		);

		const outcomes = harness.eventsOfType("TaskOutcomeRecorded");
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].taskId).toBe(taskOpened[0].taskId);
		expect(outcomes[0].outcome.result).toBe("delivered");
		expect(outcomes[0].outcome.evidence).toBe("observed");
		expect(harness.events.indexOf(outcomes[0])).toBeLessThan(
			harness.events.indexOf(harness.eventsOfType("TaskClosed")[0]),
		);
	});

	it("declares focus once per distinct scope and not on a restatement", async () => {
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
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
			]),
			// Same scope restated: no second event, since the fold's output does not change.
			fauxAssistantMessage([
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				fauxToolCall("select_experiment", { intent: "what the answer must report", beliefIds: ["belief-1"] }),
			]),
			fauxAssistantMessage("Observed:\n- logout kept the value."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "logout kept the value as predicted",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		expect(harness.eventsOfType("FocusDeclared")).toHaveLength(1);
	});

	it("records no task outcome when the fast path reports none", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("route_task", {
					decision: "fast-path",
					reason: "epistemically closed",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 2,
					difficulty: "low",
				}),
			]),
			// The fast path completes with tools but never submits a delivery record. The runtime
			// synthesizes a failure outcome for continuity, and that synthesized value must stay out
			// of the domain stream: it is runtime bookkeeping, not something the model delivered.
			fauxAssistantMessage([fauxToolCall("read", { file_path: "README.md" })]),
			fauxAssistantMessage("Done."),
		]);

		await harness.session.prompt("summarize the readme");

		expect(harness.eventsOfType("TaskOutcomeRecorded")).toHaveLength(0);
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
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				fauxToolCall("select_experiment", {
					intent: "how long the final answer should say the cache survives",
					beliefIds: ["belief-1"],
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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
