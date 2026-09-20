import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * `answer_correction` — the propose role's response to a user correction.
 *
 * A correction is not an instruction to overwrite the current reading: the user objected to how
 * the agent understands the task, and propose is the only role that may say what it now makes of
 * it. Answering in words is therefore a separate decision from publishing a revision — the agent
 * may legitimately keep its reading and say why, or ask what is ambiguous — and the resolution is
 * addressed to one correction id, so a response written for an older correction can never be
 * recorded as the answer to one that arrived while it was being handled.
 *
 * Publishing a revision is a separate call (`set_formulation`, citing the correction). The
 * controller links the two when the citing version already exists, and the version's own source
 * list records the association either way.
 */

const answerCorrectionSchema = Type.Object({
	correctionId: Type.String({
		description: "The correction you are answering, by the id you were shown.",
	}),
	response: Type.String({
		description:
			"How you are responding, in one or two sentences: what you changed, why you are keeping your reading, or what you need the user to clarify. Not an acknowledgement — the user must be able to see what happened to their correction.",
	}),
});

export type AnswerCorrectionInput = Static<typeof answerCorrectionSchema>;

export function createAnswerCorrectionToolDefinition(
	onAnswer: (
		input: AnswerCorrectionInput,
	) =>
		| { readonly outcome: "recorded"; readonly text: string }
		| { readonly outcome: "rejected"; readonly reason: string },
): ToolDefinition<typeof answerCorrectionSchema, undefined> {
	return {
		name: "answer_correction",
		label: "answer correction",
		description:
			"Answer a correction the user made to your reading of this task, saying how you are responding to it. Publishing a revised reading with set_formulation (citing the correction) and answering with this tool are separate: revise first if you are revising, then answer and say so.",
		promptSnippet: "Answer a user correction to your reading of the task",
		promptGuidelines: [
			"Answer every pending correction; until each has an answer you may not dispatch another experiment or conclude",
			"State the substance of the response — a revision you published, the reason you are keeping your reading, or the ambiguity you need clarified",
			"A user constraint must be honoured; if it conflicts with the evidence, say so explicitly rather than ignoring it",
			"Write the response in {beliefLang}",
		],
		parameters: answerCorrectionSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			const result = onAnswer(input);
			if (result.outcome === "rejected") throw new Error(`Correction response rejected: ${result.reason}`);
			return { content: [{ type: "text", text: result.text }], details: undefined };
		},
	};
}
