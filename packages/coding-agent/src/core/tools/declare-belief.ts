import { type Static, Type } from "typebox";
import type { BeliefDelta, BeliefSet } from "../belief-set.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * The `declare_belief` tool. This is the single-loop counterpart to Pie's no-tool
 * epistemic controller: instead of a separate role emitting a control JSON menu,
 * the model records and reclassifies its beliefs by calling this tool interleaved
 * with `read`/`bash`/`grep`. The harness validates the delta and mutates the
 * `BeliefSet`; dispatch (running real tools) and asking (ending the turn with a
 * question) need no mechanism — the single loop already provides them.
 */

const declareBeliefSchema = Type.Object({
	op: Type.Union(
		[
			Type.Literal("propose"),
			Type.Literal("support"),
			Type.Literal("refute"),
			Type.Literal("refine"),
			Type.Literal("retract"),
		],
		{ description: "What to do: add a new belief, or reclassify an existing one." },
	),
	statement: Type.Optional(
		Type.String({
			description:
				"The belief as a named relation about product or code, e.g. 'authorizationSource(1003,1001) returns stale-replica'. Required for propose and refine.",
		}),
	),
	domain: Type.Optional(
		Type.Union([Type.Literal("product"), Type.Literal("code")], {
			description:
				"Is this belief about the product's observable behavior, or the code's behavior/structure? Required for propose.",
		}),
	),
	beliefId: Type.Optional(
		Type.String({
			description: "The id of the belief to support/refute/refine/retract. Required for those ops.",
		}),
	),
});

export type DeclareBeliefInput = Static<typeof declareBeliefSchema>;

export const declareBeliefSystemPromptContribution = {
	snippet: "Record or update what you currently believe about the product or code",
	guidelines: [
		"Maintain a working set of beliefs about the task's product and code; call declare_belief to propose a new belief, or to support/refute/refine one after you see a result",
		"A belief is a named relation about the product or code, not a command or a test-output prediction",
	],
};

function toDelta(input: DeclareBeliefInput): BeliefDelta {
	switch (input.op) {
		case "propose":
			if (!input.statement?.trim()) {
				throw new Error("propose requires a non-empty `statement`.");
			}
			if (input.domain !== "product" && input.domain !== "code") {
				throw new Error("propose requires `domain` of 'product' or 'code'.");
			}
			return { op: "propose", statement: input.statement, domain: input.domain };
		case "support":
			if (!input.beliefId) throw new Error("support requires a `beliefId`.");
			return { op: "support", beliefId: input.beliefId };
		case "refute":
			if (!input.beliefId) throw new Error("refute requires a `beliefId`.");
			return { op: "refute", beliefId: input.beliefId };
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
			return { op: "refine", beliefId: input.beliefId, statement: input.statement };
	}
}

export function createDeclareBeliefToolDefinition(
	beliefSet: BeliefSet,
): ToolDefinition<typeof declareBeliefSchema, undefined> {
	return {
		name: "declare_belief",
		label: "declare belief",
		description:
			"Record or update your current beliefs about the product or code. A belief names a relation between two referents " +
			"(e.g. 'authorizationSource(1003,1001) returns stale-replica'). Ops: propose (add a belief), support/refute " +
			"(reclassify an existing belief after a result), refine (replace a belief with a corrected version), retract (withdraw).",
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
							text: `Applied ${input.op}: ${belief.statement} [${belief.domain}] (${belief.status}).`,
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
