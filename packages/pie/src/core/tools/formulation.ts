import { type Static, Type } from "typebox";
import type { FormulationContent } from "../agent-session-domain.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The propose role's problem-formulation tools — `set_formulation` and `defer_formulation`.
 *
 * These are the only way a formulation enters existence, and they are on the propose surface
 * alone: distill adjudicates evidence and may *suggest* a reframing, but a suggestion does not
 * become the current understanding until propose publishes it. Nothing here is a belief —
 * the formulation carries no evidence verdict and never counts as support for one.
 *
 * The tools themselves only parse and delegate. Resolving a citation to a durable record and
 * deciding whether a submission is a no-op both need the task's replayed state, so they live in
 * the controller; a rejection comes back as a tool error, which means the required decision is
 * still outstanding rather than silently satisfied.
 */

/**
 * A citation the model can actually make. Execution and distillation ids are not reachable from
 * the propose transcript, so those source kinds stay protocol-level for now; what a propose turn
 * can point at is the request it was given, a belief it has recorded, and a correction it was
 * asked to answer.
 */
const citationSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("prompt") },
		{ description: "The user's request for this task, as the task recorded it." },
	),
	Type.Object(
		{
			kind: Type.Literal("belief"),
			beliefId: Type.String({ description: "A belief this reading was formed from." }),
		},
		{
			description:
				"Recorded together with that belief's state at this moment, so reading the version back later does not substitute the belief's later state.",
		},
	),
	Type.Object(
		{
			kind: Type.Literal("correction"),
			correctionId: Type.String({ description: "A user correction you are answering." }),
		},
		{ description: "The correction this version responds to." },
	),
]);

export type FormulationCitation = Static<typeof citationSchema>;

const setFormulationSchema = Type.Object({
	interpretation: Type.String({
		description:
			"How you currently understand this task, in the first person and provisional: what you take the problem to be now. Not a belief, and not a claim you are asserting is true.",
	}),
	focus: Type.String({
		description:
			"Which objects, relations, or scales you are attending to under this reading. Prose, not a list of belief ids — the task's scope is declared separately with focus_beliefs.",
	}),
	implication: Type.String({
		description:
			"What this reading changes about where the investigation or intervention goes next. Not a plan and not a list of steps.",
	}),
	alternative: Type.Optional(
		Type.String({
			description:
				"A reading you are not currently prioritizing. Omit it when there is no real rival reading — do not invent one to fill the field.",
		}),
	),
	tension: Type.Optional(
		Type.String({
			description:
				"The conflict, gap, or phenomenon you are trying to explain. Omit it when nothing is clearly in tension yet.",
		}),
	),
	reason: Type.String({
		description:
			"One short sentence: why this reading, or why you are revising the previous one. Distinguish a substantive change of understanding from a restatement.",
	}),
	citations: Type.Optional(
		Type.Array(citationSchema, {
			description: "What this reading was formed from. Every citation must resolve to a record on this task.",
		}),
	),
});

const deferFormulationSchema = Type.Object({
	missingInformation: Type.String({
		description:
			"What you still cannot determine, stated concretely enough that a later investigation could supply it.",
	}),
	reason: Type.String({
		description: "Why this cannot be settled yet from the evidence you have.",
	}),
	citations: Type.Optional(
		Type.Array(citationSchema, {
			description: "What you are deferring from. Every citation must resolve to a record on this task.",
		}),
	),
});

export type SetFormulationInput = Static<typeof setFormulationSchema>;
export type DeferFormulationInput = Static<typeof deferFormulationSchema>;

/** What a formulation write did, mirroring the controller's result so a rejection becomes a
 *  tool error rather than a silent success. */
export type FormulationToolResult =
	| { readonly outcome: "recorded"; readonly text: string }
	| { readonly outcome: "unchanged"; readonly text: string }
	| { readonly outcome: "rejected"; readonly reason: string };

export function createSetFormulationToolDefinition(
	onSet: (input: SetFormulationInput) => FormulationToolResult,
): ToolDefinition<typeof setFormulationSchema, undefined> {
	return {
		name: "set_formulation",
		label: "set formulation",
		description:
			"Publish how you currently understand this task: your provisional reading, what it attends to, and what it changes. This is the agent's stated position, not a belief and not evidence. Revising it creates a new version, invalidates an undispatched experiment, and pauses for the user's response. After answering that response, review focus explicitly, even if its membership stays the same.",
		promptSnippet: "Publish your current understanding of the task",
		promptGuidelines: [
			"State a provisional first-person reading, not a settled claim; the formulation is never evidence for a belief",
			"If a reading implies an untested empirical claim that would change what you do, record that claim as a belief and test it instead of asserting it here",
			"Revise only for a substantive change in what you understand, where you are attending, or where the work goes; more evidence for the same reading is not a revision",
			"Write the content in {beliefLang}",
		],
		parameters: setFormulationSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			const result = onSet(input);
			if (result.outcome === "rejected") throw new Error(`Formulation rejected: ${result.reason}`);
			return { content: [{ type: "text", text: result.text }], details: undefined };
		},
	};
}

export function createDeferFormulationToolDefinition(
	onDefer: (input: DeferFormulationInput) => FormulationToolResult,
): ToolDefinition<typeof deferFormulationSchema, undefined> {
	return {
		name: "defer_formulation",
		label: "defer formulation",
		description:
			"Record that you have investigated but cannot yet state how you understand the task, and say what is missing and why. This is a real decision, not a blank version, and it never erases a formulation you already published.",
		promptSnippet: "Defer stating your current understanding, and say why",
		promptGuidelines: [
			"Say what information is missing concretely enough to be supplied by a later experiment",
			"A deferral is reconsidered when new information arrives; it is not a standing exemption from forming a reading",
			"Write the content in {beliefLang}",
		],
		parameters: deferFormulationSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			const result = onDefer(input);
			if (result.outcome === "rejected") throw new Error(`Deferral rejected: ${result.reason}`);
			return { content: [{ type: "text", text: result.text }], details: undefined };
		},
	};
}

/** Build the domain-shaped content a `set_formulation` call describes. Trimming happens in the
 *  controller, which also drops blank optionals, so absent and empty stay distinguishable. */
export function formulationContentFromTool(input: SetFormulationInput): FormulationContent {
	return {
		interpretation: input.interpretation,
		alternative: input.alternative,
		focus: input.focus,
		tension: input.tension,
		implication: input.implication,
	};
}
