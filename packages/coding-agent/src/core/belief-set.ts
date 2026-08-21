/**
 * The belief set: the epistemic loop's object — immutable records, append-only except for
 * the single task-end pruning operation (`pruneForNewTask`).
 *
 * A belief is a named relational assertion about product or code, carrying a
 * falsifiable `expectation` and a structured `evidenceRounds` estimate. Any number
 * of beliefs may be `proposed` (unadjudicated) at once: those open beliefs are the
 * *frame* — the set of beliefs the next execution episode probes. Each is
 * validated independently, so a batch of proposals is legal as long as every one
 * passes its own structural rules.
 *
 * Records are immutable: `support`/`refute` append evidence, `refine`/`retract` mark
 * the prior record superseded and (for `refine`) add a new record. `status` is a
 * derived pure function of that append-only provenance — it is never stored or
 * mutated. Tool results never enter this object; they live in the execution context.
 *
 * Validation is structural only (non-empty, enum membership, identity existence,
 * evidence-present, bounded integer) — no regex heuristics, which leak across
 * languages.
 */

export type BeliefDomain = "product" | "code" | "framing" | "routing";

/** Routing decision for a request: whether it is suitable for fast-path execution. */
export type RoutingDecision = "fast-path" | "belief-loop";

/** Estimated difficulty of a request for fast-path routing. */
export type RoutingDifficulty = "low" | "medium" | "high";

/**
 * Lifecycle of a belief. Monotone in one direction:
 * `proposed → supported | refuted → superseded`. `status` is derived, not stored.
 */
export type BeliefStatus = "proposed" | "supported" | "refuted" | "superseded";

export interface Belief {
	/** Stable within a session; assigned by the BeliefSet, never persisted separately. */
	readonly id: string;
	/** The frozen relation assertion in prose, e.g. "authorizationSource returns stale-replica". */
	readonly statement: string;
	/** Author-declared at proposal time — never inferred later. */
	readonly domain: BeliefDomain;
	/** The falsifiable prediction: what observing the referent will show if the belief is true. */
	readonly expectation: string;
	/** Structured evidence-round estimate: how many tool results this test needs. */
	readonly evidenceRounds: number;
	/** Append-only evidence that settled the belief as supported. A framing belief's entries
	 *  also carry the ids of the product/code beliefs whose support discharged the obligation. */
	readonly supportedBy: readonly { evidence: string; beliefIds?: readonly string[] }[];
	/** Append-only evidence that settled the belief as refuted. */
	readonly refutedBy: readonly { evidence: string }[];
	/** The id of the belief that superseded this one (`refine`), or the `WITHDRAWN` sentinel (`retract`). */
	readonly supersededBy?: string;
	/** Routing fields, present only for domain "routing". */
	readonly decision?: RoutingDecision;
	readonly suitabilityProbability?: number;
	readonly successProbability?: number;
	readonly estimatedSteps?: number;
	readonly difficulty?: RoutingDifficulty;
}

/** Sentinel `supersededBy` value for a withdrawn (retracted) belief. */
export const WITHDRAWN = "withdrawn";

/**
 * A mutation the model may request. `propose`/`refine` carry a new statement +
 * expectation + evidence-round estimate; `support`/`refute` carry the evidence that
 * settled the belief; `retract` withdraws it.
 */
export type BeliefDelta =
	| { op: "propose"; statement: string; domain: BeliefDomain; expectation: string; evidenceRounds: number }
	| { op: "support"; beliefId: string; evidence: string; evidenceBeliefIds?: readonly string[] }
	| { op: "refute"; beliefId: string; evidence: string }
	| { op: "refine"; beliefId: string; statement: string; expectation: string; evidenceRounds: number }
	| { op: "retract"; beliefId: string }
	| {
			op: "route";
			statement: string;
			expectation: string;
			decision: RoutingDecision;
			suitabilityProbability: number;
			successProbability: number;
			estimatedSteps: number;
			difficulty: RoutingDifficulty;
	  };

/** Thrown when a delta names an invalid statement or an illegal transition. */
export class BeliefValidationError extends Error {}

/** Upper bound on a declared evidence-round estimate (a validation cap, not a horizon). */
export const MAX_EVIDENCE_ROUNDS = 5;

/** Upper bound on belief records held at once. The 200th may be added; the 201st is rejected. */
export const MAX_BELIEFS = 200;

/** Derive a belief's status from its append-only provenance. Never stored. */
export function statusOf(belief: Belief): BeliefStatus {
	if (belief.supersededBy !== undefined) {
		return "superseded";
	}
	if (belief.refutedBy.length > 0) {
		return "refuted";
	}
	if (belief.supportedBy.length > 0) {
		return "supported";
	}
	return "proposed";
}

