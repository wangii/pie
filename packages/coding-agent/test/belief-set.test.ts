import { describe, expect, test } from "vitest";
import {
	BeliefSet,
	BeliefValidationError,
	formatBeliefsForView,
	MAX_EVIDENCE_ROUNDS,
	statusOf,
	validateBelief,
	validateEvidenceRounds,
	validateExpectation,
} from "../src/core/belief-set.ts";

describe("BeliefSet status machine (immutable, derived status)", () => {
	test("propose opens a frame with domain, expectation, and evidence rounds", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "authorizationSource(1003,1001) returns stale-replica",
			domain: "code",
			expectation: "reading authorizationSource shows a stale replica",
			evidenceRounds: 2,
		});

		expect(belief.id).toBe("belief-1");
		expect(statusOf(belief)).toBe("proposed");
		expect(belief.expectation).toContain("stale replica");
		expect(belief.evidenceRounds).toBe(2);
		expect(set.proposed().map((b) => b.id)).toEqual(["belief-1"]);
		expect(set.open()).toHaveLength(1);
	});

	test("support appends evidence and derives supported status", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache survives logout for 30s",
			domain: "product",
			expectation: "value persists 30s",
			evidenceRounds: 1,
		});

		const settled = set.apply({ op: "support", beliefId: belief.id, evidence: "the probe kept the value for 30s" });
		expect(statusOf(settled)).toBe("supported");
		expect(set.proposed()).toHaveLength(0);
		expect(set.open()).toHaveLength(1);
	});

	test("refute appends evidence and derives refuted status", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "value persists",
			evidenceRounds: 1,
		});

		set.apply({ op: "refute", beliefId: belief.id, evidence: "the value cleared on logout" });
		expect(statusOf(set.get(belief.id)!)).toBe("refuted");
		expect(set.proposed()).toHaveLength(0);
		expect(set.open()).toHaveLength(0);
	});

	test("multiple open beliefs are allowed (no single-frame invariant)", () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});
		set.apply({
			op: "propose",
			statement: "login is stateless",
			domain: "product",
			expectation: "no session reuse",
			evidenceRounds: 1,
		});

		expect(set.proposed().map((b) => b.statement)).toEqual(["the cache is warm", "login is stateless"]);
	});

	test("framing beliefs are obligations, excluded from the open frame", () => {
		const set = new BeliefSet();
		const framing = set.apply({
			op: "propose",
			statement: "the answer must establish whether it is one bug or two",
			domain: "framing",
			expectation: "no second independent mechanism",
			evidenceRounds: 1,
		});
		const world = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});

		// The open frame holds only the dispatchable world belief; framing is a separate obligation.
		expect(set.proposed().map((b) => b.id)).toEqual([world.id]);
		expect(set.framings().map((b) => b.id)).toEqual([framing.id]);
		expect(
			set
				.open()
				.map((b) => b.id)
				.sort(),
		).toEqual([framing.id, world.id].sort());
	});

	test("each proposal in a batch is still validated individually", () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});

		// A second proposal with an empty statement is rejected even though one is already open.
		expect(() =>
			set.apply({
				op: "propose",
				statement: "  ",
				domain: "code",
				expectation: "x",
				evidenceRounds: 1,
			}),
		).toThrow(BeliefValidationError);
	});

	test("support/refute require evidence", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});

		expect(() => set.apply({ op: "support", beliefId: belief.id, evidence: "  " })).toThrow(BeliefValidationError);
		expect(() => set.apply({ op: "refute", beliefId: belief.id, evidence: "" })).toThrow(BeliefValidationError);
	});

	test("support/refute are restricted to the open frame", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: belief.id, evidence: "reads hit cache" });

		expect(() => set.apply({ op: "support", beliefId: belief.id, evidence: "again" })).toThrow(BeliefValidationError);
	});

	test("refine supersedes the prior belief and adds a proposed replacement", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the worker cache is the cause",
			domain: "code",
			expectation: "disabling cache stops staleness",
			evidenceRounds: 1,
		});

		const refined = set.apply({
			op: "refine",
			beliefId: belief.id,
			statement: "stale-replica from the worker cache is the cause",
			expectation: "the stale value matches the worker cache entry",
			evidenceRounds: 1,
		});

		expect(statusOf(set.get(belief.id)!)).toBe("superseded");
		expect(statusOf(refined)).toBe("proposed");
		// The refined belief is a new hypothesis: it must re-enter the dispatch frame
		// (`proposed()`), not be pre-settled without evidence.
		expect(set.proposed().map((b) => b.id)).toEqual([refined.id]);
	});

	test("retract withdraws a belief", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});

		set.apply({ op: "retract", beliefId: belief.id });
		expect(statusOf(set.get(belief.id)!)).toBe("superseded");
		expect(set.proposed()).toHaveLength(0);
	});

	test("illegal transitions and unknown ids throw", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});

		expect(() => set.apply({ op: "support", beliefId: "missing", evidence: "x" })).toThrow(BeliefValidationError);

		set.apply({ op: "refute", beliefId: belief.id, evidence: "reads missed" });
		expect(() => set.apply({ op: "support", beliefId: belief.id, evidence: "x" })).toThrow(BeliefValidationError);
	});

	test("records are immutable — the original belief object is not mutated by support", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});

		set.apply({ op: "support", beliefId: belief.id, evidence: "reads hit cache" });

		// The frozen record still reads as proposed; the set's current record is supported.
		expect(statusOf(belief)).toBe("proposed");
		expect(statusOf(set.get(belief.id)!)).toBe("supported");
	});
});

