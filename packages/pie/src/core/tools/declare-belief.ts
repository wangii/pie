import { type Static, Type } from "typebox";
import {
	type Belief,
	type BeliefDelta,
	type BeliefSet,
	type BeliefStatus,
	type ExperimentSelection,
	type FocusSet,
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
		Type.Number({
			description:
				"Estimated tool results this belief's experiment needs, counting locate, read, cross-check, and verify steps " +
				"(1-15); each parallel tool call counts as one. The execution budget sums this over every belief dispatched " +
				"in the experiment, so split shared work across the dispatched beliefs instead of repeating it on each and " +
				"keep at least 1 per belief. Defaults to 1.",
		}),
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

const selectExperimentSchema = Type.Object({
	intent: Type.String({
		description:
			"The task decision, action, or conclusion this experiment's outcome could change. One sentence, not a restatement of what you want to learn.",
	}),
	beliefIds: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Belief ids forming one coherent experiment. Must be a subset of the declared task focus. Dispatch is limited to this selection; beliefs left out keep their status and stay in focus.",
	}),
});

const focusBeliefsSchema = Type.Object({
	beliefIds: Type.Array(Type.String(), {
		description:
			"Belief ids the task currently acts on. Replaces the focus slice; pass an empty array to declare that nothing is in focus. Changing focus never changes a belief's status.",
	}),
});

export type SelectExperimentInput = Static<typeof selectExperimentSchema>;
export type FocusBeliefsInput = Static<typeof focusBeliefsSchema>;

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

export function createFocusBeliefsToolDefinition(
	beliefSet: BeliefSet,
	focusSet: FocusSet,
	onFocus?: (beliefIds: readonly string[]) => void,
): ToolDefinition<typeof focusBeliefsSchema, undefined> {
	return {
		name: "focus_beliefs",
		label: "focus beliefs",
		description:
			"Declare which beliefs the task currently acts on. Replaces the focus slice; an empty list means nothing is in focus. Control metadata, not a belief.",
		promptSnippet: "Declare the beliefs the task currently acts on",
		promptGuidelines: [
			"Focus is the task's scope, not an experiment; it never changes a belief's status",
			"A refuted or inconclusive belief can be put back in focus if it is relevant again",
		],
		parameters: focusBeliefsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			try {
				const beliefIds = [...new Set(input.beliefIds.map((id) => id.trim()).filter(Boolean))];
				for (const beliefId of beliefIds) {
					if (!beliefSet.get(beliefId)) throw new Error(`Unknown belief id: ${beliefId}.`);
				}
				focusSet.select(beliefIds);
				onFocus?.(beliefIds);
				return {
					content: [
						{
							type: "text",
							text:
								beliefIds.length > 0 ? `Focused beliefs: ${beliefIds.join(", ")}` : "Focused beliefs: (none)",
						},
					],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Focus rejected: ${message}`);
			}
		},
	};
}

export function createSelectExperimentToolDefinition(
	beliefSet: BeliefSet,
	focusSet: FocusSet,
	onSelect?: (selection: ExperimentSelection) => void,
): ToolDefinition<typeof selectExperimentSchema, undefined> {
	return {
		name: "select_experiment",
		label: "select experiment",
		description:
			"Choose the belief subset for the next execution experiment and state which task decision its outcome would change. Control metadata, not a belief.",
		promptSnippet: "Select the next experiment's beliefs and the decision they inform",
		promptGuidelines: [
			"The selection must be a subset of the declared focus; unselected focus beliefs keep their status",
			"State the action or conclusion the experiment could change, not what you hope to learn",
		],
		parameters: selectExperimentSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
			try {
				const intent = input.intent.trim();
				if (!intent) throw new Error("select_experiment requires a non-empty `intent`.");
				if (!focusSet.declared) {
					throw new Error("Declare the task focus with focus_beliefs before selecting an experiment.");
				}
				const beliefIds = [...new Set(input.beliefIds.map((id) => id.trim()).filter(Boolean))];
				if (beliefIds.length === 0) throw new Error("select_experiment requires at least one belief id.");
				for (const beliefId of beliefIds) {
					const belief = beliefSet.get(beliefId);
					if (!belief) throw new Error(`Unknown belief id: ${beliefId}.`);
					if (!focusSet.has(beliefId)) {
						throw new Error(`Belief ${beliefId} is outside the declared focus; add it with focus_beliefs first.`);
					}
					const status = statusOf(belief);
					if (status !== "proposed" && status !== "inconclusive") {
						throw new Error(`Belief ${beliefId} is ${status}; only an unresolved belief can be selected.`);
					}
				}
				onSelect?.({ intent, beliefIds });
				return {
					content: [
						{
							type: "text",
							text: `Selected experiment: ${beliefIds.join(", ")} -- decision: ${intent}`,
						},
					],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Experiment selection rejected: ${message}`);
			}
		},
	};
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
		executionMode: "sequential",
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
				throw new Error(`Routing rejected: ${message}`);
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
		executionMode: "sequential",
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
				throw new Error(`Belief rejected: ${message}`);
			}
		},
	};
}
