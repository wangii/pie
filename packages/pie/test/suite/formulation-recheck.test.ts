import { type FauxResponseFactory, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { formulationRecheckOwed } from "../../src/core/agent-session-domain.ts";
import { BeliefLoopController } from "../../src/core/belief-loop/belief-loop-controller.ts";
import { statusOf } from "../../src/core/belief-set.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * M7.3: every distillation owes propose a result for the round it just reported on.
 *
 * The defect these tests close is that "reconsidered and kept the reading" used to be the same
 * absence as "never reconsidered": only a *changed* reading left a record, so a task that kept
 * accumulating evidence under a stable reading looked exactly like one that stopped checking. The
 * gate therefore rides the same decision propose already owes, and it binds both ways a round can
 * end — choose the next experiment, or conclude.
 *
 * Every test here runs a scripted task to a stopping point, because a round that owes a result is
 * not a state a real run can rest in: the loop keeps asking until propose answers or the task
 * pauses. What the refusal did is read off the steer the user saw and the order of the records.
 */
describe("per-round formulation recheck", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const reading = (interpretation: string) =>
		fauxToolCall("set_formulation", {
			interpretation,
			focus: "the observations the selected beliefs predict",
			implication: "which conclusion the answer must report turns on what the probe shows",
			reason: "the reading the round was chosen under",
		});
	const select = (beliefIds = ["belief-1"]) => [
		fauxToolCall("focus_beliefs", { beliefIds }),
		fauxToolCall("select_experiment", { intent: "which action to take", beliefIds }),
	];
	const propose = (statement = "the cache survives logout") =>
		fauxToolCall("declare_belief", {
			op: "propose",
			statement,
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		});
	const adjudicate = (op: string, evidence: string) =>
		fauxToolCall("declare_belief", { op, beliefId: "belief-1", evidence });
	const conclude = () => fauxToolCall("conclude", { result: "delivered", evidence: "observed" });
	const recheck = (reason = "the round's evidence fits the reading") =>
		fauxToolCall("recheck_formulation", { reason });

	const userText = (harness: Harness) =>
		harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");
	const toolText = (harness: Harness, toolName: string) =>
		harness.session.messages
			.filter((message) => message.role === "toolResult" && message.toolName === toolName)
			.map(getMessageText)
			.join("\n");
	const dispatchedPlans = (harness: Harness) =>
		harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0);
	const eventIndex = (harness: Harness, match: (event: { type: string }) => boolean) =>
		harness.events.findIndex((event) => match(event as { type: string }));
	/** The last task in the log. Read from the snapshot because a completed task still holds its
	 *  records while `getFormulationState()` — which answers for the *open* task — no longer does. */
	const lastTask = (harness: Harness) => [...harness.session.domainSnapshot.tasks.values()].at(-1)!;

	it("owes a result before the next experiment, and records one that keeps the reading", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		// What propose reads, captured as its turn starts right after the distillation: the block is
		// rebuilt on every role change, so this is the prompt the answering turn was actually given.
		let owedPrompt = "";
		let owedFrame = "";
		harness.session.subscribe((event) => {
			if (event.type !== "turn_end" || owedPrompt) return;
			const adjudicated = event.toolResults.some((result) =>
				/Applied (support|refute|refine|inconclusive)/.test(getMessageText(result)),
			);
			if (adjudicated) {
				owedPrompt = harness.session.agent.state.systemPrompt;
				owedFrame = harness.session.getFrameProjection();
			}
		});
		harness.setResponses([
			// focus before publishing; the selection moves to the turn after the reply.
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			// Choosing again without answering. The round is what owes the result, so the same gate
			// that guards concluding guards the next dispatch — this selection never dispatches.
			fauxAssistantMessage([...select()]),
			fauxAssistantMessage([recheck(), ...select()]),
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value again."),
			fauxAssistantMessage([adjudicate("support", "the post-logout read kept the value as predicted")]),
			fauxAssistantMessage([recheck("the second round fits the reading too"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);
		await harness.session.prompt("is the cache persistent?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		expect(userText(harness)).toContain("so say what it means for how you read this task");
		// Two experiments ran, and the second one only after the round had been answered.
		const plans = dispatchedPlans(harness);
		expect(plans).toHaveLength(2);
		const rechecks = harness.eventsOfType("FormulationRecheckRecorded");
		expect(rechecks).toHaveLength(2);
		expect(rechecks[0].recheck.verdict).toBe("maintained");
		expect(rechecks[0].recheck.episodeId).toBe(harness.eventsOfType("DistillationProduced")[0].episodeId);
		expect(rechecks[1].recheck.episodeId).not.toBe(rechecks[0].recheck.episodeId);
		expect(eventIndex(harness, (event) => event === rechecks[0])).toBeLessThan(
			eventIndex(harness, (event) => event === plans[1]),
		);

		// Keeping the reading publishes nothing: no new version, and so no revision to respond to.
		expect(harness.eventsOfType("ProblemFormulationRecorded")).toHaveLength(1);
		const task = lastTask(harness);
		expect(formulationRecheckOwed(task)).toBe(false);
		expect(task.formulationRecheck?.reason).toBe("the second round fits the reading too");
		expect(task.formulationReview?.focusReviewed).toBe(true);

		// The obligation is visible where the reading is read, not only in the steer that follows it,
		// and it is stated as the agent's own position rather than as evidence about the task.
		expect(owedFrame).toContain("<current_formulation>");
		expect(owedPrompt).toContain("you have not yet said what it means for this reading");
		expect(owedPrompt).toContain("recheck_formulation to keep it");
	});

	it("settles the round with the version a revision carried", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			// The round is answered by changing the reading rather than by keeping it.
			fauxAssistantMessage([reading("persistence is settled, the lifetime is the question"), conclude()]),
		]);
		await harness.session.prompt("is the cache persistent?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		const versions = harness.eventsOfType("ProblemFormulationRecorded");
		expect(versions.map((event) => event.version.ordinal)).toEqual([1, 2]);
		const rechecks = harness.eventsOfType("FormulationRecheckRecorded");
		expect(rechecks).toHaveLength(1);
		expect(rechecks[0].recheck.verdict).toBe("revised");
		expect(rechecks[0].recheck.versionId).toBe(versions[1].version.id);
		// The revision's own pause is untouched: the recheck answered the round, not the user.
		expect(harness.session.getFormulationState()?.review?.versionId).toBe(versions[1].version.id);

		// And the reading's projection now says what the agent made of the round. The verdict is the
		// state; the one-line basis stays in the record and the interface rather than being re-sent on
		// every request.
		const frame = harness.session.getFrameProjection();
		expect(frame).toContain("<current_formulation>");
		expect(frame).toContain("you reconsidered this reading and changed it");
		expect(frame).not.toContain("Your stated basis");
		expect(frame).not.toContain("the reading the round was chosen under");
		expect(harness.session.agent.state.systemPrompt).not.toContain(
			"you have not yet said what it means for this reading",
		);
	});

	it("accepts a deferral as the round's result without erasing the current reading", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			fauxAssistantMessage([
				fauxToolCall("defer_formulation", {
					missingInformation: "whether the value survives a restart, not just a logout",
					reason: "the round could not separate the two",
				}),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout, restart unknown"),
		]);
		await harness.session.prompt("can you still read it?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		const rechecks = harness.eventsOfType("FormulationRecheckRecorded");
		expect(rechecks).toHaveLength(1);
		expect(rechecks[0].recheck.verdict).toBe("deferred");
		const task = lastTask(harness);
		expect(formulationRecheckOwed(task)).toBe(false);
		expect(task.formulationDeferral?.missingInformation).toContain("survives a restart");
		expect(task.formulations.map((version) => version.ordinal)).toEqual([1]);
	});

	it("refuses a recheck that answers nothing, and says which nothing it is", async () => {
		// A round is waiting: the refusal is about that round having been answered already.
		const answered = await createHarness({});
		harnesses.push(answered);
		answered.setResponses([
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			fauxAssistantMessage([recheck(), recheck("kept it again"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);
		await answered.session.prompt("is the cache persistent?");
		answered.session.approveFormulation();
		await answered.session.waitForIdle();
		expect(toolText(answered, "recheck_formulation")).toContain("already been reconsidered");
		expect(answered.eventsOfType("FormulationRecheckRecorded")).toHaveLength(1);

		// No reading exists yet: the round cannot be answered by keeping a reading that is not there,
		// and the refusal says so rather than sending the model looking for a round to answer.
		const unformed = await createHarness({});
		harnesses.push(unformed);
		unformed.setResponses([
			fauxAssistantMessage([propose(), fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }), ...select()]),
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			fauxAssistantMessage([recheck(), reading("persistence across logout"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);
		await unformed.session.prompt("is the cache persistent?");
		expect(toolText(unformed, "recheck_formulation")).toContain("no current reading to reconsider yet");
		// Stating the reading in the same turn is what answers the round, so the record is the
		// publication's — the refused call recorded nothing.
		const recorded = unformed.eventsOfType("FormulationRecheckRecorded");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].recheck.verdict).toBe("revised");
	});

	it("restores the record with the branch, and starts the next task without one", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let afterDistillation = "";
		const frameProjections: string[] = [];
		const captureRequestFrame = (context: Parameters<FauxResponseFactory>[0]) => {
			const message = context.messages.at(-1);
			const text = message ? getMessageText(message) : "";
			if (text.includes("<current_formulation>")) frameProjections.push(text);
		};
		// Capture the leaf the run passed through right after the first distillation was recorded.
		// Subscribing to the domain event rather than to the turn means the entry holding the round
		// is already committed, so navigating back to it lands on a branch that owes the result.
		harness.session.subscribe((event) => {
			if (event.type !== "DistillationProduced" || afterDistillation) return;
			afterDistillation = harness.sessionManager.getLeafId()!;
		});
		const responses: Parameters<typeof harness.setResponses>[0] = [
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			fauxAssistantMessage([recheck(), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
			// A second task in the same session: its own reading, its own round, its own result.
			fauxAssistantMessage([
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("eviction under pressure"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- pressure evicted the value."),
			fauxAssistantMessage([adjudicate("support", "pressure evicted the value as predicted")]),
			fauxAssistantMessage([recheck("the second task's round fits its reading"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("eviction is pressure-driven"),
		];
		harness.setResponses(
			responses.map(
				(step) =>
					((context, options, state, model) => {
						captureRequestFrame(context);
						return typeof step === "function" ? step(context, options, state, model) : step;
					}) satisfies FauxResponseFactory,
			),
		);
		await harness.session.prompt("is the cache persistent?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		await harness.session.prompt("does pressure evict the cache?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		// Each provider request receives one current Frame, and a new task gets its own reading.
		for (const frame of frameProjections) {
			expect(frame.match(/<current_formulation>/g) ?? []).toHaveLength(1);
		}
		const firstTaskFrames = frameProjections.filter((frame) => frame.includes("persistence across logout"));
		expect(firstTaskFrames.length).toBeGreaterThan(1);
		const secondTaskStart = frameProjections.findIndex((frame) => frame.includes("eviction under pressure"));
		expect(secondTaskStart).toBeGreaterThan(0);
		for (const frame of frameProjections.slice(secondTaskStart)) {
			expect(frame).toContain("eviction under pressure");
			expect(frame).not.toContain("persistence across logout");
		}

		// The new task did not inherit the previous understanding, so it did not inherit the answer
		// to the previous round either: what is recorded is its own.
		const task = lastTask(harness);
		expect(task.formulationRecheck?.reason).toBe("the second task's round fits its reading");
		expect(task.formulations.map((version) => version.ordinal)).toEqual([1]);
		expect(task.formulationRecheck?.episodeId).toBe(harness.eventsOfType("DistillationProduced").at(-1)!.episodeId);

		// The branch that never answered the round is still owed one: the record belongs to the round
		// it answered, not to the task's latest state.
		await harness.session.navigateTree(afterDistillation);
		const switched = new BeliefLoopController(harness.session);
		expect(switched.formulationRecheck()).toBeUndefined();
		expect(switched.formulationRecheckOwed()).toBe(true);
	});

	it("leaves a fast-path round out of the gate", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("route_task", {
					decision: "fast-path",
					reason: "no unresolved uncertainty can change the action",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("report_outcome", { result: "checked the cache", evidence: "the read returned ok" }),
			]),
			fauxAssistantMessage("Reported the delivered result."),
			fauxAssistantMessage("Summary: checked the cache."),
			fauxAssistantMessage([reading("the cache question was closed by the run"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache is warm"),
		]);
		await harness.session.prompt("is the cache warm?");

		// A fast path settles through a distillation record of its own, but it has no distill role
		// and no adjudication to reconsider — so it never owes a per-round result.
		expect(harness.eventsOfType("DistillationProduced").length).toBeGreaterThan(0);
		expect(harness.eventsOfType("FormulationRecheckRecorded")).toHaveLength(0);
		expect(formulationRecheckOwed(lastTask(harness))).toBe(false);
	});

	it("keeps residual out of the belief record and out of the reading's basis", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		// An observation the belief set cannot explain, written where it belongs: the distill turn's
		// own text. It is not turned into a belief, and it is not the reason the reading was kept.
		const residual = "Residual: nothing yet explains why the second read missed the cache.";
		harness.setResponses([
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
				...select(),
			]),
			fauxAssistantMessage("Observed:\n- the first read hit the cache, the second did not."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "inconclusive",
					beliefId: "belief-1",
					evidence: "the reads disagreed, so the probe did not settle the belief",
				}),
				fauxText(residual),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage([recheck("the round's evidence fits the reading"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("persistence is unsettled"),
		]);
		await harness.session.prompt("is the cache persistent?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		// The residual became no belief, and no belief's evidence was drawn from it: an anomaly is a
		// reason to reconsider the reading, never support for a claim.
		expect(harness.session.beliefs.map(statusOf)).toEqual(["inconclusive"]);
		const belief = harness.session.beliefs[0]!;
		expect(belief.inconclusiveBy.map((entry) => entry.evidence).join("\n")).not.toContain("Residual");
		expect(belief.supportedBy).toEqual([]);
		// It stays in the transcript — one turn's text — and nowhere else.
		expect(harness.session.messages.filter((message) => getMessageText(message).includes(residual))).toHaveLength(1);
	});

	it("answers a user correction before the round it interrupted is reconsidered", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let correctionId = "";
		/**
		 * The correction lands in the window a real user would use: the round has distilled, the
		 * result is still owed, and the user says the agent is looking at the wrong thing. The
		 * submission is deferred by a microtask so the domain event that announced the round has
		 * finished being handled before the correction is recorded — submitting from inside the
		 * handler itself would re-enter the loop while it is still finishing the round.
		 */
		harness.session.subscribe((event) => {
			if (event.type !== "DistillationProduced" || correctionId) return;
			queueMicrotask(() => {
				correctionId = harness.session.submitFormulationCorrection("the question is about the re-arm path")!.id;
			});
		});
		/** Built at call time: the id is not known when the script is written. */
		const answerCorrection: FauxResponseFactory = () =>
			fauxAssistantMessage([
				fauxToolCall("answer_correction", {
					correctionId,
					response: "kept the reading; the correction names a different path",
				}),
			]);
		harness.setResponses([
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			// Closing the task while the correction stands unanswered: the loop puts the correction
			// first, so this is refused and propose is sent back for it.
			fauxAssistantMessage([conclude()]),
			answerCorrection,
			// Only now, with the correction answered, is the round reconsidered.
			fauxAssistantMessage([recheck(), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);
		await harness.session.prompt("is the cache persistent?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		expect(correctionId).not.toBe("");
		expect(userText(harness)).toContain("The user corrected your reading of this task");
		const task = lastTask(harness);
		expect(task.formulationCorrections.map((correction) => correction.status)).toEqual(["resolved"]);
		// The correction was answered first and the round reconsidered after it, in that order.
		expect(eventIndex(harness, (event) => event.type === "FormulationCorrectionResolved")).toBeLessThan(
			eventIndex(harness, (event) => event.type === "FormulationRecheckRecorded"),
		);
		expect(task.formulationRecheck?.verdict).toBe("maintained");
	});

	it("keeps the record across compaction, and reports the same state as the log", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([adjudicate("inconclusive", "the probe never reached a second attempt")]),
			fauxAssistantMessage([recheck("the round's evidence fits the reading"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);
		await harness.session.prompt("is the cache persistent?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		const before = lastTask(harness).formulationRecheck;

		await harness.session.compact();

		// Compaction summarizes the transcript, not the domain log: the record the panel and the RPC
		// snapshot read is the same one the round wrote.
		const after = lastTask(harness).formulationRecheck;
		expect(after).toEqual(before);
		expect(after?.verdict).toBe("maintained");
		expect(after?.reason).toBe("the round's evidence fits the reading");
		expect(harness.eventsOfType("FormulationRecheckRecorded")).toHaveLength(1);
	});

	it("does not treat a round whose adjudication is unsettled as a finished distillation", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				propose(),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				reading("persistence across logout"),
			]),
			(_context) => {
				return fauxAssistantMessage([
					fauxToolCall("review_applicability", {
						entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
					}),
					...select(),
				]);
			},
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			// Concluding without adjudicating the belief the round was dispatched for: the loop keeps
			// the role in distill rather than letting the round end.
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([adjudicate("support", "the post-logout read kept the value as predicted")]),
			fauxAssistantMessage([recheck(), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);
		await harness.session.prompt("is the cache persistent?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		// The refusal names the unadjudicated belief, and the record that follows covers the round
		// only once its adjudication is done — there is nothing to reconsider before that.
		expect(userText(harness)).toContain("remain unadjudicated");
		expect(harness.session.beliefs.map(statusOf)).toEqual(["supported"]);
		const distillations = harness.eventsOfType("DistillationProduced");
		expect(distillations).toHaveLength(1);
		expect(harness.eventsOfType("FormulationRecheckRecorded")[0].recheck.episodeId).toBe(distillations[0].episodeId);
		expect(harness.eventsOfType("TaskOutcomeRecorded")).toHaveLength(1);
	});
});
