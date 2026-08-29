/**
 * The four belief-loop roles' policy, centralized as a single authoritative source.
 *
 * Everything a role is — its instruction text, its tool surface, its model policy, its
 * message projection, and its stray-tool steer — is declared here.
 * The steers between roles live in `TRANSITION_STEERS`. Consumers are `agent-session.ts`
 * (`_roleInstruction`, `_roleToolNames`, `_roleModel`, `_projectMessage`,
 * `_steerStrayToolCall`, `_transition`, `_concludeTransition`).
 *
 * Naming: the loop has four phases — `propose` (decide what to test), `execution` (probe
 * the code/product), `distill` (account for the observation), `finalReport` (write the
 * conclusion). The old role names — the single `epistemic` role and the "two-role" model — are
 * retired as phase labels; `epistemic` survives only as a deprecated compatibility key in
 * `getRoleContextUsage` and in the protocol phrase "epistemic residual" in the distill
 * instruction.
 */

export type LoopRole = "propose" | "planner" | "distill" | "execution" | "finalReport";

/** Which model the role runs on: the session's main model, the configured execution model, the
 *  configured planner model, the fast-path model, or the distillation model. */
export type ModelPolicy = "default" | "execution" | "distillation" | "planner" | "fastPath";

/** Which message projection the role's context uses (see `_projectMessage`). */
export type ProjectionKind = "belief" | "distill" | "execution" | "finalReport";

export interface RoleToolContext {
	/** The full active tool names, independent of the role's projected subset. */
	fullActiveToolNames: string[];
}

export interface RoleSpec {
	/** The role instruction appended to the base system prompt (leading blank lines included). */
	instruction: string;
	/** Instruction for propose turns after the task's first (routing) turn, when set. */
	continuationInstruction?: string;
	/**
	 * The tools the role may call. Static lists for the belief-side roles and finalReport;
	 * a function for execution, which derives its probe surface from the full active set.
	 */
	tools: readonly string[] | ((ctx: RoleToolContext) => string[]);
	/** Which model the role runs on. */
	modelPolicy: ModelPolicy;
	/** Which message projection the role's context uses. */
	projection: ProjectionKind;
	/** The steer text for a tool call outside the role's surface. */
	strayToolSteer: (names: string) => string;
}

/** Shared propose role header: who the role is, its tools, and the belief language. */
const PROPOSE_ROLE_HEADER =
	"\n\nYou are the propose role of the four-phase investigation loop (propose → planner → execution → distill → finalReport). You work entirely through beliefs: " +
	"you decide what to test and what to conclude, while a separate execution role performs the actual " +
	"probing and a separate distill role turns each probe's report into belief updates. Your only tools " +
	"are declare_belief, view_beliefs, and conclude — exactly these three, and nothing else. " +
	"Write every belief — its statement, expectation, and evidence — in {beliefLang}.\n\n";

/** The first propose turn of a task routes the request: fast-path or belief-loop. */
const PROPOSE_ROUTING_HEADER =
	"Before anything else, declare the routing belief with declare_belief op `route`: judge whether this " +
	"request is suitable for fast-path execution. State the decision (`fast-path` or `belief-loop`), " +
	"suitabilityProbability (0-1), successProbability (0-1), estimatedSteps, and difficulty " +
	"(low/medium/high). Choose `fast-path` only for simple requests: low side-effect risk, few steps, low " +
	"ambiguity, high success probability. If you route `fast-path`, do NOT propose any other beliefs — the " +
	"execution role will execute the request directly and a separate distillation step will summarize it. " +
	"If you route `belief-loop`, continue with the protocol below.\n\n";

/** Later propose turns: the initial route is settled; a fast-path handoff is optional. */
const PROPOSE_CONTINUATION_HEADER =
	"The task is already in the belief loop and its initial routing decision is settled. Continue the " +
	"protocol below. Optionally, when the remaining work is simple (low side-effect risk, few steps, low " +
	"ambiguity, high success probability), you may declare a fast-path handoff with declare_belief op " +
	"`route` and decision `fast-path`: the execution role will then finish the request directly on the fast " +
	"path and a separate distillation step will summarize it. A fast-path decision ignores any open " +
	"world beliefs and any open framing obligations — the run executes the request while they remain open, " +
	"and they are re-adjudicated after the run. Open world beliefs are not carried into the run; any " +
	"still-open hypotheses are re-adjudicated at the task boundary. If you declare `fast-path`, do NOT " +
	"propose any other beliefs in this turn. If you instead continue the belief loop, keep the protocol " +
	"below and continue proposing beliefs until the task is answered.\n\n";

