import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { FormulationContent } from "../src/core/agent-session-domain.ts";
import { BeliefLoopController } from "../src/core/belief-loop/belief-loop-controller.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createRecheckFormulationToolDefinition,
	createSetFormulationToolDefinition,
} from "../src/core/tools/formulation.ts";

const CONTENT: FormulationContent = {
	interpretation: "I read this as an identity lifecycle problem",
	alternative: "a local bug in the retry guard",
	focus: "the PaymentIntent that survives across attempts",
	tension: "retries outlive the request but the identity does not",
	implication: "look at where identity is created and retained first",
};

/**
 * The controller's formulation API only needs the session manager (to replay and append domain
 * events) and the event sink, so it is driven here without standing up a whole `AgentSession`
 * and a faux provider. That keeps these tests about the formulation contract rather than about
 * the loop's turn machinery, which the suite tests cover.
 */
function createController(session = SessionManager.inMemory(process.cwd(), { id: "session-1" })) {
	const events: string[] = [];
	const host = {
		sessionManager: session,
		_emit: (event: { type: string }) => events.push(event.type),
		_fullActiveToolNames: [] as string[],
	} as unknown as AgentSession;
	const controller = new BeliefLoopController(host);
	return { controller, session, events, host };
}

function beginTask(controller: BeliefLoopController): void {
	controller.beginDomainTask("is the cache persistent?", "is the cache persistent?");
}

/** approve the reading every publication waits on, and close its review. */
function releasePublication(controller: BeliefLoopController): void {
	controller.approveFormulation();
	const correction = controller.pendingCorrections()[0];
	if (correction) controller.answerFormulationCorrection(correction.id, "I keep this reading.");
	for (const beliefId of controller.pendingApplicability()) {
		controller.recordApplicability([{ beliefId, decision: "carries-over", reason: "still the question" }]);
	}
	controller.setFocus([...controller.focusSet.beliefIds]);
}

