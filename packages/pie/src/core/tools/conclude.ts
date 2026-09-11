import { Type } from "typebox";
import type { TaskOutcome } from "../belief-set.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The `conclude` tool — the epistemic role's explicit "done" signal.
 *
 * The belief loop must not infer completion from the belief set's open count: a settled
 * belief does not mean the task is answered. Completion is the model's call, expressed by
 * invoking this tool, which hands the loop to the finalReport role to write the conclusion.
 *
 * Concluding also records the task outcome — the delivered result, the evidence that shows it
 * was delivered, and any remaining blocker — outside the BeliefSet. Epistemic sufficiency
 * ("the beliefs are settled") and task completion ("the user's request was delivered and
 * verified") are separate judgments: the same beliefs can answer an explanation request and
 * fail a change request that also required the change to be made and verified.
 */

const concludeSchema = Type.Object({
	result: Type.String({
		description:
			"What was actually delivered for the user's request: the answer, the change made, or the artifact produced. Not a restatement of the beliefs.",
	}),
	evidence: Type.String({
		description:
			"The observations or verification that show the delivery happened (for a change, the verification that it works), with source or command result.",
	}),
	blockers: Type.Optional(
		Type.String({
			description: "Known limitations or unresolved blockers that remain, if any.",
		}),
	),
});

export function createConcludeToolDefinition(
	onConclude?: (outcome: TaskOutcome) => void,
): ToolDefinition<typeof concludeSchema, undefined> {
	return {
		name: "conclude",
		label: "conclude",
		description:
			"Signal that the investigation is complete and record the delivered result and its verification before writing the final answer.",
		promptSnippet: "Conclude and record the delivered result",
		promptGuidelines: [
			"State what was delivered and the evidence that it was delivered, not just that beliefs are settled",
			"A change request is not complete until the change exists and its result was verified",
		],
		parameters: concludeSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			const outcome = parseTaskOutcome(input);
			onConclude?.(outcome);
			return {
				content: [{ type: "text", text: `Investigation concluded. Delivered: ${outcome.result}` }],
				details: undefined,
				// Terminate the tool-call loop: concluding is the terminal action, so the harness
				// hands off to the finalReport role on the next turn via a steering message.
				terminate: true,
			};
		},
	};
}

/**
 * The `report_outcome` tool — the fast-path execution role's explicit task-result submission.
 *
 * The fast path runs with no belief loop, so it cannot use `conclude`. Without an explicit
 * submission the harness would have to infer completion from the absence of tool errors, which
 * conflates "no tool failed" with "the user's request was delivered". This tool records the same
 * `TaskOutcome` (delivered result, evidence, blockers) that `conclude` records, so the fast path
 * and the belief loop share one result channel and the tool log stays operational evidence
 * rather than the completion judgment.
 */
export function createReportOutcomeToolDefinition(
	onOutcome?: (outcome: TaskOutcome) => void,
): ToolDefinition<typeof concludeSchema, undefined> {
	return {
		name: "report_outcome",
		label: "report outcome",
		description:
			"Record what the fast-path execution actually delivered for the user's request, the evidence that it was delivered, and any remaining blocker. A clean tool log alone is not completion.",
		promptSnippet: "Record the delivered result for the fast-path run",
		promptGuidelines: [
			"State what was delivered and how it was verified, not that no tool errored",
			"Include any blocker or limitation that remains",
		],
		parameters: concludeSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			const outcome = parseTaskOutcome(input);
			onOutcome?.(outcome);
			return {
				content: [{ type: "text", text: `Recorded delivered result: ${outcome.result}` }],
				details: undefined,
			};
		},
	};
}

function parseTaskOutcome(input: { result: string; evidence: string; blockers?: string }): TaskOutcome {
	const result = input.result.trim();
	const evidence = input.evidence.trim();
	if (!result) throw new Error("a non-empty `result` is required.");
	if (!evidence) throw new Error("non-empty `evidence` for the delivered result is required.");
	return { result, evidence, blockers: input.blockers?.trim() || undefined };
}
