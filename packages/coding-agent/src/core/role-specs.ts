/**
 * The four belief-loop roles' policy, centralized as a single authoritative source.
 *
 * Everything a role is — its instruction text, its tool surface, its belief-view scope,
 * its model policy, its message projection, and its stray-tool steer — is declared here.
 * The steers between roles live in `TRANSITION_STEERS`. Consumers are `agent-session.ts`
 * (`_roleInstruction`, `_roleToolNames`, `_roleModel`, `_projectMessage`,
 * `_steerStrayToolCall`, `_transition`, `_concludeTransition`) and the `view_beliefs`
 * tool (`beliefScope`).
 *
 * Naming: the loop has four phases — `propose` (decide what to test), `execution` (probe
 * the code/product), `distill` (account for the observation), `finalAnswer` (write the
 * conclusion). The old role names — the single `epistemic` role and the "two-role" model — are
 * retired as phase labels; `epistemic` survives only as a deprecated compatibility key in
 * `getRoleContextUsage` and in the protocol phrase "epistemic residual" in the distill
 * instruction.
 */

export type LoopRole = "propose" | "distill" | "execution" | "finalAnswer";

/** Which model the role runs on: the session's main model, the configured execution model, or the distillation model. */
export type ModelPolicy = "default" | "execution" | "distillation";

/** Which message projection the role's context uses (see `_projectMessage`). */
export type ProjectionKind = "belief" | "execution" | "finalAnswer";

/** The belief-view scope: the belief-side roles read the full set, execution only the frame. */
export type BeliefScope = "all" | "frame";

export interface RoleToolContext {
	/** The full active tool names, independent of the role's projected subset. */
	fullActiveToolNames: string[];
}

export interface RoleSpec {
	/** The role instruction appended to the base system prompt (leading blank lines included). */
	instruction: string;
	/**
	 * The tools the role may call. Static lists for the belief-side roles and finalAnswer;
	 * a function for execution, which derives its probe surface from the full active set.
	 */
	tools: readonly string[] | ((ctx: RoleToolContext) => string[]);
	/** The scope handed to `view_beliefs`: "all" or "frame". */
	beliefScope: BeliefScope;
	/** Which model the role runs on. */
	modelPolicy: ModelPolicy;
	/** Which message projection the role's context uses. */
	projection: ProjectionKind;
	/** The steer text for a tool call outside the role's surface. */
	strayToolSteer: (names: string) => string;
}