describe("formulation publishing", () => {
	it("records a first version and numbers revisions from it", () => {
		const { controller, events } = createController();
		beginTask(controller);

		const first = controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });
		expect(first.outcome).toBe("recorded");
		if (first.outcome === "rejected") throw new Error(first.reason);
		expect(first.value.ordinal).toBe(1);
		expect(first.value.previousVersionId).toBeUndefined();
		expect(first.value.origin).toBe("propose");
		expect(controller.currentFormulation()?.id).toBe(first.value.id);

		// the first publication waits for the user, so the revision is only allowed after
		// the response, the applicability review of the scope it carried, and the focus review.
		expect(controller.awaitingFormulationResponse()).toBe(true);
		controller.approveFormulation();
		const correction = controller.pendingCorrections()[0];
		if (correction) controller.answerFormulationCorrection(correction.id, "I keep this reading.");
		for (const beliefId of controller.pendingApplicability()) {
			controller.recordApplicability([{ beliefId, decision: "carries-over", reason: "still the question" }]);
		}
		controller.setFocus(["belief-1"]);
		expect(controller.awaitingFormulationResponse()).toBe(false);
		expect(controller.revisionGate()).toBeUndefined();

		const revised = controller.publishFormulation({
			content: { ...CONTENT, focus: "where identity is retained between attempts" },
			reason: "the probe moved the focus to retention",
			sources: [],
		});
		expect(revised.outcome).toBe("recorded");
		if (revised.outcome === "rejected") throw new Error(revised.reason);
		expect(revised.value.ordinal).toBe(2);
		expect(revised.value.previousVersionId).toBe(first.value.id);
		// Every version stays readable; a revision adds to the history rather than replacing it.
		expect(controller.formulationHistory().map((version) => version.id)).toEqual([first.value.id, revised.value.id]);
		expect(events.filter((type) => type === "ProblemFormulationRecorded")).toHaveLength(2);
	});

	it("treats an identical resubmission as a no-op rather than a new version", () => {
		const { controller, events } = createController();
		beginTask(controller);
		const first = controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });
		if (first.outcome === "rejected") throw new Error(first.reason);

		// Same words, a different reason and no new evidence: the reading has not changed, and
		// deciding whether a paraphrase counts would take a comparison model the runtime refuses
		// to add. More evidence for an unchanged reading is likewise not a revision.
		const again = controller.publishFormulation({
			content: { ...CONTENT },
			reason: "restating the same reading with more confidence",
			sources: [],
		});
		expect(again.outcome).toBe("unchanged");
		if (again.outcome === "rejected") throw new Error(again.reason);
		expect(again.value.id).toBe(first.value.id);
		expect(controller.formulationHistory()).toHaveLength(1);
		expect(events.filter((type) => type === "ProblemFormulationRecorded")).toHaveLength(1);

		// Whitespace is normalized away before the comparison, so padding does not look like a change.
		const padded = controller.publishFormulation({
			content: { ...CONTENT, interpretation: `  ${CONTENT.interpretation}  ` },
			reason: "padded",
			sources: [],
		});
		expect(padded.outcome).toBe("unchanged");
		expect(controller.formulationHistory()).toHaveLength(1);
	});

	it("refuses to publish without the content a real understanding needs", () => {
		const { controller, events } = createController();
		beginTask(controller);

		for (const missing of ["interpretation", "focus", "implication"] as const) {
			const result = controller.publishFormulation({
				content: { ...CONTENT, [missing]: "   " },
				reason: "incomplete",
				sources: [],
			});
			expect(result.outcome).toBe("rejected");
			if (result.outcome !== "rejected") throw new Error("expected a rejection");
			expect(result.reason).toContain(missing);
		}
		expect(controller.publishFormulation({ content: CONTENT, reason: "  ", sources: [] }).outcome).toBe("rejected");
		expect(controller.formulationHistory()).toEqual([]);
		expect(events).not.toContain("ProblemFormulationRecorded");
	});

	it("publishes a version with no tension or alternative, and drops blank optionals", () => {
		const { controller } = createController();
		beginTask(controller);

		const result = controller.publishFormulation({
			content: {
				interpretation: "I read this as a latency budget problem",
				alternative: "   ",
				focus: "the request path between the gateway and the cache",
				implication: "measure the segments before changing any of them",
			},
			reason: "no rival reading is worth naming yet",
			sources: [],
		});

		expect(result.outcome).toBe("recorded");
		if (result.outcome === "rejected") throw new Error(result.reason);
		// A blank optional is absent, not an empty string masquerading as content.
		expect(result.value.content.alternative).toBeUndefined();
		expect(result.value.content.tension).toBeUndefined();
	});

	it("rejects a source that does not resolve to a record on this task", () => {
		const { controller } = createController();
		beginTask(controller);
		const task = controller.domainSnapshot.tasks.get(controller.currentTaskId!)!;
		const promptId = task.initialPrompt.id;

		expect(
			controller.publishFormulation({
				content: CONTENT,
				reason: "quoting the request itself",
				sources: [{ kind: "prompt", promptId }],
			}).outcome,
		).toBe("recorded");

		const dangling = controller.publishFormulation({
			content: { ...CONTENT, focus: "something else entirely" },
			reason: "citing a record that does not exist",
			sources: [{ kind: "execution", executionId: "execution-404" }],
		});
		expect(dangling.outcome).toBe("rejected");
		if (dangling.outcome !== "rejected") throw new Error("expected a rejection");
		expect(dangling.reason).toContain("does not resolve");
	});
});