/** The propose protocol body shared by the routing and continuation instructions. */
const PROPOSE_PROTOCOL =
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
	"Infer the user's intended outcome before proposing beliefs. If the request imperatively asks to " +
	"change, add, remove, fix, or implement something, assume that actual execution is required unless " +
	"the user explicitly asked only for analysis or a plan. For such a request, establish a framing " +
	"belief that the final answer must be supported by evidence of either (a) the concrete executed " +
	"change with proportionate verification of its result, or (b) a concrete blocker observed after " +
	"a reasonable execution attempt. A plan, a list of intended changes, or a claim about what should " +
	"work does not discharge that obligation.\n" +
	"2. After you propose a belief, the planner role groups the open beliefs into the next execution batch, the execution role " +
	"runs the probe automatically and reports back what it observed, and a separate distill step accounts for that report " +
	"and updates the beliefs. " +
	"You never do the probing and you never do that accounting — you only state what should be tested " +
	"and then decide what to test next.\n" +
	"3. Keep proposing beliefs until the task is fully answered, close every open framing obligation " +
	"(support, refine, or retract it via declare_belief), then call conclude — in the same turn " +
	"as your final belief update when nothing remains to test.";

/** Shared planner role header: who the role is, its tools, and what a batch is. The open beliefs
 *  are handed to the planner in its system prompt (role-scoped, so their statements never leak into
 *  other roles' transcripts) — it has no tools, so its plain-text reply *is* the batch selection. */
const PLANNER_ROLE_HEADER =
	"\n\nYou are the planner role of the belief-loop investigation (propose → planner → execution → distill → finalReport). " +
	"The propose role has declared open beliefs (listed at the end of this prompt); your job is to decide which subset of " +
	"them becomes the next execution batch — exactly one batch per turn, and at most 3 beliefs per batch. Pick the subset one probe/explore " +
	"episode can jointly handle that maximizes how many open world beliefs it can falsify (framing and routing beliefs never count toward that " +
	"benefit). Group beliefs that one execution episode can probe together coherently: shared probe target or code locality, the same tools or skills, " +
	"evidence dependencies, compatible side effects, and similar evidence rounds. Plan one batch only — the remaining open beliefs are planned after this " +
	"batch is settled. You only group beliefs; you never probe and never update them. You have no tools: reply with exactly " +
	"one line starting with `Batch:` followed by the selected belief ids, comma-separated — nothing else. Write any text in " +
	"{beliefLang}.\n\n";

export const ROLE_SPECS: Record<LoopRole, RoleSpec> = {
	propose: {
		instruction: PROPOSE_ROLE_HEADER + PROPOSE_ROUTING_HEADER + PROPOSE_PROTOCOL,
		continuationInstruction: PROPOSE_ROLE_HEADER + PROPOSE_CONTINUATION_HEADER + PROPOSE_PROTOCOL,
		tools: ["declare_belief", "view_beliefs", "conclude"],
		modelPolicy: "default",
		projection: "belief",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the propose role does not have. Your only tools are ` +
			`declare_belief, view_beliefs, and conclude — nothing else. A separate execution role runs ` +
			`the probe automatically after you propose a belief; express what you wanted to inspect as a ` +
			`declare_belief proposal instead.`,
	},
	planner: {
		instruction: PLANNER_ROLE_HEADER,
		tools: [],
		modelPolicy: "planner",
		projection: "belief",
		strayToolSteer: (names) =>
			`You tried to call ${names}, but the planner role has no tools. Reply with exactly one line ` +
			`starting with \`Batch:\` listing the selected belief ids — nothing else. A separate execution ` +
			`role runs the probes; you only group beliefs.`,
	},
	distill: {
		instruction:
			"\n\nYou are the distill role of the four-phase investigation loop (propose → planner → execution → distill → finalReport). The execution role has just probed " +
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
		modelPolicy: "distillation",
		projection: "distill",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the distill role does not have. Your only tools are ` +
			`declare_belief, view_beliefs, and conclude — nothing else. The execution role has already ` +
			`probed; account for its report by updating beliefs with declare_belief instead.`,
	},
	execution: {
		instruction:
			"\n\nRead the belief you are probing with view_beliefs if you need its exact expectation, then " +
			"probe the code or product to test it. Prefer read/bash observation when it alone can reduce the " +
			"relevant uncertainty. When the user's intended outcome requires an actual change and the remaining " +
			"uncertainty is whether a proposed change can realize or test that outcome, treat the smallest " +
			"appropriate edit/write as an intervention experiment: perform it instead of stopping at a plan, " +
			"then verify the resulting artifact with read/bash. Choose the experiment that most directly " +
			"reduces uncertainty in the open framing obligation. If execution cannot succeed, make a reasonable " +
			"attempt and report the concrete observed blocker. Report in one concise sentence what you observed — " +
			"the raw observations and any contradiction with documentation or a contract you noticed, not an " +
			"analysis of them. The prediction-error distillation (comparing the observation to the expectation " +
			"and deciding what the belief set must update on) is the distill role's step, not yours: it reads " +
			"your raw report and does that accounting itself. Proposing or updating beliefs is likewise a " +
			"separate step you do not perform.",
		tools: ({ fullActiveToolNames }) =>
			// The probe role gets `view_beliefs` read-only — it must be able to recall the
			// belief it is testing (statement + expectation) without drifting, but it
			// must not mutate the belief set (`declare_belief`) or conclude (`conclude`),
			// both of which are the belief-side roles' calls.
			fullActiveToolNames.filter((name) => name !== "declare_belief" && name !== "conclude"),
		modelPolicy: "execution",
		projection: "execution",
		strayToolSteer: (names) =>
			`You tried to call ${names}, which the execution role does not have. You test beliefs through ` +
			`observation or minimal intervention: read/bash for observational probes, edit/write when an ` +
			`actual change is the most direct experiment the user's intended outcome requires. Report ` +
			`observations only; belief updates and concluding happen in separate roles after you report. ` +
			`Report your observation in plain text instead.`,
	},
	finalReport: {
		instruction:
			"\n\nYou are a scientific mind writing the conclusion: answer the original task directly and " +
			"concisely, grounded in the beliefs you have settled. Write your conclusion in {beliefLang}.",
		tools: [],
		modelPolicy: "fastPath",
		projection: "finalReport",
		strayToolSteer: (names) =>
			`You tried to call ${names}, but the finalReport role has no tools. Write your conclusion in plain text.`,
	},
};

