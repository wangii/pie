import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Exercise the belief-loop event family and assert the events introduced/completed by the
 * contract-hardening change fire with the expected shapes and ordering:
 * - BeliefCreated fires at propose time (before BeliefsSelected), not at batch selection.
 * - BeliefUpdated fires when a belief's status actually changes (support/refute/refine/retract).
 * - ProposalCreated / PlanProduced (with planId) / BeliefsSelected fire on a planner batch.
 * - CursorChanged no longer carries a stub `item`.
 */
describe("belief-loop event family", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits BeliefCreated on propose (before batch selection) and BeliefUpdated on a real status change", async () => {
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
			// finalAnswer writes the conclusion.
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// BeliefCreated fires at propose time, before BeliefsSelected.
		const created = harness.eventsOfType("BeliefCreated");
		expect(created.length).toBeGreaterThan(0);
		for (const ev of created) {
			expect(ev.beliefId).toBeGreaterThan(0);
			expect(ev.statement).toBeTruthy();
			expect(ev.domain).toBeTruthy();
			expect(ev.expectation).toBeTruthy();
			expect(ev.evidenceRounds).toBeGreaterThan(0);
		}
		const firstCreated = harness.events.indexOf(created[0]);
		const selected = harness.eventsOfType("BeliefsSelected");
		expect(selected.length).toBeGreaterThan(0);
		const firstSelected = harness.events.indexOf(selected[0]);
		expect(firstCreated).toBeLessThan(firstSelected);

		// BeliefUpdated fires on a real status change with raw status + previousStatus.
		const updated = harness.eventsOfType("BeliefUpdated");
		expect(updated.length).toBeGreaterThan(0);
		for (const ev of updated) {
			expect(["proposed", "supported", "refuted", "superseded"]).toContain(ev.status);
			expect(["proposed", "supported", "refuted", "superseded"]).toContain(ev.previousStatus);
			expect(ev.statement).toBeTruthy();
		}

		// ProposalCreated / PlanProduced (with planId) / BeliefsSelected are emitted on a batch.
		expect(harness.eventsOfType("ProposalCreated").length).toBeGreaterThan(0);
		const plans = harness.eventsOfType("PlanProduced");
		expect(plans.length).toBeGreaterThan(0);
		for (const plan of plans) {
			expect(plan.planId).toBeTruthy();
		}

		// CursorChanged no longer carries a stub `item`.
		const cursors = harness.eventsOfType("CursorChanged");
		expect(cursors.length).toBeGreaterThan(0);
		for (const cursor of cursors) {
			expect("item" in cursor).toBe(false);
		}

		// DistillationProduced fires in the distill role with a non-empty interpretation and
		// no removed `inputIds`/`unexplained` fields.
		const distillations = harness.eventsOfType("DistillationProduced");
		expect(distillations.length).toBeGreaterThan(0);
		for (const dist of distillations) {
			expect(dist.label).toMatch(/^D-/);
			expect(dist.interpretation).toBeTruthy();
			expect("inputIds" in dist).toBe(false);
			expect("unexplained" in dist).toBe(false);
		}
	});

	it("emits a BeliefCreated for the refined belief and a BeliefUpdated (superseded) for the prior on refine", async () => {
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
			// finalAnswer writes the conclusion.
			fauxAssistantMessage("the cache survives logout for 30s"),
		]);

		await harness.session.prompt("how long does the cache survive logout?");

		const created = harness.eventsOfType("BeliefCreated");
		expect(created.length).toBeGreaterThan(0);

		const updated = harness.eventsOfType("BeliefUpdated");
		expect(updated.length).toBeGreaterThan(0);
		// The refine supersedes the prior (was proposed) and surfaces it as a `superseded` update.
		const superseded = updated.find((ev) => ev.status === "superseded");
		expect(superseded).toBeDefined();
		expect(superseded?.previousStatus).toBe("proposed");
	});

	it("emits a BeliefCreated for the routing belief so the native GUI registers it", async () => {
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

		// A routing belief must surface as a BeliefCreated so the GUI registers it in the
		// belief registry (otherwise it would only reach the GUI as a ProposalCreated and
		// never appear in the belief-set pane).
		const routingCreated = harness.eventsOfType("BeliefCreated").filter((ev) => ev.domain === "routing");
		expect(routingCreated.length).toBe(1);
		expect(routingCreated[0].beliefId).toBeGreaterThan(0);
		expect(routingCreated[0].statement).toBeTruthy();
		expect(routingCreated[0].evidenceRounds).toBeGreaterThan(0);
		// The `BeliefCreated` event schema carries no status field; the GUI defaults a
		// new belief to `proposed`, and since only the `open` status maps to the accent
		// color, a routing belief renders as default text (never as open).
	});
});
