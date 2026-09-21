import { type Static, Type } from "typebox";
import type { FormulationContent, FormulationRecheckVerdict } from "../agent-session-domain.ts";
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
			"How you currently understand this task, in the first person and provisional: the reading you hold this task's beliefs under — how they relate and which distinctions matter, not a summary of their statuses. The grouping may overlap or leave a belief unplaced, and a reading is expected even while the task still holds few beliefs. Not a belief, and not a claim you are asserting is true.",
	}),
	focus: Type.String({
		description:
			"Which objects, relations, or scales you are attending to under this reading, and why they matter to this task. Prose, not a list of belief ids — the task's scope is declared separately with focus_beliefs.",
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

/**
 * The beliefs a revision has to account for, and what each still means under the new reading. The
 * decisions mirror the domain's `FormulationApplicabilityDecision`; the tool only parses, and the
 * controller decides what is owed and rejects anything that is not.
 */
const reviewApplicabilitySchema = Type.Object({
	entries: Type.Array(
		Type.Object({
			beliefId: Type.String({
				description: "A belief one of the listed ids names.",
			}),
			decision: Type.Union(
				[Type.Literal("carries-over"), Type.Literal("not-applicable"), Type.Literal("needs-revalidation")],
				{
					description:
						"carries-over: still a finding of this task under the new reading. not-applicable: the task no longer asks about " +
						"it. needs-revalidation: its evidence was gathered under the old reading and it may not be reported until it is probed again.",
				},
			),
			reason: Type.String({
				description: "Why this decision, stated in terms of the new reading.",
			}),
		}),
		{
			minItems: 1,
			description: "One decision per belief the current reading has not accounted for yet.",
		},
	),
});

export type ReviewApplicabilityInput = Static<typeof reviewApplicabilitySchema>;

/**
 * Reconsidering the current reading after a distillation and finding it still holds. The tool has
 * one outcome on purpose: "the reading changed" is a publication (`set_formulation`) and "no
 * reading can be stated" is a deferral (`defer_formulation`), so this is the answer that
 * previously had nowhere to go — the one that used to be indistinguishable from not looking.
 */
const recheckFormulationSchema = Type.Object({
	reason: Type.String({
		description:
			"Why the current reading still organizes this task after what the round found, stated in terms of the evidence.",
	}),
});

export type RecheckFormulationInput = Static<typeof recheckFormulationSchema>;

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
			"Make the interpretation an organizing reading of the beliefs this task holds: how they relate and which distinctions matter — not a restatement of the goal and not a summary of belief statuses",
			"A statement that would hold unchanged under a different task says nothing about this one; say what this reading rules in or out for the next choice",
			"State a reading even when the task holds few beliefs or none yet, and let the distinctions overlap or leave something unplaced — an organizing reading is not an exhaustive classification",
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

export function createReviewApplicabilityToolDefinition(
	onReview: (input: ReviewApplicabilityInput) => { recorded: number; pending: number },
): ToolDefinition<typeof reviewApplicabilitySchema, undefined> {
	return {
		name: "review_applicability",
		label: "review applicability",
		description:
			"Say what each belief already in scope means under the current reading, after a frame revision. This never changes a belief's evidence or status: it records whether that evidence still answers the question the task now asks. Required for every belief the revision names, including any that a narrowed focus leaves out, and before the task may conclude.",
		promptSnippet: "Say which of the old conclusions still apply to the revised reading",
		promptGuidelines: [
			"carries-over keeps a belief as a finding of this task; not-applicable records that the task no longer asks about it",
			"needs-revalidation means the evidence was gathered under the old reading: probe it again before reporting it",
			"Classify every belief the revision lists, even the ones the new focus drops",
		],
		parameters: reviewApplicabilitySchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			try {
				const result = onReview({
					entries: input.entries.map((entry) => ({
						beliefId: entry.beliefId.trim(),
						decision: entry.decision,
						reason: entry.reason.trim(),
					})),
				});
				return {
					content: [
						{
							type: "text",
							text:
								result.pending > 0
									? `Recorded ${result.recorded} applicability decision(s); ${result.pending} belief(s) are still unaccounted for.`
									: `Recorded ${result.recorded} applicability decision(s); the reading's scope is fully accounted for.`,
						},
					],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Applicability review rejected: ${message}`);
			}
		},
	};
}

export function createRecheckFormulationToolDefinition(
	onRecheck: (input: RecheckFormulationInput) => { verdict: FormulationRecheckVerdict },
): ToolDefinition<typeof recheckFormulationSchema, undefined> {
	return {
		name: "recheck_formulation",
		label: "recheck formulation",
		description:
			"Reconsider how you currently understand this task after a round of evidence, and record that the reading still holds. Every distillation owes this result before you choose another experiment or conclude: an unchanged belief set is not a reason to skip it, because new evidence can bear on the reading without changing any belief's status. This records a position, not evidence — it neither settles an unadjudicated belief nor questions a settled one.",
		promptSnippet: "Record that you reconsidered your current reading and it still holds",
		promptGuidelines: [
			"Use set_formulation instead when the reading itself changed, and defer_formulation when no reading can be stated right now",
			"State why the reading still organizes the task in light of what the round found; 'no change' is not a reason",
			"Write the reason in {beliefLang}",
		],
		parameters: recheckFormulationSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			try {
				const result = onRecheck({ reason: input.reason.trim() });
				return {
					content: [
						{
							type: "text",
							text:
								result.verdict === "maintained"
									? "Reconsidered the current reading: it still holds."
									: `Reconsidered the current reading: ${result.verdict}.`,
						},
					],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Recheck rejected: ${message}`);
			}
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
