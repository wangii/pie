/**
 * Belief-loop role policy. Cognitive phases are propose, execution, distill, and
 * finalReport. Routing and execution leases are implementation helpers, not epistemic phases.
 */

export type LoopRole = "propose" | "distill" | "execution" | "finalReport";

export type ModelPolicy = "default" | "execution" | "distillation" | "fastPath";

export type ProjectionKind = "belief" | "distill" | "execution" | "finalReport";

/**
 * The belief loop's control surface, in one place.
 *
 * Membership is the whole point, and it is needed in four places that must not drift: the propose
 * and distill tool lists, the projection that decides which calls and results are bookkeeping
 * rather than observations, and the session's list of tools that stay enabled regardless of the
 * caller's `activeToolNames`. A tool missing from any one of them is misread — masked as a probe,
 * dropped from a role's surface, or silently disabled — so the set is defined once and derived
 * from everywhere else.
 */
export const BELIEF_SURFACE_TOOLS = [
	"route_task",
	"declare_belief",
	"focus_beliefs",
	"select_experiment",
	"set_formulation",
	"defer_formulation",
	"recheck_formulation",
	"answer_correction",
	"review_applicability",
	"view_beliefs",
	"conclude",
] as const;

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
	"set_formulation, defer_formulation, recheck_formulation, answer_correction, review_applicability, view_beliefs, and conclude. " +
	"Write every belief, every formulation, and its evidence in {beliefLang}.\n\n";

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
	"8. Derive focus from the current reading's task scope: name the objects, relations, and scale that matter, " +
	"and why. A function, data structure, or component boundary is relevant because of the problem, not a fixed " +
	"file/component/system hierarchy. Keep task focus separate from belief truth. Use focus_beliefs to declare the " +
	"task's current focus; changing focus never changes a belief's status, and an empty focus means nothing is in scope. " +
	"Then use select_experiment with the belief ids (a subset of the focus) and one sentence naming the task decision the " +
	"experiment could change. Beliefs left out of an experiment keep their status and stay in focus. view_beliefs reports " +
	"the current focus and any selected experiment, and the listing includes beliefs retained from earlier tasks: those " +
	"are history, not current scope.\n" +
	"9. State how you currently understand the task with set_formulation: the organizing reading you hold this task's " +
	"beliefs under — how they relate, which distinctions matter, and what you take the problem to be — plus what it " +
	"attends to, what tension it explains, and what the reading changes. A restatement of the goal or a summary of belief " +
	"statuses is not a reading, and neither is one that would hold unchanged under a different task. State it even with " +
	"few beliefs recorded, and let the distinctions overlap or leave something unplaced: the reading is how you hold what " +
	"you have, not an exhaustive classification. This is your own " +
	"working position, not a belief " +
	"and not evidence — if the reading implies an untested empirical claim that would change what you do, declare that " +
	"claim as a belief and test it instead. Once you have investigated, this decision is required before you choose " +
	"another experiment or conclude; if you genuinely cannot state a reading yet, use defer_formulation to say what is " +
	"missing and why. Publishing a new version voids any experiment you selected but have not dispatched, so select again " +
	"afterwards. Every publication pauses execution and conclusion until the user responds to that version — the first " +
	"reading as much as a revision, since nothing is built on an understanding the user has not seen. Answer the " +
	"response, then account for the beliefs already in scope under the reading with " +
	"review_applicability — carries-over, not-applicable, or needs-revalidation, with a reason for each, including the " +
	"beliefs the reading leaves out — and then review focus with focus_beliefs, even if the same ids remain " +
	"relevant. A belief classified needs-revalidation may not be reported until it has been probed again under the new " +
	"reading. " +
	"Reconsider the reading when residual evidence conflicts with its assumptions or scope, or a user correction changes " +
	"the problem. This feedback is evidence → reading → focus → experiment; preserve counterexample probes. " +
	"Every distillation owes you a result before you choose another experiment or conclude, including a round that " +
	"changed no belief and left no residual: use recheck_formulation to record that the reading still holds and why, " +
	"naming the finding this round produced that bears on it, " +
	"set_formulation when it changed, or defer_formulation when none can be stated. This is a check on the reading, " +
	"not on the beliefs — it neither settles an unadjudicated belief nor questions a settled one, and residual is not " +
	"evidence for it. " +
	"Revise only for a substantive change in what you understand, where you attend, or where the work goes: " +
	"the same reading with more evidence behind it is not a revision.\n" +
	"10. When the user corrects your reading, answer it with answer_correction before anything else: revise the reading " +
	"(citing the correction in set_formulation), state explicitly that you keep it and why, or say what is ambiguous and " +
	"ask. A user constraint must be honoured; where it conflicts with the evidence, say so plainly rather than ignoring it. " +
	"Until every pending correction has an answer, you may not dispatch another experiment or conclude.";