describe("formulation deferral", () => {
	it("records what is missing, and a later publication answers it", () => {
		const { controller, events } = createController();
		beginTask(controller);

		const deferred = controller.deferFormulation({
			missingInformation: "whether the duplicate charge is per-attempt or per-request",
			reason: "one probe cannot separate the two readings",
			sources: [],
		});
		expect(deferred.outcome).toBe("recorded");
		if (deferred.outcome === "rejected") throw new Error(deferred.reason);
		expect(controller.formulationDeferral()?.missingInformation).toContain("per-attempt");
		// Deferring is not publishing: there is still no understanding to show.
		expect(controller.currentFormulation()).toBeUndefined();

		controller.publishFormulation({ content: CONTENT, reason: "enough evidence now", sources: [] });
		expect(controller.formulationDeferral()).toBeUndefined();
		expect(events.filter((type) => type === "ProblemFormulationDeferred")).toHaveLength(1);
	});

	it("refuses a deferral that does not say what is missing or why", () => {
		const { controller } = createController();
		beginTask(controller);

		expect(controller.deferFormulation({ missingInformation: "  ", reason: "why", sources: [] }).outcome).toBe(
			"rejected",
		);
		expect(controller.deferFormulation({ missingInformation: "what", reason: " ", sources: [] }).outcome).toBe(
			"rejected",
		);
		expect(controller.formulationDeferral()).toBeUndefined();
	});

	it("treats an identical restated deferral as a no-op", () => {
		const { controller, events } = createController();
		beginTask(controller);
		const input = { missingInformation: "the re-arm path", reason: "the probe could not isolate it", sources: [] };

		controller.deferFormulation(input);
		const again = controller.deferFormulation(input);
		expect(again.outcome).toBe("unchanged");
		expect(events.filter((type) => type === "ProblemFormulationDeferred")).toHaveLength(1);
	});

	it("answers each investigation round, even when the same information is still missing", () => {
		const { controller, events } = createController();
		beginTask(controller);
		const input = { missingInformation: "the re-arm path", reason: "the probe could not isolate it", sources: [] };

		const first = controller.deferFormulation(input);
		expect(first.outcome).toBe("recorded");
		if (first.outcome === "rejected") throw new Error(first.reason);
		// Nothing has run yet, so the deferral answers the investigation as it stands: none.
		expect(first.value.answeredThroughEpisodeOrdinal).toBe(0);

		// A round runs and the same information is still missing. The stored deferral has to name
		// *this* round: folding it into the earlier record would leave the required decision reading
		// as settled by a statement made before the new evidence existed.
		controller.ensureDomainPlan([], "probe the re-arm path");
		const second = controller.deferFormulation(input);
		expect(second.outcome).toBe("recorded");
		if (second.outcome === "rejected") throw new Error(second.reason);
		expect(second.value.answeredThroughEpisodeOrdinal).toBe(1);
		expect(controller.formulationDecisionOwed()).toBe(false);

		// Restating it again for the same round is still the no-op it always was.
		expect(controller.deferFormulation(input).outcome).toBe("unchanged");
		expect(events.filter((type) => type === "ProblemFormulationDeferred")).toHaveLength(2);
	});
});

describe("formulation corrections", () => {
	it("keeps a correction beside the version it objects to and resolves it by id", () => {
		const { controller } = createController();
		beginTask(controller);
		const published = controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });
		if (published.outcome === "rejected") throw new Error(published.reason);

		const correction = controller.submitFormulationCorrection("the guard is simply not re-armed", published.value.id);
		expect(correction?.targetVersionId).toBe(published.value.id);
		expect(controller.pendingCorrections().map((item) => item.id)).toEqual([correction!.id]);
		// The correction never rewrites the agent's published position.
		expect(controller.currentFormulation()?.content).toEqual(published.value.content);

		controller.resolveFormulationCorrection(correction!.id, "I will keep the identity reading and test re-arm");
		expect(controller.pendingCorrections()).toEqual([]);
		expect(controller.formulationHistory()[0].content).toEqual(published.value.content);
	});

	it("allows a correction before any version exists", () => {
		const { controller } = createController();
		beginTask(controller);

		const correction = controller.submitFormulationCorrection("you are looking at the wrong thing");
		expect(correction?.targetVersionId).toBeUndefined();
		expect(controller.pendingCorrections()).toHaveLength(1);
	});
});

