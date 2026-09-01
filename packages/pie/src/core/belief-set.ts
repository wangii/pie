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

export type BeliefDomain = "product" | "code";

/** Routing decision for a request: whether it is suitable for fast-path execution. */
export type RoutingDecision = "fast-path" | "belief-loop";

/** Estimated difficulty of a request for fast-path routing. */
export type RoutingDifficulty = "low" | "medium" | "high";

/**
 * Lifecycle of a belief. `inconclusive` records a failed experiment and remains
 * retryable; support, refutation, refinement, or retraction can still settle it.
 * `status` is derived, not stored.
 */
export type BeliefStatus = "proposed" | "supported" | "refuted" | "inconclusive" | "superseded";

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
	/** Optional skill ids this belief references (e.g. skills the execution role should load). */
	readonly skillRefs?: readonly string[];
	/** Append-only evidence that settled the belief as supported. */
	readonly supportedBy: readonly { evidence: string }[];
	/** Append-only evidence that settled the belief as refuted. */
	readonly refutedBy: readonly { evidence: string }[];
	/** Evidence from an experiment that could not settle this belief. */
	readonly inconclusiveBy: readonly { evidence: string }[];
	/** The id of the belief that superseded this one (`refine`), or the `WITHDRAWN` sentinel (`retract`). */
	readonly supersededBy?: string;
}

export interface Routing {
	readonly id: string;
	readonly statement: string;
	readonly decision: RoutingDecision;
	readonly suitabilityProbability: number;
	readonly successProbability: number;
	readonly estimatedSteps: number;
	readonly difficulty: RoutingDifficulty;
	readonly reason?: string;
}

/** Sentinel `supersededBy` value for a withdrawn (retracted) belief. */
export const WITHDRAWN = "withdrawn";

/**
 * A mutation the model may request. `propose`/`refine` carry a new statement +
 * expectation + evidence-round estimate; `support`/`refute` carry the evidence that
 * settled the belief; `retract` withdraws it.
 */
export type BeliefDelta =
	| {
			op: "propose";
			statement: string;
			domain: BeliefDomain;
			expectation: string;
			evidenceRounds: number;
			skillRefs?: readonly string[];
	  }
	| { op: "support"; beliefId: string; evidence: string }
	| { op: "refute"; beliefId: string; evidence: string }
	| { op: "inconclusive"; beliefId: string; evidence: string }
	| {
			op: "refine";
			beliefId: string;
			statement: string;
			expectation: string;
			evidence: string;
			evidenceRounds: number;
			skillRefs?: readonly string[];
	  }
	| { op: "retract"; beliefId: string };

export interface RoutingDelta {
	readonly op: "route";
	readonly statement: string;
	readonly decision: RoutingDecision;
	readonly suitabilityProbability: number;
	readonly successProbability: number;
	readonly estimatedSteps: number;
	readonly difficulty: RoutingDifficulty;
	readonly reason?: string;
}

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
	if (belief.inconclusiveBy.length > 0) {
		return "inconclusive";
	}
	return "proposed";
}

