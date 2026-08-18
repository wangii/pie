/**
 * The belief set: the epistemic loop's object — immutable and append-only.
 *
 * A belief is a named relational assertion about product or code, carrying a
 * falsifiable `expectation` and a structured `evidenceRounds` estimate. At most one
 * belief is `proposed` (unadjudicated) at a time: that belief is the *frame*, the
 * single thing the next execution episode must probe.
 *
 * Records are immutable: `support`/`refute` append evidence, `refine`/`retract` mark
 * the prior record superseded and (for `refine`) add a new record. `status` is a
 * derived pure function of that append-only provenance — it is never stored or
 * mutated. Tool results never enter this object; they live in the execution context.
 *
 * Validation is structural only (non-empty, enum membership, identity existence,
 * single-frame invariant, evidence-present, bounded integer) — no regex heuristics,
 * which leak across languages.
 */

export type BeliefDomain = "product" | "code";

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
	/** Append-only evidence that settled the belief as supported. */
	readonly supportedBy: readonly { evidence: string }[];
	/** Append-only evidence that settled the belief as refuted. */
	readonly refutedBy: readonly { evidence: string }[];
	/** The id of the belief that superseded this one (`refine`), or the `WITHDRAWN` sentinel (`retract`). */
	readonly supersededBy?: string;
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
	| { op: "support"; beliefId: string; evidence: string }
	| { op: "refute"; beliefId: string; evidence: string }
	| { op: "refine"; beliefId: string; statement: string; expectation: string; evidenceRounds: number }
	| { op: "retract"; beliefId: string };

/** Thrown when a delta names an invalid statement or an illegal transition. */
export class BeliefValidationError extends Error {}

/** Upper bound on a declared evidence-round estimate (a validation cap, not a horizon). */
export const MAX_EVIDENCE_ROUNDS = 5;

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

/**
 * Mutable-internally, immutable-records belief set. `apply` is the single choke point:
 * every delta is validated and applied as an append-only update (records are replaced
 * with new immutable copies, never mutated in place).
 */
export class BeliefSet {
	private readonly _beliefs: Belief[] = [];
	private _nextId = 1;

	/** All belief records, refuted/superseded negatives included — the full history. */
	get beliefs(): readonly Belief[] {
		return this._beliefs;
	}

	/** The single unadjudicated belief driving action, if any. */
	frame(): Belief | undefined {
		return this._beliefs.find((b) => statusOf(b) === "proposed");
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
				// Single-frame invariant: a new belief may be proposed only after the
				// prior frame is settled (no daydreaming).
				if (this.frame()) {
					throw new BeliefValidationError(
						"A belief is already open; settle it (support/refute/refine) before proposing a new one.",
					);
				}
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
				return this._adjudicate(delta.beliefId, delta.evidence, "supported");
			case "refute":
				return this._adjudicate(delta.beliefId, delta.evidence, "refuted");
			case "refine": {
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
					supportedBy: [{ evidence: `refined from ${prior.id}` }],
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
		}
	}

	/**
	 * Settle the frame. Only an open (`proposed`) belief may be supported/refuted, and
	 * only with evidence — the observed result and how it met or diverged from the
	 * expectation. This is the R → B′ arrow: an action's result is what moves the belief.
	 */
	private _adjudicate(id: string, evidence: string, sign: "supported" | "refuted"): Belief {
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
		const updated =
			sign === "supported"
				? { ...belief, supportedBy: [...belief.supportedBy, { evidence: trimmed }] }
				: { ...belief, refutedBy: [...belief.refutedBy, { evidence: trimmed }] };
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

/**
 * Render the belief set as structured text for the read-only `view_beliefs` tool — the
 * model's only surface onto beliefs (never injected into the system prompt). The frame
 * is called out with its expectation and evidence-round estimate.
 */
export function formatBeliefsForView(beliefs: readonly Belief[]): string {
	if (beliefs.length === 0) {
		return "No beliefs yet.";
	}
	const lines: string[] = [];
	const frame = beliefs.find((b) => statusOf(b) === "proposed");
	if (frame) {
		lines.push(`[FRAME] ${frame.id} [${frame.domain}] ${frame.statement}`);
		lines.push(`  expectation: ${frame.expectation}`);
		lines.push(`  evidence rounds: ${frame.evidenceRounds}`);
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
	return lines.join("\n");
}