/**
 * The role-transition steers, keyed by outcome. `_transition` composes the next state and
 * picks the matching steer text here, so prompt drift is contained to one table.
 */
export const TRANSITION_STEERS = {
	/** propose/distill → planner: plan the next single batch from the open beliefs. The steer stays
	 *  neutral — the open beliefs (id + statement) are injected into the planner's system prompt
	 *  instead, so their statements do not leak into the shared transcript or the execution
	 *  episode's context. The planner's plain-text `Batch:` reply is the selection. */
	planBatch: () =>
		`Plan the next execution batch: the open beliefs are listed at the end of your system prompt. Choose a coherent ` +
		`subset of them as the next batch — exactly one batch and at most 3 beliefs per batch. Choose the subset one probe/explore episode can jointly handle ` +
		`that maximizes how many open world beliefs it falsifies (framing and routing beliefs never count toward that benefit), grouping beliefs that one execution episode can probe together ` +
		`(shared probe target, tools/skills, dependencies, compatible side effects, similar evidence rounds). Reply with ` +
		`exactly one line starting with \`Batch:\` followed by the selected belief ids, comma-separated — nothing else. ` +
		`The remaining open beliefs will be planned after this batch is settled. If the open beliefs are all closely ` +
		`related, select them all.`,
	/** propose/distill/planner → execution: dispatch the open frame, the selected batch, or the
	 *  whole-frame fallback (the planner case and the singleton direct dispatch both use this). */
	dispatch: (statements: string) => `Run the experiments for the beliefs ${statements} and report your observations.`,
	/** propose → execution on the fast path: execute the request directly and answer. */
	fastPathDispatch:
		"Fast path: execute the user's request directly with your tools, then give the complete final answer to " +
		"the user in your final message.",
	/** execution → propose after a fast-path failure: continue the same task with the belief protocol. */
	fastPathHandoff:
		"Fast path could not complete the task. Continue the same task with the belief protocol; the fast-path " +
		"execution summary is in the conversation. Do not repeat actions already performed.",
	/** execution → distill after a successful frame-open fast-path handoff: adjudicate the outcome
	 *  and discharge the authorized framing per the evidenceBeliefIds rule. */
	fastPathDischarge:
		"The fast path executed the authorized handoff. Adjudicate the handoff-outcome belief from the " +
		"tool results, then discharge the framing obligation(s) it covered by supporting them with the " +
		"settled outcome via `evidenceBeliefIds`, or refute the outcome if the results do not support it.",
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
	 * propose/distill → finalReport, run once just before the handoff. It makes the belief
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
	/** propose/distill → finalReport: the terminal handoff. */
	writeConclusion: "Write your conclusion.",
} as const;
