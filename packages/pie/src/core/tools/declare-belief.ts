import { type Static, Type } from "typebox";
import {
	type Belief,
	type BeliefDelta,
	type BeliefSet,
	type BeliefStatus,
	type Routing,
	type RoutingDelta,
	type RoutingSet,
	statusOf,
} from "../belief-set.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const declareBeliefSchema = Type.Object({
	op: Type.Optional(
		Type.Union(
			[
				Type.Literal("propose"),
				Type.Literal("support"),
				Type.Literal("refute"),
				Type.Literal("refine"),
				Type.Literal("inconclusive"),
				Type.Literal("retract"),
			],
			{
				description:
					"Belief-state operation. Omit to propose. support/refute/inconclusive adjudicate an open belief with evidence. refine replaces it with an evidence-supported correction. retract withdraws an immaterial or abandoned belief.",
			},
		),
	),
	statement: Type.Optional(
		Type.String({
			description:
				"A provisional, task-local relational judgment about code, product behavior, a user requirement, or a relevant convention. Required for propose and refine.",
		}),
	),
	domain: Type.Optional(
		Type.Union([Type.Literal("product"), Type.Literal("code")], {
			description: "What part of the world the belief concerns. Required for propose.",
		}),
	),
	expectation: Type.Optional(
		Type.String({
			description: "The observable prediction that would bear on this belief. Required for propose and refine.",
		}),
	),
	evidenceRounds: Type.Optional(
		Type.Number({ description: "Estimated tool results needed by one coherent experiment (1-5). Defaults to 1." }),
	),
	skillRefs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional skill ids relevant to executing this belief's experiment.",
		}),
	),
	beliefId: Type.Optional(Type.String({ description: "The belief to adjudicate, refine, or retract." })),
	evidence: Type.Optional(
		Type.String({
			description:
				"The material observations supporting this adjudication or refinement. Required for support, refute, inconclusive, and refine.",
		}),
	),
});

