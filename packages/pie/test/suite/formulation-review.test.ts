import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	replayAgentSessionDomainEntries,
} from "../../src/core/agent-session-domain.ts";
import { BeliefLoopController } from "../../src/core/belief-loop/belief-loop-controller.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const reading = (interpretation: string) =>
	fauxToolCall("set_formulation", {
		interpretation,
		focus: "identity across components",
		implication: "test identity ownership, including counterexamples",
		reason: "the task scope changed",
	});
const conclude = () => fauxToolCall("conclude", { result: "reviewed", evidence: "recorded observations" });
const focus = () => fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] });
const select = () =>
	fauxToolCall("select_experiment", { beliefIds: ["belief-1"], intent: "whether to change identity ownership" });
const belief = () =>
	fauxToolCall("declare_belief", {
		op: "propose",
		statement: "identity survives a retry",
		domain: "code",
		expectation: "the same identity is reused",
		evidenceRounds: 1,
	});
const answer = (id: string) =>
	fauxToolCall("answer_correction", {
		correctionId: id,
		response: "I keep the revised reading and will test its counterexample.",
	});
const applicability = (beliefId: string, decision: string, reason: string) =>
	fauxToolCall("review_applicability", { entries: [{ beliefId, decision, reason }] });

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});
async function pausedHarness(): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([
		// focus before publishing; the second version waits for the user's reply to the first.
		fauxAssistantMessage([belief(), focus(), reading("local retry control")]),
		(context) => {
			const seen = context.messages.map((message) => getMessageText(message)).join("\n");
			const correctionId = /formulation-correction-[0-9a-f-]+/.exec(seen)?.[0] ?? "";
			return fauxAssistantMessage([answer(correctionId), reading("cross-component identity ownership")]);
		},
	]);
	await harness.session.prompt("Investigate identity ownership");
	await harness.session.prompt("keep the reading");
	return harness;
}