/** Structural validation for a belief statement. Throws on rejection. */
export function validateBelief(statement: string, domain: BeliefDomain): void {
	if (!statement.trim()) {
		throw new BeliefValidationError("Belief statement must not be empty.");
	}
	if (domain !== "product" && domain !== "code" && domain !== "framing" && domain !== "routing") {
		throw new BeliefValidationError("Belief domain must be 'product', 'code', 'framing', or 'routing'.");
	}
}

/** Structural validation for a falsifiable expectation. Throws on rejection. */
export function validateExpectation(expectation: string): void {
	if (!expectation.trim()) {
		throw new BeliefValidationError("Belief expectation must not be empty.");
	}
}

/** Structural validation for the evidence-round estimate. Throws on rejection. */
export function validateEvidenceRounds(evidenceRounds: number): void {
	if (!Number.isSafeInteger(evidenceRounds) || evidenceRounds < 1 || evidenceRounds > MAX_EVIDENCE_ROUNDS) {
		throw new BeliefValidationError(`evidenceRounds must be an integer from 1 to ${MAX_EVIDENCE_ROUNDS}.`);
	}
}

/** Structural validation for a routing decision. Throws on rejection. */
export function validateRoutingDecision(decision: RoutingDecision): void {
	if (decision !== "fast-path" && decision !== "belief-loop") {
		throw new BeliefValidationError("decision must be 'fast-path' or 'belief-loop'.");
	}
}

/** Structural validation for a routing probability field. Throws on rejection. */
export function validateRoutingProbability(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new BeliefValidationError(`${name} must be a number between 0 and 1.`);
	}
}

/** Structural validation for the routing step estimate. Throws on rejection. */
export function validateRoutingSteps(steps: number): void {
	if (!Number.isSafeInteger(steps) || steps < 0 || steps > 100) {
		throw new BeliefValidationError("estimatedSteps must be an integer from 0 to 100.");
	}
}

/** Structural validation for the routing difficulty. Throws on rejection. */
export function validateRoutingDifficulty(difficulty: RoutingDifficulty): void {
	if (difficulty !== "low" && difficulty !== "medium" && difficulty !== "high") {
		throw new BeliefValidationError("difficulty must be 'low', 'medium', or 'high'.");
	}
}

/**
 * Mutable-internally, immutable-records belief set. `apply` is the single choke point:
 * every delta is validated and applied as an append-only update (records are replaced
 * with new immutable copies, never mutated in place). The one exception is
 * `pruneForNewTask`, the task-boundary cleanup that drops records whose provenance no
 * longer carries meaning across tasks.
 */
export class BeliefSet {
	private _beliefs: Belief[] = [];
	private _nextId = 1;

	/** All belief records currently held; negatives and ephemera are removed at task end by `pruneForNewTask`. */
	get beliefs(): readonly Belief[] {
		return this._beliefs;
	}

	/**
	 * The unadjudicated *world* beliefs driving action — the open frame (may be empty or hold
	 * several). Framing and routing beliefs are excluded: they are obligations/decisions, never
	 * dispatch targets.
	 */
	proposed(): Belief[] {
		return this._beliefs.filter(
			(b) => statusOf(b) === "proposed" && b.domain !== "framing" && b.domain !== "routing",
		);
	}

	/** The unadjudicated framing beliefs — open obligations for what the final answer must establish. */
	framings(): Belief[] {
		return this._beliefs.filter((b) => statusOf(b) === "proposed" && b.domain === "framing");
	}

	/** Beliefs still actionable: proposed or supported, not superseded. */
	open(): Belief[] {
		return this._beliefs.filter((b) => {
			const status = statusOf(b);
			return status === "proposed" || status === "supported";
		});
	}

	get(id: string): Belief | undefined {
		return this._beliefs.find((b) => b.id === id);
	}