export const ROLE_SPECS: Record<LoopRole, RoleSpec> = {
	propose: {
		instruction:
			"\n\nYou are the propose role of the four-phase investigation loop (propose → execution → distill → finalAnswer). You work entirely through beliefs: " +
			"you decide what to test and what to conclude, while a separate execution role performs the actual " +
			"probing and a separate distill role turns each probe's report into belief updates. Your only tools " +
			"are declare_belief, view_beliefs, and conclude — exactly these three, and nothing else. " +
			"Write every belief — its statement, expectation, and evidence — in {beliefLang}.\n\n" +
			"Work the belief → experiment → update protocol:\n" +
			"1. Propose beliefs with declare_belief. A world belief (domain product/code) names a relation about " +
			"the product or code, states what you would observe if it were true (its falsifiable expectation), and " +
			"how many evidence rounds it needs. Tag each referent in the statement with one of four kinds — " +
			"[code] (implementation: symbol/file/logic), [prod] (product behavior or documented claim), " +
			"[user] (user intent/requirement), [convention] (repo idiom/naming/pattern) — tagging only the " +
			"referents the relation points at, not every noun (e.g. `_projectMessagesFor[code]` 计算 `status[prod]` " +
			"的 context 统计规则). A framing belief (domain framing) states what the final answer " +
			"must establish — an obligation, not a probe target. When the task asks you to examine, review, or " +
			"audit something, the framing obligation must include surfacing any inconsistency between what the " +
			"project's documentation and code claim and what the implementation actually does — not merely " +
			"describing where things are defined. Every examine/review/audit question also carries an implicit " +
			'frame you must not inherit silently: it splits the world into two sides (e.g. "server" vs ' +
			'"client") and thereby presupposes each side is internally coherent, is the current authority, ' +
			"and that drift lives only across that line. Make that frame explicit and falsify it — name the " +
			"presuppositions the question's wording imports and propose each as a testable belief, including " +
			"whether two parts of one side contradict each other, whether one side's summary or status table " +
			"contradicts its own body, and whether one side claims something the other side no longer has.\n" +
			"The user's names are presuppositions too, distinct from the question's frame above. " +
			"Do not assume a name the user used is an atomic entity — a name is atomic only after a probe confirms it, " +
			"never before. For every user-named unit except one that is already a specific file:line, a unique symbol, or a " +
			"list the user enumerated, propose a scope-discovery world belief whose expectation is to enumerate its immediate " +
			"component boundaries — the direct children, not the whole tree. Atomicity is a result of that discovery, not a " +
			"default: if execution finds a single referent, support the discovery belief and stop; if it finds several, adopt " +
			"each component that matters as its own referent, or explicitly exclude a component with a reason — exclusion is a " +
			"successful resolution, not a failure. An aggregate belief does not discharge coverage for its children.\n" +
			"2. After you propose a belief, the execution role runs the probe automatically and reports back " +
			"what it observed, and a separate distill step accounts for that report and updates the beliefs. " +
			"You never do the probing and you never do that accounting — you only state what should be tested " +
			"and then decide what to test next.\n" +
			"3. Keep proposing beliefs until the task is fully answered, close every open framing obligation " +
			"(support, refine, or retract it via declare_belief), then call conclude — in the same turn " +
			"as your final belief update when nothing remains to test.",
		tools: ["declare_belief", "view_beliefs", "conclude"],
		beliefScope: "all",
		modelPolicy: "default",
		projection: "belief",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the propose role does not have. Your only tools are ` +
			`declare_belief, view_beliefs, and conclude — nothing else. A separate execution role runs ` +
			`the probe automatically after you propose a belief; express what you wanted to inspect as a ` +
			`declare_belief proposal instead.`,
	},
	distill: {
		instruction:
			"\n\nYou are the distill role of the four-phase investigation loop (propose → execution → distill → finalAnswer). The execution role has just probed " +
			"and reported its raw observation; your job is the prediction-error distillation that turns that " +
			"observation into what the belief set must update on. Your only tools are declare_belief, " +
			"view_beliefs, and conclude — exactly these three, and nothing else. Write every belief in {beliefLang}.\n\n" +
			"1. Update from the epistemic residual, not the whole report. In order: explain which parts of the " +
			"report your current beliefs already account for; isolate the residual — the observations and " +
			"prediction errors they do not explain; then use only that residual to update beliefs.\n" +
			"2. Update via declare_belief: support or refute an open belief with the observed evidence, or refine " +
			"a belief whose statement/expectation was wrong. The single declare_belief tool takes an `op` " +
			"argument — one of propose, support, refute, refine, or retract (omit `op` to propose) — to add, " +
			"settle, correct, or withdraw a belief; these are op values, never separate tools. Review the set " +
			"with view_beliefs.\n" +
			"3. When the residual shows a user-named referent resolving into several component boundaries or distinct " +
			"senses, that observation refutes any belief that treated the name as atomic — including an atomicity that was " +
			"never explicitly proposed. Refute or refine that belief (refute the atomic reading, or refine it to name the " +
			"parts); do not propose the child division here — that is the next propose step, not yours.\n" +
			"4. Once every open belief is updated from the residual, stop — proposing the next belief is a " +
			"separate propose step, not yours.",
		tools: ["declare_belief", "view_beliefs", "conclude"],
		beliefScope: "all",
		modelPolicy: "distillation",
		projection: "belief",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the distill role does not have. Your only tools are ` +
			`declare_belief, view_beliefs, and conclude — nothing else. The execution role has already ` +
			`probed; account for its report by updating beliefs with declare_belief instead.`,
	},
	execution: {
		instruction:
			"\n\nRead the belief you are probing with view_beliefs if you need its exact expectation, then " +
			"probe the code or product to test it. Report in one concise sentence what you observed — the raw " +
			"observations and any contradiction with documentation or a contract you noticed, not an analysis " +
			"of them. The prediction-error distillation (comparing the observation to the expectation and " +
			"deciding what the belief set must update on) is the distill role's step, not yours: it reads " +
			"your raw report and does that accounting itself. Proposing or updating beliefs is likewise a " +
			"separate step you do not perform.",
		tools: ({ fullActiveToolNames }) =>
			// The probe role gets `view_beliefs` read-only — it must be able to recall the
			// belief it is testing (statement + expectation) without drifting, but it
			// must not mutate the belief set (`declare_belief`) or conclude (`conclude`),
			// both of which are the belief-side roles' calls.
			fullActiveToolNames.filter((name) => name !== "declare_belief" && name !== "conclude"),
		beliefScope: "frame",
		modelPolicy: "execution",
		projection: "execution",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the execution role does not have. You probe with read/bash ` +
			`and report observations; belief updates and concluding happen in separate roles after you ` +
			`report. Report your observation in plain text instead.`,
	},
	finalAnswer: {
		instruction:
			"\n\nYou are a scientific mind writing the conclusion: answer the original task directly and " +
			"concisely, grounded in the beliefs you have settled.",
		tools: [],
		beliefScope: "all",
		modelPolicy: "default",
		projection: "finalAnswer",
		strayToolSteer: (names) =>
			`You tried to call ${names}, but the finalAnswer role has no tools. Write your conclusion in plain text.`,
	},
};

/**
 * The role-transition steers, keyed by outcome. `_transition` composes the next state and
 * picks the matching steer text here, so prompt drift is contained to one table.
 */
export const TRANSITION_STEERS = {
	/** propose/distill → execution: dispatch the open frame. */
	dispatch: (statements: string) => `Run the experiments for the beliefs ${statements} and report your observations.`,
	/** propose → distill / distill stay: some open beliefs were not updated. */
	openBeliefs: (statements: string) =>
		`Some beliefs are still open (${statements}). Update them — support, refute, or refine each from the observations you received.`,
	/** propose stay / distill → propose: deepen the investigation or conclude. */
	deepenOrConclude:
		"Propose the next belief to deepen the investigation, or conclude if the task is answered. " +
		"You may conclude in the same turn as your final belief update — a separate conclude-only turn is unnecessary.",
	/**
	 * execution → distill: the probe's observation is in. Deliberately does not say "update
	 * your belief" — that invites the model to re-process the whole observation. The
	 * epistemic uplink walks three steps instead: explain what the current beliefs already
	 * account for, isolate the residual they do not, and update on that residual alone.
	 */
	residual:
		"Account for the observation: explain what your beliefs already explain, isolate the residual they do not, and update only on that residual.",
	/** execution stay: lease exhausted, nudge once to report before forcing the return. */
	leaseNudge: "You have gathered enough evidence. Report your observation in one concise sentence.",
	/** propose/distill: conclude with an open obligation or open world belief is premature. */
	concludePremature: (reasons: string) =>
		`Concluding is premature — ${reasons}. Use declare_belief to support, refute, refine, or retract each before concluding.`,
	/**
	 * propose/distill → finalAnswer, run once just before the handoff. It makes the belief
	 * set itself the object of one last test, mirroring the residual protocol at one level
	 * up: the epistemic residual isolates what a single observation does not explain, this
	 * isolates what the *whole set* does not name. Three falsifiable checks — coverage,
	 * composition, completeness — each map to a failure mode the residual filter cannot see
	 * because the probe never ran. Firing only when the task produced beliefs and only once
	 * (`_reflected`) keeps a direct answer on an empty set, or a reflection that proposes
	 * nothing, from looping forever.
	 */
	reflection:
		"Before you conclude, reflect on the belief set itself as the object of one final test. " +
		"For each check that fails, propose the missing belief and let it be probed — do not conclude yet. " +
		"(1) Coverage — every path or @reference the task named has appeared as the referent of some belief. List each " +
		"user-named concept the task treats as a unit, one per line, with its resolution and the belief ids behind it: " +
		"`atomic` (name the belief whose evidence proved it), `decomposed` (name the scope-discovery belief and its " +
		"adopted child beliefs), or `excluded` (name the reason). A concept you cannot attach to such a line is unresolved — " +
		"an aggregate belief does not discharge coverage for its children. If any path is untouched or any concept is " +
		"unresolved, propose a belief to probe it. " +
		"(2) Composition — the conjunction of two supported beliefs may smuggle a claim that was never proposed; " +
		"propose that implied claim. " +
		"(3) Completeness — every belief that calls something consistent or free of drift treated it as complete; " +
		"check its own internals and the reverse direction (does the contract lag the code, does one document lag another). " +
		"If all three pass with nothing to add, conclude again.",
	/** propose/distill → finalAnswer: the terminal handoff. */
	writeConclusion: "Write your conclusion.",
} as const;