describe("formulation state restoration", () => {
	it("restores the current version, the deferral, and pending corrections from the log", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const { controller } = createController(session);
		beginTask(controller);

		const first = controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });
		if (first.outcome === "rejected") throw new Error(first.reason);
		releasePublication(controller);
		const second = controller.publishFormulation({
			content: { ...CONTENT, implication: "check retention before touching the guard" },
			reason: "the first probe narrowed the direction",
			sources: [],
		});
		if (second.outcome === "rejected") throw new Error(second.reason);
		controller.deferFormulation({
			missingInformation: "whether the second charge is per-attempt",
			reason: "still two readings",
			sources: [],
		});
		const correction = controller.submitFormulationCorrection("the guard is not re-armed");

		// A fresh controller on the same branch is what a resume, a branch switch, or a
		// post-compaction reload looks like: everything above has to come back from the log.
		const restored = createController(session).controller;
		expect(restored.currentFormulation()?.id).toBe(second.value.id);
		expect(restored.formulationHistory().map((version) => version.ordinal)).toEqual([1, 2]);
		expect(restored.formulationDeferral()?.missingInformation).toContain("per-attempt");
		expect(restored.pendingCorrections().map((item) => item.id)).toEqual([correction!.id]);

		// And the restored controller keeps writing to the same history rather than starting over.
		const third = restored.publishFormulation({
			content: { ...CONTENT, interpretation: "I read this as a re-arm ordering problem" },
			reason: "the correction and the evidence agree",
			sources: [{ kind: "correction", correctionId: correction!.id }],
		});
		expect(third.outcome).toBe("recorded");
		if (third.outcome === "rejected") throw new Error(third.reason);
		expect(third.value.ordinal).toBe(3);
		expect(third.value.previousVersionId).toBe(second.value.id);
	});

	it("does not carry the previous task's understanding into a new task", () => {
		const { controller } = createController();
		beginTask(controller);
		controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });

		controller.closeDomainTask("completed");
		beginTask(controller);

		expect(controller.formulationHistory()).toEqual([]);
		expect(controller.currentFormulation()).toBeUndefined();
		expect(controller.formulationDeferral()).toBeUndefined();
		expect(controller.pendingCorrections()).toEqual([]);
	});
});