describe("validateBelief (structural)", () => {
	test("accepts a code relation and a product relation", () => {
		expect(() => validateBelief("authorizationSource returns stale-replica", "code")).not.toThrow();
		expect(() => validateBelief("worker-local cache survives logout for 30s", "product")).not.toThrow();
	});

	test("rejects empty statements and unknown domains", () => {
		expect(() => validateBelief("", "code")).toThrow(BeliefValidationError);
		expect(() => validateBelief("x", "bogus" as "code")).toThrow(BeliefValidationError);
	});

	test("accepts a framing domain", () => {
		expect(() => validateBelief("the answer must establish X", "framing")).not.toThrow();
	});
});

describe("validateExpectation", () => {
	test("accepts a falsifiable prediction", () => {
		expect(() => validateExpectation("reading authorizationSource shows a stale replica")).not.toThrow();
	});

	test("rejects empty expectations", () => {
		expect(() => validateExpectation("")).toThrow(BeliefValidationError);
	});
});

describe("validateEvidenceRounds", () => {
	test("accepts a bounded integer", () => {
		expect(() => validateEvidenceRounds(1)).not.toThrow();
		expect(() => validateEvidenceRounds(MAX_EVIDENCE_ROUNDS)).not.toThrow();
	});

	test("rejects zero, non-integers, and out-of-range values", () => {
		expect(() => validateEvidenceRounds(0)).toThrow(BeliefValidationError);
		expect(() => validateEvidenceRounds(1.5)).toThrow(BeliefValidationError);
		expect(() => validateEvidenceRounds(MAX_EVIDENCE_ROUNDS + 1)).toThrow(BeliefValidationError);
	});
});

describe("formatBeliefsForView", () => {
	test("renders a placeholder for no beliefs", () => {
		expect(formatBeliefsForView([])).toContain("No beliefs");
	});

	test("calls out the frame with expectation and evidence rounds", () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "authorizationSource returns stale-replica",
			domain: "code",
			expectation: "reading it shows a stale replica",
			evidenceRounds: 2,
		});
		const text = formatBeliefsForView(set.beliefs);
		expect(text).toContain("[FRAME]");
		expect(text).toContain("stale replica");
		expect(text).toContain("evidence rounds: 2");
	});

	test("lists settled beliefs separately", () => {
		const set = new BeliefSet();
		const b = set.apply({
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "value persists",
			evidenceRounds: 1,
		});
		set.apply({ op: "refute", beliefId: b.id, evidence: "value cleared" });
		const text = formatBeliefsForView(set.beliefs);
		expect(text).toContain("[SETTLED]");
		expect(text).toContain("the cache survives logout");
	});

	test("renders framing obligations separately from dispatchable frames", () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the answer must establish X",
			domain: "framing",
			expectation: "no second mechanism",
			evidenceRounds: 1,
		});
		set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});
		const text = formatBeliefsForView(set.beliefs);
		expect(text).toContain("[FRAMING]");
		expect(text).toContain("[FRAME]");
		expect(text).toContain("reframe if:");
	});

	test('scope "frame" renders only the open frame, not framing obligations or settled history', () => {
		const set = new BeliefSet();
		const settled = set.apply({
			op: "propose",
			statement: "the old belief",
			domain: "product",
			expectation: "stale",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: settled.id, evidence: "held" });
		set.apply({
			op: "propose",
			statement: "the answer must establish Y",
			domain: "framing",
			expectation: "no second mechanism",
			evidenceRounds: 1,
		});
		set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit cache",
			evidenceRounds: 1,
		});

		const frame = formatBeliefsForView(set.beliefs, "frame");
		expect(frame).toContain("[FRAME]");
		expect(frame).toContain("the cache is warm");
		expect(frame).toContain("expectation: reads hit cache");
		expect(frame).not.toContain("[FRAMING]");
		expect(frame).not.toContain("[SETTLED]");
		expect(frame).not.toContain("the old belief");
		// The full scope still surfaces everything.
		expect(formatBeliefsForView(set.beliefs, "all")).toContain("[FRAMING]");
		expect(formatBeliefsForView(set.beliefs, "all")).toContain("[SETTLED]");
	});
});

