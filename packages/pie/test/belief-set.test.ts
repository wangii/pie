import { describe, expect, test } from "vitest";
import {
	BeliefSet,
	BeliefValidationError,
	formatBeliefsForView,
	MAX_BELIEFS,
	RoutingSet,
	statusOf,
	validateBelief,
	validateEvidenceRounds,
	validateExpectation,
	WITHDRAWN,
} from "../src/core/belief-set.ts";

const propose = (set: BeliefSet, statement = "authorizationSource returns stale-replica") =>
	set.apply({
		op: "propose",
		statement,
		domain: "code",
		expectation: "reading the implementation shows stale-replica",
		evidenceRounds: 1,
	});

describe("BeliefSet", () => {
	test("stores multiple provisional world beliefs", () => {
		const set = new BeliefSet();
		propose(set);
		set.apply({
			op: "propose",
			statement: "logout preserves the cache",
			domain: "product",
			expectation: "a post-logout read returns the cached value",
			evidenceRounds: 2,
		});

		expect(set.proposed()).toHaveLength(2);
		expect(set.beliefs.map((belief) => belief.id)).toEqual(["belief-1", "belief-2"]);
	});

	test("support and refute adjudicate only from evidence", () => {
		const supportedSet = new BeliefSet();
		const supported = propose(supportedSet);
		expect(() => supportedSet.apply({ op: "support", beliefId: supported.id, evidence: "" })).toThrow(
			BeliefValidationError,
		);
		const supportResult = supportedSet.apply({
			op: "support",
			beliefId: supported.id,
			evidence: "the implementation returned stale-replica as predicted",
		});
		expect(statusOf(supportResult)).toBe("supported");

		const refutedSet = new BeliefSet();
		const refuted = propose(refutedSet);
		const refuteResult = refutedSet.apply({
			op: "refute",
			beliefId: refuted.id,
			evidence: "the implementation always reads the primary",
		});
		expect(statusOf(refuteResult)).toBe("refuted");
	});

	test("records an inconclusive experiment as distinct from truth adjudication", () => {
		const set = new BeliefSet();
		const belief = propose(set);
		const result = set.apply({
			op: "inconclusive",
			beliefId: belief.id,
			evidence: "the dependency failed before the referent was observed",
		});

		expect(statusOf(result)).toBe("inconclusive");
		expect(result.supportedBy).toHaveLength(0);
		expect(result.refutedBy).toHaveLength(0);
		expect(result.inconclusiveBy).toHaveLength(1);
		expect(set.proposed()).toHaveLength(0);
		expect(set.unresolved()).toEqual([result]);
	});

	test("retries an inconclusive belief until later evidence settles it", () => {
		const set = new BeliefSet();
		const belief = propose(set);
		set.apply({ op: "inconclusive", beliefId: belief.id, evidence: "the first probe timed out" });
		const retried = set.apply({
			op: "inconclusive",
			beliefId: belief.id,
			evidence: "the second probe lacked permission",
		});
		expect(retried.inconclusiveBy).toHaveLength(2);

		const settled = set.apply({
			op: "support",
			beliefId: belief.id,
			evidence: "the third probe observed the expected implementation",
		});
		expect(statusOf(settled)).toBe("supported");
		expect(set.unresolved()).toHaveLength(0);

		const refutedSet = new BeliefSet();
		const refuted = propose(refutedSet, "retry then refute");
		refutedSet.apply({ op: "inconclusive", beliefId: refuted.id, evidence: "first probe failed" });
		expect(
			statusOf(refutedSet.apply({ op: "refute", beliefId: refuted.id, evidence: "retry contradicted it" })),
		).toBe("refuted");

		const refinedSet = new BeliefSet();
		const refined = propose(refinedSet, "retry then refine");
		refinedSet.apply({ op: "inconclusive", beliefId: refined.id, evidence: "first probe failed" });
		const replacement = refinedSet.apply({
			op: "refine",
			beliefId: refined.id,
			statement: "refined after retry",
			expectation: "the retry observes the refined relation",
			evidence: "the retry exposed a more precise relation",
			evidenceRounds: 1,
		});
		expect(statusOf(replacement)).toBe("supported");
		expect(statusOf(refinedSet.get(refined.id)!)).toBe("superseded");
	});

	test("refine can directly form an evidence-supported world-model correction", () => {
		const set = new BeliefSet();
		const prior = propose(set, "authentication is one mechanism");
		const refined = set.apply({
			op: "refine",
			beliefId: prior.id,
			statement: "authentication has OAuth, session, and API-token mechanisms",
			expectation: "the mechanisms have distinct handlers",
			evidence: "three distinct handlers were observed",
			evidenceRounds: 1,
		});

		expect(statusOf(set.get(prior.id)!)).toBe("superseded");
		expect(set.get(prior.id)?.supersededBy).toBe(refined.id);
		expect(statusOf(refined)).toBe("supported");
		expect(refined.supportedBy).toEqual([{ evidence: "three distinct handlers were observed" }]);
	});

	test("rejects refinement without material evidence", () => {
		const set = new BeliefSet();
		const prior = propose(set);
		expect(() =>
			set.apply({
				op: "refine",
				beliefId: prior.id,
				statement: "authorizationSource reads the primary",
				expectation: "reading the implementation shows a primary read",
				evidence: " ",
				evidenceRounds: 1,
			}),
		).toThrow(/Cannot refine without evidence/);
	});

	test("retract withdraws a belief without asserting its negation", () => {
		const set = new BeliefSet();
		const belief = propose(set);
		const withdrawn = set.apply({ op: "retract", beliefId: belief.id });
		expect(statusOf(withdrawn)).toBe("superseded");
		expect(withdrawn.supersededBy).toBe(WITHDRAWN);
	});

	test("rejects repeated adjudication and unknown ids", () => {
		const set = new BeliefSet();
		const belief = propose(set);
		set.apply({ op: "support", beliefId: belief.id, evidence: "matched" });
		expect(() => set.apply({ op: "refute", beliefId: belief.id, evidence: "later claim" })).toThrow(
			/Only an unresolved belief/,
		);
		expect(() => set.apply({ op: "support", beliefId: "belief-99", evidence: "x" })).toThrow(/Unknown belief id/);
	});

	test("prunes task-local negatives and uncertainty but retains supported knowledge", () => {
		const set = new BeliefSet();
		const supported = propose(set, "supported relation");
		set.apply({ op: "support", beliefId: supported.id, evidence: "matched" });
		const refuted = propose(set, "refuted relation");
		set.apply({ op: "refute", beliefId: refuted.id, evidence: "contradicted" });
		const inconclusive = propose(set, "unsettled relation");
		set.apply({ op: "inconclusive", beliefId: inconclusive.id, evidence: "probe blocked" });
		propose(set, "leftover open relation");

		const removed = set.pruneForNewTask();
		expect(set.beliefs.map((belief) => belief.statement)).toEqual(["supported relation"]);
		expect(removed).toHaveLength(3);
	});

	test("enforces the record capacity", () => {
		const set = new BeliefSet();
		for (let index = 0; index < MAX_BELIEFS; index++) propose(set, `belief ${index}`);
		expect(() => propose(set, "overflow")).toThrow(/capacity reached/);
	});
});

