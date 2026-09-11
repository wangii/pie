import { Type } from "typebox";
import { type BeliefSet, type ExperimentSelection, type FocusSet, formatBeliefsForView } from "../belief-set.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The `view_beliefs` tool — the read-only surface onto the belief set.
 *
 * Beliefs are the *operated-on object* of the belief loop, so they are surfaced as
 * tool output (this tool) and as `declare_belief` echoes — never baked into the system
 * prompt. The model reads its current beliefs here whenever it needs them.
 *
 * The output is always the full set of open and adjudicated world beliefs. Routing and
 * workflow control metadata are deliberately not represented as beliefs.
 *
 * The task focus slice and any pending experiment selection are reported *alongside* the
 * beliefs as control metadata, never as beliefs. Belief records are retained across tasks,
 * so the listing is history: without the focus header the model cannot tell which of those
 * records the current task is acting on, and would have to reconstruct the slice from the
 * transcript.
 */

const viewBeliefsSchema = Type.Object({});

export function createViewBeliefsToolDefinition(
	beliefSet: BeliefSet,
	focusSet?: FocusSet,
	pendingExperiment?: () => ExperimentSelection | undefined,
): ToolDefinition<typeof viewBeliefsSchema, undefined> {
	return {
		name: "view_beliefs",
		label: "view beliefs",
		description: "Show the current open and adjudicated world beliefs, the task focus, and any selected experiment.",
		promptSnippet: "View your current beliefs",
		promptGuidelines: [],
		parameters: viewBeliefsSchema,
		async execute(_toolCallId, _input, _signal, _onUpdate, _ctx) {
			const sections = [formatScopeHeader(focusSet, pendingExperiment?.())];
			sections.push(formatBeliefsForView(beliefSet.beliefs, "all"));
			return {
				content: [{ type: "text", text: sections.join("\n") }],
				details: undefined,
			};
		},
	};
}

/** The control-metadata header: which beliefs the task currently acts on, and which of them the
 *  next experiment probes. Rendered above the belief listing so scope reads before history. */
function formatScopeHeader(focusSet?: FocusSet, experiment?: ExperimentSelection): string {
	if (!focusSet) return "";
	const lines: string[] = [];
	if (!focusSet.declared) {
		lines.push("[FOCUS] (none declared — set the task scope with focus_beliefs)");
	} else {
		lines.push(focusSet.beliefIds.length > 0 ? `[FOCUS] ${focusSet.beliefIds.join(", ")}` : "[FOCUS] (empty)");
	}
	if (experiment) {
		lines.push(`[SELECTED EXPERIMENT] ${experiment.beliefIds.join(", ")} -- decision: ${experiment.intent}`);
	}
	return lines.join("\n");
}