describe("route op (fast-path routing belief)", () => {
	test("route creates a settled routing belief that never enters the dispatch frame", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "route",
			statement: "本请求适合 fast path 执行",
			expectation: "该请求为简单任务",
			decision: "fast-path",
			suitabilityProbability: 0.9,
			successProbability: 0.85,
			estimatedSteps: 2,
			difficulty: "low",
		});

		expect(belief.domain).toBe("routing");
		expect(belief.decision).toBe("fast-path");
		expect(belief.suitabilityProbability).toBe(0.9);
		expect(belief.successProbability).toBe(0.85);
		expect(belief.estimatedSteps).toBe(2);
		expect(belief.difficulty).toBe("low");
		// Created settled (evidence is the decision), so it is not an open dispatch target.
		expect(statusOf(belief)).toBe("supported");
		expect(set.proposed()).toHaveLength(0);
		expect(set.open()).toContain(belief);
	});

	test("rejects an invalid routing decision", () => {
		const set = new BeliefSet();
		expect(() =>
			set.apply({
				op: "route",
				statement: "本请求适合 fast path 执行",
				expectation: "简单任务",
				decision: "maybe" as never,
				suitabilityProbability: 0.9,
				successProbability: 0.9,
				estimatedSteps: 1,
				difficulty: "low",
			}),
		).toThrow("decision must be 'fast-path' or 'belief-loop'.");
	});

	test("rejects probabilities outside 0-1", () => {
		const set = new BeliefSet();
		expect(() =>
			set.apply({
				op: "route",
				statement: "本请求适合 fast path 执行",
				expectation: "简单任务",
				decision: "fast-path",
				suitabilityProbability: 1.2,
				successProbability: 0.9,
				estimatedSteps: 1,
				difficulty: "low",
			}),
		).toThrow("suitabilityProbability must be a number between 0 and 1.");
		expect(() =>
			set.apply({
				op: "route",
				statement: "本请求适合 fast path 执行",
				expectation: "简单任务",
				decision: "fast-path",
				suitabilityProbability: 0.9,
				successProbability: -0.1,
				estimatedSteps: 1,
				difficulty: "low",
			}),
		).toThrow("successProbability must be a number between 0 and 1.");
	});

	test("rejects a non-integer step estimate and an unknown difficulty", () => {
		const set = new BeliefSet();
		expect(() =>
			set.apply({
				op: "route",
				statement: "本请求适合 fast path 执行",
				expectation: "简单任务",
				decision: "fast-path",
				suitabilityProbability: 0.9,
				successProbability: 0.9,
				estimatedSteps: 1.5,
				difficulty: "low",
			}),
		).toThrow("estimatedSteps must be an integer from 0 to 100.");
		expect(() =>
			set.apply({
				op: "route",
				statement: "本请求适合 fast path 执行",
				expectation: "简单任务",
				decision: "fast-path",
				suitabilityProbability: 0.9,
				successProbability: 0.9,
				estimatedSteps: 1,
				difficulty: "extreme" as never,
			}),
		).toThrow("difficulty must be 'low', 'medium', or 'high'.");
	});
});

