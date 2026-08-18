/**
 * The belief set: the epistemic loop's object.
 *
 * A belief is a named relational assertion about product or code that the model
 * currently holds, with a derived status. The belief set is the *grip* the
 * single-loop agent maintains while it reasons and acts — it replaces Pie's
 * 16-kind control menu with three verbs (update-belief / dispatch / ask), of
 * which only update-belief mutates this object.
 *
 * This first version is deliberately minimal:
 *  - the only structure added beyond the prose statement is `domain` (product vs code);
 *  - provenance (sourceEventIds) is deferred until the belief semantics settle
 *    (the "immutable trace" question), so the set is mutable in memory.
 */

export type BeliefDomain = "product" | "code";

/**
 * Lifecycle of a belief. Monotone in one direction:
 * `proposed → supported | refuted → superseded`.
 */
export type BeliefStatus = "proposed" | "supported" | "refuted" | "superseded";

export interface Belief {
	/** Stable within a session; assigned by the BeliefSet, never persisted separately. */
	id: string;
	/** The frozen relation assertion in prose, e.g. "authorizationSource returns stale-replica". */
	statement: string;
	/** Author-declared at proposal time — never inferred later. */
	domain: BeliefDomain;
	status: BeliefStatus;
}

/**
 * A mutation the model may request. `propose`/`refine` carry a new statement and
 * are validated before they touch the set; the others reclassify an existing belief.
 */
export type BeliefDelta =
	| { op: "propose"; statement: string; domain: BeliefDomain }
	| { op: "support"; beliefId: string }
	| { op: "refute"; beliefId: string }
	| { op: "refine"; beliefId: string; statement: string }
	| { op: "retract"; beliefId: string };

/** Thrown when a delta names an invalid statement or an illegal transition. */
export class BeliefValidationError extends Error {}

/**
 * Mutable in-memory belief set. `apply` is the single choke point: every delta is
 * validated and applied here, so callers (the `declare_belief` tool, tests) cannot
 * corrupt the status machine.
 */
export class BeliefSet {
	private readonly _beliefs: Belief[] = [];
	private _nextId = 1;

	/** All beliefs, including refuted/superseded negatives — the full current model. */
	get beliefs(): readonly Belief[] {
		return this._beliefs;
	}

	/** Beliefs still actionable for dispatch: proposed or supported, not superseded. */
	open(): Belief[] {
		return this._beliefs.filter((b) => b.status === "proposed" || b.status === "supported");
	}

	get(id: string): Belief | undefined {
		return this._beliefs.find((b) => b.id === id);
	}

	apply(delta: BeliefDelta): Belief {
		switch (delta.op) {
			case "propose": {
				validateBelief(delta.statement, delta.domain);
				const belief: Belief = {
					id: this._allocateId(),
					statement: delta.statement.trim(),
					domain: delta.domain,
					status: "proposed",
				};
				this._beliefs.push(belief);
				return belief;
			}
			case "support":
				return this._reclassify(delta.beliefId, ["proposed", "supported"], "supported");
			case "refute":
				return this._reclassify(delta.beliefId, ["proposed", "supported"], "refuted");
			case "refine": {
				const prior = this._require(delta.beliefId, ["proposed", "supported"]);
				validateBelief(delta.statement, prior.domain);
				// Direct set operation (no `replacement` sub-object): the old belief is
				// superseded, and a new belief grounded in the triggering result is added.
				prior.status = "superseded";
				const refined: Belief = {
					id: this._allocateId(),
					statement: delta.statement.trim(),
					domain: prior.domain,
					status: "supported",
				};
				this._beliefs.push(refined);
				return refined;
			}
			case "retract":
				return this._reclassify(delta.beliefId, ["proposed", "supported", "refuted"], "superseded");
		}
	}

	private _allocateId(): string {
		return `belief-${this._nextId++}`;
	}

	private _require(id: string, allowed: BeliefStatus[]): Belief {
		const belief = this.get(id);
		if (!belief) {
			throw new BeliefValidationError(`Unknown belief id: ${id}.`);
		}
		if (!allowed.includes(belief.status)) {
			throw new BeliefValidationError(
				`Belief ${id} is already ${belief.status}; cannot transition from ${belief.status} to ${allowed.join("/")}.`,
			);
		}
		return belief;
	}