/** Structural validation for a belief statement. Throws on rejection. */
export function validateBelief(statement: string, domain: BeliefDomain): void {
	if (!statement.trim()) {
		throw new BeliefValidationError("Belief statement must not be empty.");
	}
	if (domain !== "product" && domain !== "code") {
		throw new BeliefValidationError("Belief domain must be 'product' or 'code'.");
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

	/** The unadjudicated world beliefs driving the next experiment. */
	proposed(): Belief[] {
		return this._beliefs.filter((b) => statusOf(b) === "proposed");
	}

	/** Unresolved beliefs that still require a successful experiment. */
	unresolved(): Belief[] {
		return this._beliefs.filter((b) => {
			const status = statusOf(b);
			return status === "proposed" || status === "inconclusive";
		});
	}

	/** Beliefs still actionable: unresolved or supported, not superseded. */
	open(): Belief[] {
		return this._beliefs.filter((b) => {
			const status = statusOf(b);
			return status === "proposed" || status === "inconclusive" || status === "supported";
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
					skillRefs: delta.skillRefs,
					supportedBy: [],
					refutedBy: [],
					inconclusiveBy: [],
				};
				this._beliefs.push(belief);
				return belief;
			}
			case "support":
				return this._adjudicate(delta.beliefId, delta.evidence, "supported");
			case "refute":
				return this._adjudicate(delta.beliefId, delta.evidence, "refuted");
			case "inconclusive":
				return this._adjudicate(delta.beliefId, delta.evidence, "inconclusive");
			case "refine": {
				this._ensureCapacity();
				const prior = this._require(delta.beliefId, ["proposed", "inconclusive", "supported"]);
				validateBelief(delta.statement, prior.domain);
				validateExpectation(delta.expectation);
				validateEvidenceRounds(delta.evidenceRounds);
				const evidence = delta.evidence.trim();
				if (!evidence) {
					throw new BeliefValidationError("Cannot refine without evidence.");
				}
				const refined: Belief = {
					id: this._allocateId(),
					statement: delta.statement.trim(),
					domain: prior.domain,
					expectation: delta.expectation.trim(),
					evidenceRounds: delta.evidenceRounds,
					supportedBy: [{ evidence }],
					refutedBy: [],
					inconclusiveBy: [],
					skillRefs: delta.skillRefs ?? prior.skillRefs,
				};
				this._replace(prior.id, { ...prior, supersededBy: refined.id });
				this._beliefs.push(refined);
				return refined;
			}
			case "retract": {
				const prior = this._require(delta.beliefId, ["proposed", "supported", "refuted", "inconclusive"]);
				return this._replace(prior.id, { ...prior, supersededBy: WITHDRAWN });
			}
		}
	}

	/**
	 * Task-end cleanup: keep only supported world knowledge that still means something
	 * to the next task. Refuted, inconclusive, superseded, and leftover proposed entries are dropped.
	 * Returns the removed records.
	 *
	 * Removed ids are never reused.
	 */
	pruneForNewTask(): Belief[] {
		const removed: Belief[] = [];
		this._beliefs = this._beliefs.filter((b) => {
			const keep = statusOf(b) === "supported";
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
	 * Settle one experiment. A proposed or previously inconclusive belief may be
	 * adjudicated with evidence. Another inconclusive result appends attempt history;
	 * support or refutation settles the belief. This is the R → B′ arrow.
	 */
	private _adjudicate(id: string, evidence: string, sign: "supported" | "refuted" | "inconclusive"): Belief {
		const trimmed = evidence.trim();
		if (!trimmed) {
			throw new BeliefValidationError(`Cannot mark ${sign} without evidence.`);
		}
		const belief = this.get(id);
		if (!belief) {
			throw new BeliefValidationError(`Unknown belief id: ${id}.`);
		}
		const status = statusOf(belief);
		if (status !== "proposed" && status !== "inconclusive") {
			throw new BeliefValidationError(
				`Only an unresolved belief can be adjudicated; belief ${id} is already ${status}.`,
			);
		}
		const entry = { evidence: trimmed };
		const updated =
			sign === "supported"
				? { ...belief, supportedBy: [...belief.supportedBy, entry] }
				: sign === "refuted"
					? { ...belief, refutedBy: [...belief.refutedBy, entry] }
					: { ...belief, inconclusiveBy: [...belief.inconclusiveBy, entry] };
		return this._replace(id, updated);
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

/** Task-scoped routing decisions. Routing is an action record, never epistemic evidence. */
export class RoutingSet {
	private _routings: Routing[] = [];
	private _nextId = 1;

	get routings(): readonly Routing[] {
		return this._routings;
	}

	apply(delta: RoutingDelta): Routing {
		if (this._routings.length >= MAX_BELIEFS) {
			throw new BeliefValidationError(`Routing capacity reached: at most ${MAX_BELIEFS} decisions may be held.`);
		}
		if (!delta.statement.trim()) throw new BeliefValidationError("Routing statement must not be empty.");
		validateRoutingDecision(delta.decision);
		validateRoutingProbability(delta.suitabilityProbability, "suitabilityProbability");
		validateRoutingProbability(delta.successProbability, "successProbability");
		validateRoutingSteps(delta.estimatedSteps);
		validateRoutingDifficulty(delta.difficulty);
		const routing: Routing = {
			id: `routing-${this._nextId++}`,
			statement: delta.statement.trim(),
			decision: delta.decision,
			suitabilityProbability: delta.suitabilityProbability,
			successProbability: delta.successProbability,
			estimatedSteps: delta.estimatedSteps,
			difficulty: delta.difficulty,
			reason: delta.reason,
		};
		this._routings.push(routing);
		return routing;
	}

	clear(): void {
		this._routings = [];
	}
}

/**
 * Render the belief set as structured text for the read-only `view_beliefs` tool — the
 * model's only surface onto beliefs (never injected into the system prompt). The frame
 * is called out with its expectation and evidence-round estimate.
 *
 * Two scopes:
 * - `"all"`: the open frame and settled beliefs.
 * - `"frame"`: only the open frame being probed (statement, expectation, and evidence estimate).
 */
export function formatBeliefsForView(beliefs: readonly Belief[], scope: "all" | "frame" = "all"): string {
	const unresolved = beliefs.filter((b) => {
		const status = statusOf(b);
		return status === "proposed" || status === "inconclusive";
	});
	const lines: string[] = [];
	for (const frame of unresolved) {
		lines.push(`[FRAME] ${frame.id} [${frame.domain}] ${frame.statement}`);
		lines.push(`  expectation: ${frame.expectation}`);
		lines.push(`  evidence rounds: ${frame.evidenceRounds}`);
		for (const attempt of frame.inconclusiveBy) {
			lines.push(`  inconclusive attempt: ${attempt.evidence}`);
		}
		if (frame.skillRefs && frame.skillRefs.length > 0) {
			lines.push(`  skill refs: ${frame.skillRefs.join(", ")}`);
		}
	}
	if (scope === "frame") {
		return lines.length > 0 ? lines.join("\n") : "No open beliefs to probe.";
	}
	const settled = beliefs.filter((b) => {
		const status = statusOf(b);
		return status === "supported" || status === "refuted";
	});
	if (settled.length > 0) {
		lines.push("[SETTLED]");
		for (const b of settled) {
			lines.push(`  ${b.id} [${b.domain}] ${b.statement} (${statusOf(b)})`);
			if (b.skillRefs && b.skillRefs.length > 0) {
				lines.push(`    skill refs: ${b.skillRefs.join(", ")}`);
			}
		}
	}
	return lines.length > 0 ? lines.join("\n") : "No beliefs yet.";
}