export const ROLE_SPECS: Record<LoopRole, RoleSpec> = {
	propose: {
		instruction: PROPOSE_ROLE_HEADER + PROPOSE_ROUTING_HEADER + PROPOSE_PROTOCOL,
		continuationInstruction: PROPOSE_ROLE_HEADER + PROPOSE_CONTINUATION_HEADER + PROPOSE_PROTOCOL,
		// Propose owns the whole control surface: routing, the belief state, scope, the experiment
		// selection, and the formulation decision are all its call.
		tools: [...BELIEF_SURFACE_TOOLS],
		modelPolicy: "default",
		projection: "belief",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the propose role does not have. Choose the next uncertainty with ` +
			`declare_belief, set scope with focus_beliefs, select the experiment with select_experiment, state your reading ` +
			`with set_formulation (or defer_formulation), record that a distillation left your reading standing with ` +
			`recheck_formulation, answer a correction with answer_correction, account for the ` +
			`previous reading's conclusions with review_applicability, inspect state with ` +
			`view_beliefs, route epistemically closed work ` +
			`with route_task, or conclude. ` +
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
				(name) =>
					// Scheduling belongs to propose: an execution turn that could re-scope the task or
					// re-choose the experiment would be writing the state the next propose turn reads, and
					// a correction is handed back to propose at the tool boundary rather than answered here.
					// `view_beliefs` stays: the probe role needs the statement it is testing.
					name !== "focus_beliefs" &&
					name !== "select_experiment" &&
					name !== "answer_correction" &&
					name !== "route_task" &&
					name !== "declare_belief" &&
					name !== "conclude" &&
					// Publishing a formulation is propose's alone: execution gathers evidence, and an
					// agent that could state its own reading mid-experiment would be answering its own
					// question. It is filtered explicitly rather than by omission, so the exclusion
					// survives a change to the belief-surface list.
					name !== "set_formulation" &&
					name !== "defer_formulation" &&
					// Saying what the current reading means after a round is that same judgment, taken one
					// step later; a probing role must not be the one to declare its own question settled.
					name !== "recheck_formulation" &&
					// Which conclusions still answer the current reading is propose's judgment for the same
					// reason: a role that probes cannot also decide what its predecessors' results mean.
					name !== "review_applicability",
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
	awaitFormulationResponse:
		"Execution is paused until you act on this Frame yourself. Approve it to build on this reading, or correct it to say " +
		"it is wrong; a plain reply is treated as an ordinary message and does not release the pause. Approving records your " +
		"decision for this version only — a later revision waits for its own approval — and the agent must answer a " +
		"correction and review the reading before continuing.",
	reviewFocus:
		"Review the task focus under the current Frame with focus_beliefs before selecting an experiment, routing to " +
		"fast path, or concluding. The same belief ids are allowed: review relevance, not truth. Keep counterexamples in scope.",
	applicabilityReview: (statements: string) =>
		`A Frame has been published, so say what each belief already in scope means under this reading with ` +
		`review_applicability: ${statements}. carries-over keeps it as a finding, not-applicable records that this task no ` +
		`longer asks about it, and needs-revalidation says its evidence was gathered under a different reading and must be ` +
		`probed again before the task may report it. This changes no belief's status, and it is owed for every belief listed ` +
		`— including any that a narrowed focus leaves out.`,
	revalidateUnderReading: (statements: string) =>
		`These beliefs were classified as needing re-examination under the current reading and have not been probed again: ` +
		`${statements}. Refine each into the claim this reading actually asks about — a refinement carries the evidence ` +
		`that bears on its successor — or record that the task no longer needs it. The earlier evidence stays exactly as ` +
		`it was: the task simply may not report it as ` +
		`settled under a reading that never tested it.`,
	dispatch: (statements: string) =>
		`Run one coherent experiment for these beliefs: ${statements}. Report all materially distinct raw observations with sources or command results.`,
	fastPathDispatch:
		"Fast path: the remaining work is epistemically closed. Execute the user's request directly with your tools, then " +
		"record what you actually delivered, the evidence that it was delivered, and any remaining blocker with " +
		"report_outcome; a clean tool log is not completion. Do not write the user-facing answer yourself: the answer is " +
		"delivered once the agent has said what it makes of the task, so state your result compactly and stop.",
	fastPathFormulation:
		"Fast path finished. State how you now understand this task — or confirm the reading you already published — " +
		"before the result is reported: call set_formulation. Do not manufacture an experiment to justify the reading; " +
		"read only the operations that actually ran and the outcome that was recorded. If a deferred reading is all you " +
		"can honestly give, defer_formulation sends the task back into the belief loop instead of closing it. If the run " +
		"left uncertainty that could change the answer, declare it, set the focus, select the experiment, and continue in " +
		"the belief loop.",
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
	// The focus is already declared, so asking for it again would repeat the step the model just took —
	// the next action is the selection, and saying so is what keeps one obligation from costing two turns.
	selectExperimentAfterFocus: (statements: string) =>
		`No experiment is selected, so these beliefs stay out of execution: ${statements}. Select the next experiment with ` +
		`select_experiment, naming the task decision its outcome could change. Dispatch is limited to the selected beliefs.`,
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
	repeatedFailure: (toolName: string, count: number) =>
		`The same ${toolName} call has now been rejected ${count} times with the same reason. Repeating it will not change ` +
		`the answer: change the call rather than re-issuing it. Read the rejection text for the args it says are required, ` +
		`and if the reason is a reference or state problem, use view_beliefs to read the current ids and statuses before ` +
		`trying again. If no valid call exists, say what is blocking instead of retrying.`,
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
	formulationDecision:
		"You have investigated this task and have not yet said how you understand it. Before choosing another experiment " +
		"or concluding, either call set_formulation to state your current reading (what you take the problem to be, what it " +
		"attends to, and what it changes), or call defer_formulation to record what is still missing and why. This is a " +
		"required decision, not a formality: it is the difference between investigating toward a reading and drifting. A " +
		"rejected call does not count — fix the input and call again.",
	formulationRecheck:
		"Distillation has reported on the round you dispatched, so say what it means for how you read this task before " +
		"choosing another experiment or concluding. Call recheck_formulation if the reading still organizes the task, with " +
		"the reason it does; call set_formulation if the reading changed; call defer_formulation if no reading can be " +
		"stated right now. An unchanged belief set is not a reason to skip this — new evidence can matter to the reading " +
		"without changing any belief's status, and a round that changed nothing still has to be looked at. This decides " +
		"the reading, not the beliefs: it neither settles an unadjudicated belief nor questions a settled one.",
	writeConclusion: "Write the evidence-grounded conclusion.",
	answerCorrection: (ids: string) =>
		`The user corrected your reading of this task (${ids}). The round that was running stopped at the tool boundary: ` +
		`the calls already in flight came back, and the ones after them were not started. Answer every correction listed ` +
		`below with answer_correction — saying how you are responding, not just acknowledging it: revise the reading ` +
		`(citing the correction in set_formulation), state explicitly that you keep it and why, or say what is ambiguous ` +
		`and ask. A user constraint must be honoured; where it conflicts with the evidence, say so plainly rather than ` +
		`ignoring it. A revision voids any experiment you selected but have not dispatched, so select again afterwards, ` +
		`and the actions the interrupted experiment had left are not resumed — you choose what to do next.`,
	correctionBlocked: (id: string) =>
		`Blocked: the user corrected the task's reading (${id}) while this round was running, so no new execution call ` +
		`starts. Report what you already observed; propose answers the correction next.`,
	unauthorizedTool: (name: string) =>
		`Blocked: "${name}" is not authorized for the execution role. Use one of the execution role's declared ` +
		`tools, or report that the observation is not available with them.`,
} as const;
