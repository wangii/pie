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

	test("refine supersedes the prior belief and adds a supported replacement", () => {
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
		expect(statusOf(refined)).toBe("supported");
		expect(set.open().map((b) => b.id)).toEqual([refined.id]);
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
