import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { statusOfDomainBelief } from "../../../src/core/agent-session-domain.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("belief-loop event family", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/**
	 * Propose's statement of how it currently reads the task.
	 *
	 * Once a round has completed, propose owes this decision before it can conclude or choose
	 * another experiment, so every belief-loop script here publishes one. Where it is published
	 * relative to the first probe is deliberate per test: before the probe, the episode's plan
	 * records that version; after it, the plan records that no version had been formed yet.
	 */
	const formulation = (reason = "reading formed from the evidence so far") =>
		fauxToolCall("set_formulation", {
			interpretation: "I read this as a question about how long the cached value survives",
			focus: "the lifetime of the cached value across a logout",
			implication: "the answer turns on what the post-logout read returns",
			reason,
		});

	it("emits task/episode lifecycle, belief deltas, plans, and distillation correlations", async () => {
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
			// First propose turn after the round: the round is complete, so propose owes its reading
			// before it can conclude. Publishing here (and not earlier) is what leaves the plan above
			// recorded as governed by no version — a first investigation is allowed to precede the
			// reading, and the reading is never back-dated onto it.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", { op: "retract", beliefId: "belief-2" }),
				formulation("the first round settled the logout question"),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const taskOpened = harness.eventsOfType("TaskOpened");
		expect(taskOpened).toHaveLength(1);
		expect(harness.eventsOfType("TargetDefined")[0].taskId).toBe(taskOpened[0].taskId);
		expect(harness.eventsOfType("EpisodeOpened")[0].taskId).toBe(taskOpened[0].taskId);

		const deltas = harness.eventsOfType("BeliefDeltaApplied");
		expect(deltas.length).toBeGreaterThan(0);
		for (const event of deltas) {
			expect(event.delta.episodeId).toBe(event.episodeId);
			expect(event.delta.resultingBeliefs.length).toBeGreaterThan(0);
			expect(event.delta.resultingBeliefs.some((belief) => belief.id === event.delta.resultBeliefId)).toBe(true);
		}

		const plans = harness.eventsOfType("PlanProduced");
		// The experiment was chosen before any reading existed, and its plan records that rather
		// than leaving the question open. Everything planned after the reading names it, so a
		// decision can always be traced to the understanding that governed it.
		const versions = harness.eventsOfType("ProblemFormulationRecorded");
		expect(versions).toHaveLength(1);
		expect(plans.length).toBeGreaterThan(0);
		const selectionPlan = plans.find((event) => event.plan.selectedToExplore.length > 0);
		expect(selectionPlan?.plan.formulation).toEqual({ kind: "unformed" });
		for (const event of plans.filter((plan) => plan !== selectionPlan)) {
			expect(event.plan.formulation).toEqual({ kind: "version", versionId: versions[0].version.id });
		}
		expect(plans.some((event) => event.plan.selectedToExplore.length > 0)).toBe(true);
		const distillations = harness.eventsOfType("DistillationProduced");
		expect(distillations.length).toBeGreaterThan(0);
		const firstEpisodeDeltas = deltas.filter((event) => event.episodeId === distillations[0].episodeId);
		expect(distillations[0].distillation.outputs).toEqual(
			firstEpisodeDeltas.filter((event) => event.delta.producerPhase === "distill").map((event) => event.delta.id),
		);
		expect(distillations[0].distillation.outputs).not.toContain(
			firstEpisodeDeltas.find((event) => event.delta.producerPhase === "propose")?.delta.id,
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
				formulation(),
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
			// Settling the fast path runs its own summarizer request, which takes the next queued
			// response. The handoff returns to propose, which now owes its reading before concluding.
			fauxAssistantMessage("Summary: read the readme without submitting a delivery record."),
			fauxAssistantMessage([
				formulation("the fast path could not establish a delivered result"),
				fauxToolCall("conclude", { result: "delivered", evidence: "observed" }),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("the readme is summarized"),
		]);

		await harness.session.prompt("summarize the readme");

		// Exactly one outcome is recorded, and it is propose's own conclusion — not the summary the
		// runtime synthesized when the fast path submitted nothing.
		const outcomes = harness.eventsOfType("TaskOutcomeRecorded");
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.outcome.result).toBe("delivered");
		expect(outcomes[0]?.outcome.blockers).toBeUndefined();
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
				formulation(),
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

	it("records routing as a episode decision rather than a belief", async () => {
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
			// Nothing was submitted through report_outcome, so the fast path hands back to the belief
			// loop rather than closing the task, and propose owes its reading before concluding.
			fauxAssistantMessage([
				formulation("the fast path produced no delivered result to answer with"),
				fauxToolCall("conclude", { result: "delivered", evidence: "observed" }),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("hello"),
		]);

		await harness.session.prompt("please echo hello");

		const routing = harness.eventsOfType("RoutingDecided");
		expect(routing).toHaveLength(1);
		expect(routing[0].routing.decision).toBe("fast-path");
		expect(harness.eventsOfType("BeliefDeltaApplied")).toHaveLength(0);
		expect(harness.eventsOfType("EpisodeBodySelected")[0].body).toBe("fast-path");
		// The fast path has no plan to carry the adoption, so its dispatch records it directly —
		// and with no version published yet, "unformed" is the accurate record.
		expect(harness.eventsOfType("EpisodeBodySelected")[0].formulation).toEqual({ kind: "unformed" });
	});
});