describe("belief set capacity (MAX_BELIEFS = 200)", () => {
	test("the 200th record is accepted and the 201st is rejected", () => {
		const set = new BeliefSet();
		for (let i = 0; i < 200; i++) {
			set.apply({
				op: "propose",
				statement: `belief ${i}`,
				domain: "product",
				expectation: "probe",
				evidenceRounds: 1,
			});
		}
		expect(set.beliefs).toHaveLength(200);
		expect(() =>
			set.apply({
				op: "propose",
				statement: "overflow",
				domain: "product",
				expectation: "probe",
				evidenceRounds: 1,
			}),
		).toThrow("Belief set capacity reached: at most 200 beliefs");
		expect(set.beliefs).toHaveLength(200);
	});

	test("support, refute, and retract still work at capacity", () => {
		const set = new BeliefSet();
		for (let i = 0; i < 200; i++) {
			set.apply({
				op: "propose",
				statement: `belief ${i}`,
				domain: "product",
				expectation: "probe",
				evidenceRounds: 1,
			});
		}
		expect(() => set.apply({ op: "support", beliefId: "belief-1", evidence: "seen" })).not.toThrow();
		expect(() => set.apply({ op: "refute", beliefId: "belief-2", evidence: "not seen" })).not.toThrow();
		expect(() => set.apply({ op: "retract", beliefId: "belief-3" })).not.toThrow();
		expect(set.beliefs).toHaveLength(200);
	});

	test("refine and route still need capacity", () => {
		const set = new BeliefSet();
		for (let i = 0; i < 200; i++) {
			set.apply({
				op: "propose",
				statement: `belief ${i}`,
				domain: "product",
				expectation: "probe",
				evidenceRounds: 1,
			});
		}
		expect(() =>
			set.apply({
				op: "refine",
				beliefId: "belief-1",
				statement: "refined",
				expectation: "probe",
				evidenceRounds: 1,
			}),
		).toThrow("Belief set capacity reached");
		expect(() =>
			set.apply({
				op: "route",
				statement: "route",
				expectation: "route",
				decision: "belief-loop",
				suitabilityProbability: 0.5,
				successProbability: 0.5,
				estimatedSteps: 1,
				difficulty: "low",
			}),
		).toThrow("Belief set capacity reached");
		expect(set.beliefs).toHaveLength(200);
	});
});

describe("pruneForNewTask (task-end cleanup)", () => {
	test("keeps only supported product/code beliefs", () => {
		const set = new BeliefSet();
		const product = set.apply({
			op: "propose",
			statement: "cache survives logout",
			domain: "product",
			expectation: "probe",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: product.id, evidence: "seen" });
		const code = set.apply({
			op: "propose",
			statement: "route handles x",
			domain: "code",
			expectation: "probe",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: code.id, evidence: "seen" });
		const framing = set.apply({
			op: "propose",
			statement: "answer must establish y",
			domain: "framing",
			expectation: "probe",
			evidenceRounds: 1,
		});
		const routing = set.apply({
			op: "route",
			statement: "route",
			expectation: "route",
			decision: "fast-path",
			suitabilityProbability: 0.9,
			successProbability: 0.9,
			estimatedSteps: 1,
			difficulty: "low",
		});
		const refuted = set.apply({
			op: "propose",
			statement: "old claim",
			domain: "product",
			expectation: "probe",
			evidenceRounds: 1,
		});
		set.apply({ op: "refute", beliefId: refuted.id, evidence: "not seen" });
		const superseded = set.apply({
			op: "propose",
			statement: "superseded claim",
			domain: "product",
			expectation: "probe",
			evidenceRounds: 1,
		});
		const refined = set.apply({
			op: "refine",
			beliefId: superseded.id,
			statement: "refined claim",
			expectation: "probe",
			evidenceRounds: 1,
		});
		const proposed = set.apply({
			op: "propose",
			statement: "still open",
			domain: "product",
			expectation: "probe",
			evidenceRounds: 1,
		});

		expect(set.beliefs).toHaveLength(8);

		const removed = set.pruneForNewTask();

		// Only the two supported product/code beliefs survive.
		expect(set.beliefs.map((b) => b.id)).toEqual([product.id, code.id]);
		// Everything else — framing, routing, refuted, superseded, refined (proposed), proposed — was removed.
		expect(removed.map((b) => b.id).sort()).toEqual(
			[framing.id, routing.id, refuted.id, superseded.id, refined.id, proposed.id].sort(),
		);
	});

	test("is idempotent on an already-pruned set", () => {
		const set = new BeliefSet();
		const product = set.apply({
			op: "propose",
			statement: "cache survives",
			domain: "product",
			expectation: "probe",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: product.id, evidence: "seen" });
		set.pruneForNewTask();
		expect(set.pruneForNewTask()).toHaveLength(0);
		expect(set.beliefs.map((b) => b.id)).toEqual([product.id]);
	});

	test("frees capacity for new records", () => {
		const set = new BeliefSet();
		for (let i = 0; i < 200; i++) {
			set.apply({
				op: "propose",
				statement: `belief ${i}`,
				domain: "product",
				expectation: "probe",
				evidenceRounds: 1,
			});
		}
		expect(() =>
			set.apply({
				op: "propose",
				statement: "overflow",
				domain: "product",
				expectation: "probe",
				evidenceRounds: 1,
			}),
		).toThrow("Belief set capacity reached");
		// Pruning 200 proposed records frees capacity; ids are never reused.
		set.pruneForNewTask();
		const fresh = set.apply({
			op: "propose",
			statement: "fresh",
			domain: "product",
			expectation: "probe",
			evidenceRounds: 1,
		});
		expect(fresh.id).toBe("belief-201");
	});
});