	apply(delta: BeliefDelta): Belief {
		switch (delta.op) {
			case "propose": {
				// Any number of beliefs may be open at once; each is validated on its own.
				this._ensureCapacity();
				validateBelief(delta.statement, delta.domain);
				validateExpectation(delta.expectation);
				validateEvidenceRounds(delta.evidenceRounds);
				const belief: Belief = {
					id: this._allocateId(),
					statement: delta.statement.trim(),
					domain: delta.domain,
					expectation: delta.expectation.trim(),
					evidenceRounds: delta.evidenceRounds,
					supportedBy: [],
					refutedBy: [],
				};
				this._beliefs.push(belief);
				return belief;
			}
			case "support":
				return this._adjudicate(delta.beliefId, delta.evidence, "supported", delta.evidenceBeliefIds);
			case "refute":
				return this._adjudicate(delta.beliefId, delta.evidence, "refuted");
			case "refine": {
				this._ensureCapacity();
				const prior = this._require(delta.beliefId, ["proposed", "supported"]);
				validateBelief(delta.statement, prior.domain);
				validateExpectation(delta.expectation);
				validateEvidenceRounds(delta.evidenceRounds);
				const refined: Belief = {
					id: this._allocateId(),
					statement: delta.statement.trim(),
					domain: prior.domain,
					expectation: delta.expectation.trim(),
					evidenceRounds: delta.evidenceRounds,
					// A refinement is a corrected hypothesis that still needs probing, not a
					// settled result — its new expectation has no evidence yet. Provenance is
					// carried by the prior record's `supersededBy` pointer, never as a fabricated
					// `supportedBy` entry (which would falsely mark it supported and drop it out
					// of the dispatch frame).
					supportedBy: [],
					refutedBy: [],
				};
				this._replace(prior.id, { ...prior, supersededBy: refined.id });
				this._beliefs.push(refined);
				return refined;
			}
			case "retract": {
				const prior = this._require(delta.beliefId, ["proposed", "supported", "refuted"]);
				return this._replace(prior.id, { ...prior, supersededBy: WITHDRAWN });
			}
			case "route": {
				// A routing belief is created settled: it records this request's routing decision and
				// never enters the dispatch frame (see `proposed()`). Its evidence is the decision.
				this._ensureCapacity();
				validateBelief(delta.statement, "routing");
				validateExpectation(delta.expectation);
				validateRoutingDecision(delta.decision);
				validateRoutingProbability(delta.suitabilityProbability, "suitabilityProbability");
				validateRoutingProbability(delta.successProbability, "successProbability");
				validateRoutingSteps(delta.estimatedSteps);
				validateRoutingDifficulty(delta.difficulty);
				const belief: Belief = {
					id: this._allocateId(),
					statement: delta.statement.trim(),
					domain: "routing",
					expectation: delta.expectation.trim(),
					evidenceRounds: 1,
					supportedBy: [
						{
							evidence: `decision=${delta.decision} suitability=${delta.suitabilityProbability} success=${delta.successProbability} steps=${delta.estimatedSteps} difficulty=${delta.difficulty}`,
						},
					],
					refutedBy: [],
					decision: delta.decision,
					suitabilityProbability: delta.suitabilityProbability,
					successProbability: delta.successProbability,
					estimatedSteps: delta.estimatedSteps,
					difficulty: delta.difficulty,
				};
				this._beliefs.push(belief);
				return belief;
			}
		}
	}

	/**
	 * Task-end cleanup: keep only settled product/code knowledge that still means something
	 * to the next task. Everything else — framing obligations, routing decisions, refuted
	 * and superseded records, and any abnormally leftover proposed entries — is dropped.
	 * Returns the removed records.
	 *
	 * Safe against dangling references: the only records that reference others by id are
	 * framing supports (`beliefIds`), and framing records are exactly the ones removed, so
	 * no surviving belief references a removed one. Removed ids are never reused.
	 */
	pruneForNewTask(): Belief[] {
		const removed: Belief[] = [];
		this._beliefs = this._beliefs.filter((b) => {
			const keep = statusOf(b) === "supported" && (b.domain === "product" || b.domain === "code");
			if (!keep) {
				removed.push(b);
			}
			return keep;
		});
		return removed;
	}

	private _ensureCapacity(): void {
		if (this._beliefs.length >= MAX_BELIEFS) {
			throw new BeliefValidationError(
				`Belief set capacity reached: at most ${MAX_BELIEFS} beliefs may be held; settle or complete the task to free records.`,
			);
		}
	}

	/**
	 * Settle the frame. Only an open (`proposed`) belief may be supported/refuted, and
	 * only with evidence — the observed result and how it met or diverged from the
	 * expectation. This is the R → B′ arrow: an action's result is what moves the belief.
	 */
	private _adjudicate(
		id: string,
		evidence: string,
		sign: "supported" | "refuted",
		evidenceBeliefIds?: readonly string[],
	): Belief {
		const trimmed = evidence.trim();
		if (!trimmed) {
			throw new BeliefValidationError(`Cannot ${sign === "supported" ? "support" : "refute"} without evidence.`);
		}
		const belief = this.get(id);
		if (!belief) {
			throw new BeliefValidationError(`Unknown belief id: ${id}.`);
		}
		if (statusOf(belief) !== "proposed") {
			throw new BeliefValidationError(
				`Only an open belief can be ${sign === "supported" ? "supported" : "refuted"}; belief ${id} is already ${statusOf(belief)}.`,
			);
		}
		// A framing belief is discharged only by supported product/code beliefs that establish
		// the obligation — the structural conclude gate cannot see whether the obligation was
		// actually satisfied, so the discharge link is enforced here instead of trusting a
		// bare evidence string. Refuting, refining, or retracting a framing keeps its original
		// semantics; only `support` requires the reference list.
		const beliefIds =
			sign === "supported" && belief.domain === "framing"
				? this._validateFramingDischarge(id, evidenceBeliefIds)
				: undefined;
		const entry = beliefIds !== undefined ? { evidence: trimmed, beliefIds } : { evidence: trimmed };
		const updated =
			sign === "supported"
				? { ...belief, supportedBy: [...belief.supportedBy, entry] }
				: { ...belief, refutedBy: [...belief.refutedBy, { evidence: trimmed }] };
		return this._replace(id, updated);
	}

