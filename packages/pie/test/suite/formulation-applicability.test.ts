import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BeliefLoopController } from "../../src/core/belief-loop/belief-loop-controller.ts";
import { statusOf } from "../../src/core/belief-set.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * Per-belief applicability under a revision: a reframe changes what the task asks, not what was
 * observed, so the old conclusions keep their evidence and status — but the task has to say what
 * each still means before it may select, route, or conclude, and a conclusion the new reading has
 * not tested cannot be reported as settled.
 */
describe("revision applicability review", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const reading = (interpretation: string) =>
		fauxToolCall("set_formulation", {
			interpretation,
			focus: "the path the reading attends to",
			implication: "which conclusion the answer reports turns on that path",
			reason: "the task scope changed",
		});
	const conclude = () => fauxToolCall("conclude", { result: "delivered", evidence: "observed" });
	const focus = (beliefIds: string[] = ["belief-1"]) => fauxToolCall("focus_beliefs", { beliefIds });
	const select = (beliefIds: string[] = ["belief-1"]) =>
		fauxToolCall("select_experiment", { beliefIds, intent: "whether identity is reused" });
	const belief = () =>
		fauxToolCall("declare_belief", {
			op: "propose",
			statement: "identity survives a retry",
			domain: "code",
			expectation: "the same identity is reused",
			evidenceRounds: 1,
		});
	const support = () =>
		fauxToolCall("declare_belief", {
			op: "support",
			beliefId: "belief-1",
			evidence: "the retry reused the same identity",
		});
	const applicability = (decision: string, reason: string) =>
		applicabilityEntries([{ beliefId: "belief-1", decision, reason }]);
	const applicabilityEntries = (entries: Array<{ beliefId: string; decision: string; reason: string }>) =>
		fauxToolCall("review_applicability", { entries });
	const secondBelief = () =>
		fauxToolCall("declare_belief", {
			op: "propose",
			statement: "the other path names its target explicitly",
			domain: "code",
			expectation: "the target is named, not inferred",
			evidenceRounds: 1,
		});
	const answer = (id: string) =>
		fauxToolCall("answer_correction", { correctionId: id, response: "I keep this reading and will re-probe it." });

	const text = (h: Harness, role: "user" | "assistant") =>
		h.session.messages
			.filter((message) => message.role === role)
			.map(getMessageText)
			.join("\n");

	/** A task paused on a revision: belief-1 is supported under v1, and v2 has been published. */
	async function revisedHarness(withSecondBelief = false): Promise<Harness> {
		const h = await createHarness();
		harnesses.push(h);
		const scope = withSecondBelief ? ["belief-1", "belief-2"] : ["belief-1"];
		h.setResponses([
			fauxAssistantMessage([
				belief(),
				...(withSecondBelief ? [secondBelief()] : []),
				focus(scope),
				select(),
				reading("local retry control"),
			]),
			fauxAssistantMessage("Observed: the retry reused the same identity"),
			fauxAssistantMessage([support()]),
			fauxAssistantMessage([reading("cross-component identity ownership")]),
		]);
		await h.session.prompt("Investigate identity ownership");
		expect(h.session.getFormulationState()?.review?.versionId).toBeDefined();
		return h;
	}

	it("accounts for the previous scope even when the revision narrows the focus to nothing", async () => {
		const h = await revisedHarness();
		const taskId = h.session.taskId!;
		const correction = h.session.submitFormulationCorrection("the new reading is about another path")!;
		h.setResponses([
			// The response is answered first, so the applicability review is no longer blocked by the
			// wait; then the focus narrows to nothing.
			fauxAssistantMessage([
				answer(correction.id),
				applicability("not-applicable", "this reading asks about a different path"),
				focus([]),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("identity is unchanged on the path this reading asks about"),
		]);
		await h.session.prompt("Continue with my response");

		const task = h.session.domainSnapshot.tasks.get(taskId)!;
		// The narrowed focus is what the task acts on now, and the belief it dropped still had to be
		// accounted for: the review keeps the scope it was published against.
		expect(task.focus).toEqual([]);
		expect(task.formulationReview?.scopedBeliefIds).toEqual(["belief-1"]);
		expect(task.formulationReview?.applicability).toEqual([
			{ beliefId: "belief-1", decision: "not-applicable", reason: "this reading asks about a different path" },
		]);
		// The belief keeps its evidence and status: nothing about what was observed changed.
		expect(h.session.beliefs.map(statusOf)).toEqual(["supported"]);
		// It is not reported as a finding of the task that no longer asks about it.
		expect(text(h, "user")).toContain("Out of scope under the current reading");
		expect(text(h, "user")).not.toContain("Supported beliefs:");
		expect(task.status).toBe("completed");
	});

	it("refuses to report a conclusion the new reading has not tested, and clears it when refined", async () => {
		const h = await revisedHarness();
		const taskId = h.session.taskId!;
		const correction = h.session.submitFormulationCorrection("test the cross-component case")!;
		h.setResponses([
			fauxAssistantMessage([
				answer(correction.id),
				applicability("needs-revalidation", "the probe answered the previous reading"),
			]),
			fauxAssistantMessage([conclude()]), // focus has not been reviewed yet
			fauxAssistantMessage([focus()]),
			fauxAssistantMessage([conclude()]), // nothing has been probed under this reading
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "refine",
					beliefId: "belief-1",
					statement: "identity is reused across component boundaries",
					expectation: "both components observe the same identity",
					evidence: "the end-to-end path reported one identity",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("identity is reused across the tested boundary"),
		]);
		await h.session.prompt("Continue with my response");

		const task = h.session.domainSnapshot.tasks.get(taskId)!;
		// The conclusion was refused while the belief stood on the old reading, and said why.
		expect(text(h, "user")).toContain("may not report it as settled");
		// Refining it into the claim this reading asks about answered the duty, and the record says
		// which delta did so. The old belief keeps its own evidence and is superseded, not re-judged.
		const entry = task.formulationReview?.applicability[0];
		expect(entry?.decision).toBe("needs-revalidation");
		expect(entry?.revalidatedByDeltaId).toBeDefined();
		expect(h.session.beliefs.map(statusOf)).toEqual(["superseded", "supported"]);
		expect(text(h, "assistant")).toContain("identity is reused across the tested boundary");
		expect(task.status).toBe("completed");
	});

	it("requires an inherited belief to be accounted for when the reading puts it back in scope", async () => {
		const h = await createHarness();
		harnesses.push(h);
		// Task A settles belief-1 and completes.
		h.setResponses([
			fauxAssistantMessage([belief(), focus(), select(), reading("local retry control")]),
			fauxAssistantMessage("Observed: the retry reused the same identity"),
			fauxAssistantMessage([support()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("identity survives a retry"),
		]);
		await h.session.prompt("Is identity preserved across a retry?");
		expect(h.session.beliefs.map(statusOf)).toEqual(["supported"]);

		// Task B has its own belief and its own reading, which is then revised.
		h.setResponses([
			fauxAssistantMessage([secondBelief(), focus(["belief-2"]), reading("the other path names its target")]),
			fauxAssistantMessage([reading("both paths must name their target"), select(["belief-2"]), conclude()]),
		]);
		await h.session.prompt("Does the other path name its target?");
		const correction = h.session.submitFormulationCorrection("identity matters too")!;
		const pendingByTurn: string[][] = [];
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			pendingByTurn.push([...(h.session.getFormulationState()?.pendingApplicability ?? ["no-open-task"])]);
		});
		h.setResponses([
			fauxAssistantMessage([
				answer(correction.id),
				applicabilityEntries([{ beliefId: "belief-2", decision: "carries-over", reason: "still this question" }]),
				focus(["belief-2"]),
			]),
			// belief-1 was settled in an earlier task and was never part of this revision's scope.
			fauxAssistantMessage([focus(["belief-1", "belief-2"])]),
			fauxAssistantMessage([
				applicabilityEntries([{ beliefId: "belief-1", decision: "carries-over", reason: "still relevant here" }]),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the target is named",
				}),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("both paths name their target"),
		]);
		await h.session.prompt("Continue with my response");
		unsubscribe();

		// Inherited history has no place in this task's own belief order, so it counts as pre-existing:
		// putting it back in scope owes a statement about what it means under this reading.
		expect(pendingByTurn[0]).toEqual([]);
		expect(pendingByTurn[1]).toEqual(["belief-1"]);
		const task = [...h.session.domainSnapshot.tasks.values()].at(-1)!;
		expect(task.formulationReview?.applicability.map((entry) => entry.beliefId)).toEqual(["belief-2", "belief-1"]);
		// Neither belief's evidence or status changed: applicability records a standing, not a verdict.
		expect(h.session.beliefs.map(statusOf)).toEqual(["supported", "supported"]);
		expect(task.status).toBe("completed");
	});

	it("requires a belief the review never classified once it enters the focus", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.setResponses([
			// belief-2 exists before the revision but is not in the focus the revision was made under.
			fauxAssistantMessage([belief(), secondBelief(), focus(), select(), reading("local retry control")]),
			fauxAssistantMessage("Observed: the retry reused the same identity"),
			fauxAssistantMessage([support()]),
			fauxAssistantMessage([reading("cross-component identity ownership")]),
		]);
		await h.session.prompt("Investigate identity ownership");
		const correction = h.session.submitFormulationCorrection("also consider the other path")!;
		const pendingByTurn: string[][] = [];
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			pendingByTurn.push([...(h.session.getFormulationState()?.pendingApplicability ?? ["no-open-task"])]);
		});
		h.setResponses([
			fauxAssistantMessage([
				answer(correction.id),
				applicability("carries-over", "still the question this reading asks"),
				focus(),
			]),
			fauxAssistantMessage([focus(["belief-1", "belief-2"])]),
			fauxAssistantMessage([
				applicabilityEntries([{ beliefId: "belief-2", decision: "carries-over", reason: "in scope now" }]),
				// belief-2 is still unadjudicated, so the conclusion would be refused until it is settled.
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the target is named",
				}),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("both paths are covered by this reading"),
		]);
		await h.session.prompt("Continue with my response");
		unsubscribe();

		// The review's scope was [belief-1]; belief-2 was never classified, so putting it in focus after
		// the review closed still owes a statement about what it means under this reading.
		expect(pendingByTurn[0]).toEqual([]);
		expect(pendingByTurn[1]).toEqual(["belief-2"]);
		const task = [...h.session.domainSnapshot.tasks.values()][0]!;
		expect(task.formulationReview?.applicability.map((entry) => entry.beliefId)).toEqual(["belief-1", "belief-2"]);
		expect(task.status).toBe("completed");
	});

	it("re-opens the duty when a belief it put out of scope is put back in focus", async () => {
		const h = await revisedHarness();
		const correction = h.session.submitFormulationCorrection("the new reading is about another path")!;
		const pendingByTurn: string[][] = [];
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			pendingByTurn.push([...(h.session.getFormulationState()?.pendingApplicability ?? ["no-open-task"])]);
		});
		h.setResponses([
			// Turn 1 puts belief-1 out of scope and empties the focus; turn 2 brings it back, which makes
			// the earlier `not-applicable` a statement about a scope the task no longer holds.
			fauxAssistantMessage([
				answer(correction.id),
				applicability("not-applicable", "this reading asks about another path"),
				focus([]),
			]),
			fauxAssistantMessage([focus()]),
			fauxAssistantMessage([applicability("carries-over", "it is in scope again under this reading")]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("identity is reused on the path this reading asks about"),
		]);
		await h.session.prompt("Continue with my response");
		unsubscribe();

		expect(pendingByTurn[0]).toEqual([]);
		expect(pendingByTurn[1]).toEqual(["belief-1"]);
		// The fresh decision replaced the stale one, and the task was able to finish on it.
		const task = [...h.session.domainSnapshot.tasks.values()][0]!;
		expect(task.formulationReview?.applicability.map((entry) => entry.decision)).toEqual(["carries-over"]);
		expect(task.status).toBe("completed");
	});

	it("does not let a delta on another belief answer the duty, and keeps the decisions branch-local", async () => {
		const h = await revisedHarness(true);
		const taskId = h.session.taskId!;
		const revisionLeaf = h.sessionManager.getLeafId()!;
		const correction = h.session.submitFormulationCorrection("test both paths")!;
		const owed: string[][] = [];
		let leafAfterDecisions = "";
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			owed.push([...(h.session.getFormulationState()?.unrevalidated ?? ["no-open-task"])]);
			if (owed.length === 1) leafAfterDecisions = h.sessionManager.getLeafId()!;
		});
		h.setResponses([
			fauxAssistantMessage([
				answer(correction.id),
				applicabilityEntries([
					{
						beliefId: "belief-1",
						decision: "needs-revalidation",
						reason: "the probe answered the previous reading",
					},
					{ beliefId: "belief-2", decision: "carries-over", reason: "still the question this reading asks" },
				]),
			]),
			fauxAssistantMessage([focus(["belief-1", "belief-2"])]),
			// An unrelated belief is adjudicated: that must not answer belief-1's duty.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the target is named on the other path",
				}),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "refine",
					beliefId: "belief-1",
					statement: "identity is reused across component boundaries",
					expectation: "both components observe the same identity",
					evidence: "the end-to-end path reported one identity",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("identity is reused across the tested boundary"),
		]);
		await h.session.prompt("Continue with my response");
		unsubscribe();
		const latestLeaf = h.sessionManager.getLeafId()!;

		const task = h.session.domainSnapshot.tasks.get(taskId)!;
		// Turn 1 accounts for both beliefs, turn 2 reviews focus, turn 3 adjudicates belief-2: after it
		// the duty on belief-1 is still open, which is the case a path-insensitive check would miss.
		expect(owed[2]).toEqual(["belief-1"]);
		expect(text(h, "user")).toContain("may not report it as settled");
		const entries = task.formulationReview?.applicability ?? [];
		expect(entries.map((entry) => entry.beliefId)).toEqual(["belief-1", "belief-2"]);
		expect(entries[0]?.revalidatedByDeltaId).toBeDefined();
		expect(entries[1]?.revalidatedByDeltaId).toBeUndefined();
		expect(task.status).toBe("completed");

		// The decisions are log state: the branch that holds them replays them exactly, and going back
		// to the revision restores the duty as owed rather than answered.
		expect(owed[0]).toEqual(["belief-1"]);
		await h.session.navigateTree(leafAfterDecisions);
		const decided = new BeliefLoopController(h.session);
		expect(decided.pendingApplicability()).toEqual([]);
		expect(decided.unrevalidatedApplicability().map((entry) => entry.beliefId)).toEqual(["belief-1"]);
		await h.session.navigateTree(revisionLeaf);
		const before = new BeliefLoopController(h.session);
		expect(before.pendingApplicability()).toEqual(["belief-1", "belief-2"]);
		expect(before.unrevalidatedApplicability()).toEqual([]);
		await h.session.navigateTree(latestLeaf);
		// The task ended, so there is no current reading to report — the decisions live on the branch
		// the task was completed on, not in the runtime.
		expect(h.session.getFormulationState()).toBeUndefined();
	});
});
