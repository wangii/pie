import { type Static, Type } from "typebox";
import { type BeliefDelta, type BeliefSet, statusOf } from "../belief-set.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The `declare_belief` tool — the epistemic role's mutation surface. It records and
 * reclassifies beliefs; the harness validates the delta and applies it to the immutable
 * `BeliefSet`. `read`/`bash` are not part of this role's surface (they live in the
 * execution role), so the epistemic layer stays cleanly separated from execution.
 */

const declareBeliefSchema = Type.Object({
	op: Type.Optional(
		Type.Union(
			[
				Type.Literal("propose"),
				Type.Literal("support"),
				Type.Literal("refute"),
				Type.Literal("refine"),
				Type.Literal("retract"),
			],
			{
				description:
					"What to do. Omit it to propose (the default). propose: add a belief (needs statement + domain + expectation). support/refute: settle an open belief (needs beliefId + evidence; supporting a framing belief also needs evidenceBeliefIds). refine: correct a belief (needs beliefId + statement + expectation). retract: withdraw (needs beliefId).",
			},
		),
	),
	statement: Type.Optional(
		Type.String({
			description:
				"The belief as a named relation about the product or code, with each referent tagged by kind: [code] (implementation), [prod] (product behavior or documented claim), [user] (user intent/requirement), [convention] (repo idiom/naming/pattern). Tag referents, not every noun. Required for propose and refine.",
		}),
	),
	domain: Type.Optional(
		Type.Union([Type.Literal("product"), Type.Literal("code"), Type.Literal("framing")], {
			description:
				"product/code: a relation about the world. framing: what the final answer must establish (an obligation). Required for propose.",
		}),
	),
	expectation: Type.Optional(
		Type.String({
			description:
				"The falsifiable prediction: what observable result would confirm or refute this belief. Required for propose and refine.",
		}),
	),
	evidenceRounds: Type.Optional(
		Type.Number({
			description: "How many tool results this test needs (1-5). Defaults to 1. Required for propose and refine.",
		}),
	),
	beliefId: Type.Optional(
		Type.String({
			description: "The id of the belief to support/refute/refine/retract. Required for those ops.",
		}),
	),
	evidence: Type.Optional(
		Type.String({
			description:
				"The observed result and how it met or diverged from the belief's expectation. Required for support and refute.",
		}),
	),
	evidenceBeliefIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Belief ids that discharge this support. Required when supporting a framing belief: reference the product/code beliefs (each must already be supported) that establish the obligation. Ignored for non-framing support.",
		}),
	),
});

export type DeclareBeliefInput = Static<typeof declareBeliefSchema>;

export const declareBeliefSystemPromptContribution = {
	snippet:
		"Record or update what you currently believe about the product, the code, or what the answer must establish",
	guidelines: [
		"A belief names a relation and its falsifiable expectation; support or refute it with the evidence you observed",
		"Write every belief in {beliefLang}, and tag each referent in the statement with one of [code] / [prod] / [user] / [convention]",
	],
};

function toDelta(input: DeclareBeliefInput): BeliefDelta {
	const op = input.op ?? "propose";
	// `op` is optional so the model can batch several proposes without restating the
	// discriminator on each. But support/refute/refine/retract each carry a `beliefId`
	// and must be explicit — reject an omitted `op` there rather than guess.
	if (input.op === undefined && input.beliefId?.trim()) {
		throw new Error(
			"`op` is required when `beliefId` is supplied (support/refute/refine/retract each need an explicit `op`). " +
				"To propose a new belief, omit `beliefId`.",
		);
	}
	switch (op) {
		case "propose":
			if (!input.statement?.trim()) {
				throw new Error("propose requires a non-empty `statement`.");
			}
			if (input.domain !== "product" && input.domain !== "code" && input.domain !== "framing") {
				throw new Error("propose requires `domain` of 'product', 'code', or 'framing'.");
			}
			if (!input.expectation?.trim()) {
				throw new Error(
					"propose requires a non-empty `expectation` (the observable result that would confirm or refute it).",
				);
			}
			return {
				op: "propose",
				statement: input.statement,
				domain: input.domain,
				expectation: input.expectation,
				evidenceRounds: input.evidenceRounds ?? 1,
			};
		case "support":
			if (!input.beliefId) throw new Error("support requires a `beliefId`.");
			if (!input.evidence?.trim()) {
				throw new Error("support requires `evidence` (the observed result and how it met the expectation).");
			}
			return {
				op: "support",
				beliefId: input.beliefId,
				evidence: input.evidence,
				...(input.evidenceBeliefIds ? { evidenceBeliefIds: input.evidenceBeliefIds } : {}),
			};
		case "refute":
			if (!input.beliefId) throw new Error("refute requires a `beliefId`.");
			if (!input.evidence?.trim()) {
				throw new Error(
					"refute requires `evidence` (the observed result and how it diverged from the expectation).",
				);
			}
			return { op: "refute", beliefId: input.beliefId, evidence: input.evidence };
		case "retract":
			if (!input.beliefId) throw new Error("retract requires a `beliefId`.");
			return { op: "retract", beliefId: input.beliefId };
		case "refine":
			if (!input.beliefId) {
				throw new Error("refine requires a `beliefId`.");
			}
			if (!input.statement?.trim()) {
				throw new Error("refine requires a non-empty `statement`.");
			}
			if (!input.expectation?.trim()) {
				throw new Error("refine requires a non-empty `expectation` (the corrected prediction).");
			}
			return {
				op: "refine",
				beliefId: input.beliefId,
				statement: input.statement,
				expectation: input.expectation,
				evidenceRounds: input.evidenceRounds ?? 1,
			};
	}
}

export function createDeclareBeliefToolDefinition(
	beliefSet: BeliefSet,
): ToolDefinition<typeof declareBeliefSchema, undefined> {
	return {
		name: "declare_belief",
		label: "declare belief",
		description:
			"Record or update your current beliefs about the product, the code, or what the answer must establish. A belief names a relation between two referents " +
			"plus a falsifiable expectation. Ops: propose (add a belief — several may be open at once), support/refute " +
			"(settle a proposed belief with the observed evidence), refine (replace a belief: supply a corrected " +
			"statement AND expectation, not evidence), retract (withdraw).",
		promptSnippet: declareBeliefSystemPromptContribution.snippet,
		promptGuidelines: declareBeliefSystemPromptContribution.guidelines,
		parameters: declareBeliefSchema,
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			try {
				const delta = toDelta(input);
				const belief = beliefSet.apply(delta);
				return {
					content: [
						{
							type: "text",
							text: `Applied ${delta.op}: ${belief.id} ${belief.statement} [${belief.domain}] (${statusOf(belief)}).`,
						},
					],
					details: undefined,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Belief rejected: ${message} Re-read your belief and retry with a corrected form.`,
						},
					],
					details: undefined,
				};
			}
		},
	};
}