	/** Validate a framing belief's discharge references: at least one id, all existing, all
	 *  product/code (never framing), all already supported. Returns the ids to persist. */
	private _validateFramingDischarge(id: string, evidenceBeliefIds?: readonly string[]): readonly string[] {
		const ids = evidenceBeliefIds ?? [];
		if (ids.length === 0) {
			throw new BeliefValidationError(
				`Supporting framing belief ${id} requires \`evidenceBeliefIds\`: reference the product/code beliefs that establish this obligation.`,
			);
		}
		const missing = ids.filter((refId) => !this.get(refId));
		if (missing.length > 0) {
			throw new BeliefValidationError(`Unknown belief id in evidenceBeliefIds: ${missing.join(", ")}.`);
		}
		const framingRefs = ids.filter((refId) => this.get(refId)!.domain === "framing");
		if (framingRefs.length > 0) {
			throw new BeliefValidationError(
				`evidenceBeliefIds must reference product/code beliefs, not framing beliefs: ${framingRefs.join(", ")}.`,
			);
		}
		const unsupported = ids.filter((refId) => statusOf(this.get(refId)!) !== "supported");
		if (unsupported.length > 0) {
			throw new BeliefValidationError(
				`evidenceBeliefIds must reference supported beliefs; these are not supported yet: ${unsupported.join(", ")}.`,
			);
		}
		return ids;
	}

	private _replace(id: string, next: Belief): Belief {
		const index = this._beliefs.findIndex((b) => b.id === id);
		this._beliefs[index] = next;
		return next;
	}

	private _require(id: string, allowed: BeliefStatus[]): Belief {
		const belief = this.get(id);
		if (!belief) {
			throw new BeliefValidationError(`Unknown belief id: ${id}.`);
		}
		if (!allowed.includes(statusOf(belief))) {
			throw new BeliefValidationError(
				`Belief ${id} is ${statusOf(belief)}; cannot transition to ${allowed.join("/")}.`,
			);
		}
		return belief;
	}

	private _allocateId(): string {
		return `belief-${this._nextId++}`;
	}
}

/**
 * Render the belief set as structured text for the read-only `view_beliefs` tool — the
 * model's only surface onto beliefs (never injected into the system prompt). The frame
 * is called out with its expectation and evidence-round estimate.
 *
 * Two scopes:
 * - `"all"` (the epistemic role): the full set — the frame, the framing obligations, and the
 *   settled beliefs.
 * - `"frame"` (the execution role): only the open frame it is probing (statement + expectation
 *   + evidence-round estimate). Settled history and framing obligations are the epistemic
 *   role's object, not the probe target, and dumping them here only invites the probe role to
 *   step out of its lane.
 */
export function formatBeliefsForView(beliefs: readonly Belief[], scope: "all" | "frame" = "all"): string {
	const proposed = beliefs.filter((b) => statusOf(b) === "proposed");
	const frames = proposed.filter((b) => b.domain !== "framing");
	const lines: string[] = [];
	for (const frame of frames) {
		lines.push(`[FRAME] ${frame.id} [${frame.domain}] ${frame.statement}`);
		lines.push(`  expectation: ${frame.expectation}`);
		lines.push(`  evidence rounds: ${frame.evidenceRounds}`);
	}
	if (scope === "frame") {
		return lines.length > 0 ? lines.join("\n") : "No open beliefs to probe.";
	}
	const framings = proposed.filter((b) => b.domain === "framing");
	for (const framing of framings) {
		lines.push(`[FRAMING] ${framing.id} ${framing.statement}`);
		lines.push(`  reframe if: ${framing.expectation}`);
	}
	const settled = beliefs.filter((b) => {
		const status = statusOf(b);
		return status === "supported" || status === "refuted";
	});
	if (settled.length > 0) {
		lines.push("[SETTLED]");
		for (const b of settled) {
			lines.push(`  ${b.id} [${b.domain}] ${b.statement} (${statusOf(b)})`);
		}
	}
	return lines.length > 0 ? lines.join("\n") : "No beliefs yet.";
}
