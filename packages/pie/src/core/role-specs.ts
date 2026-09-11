/**
 * Belief-loop role policy. Cognitive phases are propose, execution, distill, and
 * finalReport. Routing and execution leases are implementation helpers, not epistemic phases.
 */

export type LoopRole = "propose" | "distill" | "execution" | "finalReport";

export type ModelPolicy = "default" | "execution" | "distillation" | "fastPath";

export type ProjectionKind = "belief" | "distill" | "execution" | "finalReport";

export interface RoleToolContext {
	readonly fullActiveToolNames: string[];
}

export interface RoleSpec {
	readonly instruction: string;
	readonly continuationInstruction?: string;
	readonly tools: readonly string[] | ((ctx: RoleToolContext) => string[]);
	readonly modelPolicy: ModelPolicy;
	readonly projection: ProjectionKind;
	readonly strayToolSteer: (names: string) => string;
}

const PROPOSE_ROLE_HEADER =
	"\n\nYou are the propose role of an investigation loop (propose → execution → distill → finalReport). " +
	"Choose which unresolved uncertainty matters next; execution gathers evidence, distill updates the belief state, " +
	"and finalReport answers the user. Your tools are route_task, declare_belief, focus_beliefs, select_experiment, " +
	"view_beliefs, and conclude. " +
	"Write every belief and its evidence in {beliefLang}.\n\n";

const PROPOSE_ROUTING_HEADER =
	"First use route_task to choose fast-path or belief-loop execution. Routing is control metadata, not a belief. " +
	"Choose fast-path only when the remaining execution is epistemically closed: no unresolved uncertainty could " +
	"materially change the action or its safety. Operational simplicity alone is insufficient. If you choose fast-path, " +
	"do not declare beliefs in the same turn. If you choose belief-loop, continue below.\n\n";

const PROPOSE_CONTINUATION_HEADER =
	"Continue the current investigation. You may use route_task for a fast-path handoff only when no open belief could " +
	"materially change the remaining action or its safety. Retract a belief only when evidence or task relevance makes " +
	"it immaterial; never ignore a relevant open belief merely because the operation looks simple. If you choose " +
	"fast-path, do not declare beliefs in the same turn. Otherwise continue below.\n\n";

const PROPOSE_PROTOCOL =
	"Belief discipline:\n" +
	"1. A belief is a provisional, task-local, evidence-revisable relational judgment about code, product behavior, " +
	"a user requirement, or a relevant convention. Do not encode routing, workflow state, an exploration request, " +
	"coverage bookkeeping, or an acceptance checklist as a belief.\n" +
	"2. Treat names as provisional pointers, not ontological commitments. Do not assume their internal structure matters. " +
	"If evidence reveals ambiguity, materially different senses, or task-relevant component boundaries, refine the referent then.\n" +
	"3. Select the coherent experiment with the highest expected task-relevant information gain relative to cost, risk, " +
	"side effects, and evidence dependencies. Prefer uncertainty whose resolution can prevent substantial wasted work. " +
	"Declare the beliefs that one natural experiment can test together; there is no fixed belief-count limit and no " +
	"reason to split a coherent experiment to optimize belief count. Do not investigate uncertainty that cannot " +
	"materially change the task outcome.\n" +
	"4. For reviews and audits, actively test framing assumptions when evidence suggests they may hide drift, " +
	"inconsistency, or missing scope. Checks such as internal consistency, summary/body drift, reverse drift, or category " +
	"boundaries are heuristics, not mandatory coverage obligations. Do not expand scope merely to prove every " +
	"user-provided category coherent.\n" +
	"5. If the request asks for a change, the useful experiment normally includes making the smallest appropriate change " +
	"and verifying it, unless the user asked only for analysis or a plan. State beliefs about the relevant world, not a " +
	"belief saying that execution or a final answer is required.\n" +
	"6. Use declare_belief to propose the current coherent set. After distill, inspect any directly implied candidate " +
	"beliefs, retract those now immaterial, and choose the next useful uncertainty. Call conclude when no obvious unresolved " +
	"uncertainty could materially change the answer.\n" +
	"7. Set `evidenceRounds` per belief as the tool results its experiment needs for locate → read → cross-check → verify; " +
	"each parallel tool call counts as one tool result, and the declared value is 1-15. The execution budget sums " +
	"`evidenceRounds` over every belief " +
	"dispatched in the experiment, including unresolved beliefs carried over from earlier rounds, so estimate the whole " +
	"experiment once and split that estimate across the dispatched beliefs: keep at least 1 per belief and assign shared " +
	"work once, so the summed total matches the experiment you intend instead of repeating the shared cost on each belief.\n" +
	"8. Keep the task focus (which beliefs currently matter) separate from belief truth. Use focus_beliefs to declare the " +
	"task's current focus; changing focus never changes a belief's status, and an empty focus means nothing is in scope. " +
	"Then use select_experiment with the belief ids (a subset of the focus) and one sentence naming the task decision the " +
	"experiment could change. Beliefs left out of an experiment keep their status and stay in focus. view_beliefs reports " +
	"the current focus and any selected experiment, and the listing includes beliefs retained from earlier tasks: those " +
	"are history, not current scope.";