const routeTaskSchema = Type.Object({
	decision: Type.Union([Type.Literal("fast-path"), Type.Literal("belief-loop")], {
		description: "Whether direct execution is epistemically closed or needs the belief loop.",
	}),
	reason: Type.String({
		description: "Why unresolved uncertainty can or cannot materially change the action or its safety.",
	}),
	suitabilityProbability: Type.Number({
		description: "Estimated probability that direct execution is epistemically appropriate (0-1).",
	}),
	successProbability: Type.Number({
		description: "Estimated probability that direct execution completes the request (0-1).",
	}),
	estimatedSteps: Type.Number({ description: "Estimated number of direct-execution tool steps." }),
	difficulty: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

export type DeclareBeliefInput = Static<typeof declareBeliefSchema>;
export type RouteTaskInput = Static<typeof routeTaskSchema>;

export const declareBeliefSystemPromptContribution = {
	snippet: "Record or adjudicate a provisional task-local belief about the relevant world",
	guidelines: [
		"Beliefs contain evidence-revisable world judgments, not routing, workflow, exploration, or coverage state",
		"Treat names as provisional pointers; refine a referent only when evidence makes the distinction task-relevant",
		"When a skill matches the belief's target, pass its name in skillRefs so execution can load it",
	],
};

function requireBeliefId(input: DeclareBeliefInput, op: string): string {
	if (!input.beliefId?.trim()) throw new Error(`${op} requires a \`beliefId\`.`);
	return input.beliefId;
}

function requireEvidence(input: DeclareBeliefInput, op: string): string {
	if (!input.evidence?.trim()) throw new Error(`${op} requires material observed \`evidence\`.`);
	return input.evidence;
}

function toDelta(input: DeclareBeliefInput): BeliefDelta {
	const op = input.op ?? "propose";
	if (input.op === undefined && input.beliefId?.trim()) {
		throw new Error("`op` is required when `beliefId` is supplied. To propose, omit `beliefId`.");
	}
	switch (op) {
		case "propose":
			if (!input.statement?.trim()) throw new Error("propose requires a non-empty `statement`.");
			if (input.domain !== "product" && input.domain !== "code") {
				throw new Error("propose requires `domain` of 'product' or 'code'.");
			}
			if (!input.expectation?.trim()) throw new Error("propose requires a non-empty `expectation`.");
			return {
				op,
				statement: input.statement,
				domain: input.domain,
				expectation: input.expectation,
				evidenceRounds: input.evidenceRounds ?? 1,
				skillRefs: input.skillRefs,
			};
		case "support":
		case "refute":
		case "inconclusive":
			return { op, beliefId: requireBeliefId(input, op), evidence: requireEvidence(input, op) };
		case "retract":
			return { op, beliefId: requireBeliefId(input, op) };
		case "refine":
			if (!input.statement?.trim()) throw new Error("refine requires a non-empty `statement`.");
			if (!input.expectation?.trim()) throw new Error("refine requires a non-empty `expectation`.");
			return {
				op,
				beliefId: requireBeliefId(input, op),
				statement: input.statement,
				expectation: input.expectation,
				evidence: requireEvidence(input, op),
				evidenceRounds: input.evidenceRounds ?? 1,
				skillRefs: input.skillRefs,
			};
	}
}

export function createRouteTaskToolDefinition(
	routingSet: RoutingSet,
	onRouting?: (delta: RoutingDelta, routing: Routing) => void,
): ToolDefinition<typeof routeTaskSchema, undefined> {
	return {
		name: "route_task",
		label: "route task",
		description:
			"Record task-control routing metadata, not a belief. Fast path requires epistemic closure, not merely operational simplicity.",
		promptSnippet: "Route epistemically closed work to direct execution",
		promptGuidelines: [
			"Choose fast-path only when no unresolved uncertainty could materially change the action or its safety",
		],
		parameters: routeTaskSchema,
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			try {
				const delta: RoutingDelta = {
					op: "route",
					statement: input.reason,
					decision: input.decision,
					suitabilityProbability: input.suitabilityProbability,
					successProbability: input.successProbability,
					estimatedSteps: input.estimatedSteps,
					difficulty: input.difficulty,
					reason: input.reason,
				};
				const routing = routingSet.apply(delta);
				onRouting?.(delta, routing);
				return {
					content: [{ type: "text", text: `Applied routing: ${routing.id} (${routing.decision}).` }],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Routing rejected: ${message}` }],
					details: undefined,
				};
			}
		},
	};
}

export function createDeclareBeliefToolDefinition(
	beliefSet: BeliefSet,
	onBeliefDelta?: (
		delta: BeliefDelta,
		belief: Belief,
		previousStatus: BeliefStatus | undefined,
		priorBelief?: Belief,
	) => void,
): ToolDefinition<typeof declareBeliefSchema, undefined> {
	return {
		name: "declare_belief",
		label: "declare belief",
		description:
			"Record or adjudicate provisional world beliefs. A fulfilled prediction is support evidence. Residual observations may directly refine a belief or motivate new candidate beliefs.",
		promptSnippet: declareBeliefSystemPromptContribution.snippet,
		promptGuidelines: declareBeliefSystemPromptContribution.guidelines,
		parameters: declareBeliefSchema,
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			try {
				const delta = toDelta(input);
				const priorBelief = "beliefId" in delta ? beliefSet.get(delta.beliefId) : undefined;
				const previousStatus = priorBelief ? statusOf(priorBelief) : undefined;
				const belief = beliefSet.apply(delta);
				onBeliefDelta?.(delta, belief, previousStatus, priorBelief);
				return {
					content: [
						{
							type: "text",
							text: `Applied ${delta.op}: ${belief.id} ${belief.statement} [${belief.domain}] (${statusOf(belief)}).`,
						},
					],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Belief rejected: ${message}` }],
					details: undefined,
				};
			}
		},
	};
}