	private _reclassify(id: string, allowed: BeliefStatus[], next: BeliefStatus): Belief {
		const belief = this._require(id, allowed);
		belief.status = next;
		return belief;
	}
}

/**
 * Mechanical rules the model faces when it proposes a belief. This is what turns
 * "a set of cognitions" from aspiration into a grip: probe-shaped statements and
 * process records are rejected, so the model must name a product/code referent.
 *
 * The rules split by domain. Code beliefs reject probe-shaped subjects (commands,
 * test files, scripts); product beliefs reject code-internal statements. The
 * shared rules reject experiment records, process records, and bare confirmations.
 * These are heuristics — back them with ablation + gate, not faith (regexes leak).
 */

// Reject experiment records and process records; reuse the Phase 11.5 shapes.
const EXPERIMENT_RECORD = /^(expectation|prediction error)\b/i;
const PROCESS_RECORD =
	/\b(we did not prove|did not prove|budget exhausted|the action completed|not established|within budget|could not be located|no file contains|remain unidentified)\b/i;
// Anchored to the whole statement so "no cache survives logout" is not mistaken for a bare "no".
const BARE_CONFIRMATION = /^(confirmed|refuted|refined|found it|done|success|ok|yes|no)[.!]?$/i;

// A statement whose subject is a probe, not a product/code referent.
const CODE_PROBE_SUBJECT =
	/\b(npm|yarn|pnpm|node|python3?|bash|sh|grep|rg|find|cat|ls|head|tail|sed|awk|git|make)\b|\.sh\b|\.test\b|\.spec\b|scripts?[\\/]/i;

// A statement naming code internals with no observable product behavior.
const CODE_INTERNALS = /\b(function|class|module|import|export|interface|const|let|var|::|=>|\(\))\b|\.[a-z]{2,4}\b/i;

/** Validate a proposed/refined belief statement for its domain. Throws on rejection. */
export function validateBelief(statement: string, domain: BeliefDomain): void {
	const trimmed = statement.trim();
	if (!trimmed) {
		throw new BeliefValidationError("Belief statement must not be empty.");
	}
	if (EXPERIMENT_RECORD.test(trimmed)) {
		throw new BeliefValidationError(
			'Belief must name a world relation, not an experiment record (drop "Expectation:" / "Prediction error:").',
		);
	}
	if (PROCESS_RECORD.test(trimmed)) {
		throw new BeliefValidationError(
			'Belief must name a world fact, not a process record ("we did not prove X", "budget exhausted", …).',
		);
	}
	if (BARE_CONFIRMATION.test(trimmed)) {
		throw new BeliefValidationError("Belief must name what was learned, not a bare confirmation token.");
	}
	if (CODE_PROBE_SUBJECT.test(trimmed)) {
		throw new BeliefValidationError(
			'Belief must name a product/code referent, not a probe (command or test file). State what is true, not "npm test prints PASS".',
		);
	}
	if (domain === "product" && CODE_INTERNALS.test(trimmed)) {
		throw new BeliefValidationError(
			"Product beliefs must name observable behavior, not code internals (symbols/files).",
		);
	}
}

/**
 * Render the live beliefs as a system-prompt block. The block is always present
 * so the model has a stable place to read and update its beliefs; when there is
 * nothing yet it carries a bootstrap instruction that asks the model to speculate
 * initial product + code hypotheses, and once beliefs exist they become the
 * reference every later result is measured against.
 */
export function formatBeliefsForPrompt(beliefs: readonly Belief[]): string {
	if (beliefs.length === 0) {
		return (
			"\n\n[CURRENT BELIEFS]\n" +
			"(no live beliefs)\n" +
			"Bootstrap your investigation by speculating: from the user's question, call declare_belief " +
			"(op=propose) to record your initial hypotheses. Product beliefs (domain=product) name the " +
			"observable behavior you expect; code beliefs (domain=code) name the structure or behavior you " +
			"suspect. Measure every later result against these beliefs — support, refute, or refine them as " +
			"evidence arrives."
		);
	}
	const lines = beliefs.map((b) => `- [${b.domain}] ${b.statement} (${b.status})`);
	return `\n\n[CURRENT BELIEFS]\n${lines.join("\n")}`;
}