describe("belief validation", () => {
	test("accepts product and code domains", () => {
		expect(() => validateBelief("relation", "product")).not.toThrow();
		expect(() => validateBelief("relation", "code")).not.toThrow();
	});

	test("rejects empty statements and expectations", () => {
		expect(() => validateBelief("", "code")).toThrow(BeliefValidationError);
		expect(() => validateExpectation("  ")).toThrow(BeliefValidationError);
	});

	test("validates evidence-round estimates", () => {
		expect(() => validateEvidenceRounds(1)).not.toThrow();
		expect(() => validateEvidenceRounds(5)).not.toThrow();
		expect(() => validateEvidenceRounds(0)).toThrow(BeliefValidationError);
		expect(() => validateEvidenceRounds(1.5)).toThrow(BeliefValidationError);
	});
});

describe("RoutingSet", () => {
	test("stores routing as task control metadata, not a belief", () => {
		const set = new RoutingSet();
		const routing = set.apply({
			op: "route",
			statement: "no material uncertainty remains",
			decision: "fast-path",
			suitabilityProbability: 0.9,
			successProbability: 0.8,
			estimatedSteps: 2,
			difficulty: "low",
			reason: "the action is read-only and epistemically closed",
		});

		expect(routing.id).toBe("routing-1");
		expect(set.routings).toHaveLength(1);
		set.clear();
		expect(set.routings).toHaveLength(0);
	});
});

describe("formatBeliefsForView", () => {
	test("renders open and adjudicated beliefs without control metadata", () => {
		const set = new BeliefSet();
		const supported = propose(set, "supported relation");
		set.apply({ op: "support", beliefId: supported.id, evidence: "matched" });
		propose(set, "open relation");

		const text = formatBeliefsForView(set.beliefs);
		expect(text).toContain("[FRAME]");
		expect(text).toContain("[SETTLED]");
		expect(text).not.toContain("FRAMING");
		expect(text).not.toContain("routing");
	});

	test("renders inconclusive attempts in the open frame", () => {
		const set = new BeliefSet();
		const belief = propose(set, "retryable relation");
		set.apply({ op: "inconclusive", beliefId: belief.id, evidence: "probe timed out" });

		const text = formatBeliefsForView(set.beliefs, "frame");
		expect(text).toContain("[FRAME]");
		expect(text).toContain("inconclusive attempt: probe timed out");
	});
});