describe("propose ownership of the decision", () => {
	it("voids an experiment that was selected before the reading it is now under", () => {
		const { controller } = createController();
		beginTask(controller);

		const belief = controller.beliefSet.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		});
		// record the belief through the delta path, so the review's scope names a belief
		// the durable log knows about.
		controller.onBeliefDelta(
			{
				op: "propose",
				statement: "the cache survives logout",
				domain: "product",
				expectation: "a post-logout read keeps the value",
				evidenceRounds: 1,
			},
			belief,
			undefined,
		);
		controller.setFocus([belief.id]);
		controller.selectExperiment({ intent: "what the answer must report", beliefIds: [belief.id] });
		expect(controller.pendingExperiment).toBeDefined();

		const published = controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });
		expect(published.outcome).toBe("recorded");
		// The selection belonged to the previous reading, so it is gone rather than silently
		// re-scoped under the new one.
		expect(controller.pendingExperiment).toBeUndefined();
		releasePublication(controller);

		// Choosing again is what re-arms the dispatch, and the new choice is its own record.
		controller.selectExperiment({ intent: "what the answer must report", beliefIds: [belief.id] });
		expect(controller.pendingExperiment).toEqual({
			intent: "what the answer must report",
			beliefIds: [belief.id],
		});
	});

	it("replays the choice, the void, and the choice made in its place", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const { controller, events } = createController(session);
		beginTask(controller);

		const belief = controller.beliefSet.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		});
		// record the belief through the delta path, so the review's scope names a belief
		// the durable log knows about.
		controller.onBeliefDelta(
			{
				op: "propose",
				statement: "the cache survives logout",
				domain: "product",
				expectation: "a post-logout read keeps the value",
				evidenceRounds: 1,
			},
			belief,
			undefined,
		);
		controller.setFocus([belief.id]);
		controller.selectExperiment({ intent: "what the answer must report", beliefIds: [belief.id] });
		const published = controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });
		if (published.outcome === "rejected") throw new Error(published.reason);
		releasePublication(controller);
		controller.selectExperiment({ intent: "what the answer must report", beliefIds: [belief.id] });

		// The sequence lives in the log, not only in the field: a reader sees the choice, the
		// revision that voided it, and the choice made under the version that replaced it.
		const task = controller.domainSnapshot.tasks.get(controller.currentTaskId!)!;
		expect(task.episodes[0].experimentSelection).toEqual({
			intent: "what the answer must report",
			beliefIds: [belief.id],
			formulation: { kind: "version", versionId: published.value.id },
		});
		expect(events.filter((type) => type === "ExperimentSelected")).toHaveLength(2);
		expect(events.filter((type) => type === "ExperimentSelectionVoided")).toHaveLength(1);

		// A controller rebuilt on the same branch — a resume, or a branch switch — comes back
		// holding the same choice rather than an empty one.
		const restored = createController(session).controller;
		expect(restored.pendingExperiment).toEqual({
			intent: "what the answer must report",
			beliefIds: [belief.id],
		});
	});

	it("commits the choice to the plan at dispatch, leaving no selection pending", () => {
		const { controller } = createController();
		beginTask(controller);

		const belief = controller.beliefSet.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		});
		controller.onBeliefDelta(
			{
				op: "propose",
				statement: belief.statement,
				domain: belief.domain,
				expectation: belief.expectation,
				evidenceRounds: 1,
			},
			belief,
			undefined,
		);
		controller.setFocus([belief.id]);
		controller.selectExperiment({ intent: "what the answer must report", beliefIds: [belief.id] });
		controller.ensureDomainPlan([belief.id], "probe the retention path");

		const episode = controller.domainSnapshot.tasks.get(controller.currentTaskId!)!.episodes[0];
		// Dispatching does not leave the choice dangling: what remains is the plan, which records
		// the same beliefs as the decision that was actually made.
		expect(episode.experimentSelection).toBeUndefined();
		expect(episode.body.kind === "belief-loop" && episode.body.plan?.selectedToExplore).toEqual([belief.id]);
	});

	it("binds a cited belief to the delta that recorded its state, not to its later state", () => {
		const { controller } = createController();
		beginTask(controller);
		controller.selectDomainEpisodeBody("belief-loop");
		const belief = controller.beliefSet.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		});
		controller.onBeliefDelta(
			{
				op: "propose",
				statement: belief.statement,
				domain: belief.domain,
				expectation: belief.expectation,
				evidenceRounds: 1,
			},
			belief,
			undefined,
		);
		const deltas = controller.domainSnapshot.tasks.get(controller.currentTaskId!)!.episodes[0];
		if (deltas.body.kind !== "belief-loop") throw new Error("expected a belief-loop episode");
		const delta = deltas.body.beliefDeltas[0];

		const resolved = controller.resolveFormulationCitations([{ kind: "belief", beliefId: belief.id }]);
		expect(resolved).toEqual({
			sources: [{ kind: "belief", beliefId: belief.id, beliefDeltaId: delta.id }],
		});

		// A citation that names nothing is refused rather than stored as provenance.
		expect(controller.resolveFormulationCitations([{ kind: "belief", beliefId: "belief-404" }])).toEqual({
			error: "belief belief-404 has no recorded state on this task",
		});
		expect(controller.resolveFormulationCitations([{ kind: "correction", correctionId: "correction-404" }])).toEqual({
			error: "unknown correction correction-404",
		});

		// The task's own request is always available without the model carrying an id for it.
		const task = controller.domainSnapshot.tasks.get(controller.currentTaskId!)!;
		expect(controller.resolveFormulationCitations([{ kind: "prompt" }])).toEqual({
			sources: [{ kind: "prompt", promptId: task.initialPrompt.id }],
		});
	});

	it("does not treat a deferral as a standing exemption", () => {
		const { controller } = createController();
		beginTask(controller);
		expect(controller.formulationDecisionOwed()).toBe(false);

		controller.deferFormulation({
			missingInformation: "how long the value survives",
			reason: "unprobed",
			sources: [],
		});
		expect(controller.formulationDecisionOwed()).toBe(false);
		expect(controller.currentFormulation()).toBeUndefined();
	});
});

/**
 * The prompt contract is the only place the interpretation standard lives: the runtime checks
 * that the field is non-empty, so what keeps a goal restatement out of the record is the tool
 * asking for an organizing reading in the first place.
 */
