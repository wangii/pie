import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskAdvancement } from "../../src/core/agent-session-domain.ts";
import { BeliefLoopController } from "../../src/core/belief-loop/belief-loop-controller.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * The current move: what the task is doing now, and what the agent said it would do next.
 *
 * The stage is a fact the loop wrote down — the cursor and the obligations the task still owns — and
 * the wording is the agent's own, carried on the experiment selection and copied onto the plan at
 * dispatch. These tests pin the split: a stage the agent cannot claim into existence, text that
 * survives the dispatch that spends the selection, and text that stops being shown once the reading
 * it was stated under has been replaced.
 */
describe("current move", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const reading = (interpretation: string) =>
		fauxToolCall("set_formulation", {
			interpretation,
			focus: "the path the reading attends to",
			implication: "which conclusion the answer reports turns on that path",
			reason: "the reading the round was chosen under",
		});
	const propose = () =>
		fauxToolCall("declare_belief", {
			op: "propose",
			statement: "the duplicate request comes from a retry",
			domain: "code",
			expectation: "the log shows one call and two requests",
			evidenceRounds: 1,
		});
	const focus = () => fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] });
	const select = (advancement?: Record<string, string>) =>
		fauxToolCall("select_experiment", {
			intent: "whether to change the caller or the retry policy",
			beliefIds: ["belief-1"],
			...(advancement ? { advancement } : {}),
		});
	const move = {
		action: "comparing the call chain with the request log",
		condition: "confirmation that the duplicate comes from a retry",
		next: "design idempotent handling; do not change code yet",
	};
	const adjudicate = (op: string, evidence: string) =>
		fauxToolCall("declare_belief", { op, beliefId: "belief-1", evidence });
	const recheck = (reason: string) => fauxToolCall("recheck_formulation", { reason });
	const conclude = () => fauxToolCall("conclude", { result: "delivered", evidence: "observed" });

	/** A sample of the projection taken as a turn starts, with the cursor that produced the stage. */
	interface Sample {
		readonly label: string;
		readonly cursor: string | undefined;
		readonly advancement: TaskAdvancement | undefined;
	}

	it("reports the runtime's stage with the agent's own words, and drops the next step once the result is in", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		const samples: Sample[] = [];
		const sample = (label: string, responses: FauxResponseFactory): FauxResponseFactory => {
			return (...args: Parameters<FauxResponseFactory>) => {
				samples.push({
					label,
					cursor: harness.session.domainSnapshot.cursor?.stage,
					advancement: harness.session.getTaskAdvancement(),
				});
				return responses(...args);
			};
		};
		harness.setResponses([
			// A rejected selection records nothing, so the "now" the panel would show is absent.
			sample("bad-selection", () =>
				fauxAssistantMessage([
					propose(),
					reading("local retry control"),
					focus(),
					select({ condition: "half a promise" }),
				]),
			),
			sample("selected", () => fauxAssistantMessage([select(move)])),
			sample("executing", () => fauxAssistantMessage("Observed: one call, two requests.")),
			sample("distilling", () =>
				fauxAssistantMessage([adjudicate("support", "the log shows one call and two requests")]),
			),
			sample("reconsidered", () => fauxAssistantMessage([recheck("the round fits the reading"), conclude()])),
			sample("concluded", () => fauxAssistantMessage([conclude()])),
			fauxAssistantMessage("the duplicate comes from a retry"),
		]);
		await harness.session.prompt("why are there duplicate requests?");

		// The rejected call is feedback, not a move: the panel still has no action to show, and the
		// selection that replaced it is sampled on the turn after it is made.
		expect(samples[0]?.advancement).toEqual({ stage: "preparing" });
		expect(samples[1]?.advancement).toEqual({ stage: "preparing" });
		// Dispatched: the same words now describe the round that is running.
		expect(samples[2]?.cursor).toBe("executing");
		expect(samples[2]?.advancement).toEqual({ stage: "running", ...move });
		// The evidence is in: the action still says what the round was about, but whether the
		// condition held is what the agent has not yet decided, so the promise half is not shown —
		// which stays true through the turn that answers the round.
		expect(samples[3]?.cursor).toBe("distilling");
		expect(samples[3]?.advancement).toEqual({ stage: "distilling", action: move.action });
		expect(samples[4]?.advancement).toEqual({ stage: "distilling", action: move.action });

		// The words are the agent's on the durable record too, next to the beliefs it chose. The
		// episode that closes the task gets a plan of its own, which probes nothing and states nothing.
		const plans = harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.plan.advancement).toEqual(move);
		expect(plans[0]?.plan.selectedToExplore).toEqual(["belief-1"]);
		// A closed task is not still doing anything.
		expect(harness.session.getTaskAdvancement()).toBeUndefined();
	});

	it("keeps the move on the branch that replays it", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let afterPlan = "";
		let afterDispatch = "";
		harness.session.subscribe((event) => {
			if (event.type === "PlanProduced" && event.plan.selectedToExplore.length > 0 && !afterPlan) {
				afterPlan = harness.sessionManager.getLeafId()!;
			}
			// The cursor is what announces execution; this run's execution turn calls no tool, so no
			// `ExecutionStarted` is ever written.
			if (event.type === "CursorChanged" && event.stage === "executing" && !afterDispatch) {
				afterDispatch = harness.sessionManager.getLeafId()!;
			}
		});
		harness.setResponses([
			fauxAssistantMessage([propose(), reading("local retry control"), focus(), select(move)]),
			fauxAssistantMessage("Observed: one call, two requests."),
			fauxAssistantMessage([adjudicate("support", "the log shows one call and two requests")]),
			fauxAssistantMessage([recheck("the round fits the reading"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the duplicate comes from a retry"),
		]);
		await harness.session.prompt("why are there duplicate requests?");

		// The state is replayed, not remembered: a controller built on the round's own leaf reports the
		// same move the panel showed while that round was running. The plan is recorded before the loop
		// announces execution, so the two leaves differ by exactly that announcement.
		await harness.session.navigateTree(afterDispatch);
		const dispatched = new BeliefLoopController(harness.session);
		expect(dispatched.taskAdvancement()).toEqual({ stage: "running", ...move });

		await harness.session.navigateTree(afterPlan);
		const planned = new BeliefLoopController(harness.session);
		expect(planned.taskAdvancement()).toEqual({ stage: "preparing", action: move.action });
	});

	it("stops showing words stated under a reading that has been replaced", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let correctionId = "";
		const seen: (TaskAdvancement | undefined)[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "turn_end") seen.push(harness.session.getTaskAdvancement());
			if (event.type !== "ProblemFormulationRecorded" || correctionId) return;
			queueMicrotask(() => {
				correctionId = harness.session.submitFormulationCorrection("the question is about the retry policy")!.id;
			});
		});
		harness.setResponses([
			fauxAssistantMessage([propose(), reading("local retry control"), focus(), select(move)]),
			fauxAssistantMessage("Observed: one call, two requests."),
			fauxAssistantMessage([adjudicate("support", "the log shows one call and two requests")]),
			// The round's result makes the agent revise: v2 replaces the reading the round was chosen
			// under, so the sentence it stated then stops describing this task.
			fauxAssistantMessage([reading("retry policy ownership across components")]),
			fauxAssistantMessage([
				fauxToolCall("answer_correction", { correctionId, response: "revised the reading; see v2" }),
				fauxToolCall("review_applicability", {
					entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still this question" }],
				}),
				focus(),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the duplicate comes from a retry"),
		]);
		await harness.session.prompt("why are there duplicate requests?");

		// The paused turn reports the wait instead of the round it stopped: the words stated under the
		// old reading are not repeated beside the new one.
		expect(seen.some((item) => item?.stage === "waiting" && item.action === undefined)).toBe(true);
		const advancement = harness.session.getTaskAdvancement();
		expect(advancement?.action).toBeUndefined();
		expect(harness.session.getFormulationHistory().map((version) => version.ordinal)).toEqual([1, 2]);
	});

	it("refuses half a promise", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				propose(),
				reading("local retry control"),
				focus(),
				select({ action: "checking the retry path", next: "change the caller" }),
			]),
			fauxAssistantMessage([select(move)]),
			fauxAssistantMessage("Observed: one call, two requests."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe did not separate the two paths")]),
			fauxAssistantMessage([recheck("the round fits the reading"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the retry path is the likely source"),
		]);
		await harness.session.prompt("why are there duplicate requests?");

		const rejected = harness.session.messages
			.filter((message) => message.role === "toolResult" && message.toolName === "select_experiment")
			.map(getMessageText)
			.join("\n");
		expect(rejected).toContain("must state `condition` and `next` together, or omit both");
		// The refusal is not a move: only the accepted selection reached the log.
		expect(harness.eventsOfType("ExperimentSelected")).toHaveLength(1);
		expect(harness.eventsOfType("PlanProduced")[0]?.plan.advancement).toEqual(move);
	});

	it.each([
		["English (unset)", undefined],
		["Chinese", "Chinese"],
		["Deutsch", "Deutsch"],
	] as const)("asks for the move's words in the configured belief language: %s", async (_label, beliefLang) => {
		// The stage words are the runtime's, but the action, condition, and next step are the agent's,
		// so they follow the same language setting as every belief and formulation, whatever string the
		// setting holds. Both records the panel reads carry that one sentence: the selection the agent
		// wrote, and the plan it is copied onto at dispatch.
		const harness = await createHarness(beliefLang ? { settings: { pie: { beliefLang } } } : {});
		harnesses.push(harness);
		let proposePrompt = "";
		harness.setResponses([
			() => {
				proposePrompt = getMessageText(harness.session.messages[0]);
				return fauxAssistantMessage([propose(), reading("local retry control"), focus(), select(move)]);
			},
			fauxAssistantMessage("Observed: one call, two requests."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe did not separate the two paths")]),
			fauxAssistantMessage([recheck("the round fits the reading"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the duplicate comes from a retry"),
		]);
		await harness.session.prompt("why are there duplicate requests?");

		expect(harness.settingsManager.getBeliefLang()).toBe(beliefLang ?? "English");
		expect(proposePrompt).toContain(`Write \`advancement\` in ${beliefLang ?? "English"}`);
		expect(proposePrompt).not.toContain("{beliefLang}");

		const selection = harness.eventsOfType("ExperimentSelected")[0]?.selection;
		const plans = harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.plan.advancement).toEqual(selection?.advancement);
	});
});
