import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import { statusOf } from "../src/core/belief-set.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/**
 * M7.2 — residual reaches propose as prose, not as a record.
 *
 * Distillation has two outputs: adjudication settles beliefs, and residual exposes what the
 * current belief set still cannot explain. The confirmed decisions keep the residual branch as
 * the distill turn's own text — no residual event, field, or snapshot entry — so the carrier is
 * the projected transcript and nothing else. This file pins the two things that decision still
 * has to deliver:
 *
 * - the residual reaches propose even when it changes no belief and creates no belief for itself;
 * - it arrives whole, as one block of observations, rather than split into per-observation
 *   entries the runtime would have to keep addressable.
 *
 * It also pins the cost of that decision: the residual itself is not replayable and not
 * branch-isolated. M7.3 makes the *round* visible instead — every round that reaches distill now
 * writes a distillation record, so a zero-belief-change round still owes a reconsideration — while
 * the residual text stays out of the log, which is the part decision 1 accepted.
 */

/** Propose's control calls: state the reading, declare the scope, choose the experiment. */
const select = (beliefIds: string[]) => [
	fauxToolCall("set_formulation", {
		interpretation: "I currently read this as a question about which behavior actually holds",
		focus: "the observations the selected beliefs predict",
		implication: "which conclusion the answer must report turns on what the probe shows",
		reason: "the reading the choice is made under",
	}),
	fauxToolCall("focus_beliefs", { beliefIds }),
	fauxToolCall("select_experiment", { intent: "which action to take", beliefIds }),
];

/**
 * A response that records the transcript the turn was actually sent and replies with `reply`.
 * The projection is what the provider receives, so asserting here is asserting what propose saw.
 */
function recordingTurn(seen: string[], reply: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory {
	return (context) => {
		seen.push(context.messages.map((message) => `${message.role}: ${getMessageText(message)}`).join("\n\n"));
		return reply;
	};
}

function inspectTool(): AgentTool {
	return {
		name: "inspect",
		label: "Inspect",
		description: "Return code and documentation observations",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "foo.ts:42 returns X; README claims Y" }],
			details: undefined,
		}),
	};
}

describe("distillation residual", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("residual reaches propose in the round that produced it", async () => {
		const harness = await createHarness({ tools: [inspectTool()] });
		harnesses.push(harness);
		const proposeSaw: string[] = [];
		// The residual observations are distinct and separately sourced; they must survive as the
		// one block distill wrote, not as items the projection or a record split apart.
		const residual = [
			"Residual: the current belief set does not explain these observations.",
			"- `foo.ts:42` returns X.",
			"- README claims Y.",
		].join("\n");

		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "implementation and documentation agree",
					domain: "code",
					expectation: "code and README describe the same result",
					evidenceRounds: 1,
				}),
				...select(["belief-1"]),
			]),
			fauxAssistantMessage([fauxToolCall("inspect", {})]),
			fauxAssistantMessage("Observed:\n- `foo.ts:42` returns X.\n- README claims Y."),
			// Adjudication first, then the residual — the two ordered steps distill works in. The
			// residual is written into the same turn as free text; it creates no belief of its own.
			fauxAssistantMessage([
				fauxText("The prediction did not hold, but the probe was too coarse to settle it."),
				fauxText(residual),
				fauxToolCall("declare_belief", {
					op: "inconclusive",
					beliefId: "belief-1",
					evidence: "the probe could not separate the two implementations",
				}),
			]),
			recordingTurn(
				proposeSaw,
				fauxAssistantMessage([
					// The round distilled, so propose owes it a reconsideration before concluding. The
					// recheck answers the round; the residual itself stays in the distill text above.
					fauxToolCall("recheck_formulation", { reason: "the reading still organizes what the round found" }),
					fauxToolCall("conclude", { result: "delivered", evidence: "observed" }),
				]),
			),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("The implementation and README disagree."),
		]);

		await harness.session.prompt("audit the behavior");

		expect(statusOf(harness.session.beliefs[0]!)).toBe("inconclusive");
		expect(proposeSaw).toHaveLength(1);
		const transcript = proposeSaw[0]!;
		expect(transcript).toContain("Residual: the current belief set does not explain these observations.");
		expect(transcript).toContain("`foo.ts:42` returns X.");
		expect(transcript).toContain("README claims Y.");
		// One block, not three entries: the observations stay inside the turn distill wrote.
		expect(transcript).toContain(residual);
	});

	test("a round that changes no belief still carries its residual to propose", async () => {
		const harness = await createHarness({ tools: [inspectTool()] });
		harnesses.push(harness);
		const laterRounds: string[] = [];
		const residual = "Residual: the second probe left the retry budget unexplained.";

		harness.setResponses([
			// Round 1: the experiment is too coarse, so the belief comes back inconclusive.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the retry budget is enforced per request",
					domain: "code",
					expectation: "a second attempt gets a fresh budget",
					evidenceRounds: 1,
				}),
				...select(["belief-1"]),
			]),
			fauxAssistantMessage([fauxToolCall("inspect", {})]),
			fauxAssistantMessage("Observed:\n- the first attempt consumed the budget."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "inconclusive",
					beliefId: "belief-1",
					evidence: "the probe never reached a second attempt",
				}),
			]),
			// Round 2: the distillation owes a reconsideration, and only then can an already
			// adjudicated belief be probed again with a better experiment.
			recordingTurn(
				laterRounds,
				fauxAssistantMessage([
					fauxToolCall("recheck_formulation", { reason: "the reading still organizes the retry budget question" }),
					...select(["belief-1"]),
				]),
			),
			fauxAssistantMessage([fauxToolCall("inspect", {})]),
			fauxAssistantMessage("Observed:\n- a second attempt reused the first attempt's budget."),
			// Prose only: this round changes no belief and creates none, so the residual has no
			// other carrier at all — exactly the round that used to leave no trace.
			fauxAssistantMessage(residual),
			recordingTurn(
				laterRounds,
				fauxAssistantMessage([
					fauxToolCall("recheck_formulation", {
						reason: "the reading still stands; the residual is not evidence against it",
					}),
					fauxToolCall("conclude", { result: "delivered", evidence: "observed" }),
				]),
			),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("The retry budget is not refreshed per attempt."),
		]);

		await harness.session.prompt("audit the retry budget");

		expect(statusOf(harness.session.beliefs[0]!)).toBe("inconclusive");
		// Two propose turns recorded: the one that chose the second experiment, and the one that
		// ran after the prose-only distillation. The second is the transcript under test.
		expect(laterRounds).toHaveLength(2);
		expect(laterRounds[1]).toContain(residual);

		// M7.3 makes the zero-delta round visible: it writes a distillation record of its own, so
		// the round can be owed a reconsideration even though it echoed no adjudication. What
		// decision 1 keeps is the residual itself — still prose, in no record.
		const distillations = harness.eventsOfType("DistillationProduced");
		expect(distillations).toHaveLength(2);
		expect(distillations[1].distillation.contents).toBe("");
		expect(distillations[1].distillation.outputs).toEqual([]);
		expect(harness.session.messages.filter((message) => getMessageText(message).includes(residual))).toHaveLength(1);
	});
});
