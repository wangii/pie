import { describe, expect, test } from "vitest";
import {
	BeliefSet,
	BeliefValidationError,
	formatBeliefBootstrap,
	formatBeliefsForPrompt,
	validateBelief,
} from "../src/core/belief-set.ts";

describe("BeliefSet status machine", () => {
	test("propose adds a proposed belief with its declared domain", () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "authorizationSource(1003,1001) returns stale-replica",
			domain: "code",
		});

		expect(belief.id).toBe("belief-1");
		expect(belief.status).toBe("proposed");
		expect(belief.domain).toBe("code");
		expect(set.open()).toHaveLength(1);
	});

	test("support and refute reclassify an open belief", () => {
		const set = new BeliefSet();
		const belief = set.apply({ op: "propose", statement: "the cache survives logout for 30s", domain: "product" });

		set.apply({ op: "support", beliefId: belief.id });
		expect(set.get(belief.id)?.status).toBe("supported");
		expect(set.open()).toHaveLength(1);

		set.apply({ op: "refute", beliefId: belief.id });
		expect(set.get(belief.id)?.status).toBe("refuted");
		// Refuted negatives are knowledge but no longer actionable for dispatch.
		expect(set.open()).toHaveLength(0);
	});

	test("refine supersedes the prior belief and adds a supported replacement", () => {
		const set = new BeliefSet();
		const belief = set.apply({ op: "propose", statement: "the worker cache is the cause", domain: "code" });

		const refined = set.apply({
			op: "refine",
			beliefId: belief.id,
			statement: "stale-replica from the worker cache is the cause",
		});

		expect(set.get(belief.id)?.status).toBe("superseded");
		expect(refined.status).toBe("supported");
		expect(refined.statement).toBe("stale-replica from the worker cache is the cause");
		expect(refined.domain).toBe("code");
		// The replacement is open; the superseded belief is not.
		expect(set.open().map((b) => b.id)).toEqual([refined.id]);
	});

	test("retract withdraws a belief", () => {
		const set = new BeliefSet();
		const belief = set.apply({ op: "propose", statement: "the cache is warm", domain: "code" });

		set.apply({ op: "retract", beliefId: belief.id });
		expect(set.get(belief.id)?.status).toBe("superseded");
		expect(set.open()).toHaveLength(0);
	});

	test("illegal transitions and unknown ids throw", () => {
		const set = new BeliefSet();
		const belief = set.apply({ op: "propose", statement: "the cache is warm", domain: "code" });

		expect(() => set.apply({ op: "support", beliefId: "missing" })).toThrow(BeliefValidationError);

		set.apply({ op: "refute", beliefId: belief.id });
		// A refuted belief cannot be supported again.
		expect(() => set.apply({ op: "support", beliefId: belief.id })).toThrow(BeliefValidationError);
	});
});

describe("validateBelief", () => {
	test("accepts a code relation and a product relation", () => {
		expect(() => validateBelief("authorizationSource(1003,1001) returns stale-replica", "code")).not.toThrow();
		expect(() => validateBelief("worker-local cache survives logout for 30s", "product")).not.toThrow();
	});

	test("rejects empty and bare-confirmation statements", () => {
		expect(() => validateBelief("", "code")).toThrow(BeliefValidationError);
		expect(() => validateBelief("confirmed", "code")).toThrow(BeliefValidationError);
	});

	test("rejects experiment and process records", () => {
		expect(() => validateBelief("Expectation: cache survives logout", "code")).toThrow(BeliefValidationError);
		expect(() => validateBelief("we did not prove the cache survives", "code")).toThrow(BeliefValidationError);
	});

	test("rejects probe-shaped subjects in both domains", () => {
		expect(() => validateBelief("npm test prints PASS", "code")).toThrow(BeliefValidationError);
		expect(() => validateBelief("restart-probe.sh will emit RESULT: failure", "product")).toThrow(
			BeliefValidationError,
		);
	});

	test("product domain rejects code-internal statements", () => {
		expect(() => validateBelief("the function returns the cached value", "product")).toThrow(BeliefValidationError);
	});

	test("a negated belief about a named referent is not mistaken for a bare 'no'", () => {
		expect(() => validateBelief("no cache survives logout", "product")).not.toThrow();
	});
});

describe("formatBeliefsForPrompt", () => {
	test("renders live beliefs with ids and a resolve directive", () => {
		expect(formatBeliefsForPrompt([])).toBe("");

		const set = new BeliefSet();
		set.apply({ op: "propose", statement: "authorizationSource returns stale-replica", domain: "code" });
		const text = formatBeliefsForPrompt(set.open());
		expect(text).toContain("[CURRENT BELIEFS]");
		expect(text).toContain("belief-1");
		expect(text).toContain("[code] authorizationSource returns stale-replica");
		expect(text).toContain("support or refute");
		expect(text).toContain("resolve every `proposed` belief");
	});

	test("formatBeliefBootstrap is a mandatory first-step directive", () => {
		const bootstrap = formatBeliefBootstrap();
		expect(bootstrap).toContain("MANDATORY");
		expect(bootstrap).toContain("Before calling any other tool");
		expect(bootstrap).toContain("declare_belief");
		expect(bootstrap).toContain("op=propose");
		expect(bootstrap).toContain("domain=product");
		expect(bootstrap).toContain("domain=code");
	});
});

describe("propose relatedness gate", () => {
	test("empty set: a belief must relate to the root instruction", () => {
		const set = new BeliefSet();
		set.setRootInstruction("check the system prompt structure");

		expect(() =>
			set.apply({ op: "propose", statement: "system-prompt.ts assembles the system prompt", domain: "code" }),
		).not.toThrow();

		const other = new BeliefSet();
		other.setRootInstruction("check the system prompt structure");
		expect(() =>
			other.apply({ op: "propose", statement: "the cache is warm", domain: "code" }),
		).toThrow(BeliefValidationError);
	});

	test("empty set without a root instruction skips the relatedness check", () => {
		const set = new BeliefSet();
		expect(() => set.apply({ op: "propose", statement: "the cache is warm", domain: "code" })).not.toThrow();
	});

	test("non-empty set: a belief must relate to at least one current belief", () => {
		const set = new BeliefSet();
		set.apply({ op: "propose", statement: "the system prompt is assembled by buildSystemPrompt", domain: "code" });

		expect(() =>
			set.apply({ op: "propose", statement: "system-prompt.ts builds the prompt sections", domain: "code" }),
		).not.toThrow();

		expect(() =>
			set.apply({ op: "propose", statement: "the cache is warm", domain: "code" }),
		).toThrow(BeliefValidationError);
	});

	test("non-empty set: a belief must not contradict a current belief", () => {
		const set = new BeliefSet();
		set.apply({ op: "propose", statement: "the cache survives logout", domain: "product" });

		// Consistent extension passes.
		expect(() =>
			set.apply({ op: "propose", statement: "the cache survives logout for 30s", domain: "product" }),
		).not.toThrow();

		// Explicit negation of a shared referent is a contradiction.
		const other = new BeliefSet();
		other.apply({ op: "propose", statement: "the cache survives logout", domain: "product" });
		expect(() =>
			other.apply({ op: "propose", statement: "the cache does not survive logout", domain: "product" }),
		).toThrow(BeliefValidationError);
	});
});
