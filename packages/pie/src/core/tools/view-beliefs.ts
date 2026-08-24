import { Type } from "typebox";
import { type BeliefSet, formatBeliefsForView } from "../belief-set.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The `view_beliefs` tool — the read-only surface onto the belief set.
 *
 * Beliefs are the *operated-on object* of the belief loop, so they are surfaced as
 * tool output (this tool) and as `declare_belief` echoes — never baked into the system
 * prompt. The model reads its current beliefs here whenever it needs them.
 *
 * The output is always the full set — the open frame, the open framing obligations, and
 * the settled (supported/refuted) beliefs — regardless of the calling role. It never
 * hides framing or routing beliefs: everything is shown so the caller can see every
 * belief the set holds.
 */

const viewBeliefsSchema = Type.Object({});

export function createViewBeliefsToolDefinition(
	beliefSet: BeliefSet,
): ToolDefinition<typeof viewBeliefsSchema, undefined> {
	return {
		name: "view_beliefs",
		label: "view beliefs",
		description:
			"Show your current beliefs: the open beliefs (the frame), the open framing obligations, and the settled beliefs.",
		promptSnippet: "View your current beliefs",
		promptGuidelines: [],
		parameters: viewBeliefsSchema,
		async execute(_toolCallId, _input, _signal, _onUpdate, _ctx) {
			// Always render the full set — the frame, the framing obligations, and the settled
			// beliefs — so no belief (framing or routing included) is hidden from any role.
			return {
				content: [{ type: "text", text: formatBeliefsForView(beliefSet.beliefs, "all") }],
				details: undefined,
			};
		},
	};
}