describe("formulation prompt contract", () => {
	it("asks interpretation for an organizing reading rather than a summary of belief statuses", () => {
		const tool = createSetFormulationToolDefinition(() => ({ outcome: "recorded", text: "recorded" }));
		const guidelines = (tool.promptGuidelines ?? []).join(" ");
		// TypeBox schemas carry their field descriptions on the runtime object, not in the static type.
		const schema = JSON.stringify(tool.parameters);

		expect(schema).toContain("how they relate");
		expect(guidelines).toContain("summary of belief statuses");
		expect(guidelines).toContain("would hold unchanged under a different task");
	});

	it("keeps the grouping loose and the reading available before beliefs accumulate", () => {
		const tool = createSetFormulationToolDefinition(() => ({ outcome: "recorded", text: "recorded" }));
		const guidelines = (tool.promptGuidelines ?? []).join(" ");
		const schema = JSON.stringify(tool.parameters);

		// Organizing the beliefs must not read as a precondition: a reading is owed early too, and the
		// grouping is not an exhaustive classification the runtime checks.
		expect(schema).toContain("may overlap or leave a belief unplaced");
		expect(schema).toContain("few beliefs");
		expect(guidelines).toContain("few beliefs or none yet");
		expect(guidelines).toContain("overlap or leave something unplaced");
	});

	it("asks focus and implication for why it matters and which choice changes, not scope or a plan", () => {
		const tool = createSetFormulationToolDefinition(() => ({ outcome: "recorded", text: "recorded" }));
		const guidelines = (tool.promptGuidelines ?? []).join(" ");
		const schema = JSON.stringify(tool.parameters);

		// Both fields carry the reading's consequences: the reason these objects matter and the choice
		// that differs, not a file list and not steps. The tests the runtime cannot make live here.
		expect(schema).toContain("what this reading makes worth checking");
		expect(schema).toContain("a list of belief ids or file names");
		expect(schema).toContain("what you would check first, what can wait, or which standard the decision turns on");
		expect(schema).toContain("states no difference");
		expect(guidelines).toContain("in focus why these objects matter");

		// The boundaries the consolidation must not erase: a rival reading is optional, and an untested
		// empirical claim is a belief rather than formulation prose.
		expect(schema).toContain("Omit it when there is no real rival reading");
		expect(guidelines).toContain("record that claim as a belief");
	});

	it("asks recheck to name the round's finding and keeps the counterfactual on demand", () => {
		const tool = createRecheckFormulationToolDefinition(() => ({ verdict: "maintained" }));
		const guidelines = (tool.promptGuidelines ?? []).join(" ");
		const schema = JSON.stringify(tool.parameters);

		// A round is answered by what it found, not by the fact that a round ran; the counterfactual is
		// owed only when a real possibility exists, so an invented one is never required.
		expect(guidelines).toContain("Name the finding this round produced");
		expect(guidelines).toContain("only when you can name a real possibility");
		expect(schema).toContain("name the finding rather than the fact that a round happened");
		expect(schema).toContain("do not invent one");
	});
});

describe("frame projection per role", () => {
	it("keeps the reading for every role but sends propose's own obligations only to propose", () => {
		const { controller } = createController();
		beginTask(controller);
		const belief = controller.beliefSet.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		});
		controller.onBeliefDelta(
			{
				op: "propose",
				statement: "the cache survives logout",
				domain: "product",
				expectation: "a post-logout read keeps the value",
				evidenceRounds: 1,
			},
			belief,
			undefined,
		);
		controller.setFocus([belief.id]);
		controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });

		// propose owes the review, so it reads what the reading has not accounted for yet. The
		// publication time is bookkeeping the next decision does not turn on.
		const proposeFrame = controller.frameStateMessage();
		expect(proposeFrame).toContain("Beliefs this reading has not accounted for yet:");
		expect(proposeFrame).not.toContain("published 20");

		// A probing role gets the reading and the gate, never a list it may not act on.
		controller.loopState = { role: "execution", episodeHorizon: 2, leaseReportNudged: false };
		const executionFrame = controller.frameStateMessage();
		expect(executionFrame).toContain("<current_formulation>");
		expect(executionFrame).toContain("Interpretation:");
		expect(executionFrame).not.toContain("Beliefs this reading has not accounted for yet:");
	});
});

describe("approval against an unanswered objection", () => {
	it("refuses to approve a version while an objection against it is unanswered", () => {
		const { controller } = createController();
		beginTask(controller);
		const published = controller.publishFormulation({ content: CONTENT, reason: "first reading", sources: [] });
		expect(published.outcome).toBe("recorded");
		const correction = controller.submitFormulationCorrection("this is not the question")!;
		expect(controller.pendingCorrections().map((item) => item.id)).toEqual([correction.id]);

		// Approving records consent for a reading the user just objected to, with the answer still
		// outstanding. The version has to stay unapproved until the objection has been answered.
		const result = controller.approveFormulation();
		expect(result.outcome).toBe("rejected");
		expect(controller.formulationApproval()).toBeUndefined();
		expect(controller.pendingCorrections().map((item) => item.id)).toEqual([correction.id]);
	});
});
