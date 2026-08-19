import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The `conclude` tool — the epistemic role's explicit "done" signal.
 *
 * The belief loop must not infer completion from the belief set's open count: a settled
 * belief does not mean the task is answered. Completion is the model's call, expressed by
 * invoking this tool, which hands the loop to the finalAnswer role to write the conclusion.
 */

const concludeSchema = Type.Object({});

export function createConcludeToolDefinition(): ToolDefinition<typeof concludeSchema, undefined> {
	return {
		name: "conclude",
		label: "conclude",
		description: "Signal that the investigation is complete and you are ready to write the final answer.",
		promptSnippet: "Conclude the investigation",
		promptGuidelines: [],
		parameters: concludeSchema,
		async execute(_toolCallId, _input, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: "Investigation concluded." }],
				details: undefined,
				// Terminate the tool-call loop: concluding is the terminal action, so the harness
				// hands off to the finalAnswer role on the next turn via a steering message.
				terminate: true,
			};
		},
	};
}