describe("revision response and focus review", () => {
	it("rejects v5 logs explicitly without rewriting them", () => {
		expect(AGENT_SESSION_DOMAIN_SCHEMA_VERSION).toBe(6);
		const legacy = SessionManager.inMemory();
		legacy.appendCustomEntry("pie.agent-session-domain-event", {
			schemaVersion: 5,
			event: { type: "TaskOpened", schemaVersion: 5, eventId: "event-old", timestamp: "2026-09-20T00:00:00Z" },
		});
		const before = JSON.stringify(legacy.getBranch());
		expect(() => replayAgentSessionDomainEntries(legacy.getSessionId(), legacy.getBranch())).toThrow(
			"schema v5, but this runtime requires v6",
		);
		expect(JSON.stringify(legacy.getBranch())).toBe(before);
	});

	it("does not treat a pre-revision queued message as a response, or drain it while waiting", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.session.subscribe((event) => {
			if (event.type === "ProblemFormulationRecorded" && event.version.ordinal === 1) {
				void h.session.followUp("queued before the revision existed");
			}
		});
		h.setResponses([fauxAssistantMessage([reading("local"), reading("system-wide")])]);
		await h.session.prompt("Investigate");
		expect(h.session.getFormulationState()?.review?.responseCorrectionId).toBeUndefined();
		expect(h.session.pendingMessageCount).toBe(1);
		expect(h.session.agent.hasQueuedMessages()).toBe(true);
		expect(h.eventsOfType("TaskClosed")).toHaveLength(0);
	});

	it("requires a fresh response for a further revision and keeps the wait branch-local", async () => {
		const h = await createHarness();
		harnesses.push(h);
		let firstLeaf = "";
		h.session.subscribe((event) => {
			if (event.type === "ProblemFormulationRecorded" && event.version.ordinal === 1) {
				firstLeaf = h.sessionManager.getLeafId()!;
			}
		});
		h.setResponses([
			fauxAssistantMessage([reading("local")]),
			(context) => {
				const seen = context.messages.map((message) => getMessageText(message)).join("\n");
				const replyId = /formulation-correction-[0-9a-f-]+/.exec(seen)?.[0] ?? "";
				return fauxAssistantMessage([answer(replyId), reading("system-wide")]);
			},
		]);
		await h.session.prompt("Investigate");
		await h.session.prompt("keep the reading");
		const correction = h.session.submitFormulationCorrection("use component ownership instead")!;
		h.setResponses([fauxAssistantMessage([reading("component ownership"), answer(correction.id), conclude()])]);
		await h.session.prompt("Process my correction");
		expect(h.session.getFormulationState()?.current?.ordinal).toBe(3);
		expect(h.session.getFormulationState()?.review?.responseCorrectionId).toBeUndefined();
		const latestLeaf = h.sessionManager.getLeafId()!;
		await h.session.navigateTree(firstLeaf);
		expect(h.session.getFormulationState()?.current?.ordinal).toBe(1);
		// every publication leaves a review, so at the first version's leaf the review is
		// that version's — not absent.
		expect(h.session.getFormulationState()?.review?.versionId).toBe(h.session.getFormulationState()?.current?.id);
		await h.session.navigateTree(latestLeaf);
		expect(h.session.getFormulationState()?.current?.ordinal).toBe(3);
		expect(h.session.getFormulationState()?.review?.responseCorrectionId).toBeUndefined();
		expect(h.eventsOfType("TaskClosed")).toHaveLength(0);
	});

	it("settles the run without closing the task, blocks the rest of the batch, and resumes only after response and review", async () => {
		const h = await pausedHarness();
		const taskId = h.session.taskId;
		const state = h.session.getFormulationState();
		expect(state?.review).toEqual({
			versionId: state?.current?.id,
			focusReviewed: false,
			scopedBeliefIds: ["belief-1"],
			introducedAtRevision: 1,
			applicability: [],
		});
		expect(state?.pendingApplicability).toEqual(["belief-1"]);
		expect(h.session.isIdle).toBe(true);
		expect(h.eventsOfType("TaskClosed")).toHaveLength(0);
		expect(h.eventsOfType("ExperimentSelected")).toHaveLength(0);
		expect(h.eventsOfType("TaskOutcomeRecorded")).toHaveLength(0);
		expect(h.eventsOfType("FocusDeclared")).toHaveLength(1);
		expect(h.session.messages.map(getMessageText).join("\n")).toContain("Execution is paused");

		// Submit the response against the actual displayed version. It is not an agent acknowledgement.
		const correction = h.session.submitFormulationCorrection("Keep this scope; test a counterexample");
		expect(correction).toBeDefined();
		h.setResponses([
			fauxAssistantMessage([focus(), select(), conclude()]), // unresolved response blocks all three
			fauxAssistantMessage([answer(correction!.id), select(), conclude()]), // answered, but focus is still stale
			fauxAssistantMessage([
				fauxToolCall("route_task", {
					decision: "fast-path",
					reason: "attempt to bypass review",
					suitabilityProbability: 1,
					successProbability: 1,
					estimatedSteps: 0,
					difficulty: "low",
				}),
			]),
			// The reading's own scope is accounted for before focus is reviewed; identical ids are a
			// valid review of both.
			fauxAssistantMessage([
				applicability("belief-1", "carries-over", "the retry identity is still the question"),
				focus(),
				select(),
			]),
			fauxAssistantMessage("Observed: identity survives a retry."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", { op: "support", beliefId: "belief-1", evidence: "same identity observed" }),
			]),
			// The round distilled under the revised reading, so propose owes it a reconsideration
			// before the task can close.
			fauxAssistantMessage([
				fauxToolCall("recheck_formulation", { reason: "the revised reading still organizes the round's evidence" }),
				conclude(),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("reviewed"),
		]);
		const trace: string[] = [];
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			trace.push(
				event.toolResults.map((result) => `${result.toolName}:${result.isError ? "error" : "ok"}`).join(",") ||
					getMessageText(event.message),
			);
			// Fail with a bounded trace rather than starving Vitest's timeout on an exhausted faux script.
			if (trace.length > 15) h.session.agent.abort();
		});
		await h.session.prompt("Continue with my response");
		unsubscribe();
		expect(trace.length, trace.join("\n")).toBeLessThanOrEqual(15);
		expect(trace).toContain("route_task:error");
		expect(h.eventsOfType("TaskOpened")).toHaveLength(1);
		const task = h.session.domainSnapshot.tasks.get(taskId!)!;
		expect(task.formulationReview?.focusReviewed).toBe(true);
		expect(task.status).toBe("completed");
		expect(h.eventsOfType("FocusDeclared")).toHaveLength(2);
		expect(h.eventsOfType("FocusDeclared")[1].formulation).toEqual({
			kind: "version",
			versionId: state?.current?.id,
		});
		expect(h.eventsOfType("ExperimentSelected")).toHaveLength(1);
		expect(h.eventsOfType("EpisodeBodySelected").some((event) => event.body === "fast-path")).toBe(false);
		expect(h.eventsOfType("ExperimentSelected")[0].selection.formulation).toEqual({
			kind: "version",
			versionId: state?.current?.id,
		});
		// The selection attempted before the reading's own scope was accounted for was refused with the
		// applicability gate, and the recorded decision covered the belief the revision was made about.
		expect(h.session.messages.map(getMessageText).join("\n")).toContain(
			"say what each belief already in scope means under this reading",
		);
		expect(task.formulationReview?.applicability).toEqual([
			{
				beliefId: "belief-1",
				decision: "carries-over",
				reason: "the retry identity is still the question",
			},
		]);
	});

	it("accepts a normal user reply, but neither an old target nor an extension message releases the version wait", async () => {
		const h = await pausedHarness();
		const history = h.session.getFormulationHistory();
		const oldCorrection = h.session.submitFormulationCorrection("about the old reading", history[0].id)!;
		expect(h.session.getFormulationState()?.review?.responseCorrectionId).toBeUndefined();
		h.setResponses([fauxAssistantMessage([conclude()])]);
		await expect(h.session.sendUserMessage("automated continuation")).rejects.toThrow("paused");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.getFormulationState()?.review?.responseCorrectionId).toBeUndefined();
		expect(h.eventsOfType("TaskClosed")).toHaveLength(0);

		let responseId = "";
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "FormulationCorrectionSubmitted") {
				responseId = event.correction.id;
				h.appendResponses([
					fauxAssistantMessage([
						answer(oldCorrection.id),
						answer(responseId),
						applicability("belief-1", "carries-over", "identity across components is still the question"),
						// Narrowing the focus to nothing does not drop the duty to say what the belief the
						// revision was made about still means.
						fauxToolCall("focus_beliefs", { beliefIds: [] }),
						conclude(),
					]),
					fauxAssistantMessage([conclude()]),
					fauxAssistantMessage("reviewed"),
				]);
			}
		});
		// Read the generated correction id from the domain event before the model's first response.
		h.setResponses([]);
		await h.session.prompt("I agree with the revised scope");
		unsubscribe();
		expect(responseId).not.toBe("");
		const task = [...h.session.domainSnapshot.tasks.values()][0];
		expect(task.formulationReview?.responseCorrectionId).toBe(responseId);
		expect(task.formulationCorrections.map((item) => item.status)).toEqual(["resolved", "resolved", "resolved"]);
		expect(task.formulationReview?.applicability.map((entry) => entry.beliefId)).toEqual(["belief-1"]);
		expect(task.formulationReview?.scopedBeliefIds).toEqual(["belief-1"]);
		expect(task.status).toBe("completed");
	});

	it("restores the version gate, beliefs and focus from the branch and refuses premature selection or outcome", async () => {
		const h = await pausedHarness();
		const restored = new BeliefLoopController(h.session);
		expect(restored.awaitingFormulationResponse()).toBe(true);
		const current = restored.currentFormulation()!;
		expect(
			restored.publishFormulation({
				content: current.content,
				reason: "same reading with more evidence",
				sources: [],
			}).outcome,
		).toBe("unchanged");
		expect(restored.formulationHistory()).toHaveLength(2);
		expect(restored.awaitingFormulationResponse()).toBe(true);
		expect(restored.focusSet.beliefIds).toEqual(["belief-1"]);
		expect(restored.beliefs.map((item) => item.id)).toEqual(["belief-1"]);
		expect(() => restored.selectExperiment({ intent: "test", beliefIds: ["belief-1"] })).toThrow("paused");
		expect(() => restored.recordOutcome({ result: "done", evidence: "test" })).toThrow("paused");
		const correction = restored.submitFormulationCorrection("confirmed")!;
		expect(() => restored.setFocus(["belief-1"])).toThrow("Answer");
		restored.answerFormulationCorrection(correction.id, "I will keep this reading");
		// The response is answered, but the reading's own scope has not been accounted for yet.
		expect(() => restored.selectExperiment({ intent: "test", beliefIds: ["belief-1"] })).toThrow(
			"review_applicability",
		);
		restored.recordApplicability([
			{
				beliefId: "belief-1",
				decision: "needs-revalidation",
				reason: "the old probe answered the previous reading, not this one",
			},
		]);
		expect(() => restored.selectExperiment({ intent: "test", beliefIds: ["belief-1"] })).toThrow(
			"Review the task focus",
		);
		expect(restored.unrevalidatedApplicability().map((entry) => entry.beliefId)).toEqual(["belief-1"]);
		restored.setFocus(["belief-1"]);
		restored.selectExperiment({ intent: "test a counterexample", beliefIds: ["belief-1"] });
		const replayed = new BeliefLoopController(h.session);
		expect(replayed.awaitingFormulationResponse()).toBe(false);
		expect(replayed.focusReviewOwed()).toBe(false);
		expect(replayed.pendingApplicability()).toEqual([]);
		expect(replayed.unrevalidatedApplicability().map((entry) => entry.beliefId)).toEqual(["belief-1"]);
		expect(replayed.pendingExperiment?.beliefIds).toEqual(["belief-1"]);
	});
});
