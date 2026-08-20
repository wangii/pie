import { Type } from "typebox";
import { type BeliefSet, formatBeliefsForView } from "../belief-set.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The `view_beliefs` tool — the epistemic role's read-only surface onto the belief set.
 *
 * Beliefs are the *operated-on object* of the epistemic role, so they are surfaced as
 * tool output (this tool) and as `declare_belief` echoes — never baked into the system
 * prompt. The model reads its current beliefs here whenever it needs them.
 */

const viewBeliefsSchema = Type.Object({});

export function createViewBeliefsToolDefinition(
	beliefSet: BeliefSet,
	currentRole: () => "propose" | "distill" | "execution" | "finalAnswer" = () => "propose",
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
			// The execution role only needs the frame it is probing (statement + expectation);
			// the epistemic role sees the full set. Scoping the output keeps the probe role from
			// being handed framing obligations and settled history it must not act on.
			const scope = currentRole() === "execution" ? "frame" : "all";
			return {
				content: [{ type: "text", text: formatBeliefsForView(beliefSet.beliefs, scope) }],
				details: undefined,
			};
		},
	};
}