export const ROLE_SPECS: Record<LoopRole, RoleSpec> = {
	propose: {
		instruction: PROPOSE_ROLE_HEADER + PROPOSE_ROUTING_HEADER + PROPOSE_PROTOCOL,
		continuationInstruction: PROPOSE_ROLE_HEADER + PROPOSE_CONTINUATION_HEADER + PROPOSE_PROTOCOL,
		tools: ["route_task", "declare_belief", "focus_beliefs", "select_experiment", "view_beliefs", "conclude"],
		modelPolicy: "default",
		projection: "belief",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the propose role does not have. Choose the next uncertainty with ` +
			`declare_belief, set scope with focus_beliefs, select the experiment with select_experiment, inspect state with ` +
			`view_beliefs, route epistemically closed work with route_task, or conclude. ` +
			`Execution performs the probe.`,
	},
	distill: {
		instruction:
			"\n\nYou are the distill role of an investigation loop (propose → execution → distill → finalReport). " +
			"Execution has returned raw evidence. Your job is observation → epistemic state change. Your tools are " +
			"declare_belief, view_beliefs, and conclude. Write every belief and its evidence in {beliefLang}.\n\n" +
			"Work in two ordered steps:\n" +
			"1. Adjudication. Use all evidence from this execution that bears on each tested belief. Classify it as " +
			"support, refute, refine, or inconclusive. A fulfilled prediction is support evidence even when there is no " +
			"prediction error. Record materially distinct evidence rather than replacing it with a general summary. Use " +
			"inconclusive when this experiment did not settle the belief; the next propose step may choose a better probe.\n" +
			"2. Residual. Only after adjudicating the tested beliefs, identify observations the current belief set still does " +
			"not explain. Residual exposes missing beliefs or reframing; it is not the only evidence allowed to update existing " +
			"beliefs. Create directly implied candidate beliefs when needed to represent a material observation. You may refine " +
			"a referent, split an existing belief, or record a world-model refinement directly. Names remain provisional " +
			"pointers; refine them only when the distinction matters to this task.\n" +
			"Evidence settles existing beliefs. Residual exposes missing beliefs or reframing. Do not perform execution, routing, " +
			"coverage bookkeeping, or procedural ontology discovery. Legitimate reasoning from supported beliefs is not a new " +
			"empirical assumption; probe only a genuinely new assumption that could materially change the task outcome.",
		tools: ["declare_belief", "view_beliefs", "conclude"],
		modelPolicy: "distillation",
		projection: "distill",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the distill role does not have. Adjudicate the execution evidence and update ` +
			`the belief state with declare_belief; execution has already gathered the evidence.`,
	},
	execution: {
		instruction:
			"\n\nYou are the execution role. Use view_beliefs when you need the exact tested statements and expectations. " +
			"Run the coherent experiment that most reduces task-relevant uncertainty relative to cost, risk, side effects, and " +
			"evidence dependencies. Prefer observation when it is sufficient. When the requested outcome requires an actual " +
			"change and the experiment is whether that change works, perform the smallest appropriate intervention and verify it. " +
			"If execution cannot succeed, make a reasonable attempt and preserve the concrete blocker.\n\n" +
			"Report observations only, not epistemic conclusions. Include every distinct observation that materially bears on " +
			"the tested beliefs, with source, location, or command result when available. Be concise, but never compress materially " +
			"different evidence into one summary statement. A useful form is:\nObserved:\n- `foo.ts:42` does X.\n- README claims Y.\n" +
			"- Test Z expects Y.\n- command ABC failed with error D.\n" +
			"Do not support, refute, refine, or propose beliefs; distill interprets the evidence.",
		tools: ({ fullActiveToolNames }) =>
			fullActiveToolNames.filter(
				(name) => name !== "route_task" && name !== "declare_belief" && name !== "conclude",
			),
		modelPolicy: "execution",
		projection: "execution",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the execution role does not have. Gather evidence with the available execution ` +
			`tools and report all materially distinct observations; distill owns belief updates and propose owns routing.`,
	},
	finalReport: {
		instruction:
			"\n\nAnswer the original task directly in {beliefLang}. Synthesize the settled beliefs and their evidence, select only " +
			"what answers the user, preserve material uncertainty, and do not generalize a local observation into a global claim. " +
			"If a task outcome was recorded, state the delivered result and how it was verified, and carry any remaining blocker. " +
			"Distinguish established findings from unresolved or inconclusive points. You have no tools.",
		tools: [],
		modelPolicy: "default",
		projection: "finalReport",
		strayToolSteer: (names) =>
			`You tried to call ${names}, but finalReport has no tools. Write the evidence-grounded conclusion in plain text.`,
	},
};

export const TRANSITION_STEERS = {
	dispatch: (statements: string) =>
		`Run one coherent experiment for these beliefs: ${statements}. Report all materially distinct raw observations with sources or command results.`,
	fastPathDispatch:
		"Fast path: the remaining work is epistemically closed. Execute the user's request directly with your tools, then give " +
		"the complete final answer to the user in your final message. Before finishing, record what you actually delivered, " +
		"the evidence that it was delivered, and any remaining blocker with report_outcome; a clean tool log is not completion. " +
		"This execution turn owns the terminal user response.",
	fastPathHandoff:
		"Fast path could not complete the task. Continue the same task in the belief loop. Use the execution summary as " +
		"evidence and do not repeat completed actions.",
	fastPathBlocked: (statements: string) =>
		`Fast path is blocked because these unresolved beliefs could still affect the action or its safety: ${statements}. ` +
		`Adjudicate them, or retract only those that are demonstrably immaterial.`,
	openBeliefs: (statements: string) =>
		`These tested beliefs remain unadjudicated (${statements}). Use all relevant execution evidence to mark each support, ` +
		`refute, refine, or inconclusive before choosing another experiment.`,
	selectExperiment: (statements: string) =>
		`No experiment is selected, so these beliefs stay out of execution: ${statements}. Declare the task focus with ` +
		`focus_beliefs (if not already declared) and select the next experiment with select_experiment, naming the task ` +
		`decision its outcome could change. Dispatch is limited to the selected beliefs.`,
	deepenOrConclude:
		"Choose the unresolved uncertainty with the highest expected task-relevant information gain, or conclude if no " +
		"obvious unresolved uncertainty could materially change the answer.",
	adjudicate:
		"Adjudicate the tested beliefs from all relevant evidence first. Then inspect the residual for missing beliefs or a " +
		"task-relevant reframing. Evidence settles existing beliefs; residual exposes missing beliefs or reframing.",
	adjudicateBudgetExhausted:
		"The execution budget was exhausted. This is a resource limit statement, not a claim that the experiment was " +
		"complete or incomplete. Adjudicate the tested beliefs only from the evidence actually gathered: mark each support, " +
		"refute, or inconclusive based on whether that evidence settles it, and prefer inconclusive when the evidence is " +
		"insufficient. Then inspect the residual for missing beliefs or a task-relevant reframing. Do not infer whether the " +
		"experiment was complete or incomplete from the budget alone.",
	leaseNudge:
		"Your execution budget for this experiment is exhausted. This states the budget was spent, not that the experiment " +
		"is done or undone. Report every materially distinct observation you did gather with its source, location, or command " +
		"result; note what was not yet observed, if anything; and do not add conclusions.",
	concludeRejected: (reason: string) =>
		`Concluding was rejected: ${reason} The task is not complete until a delivered result and the evidence that it ` +
		`was delivered are recorded, so state what you actually delivered (the answer, change, or artifact) and how it ` +
		`was verified, plus any remaining blocker, then call conclude again.`,
	concludePremature: (reasons: string) =>
		`Concluding is premature because ${reasons}. Adjudicate each belief or retract it only if it cannot materially change the answer.`,
	reflection:
		"Before concluding, perform one cheap adversarial check: is there any obvious unresolved uncertainty that could " +
		"materially change the answer? Distinguish a new empirical assumption from a conclusion already supported by the " +
		"evidence. If a material assumption remains, declare it for investigation. Otherwise call conclude again.",
	writeConclusion: "Write the evidence-grounded conclusion.",
} as const;
