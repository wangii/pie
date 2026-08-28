import { describe, expect, test } from "vitest";
import { BeliefSet, RoutingSet } from "../src/core/belief-set.ts";
import { createDeclareBeliefToolDefinition } from "../src/core/tools/declare-belief.ts";
import { createViewBeliefsToolDefinition } from "../src/core/tools/view-beliefs.ts";

describe("declare_belief tool", () => {
	test("propose applies a valid belief", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{
				op: "propose",
				statement: "authorizationSource(1003,1001) returns stale-replica",
				domain: "code",
				expectation: "reading it shows a stale replica",
				evidenceRounds: 2,
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.open()).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("Applied propose");
	});

	test("propose applies when `op` is omitted (defaults to propose)", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{
				statement: "authorizationSource(1003,1001) returns stale-replica",
				domain: "code",
				expectation: "reading it shows a stale replica",
				evidenceRounds: 2,
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.proposed()).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).toContain("Applied propose");
	});

	test("an omitted `op` with a beliefId is rejected, not guessed", async () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{ beliefId: belief.id, evidence: "reads hit the cache" },
			undefined,
			undefined,
			undefined as never,
		);

		expect((result.content[0] as { text: string }).text).toContain("Belief rejected");
		expect((result.content[0] as { text: string }).text).toContain("`op`");
	});

	test("propose accepts a framing belief", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{
				op: "propose",
				statement: "the answer must establish X",
				domain: "framing",
				expectation: "no second mechanism",
				evidenceRounds: 1,
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.framings()).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).toContain("Applied propose");
	});

	test("a rejected belief is returned as text, not thrown", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{ op: "propose", statement: "", domain: "code", expectation: "x", evidenceRounds: 1 },
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.open()).toHaveLength(0);
		expect((result.content[0] as { text: string }).text).toContain("Belief rejected");
	});

	test("support reclassifies by beliefId with evidence", async () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{ op: "support", beliefId: belief.id, evidence: "reads hit the cache" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.get(belief.id)?.supportedBy).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).toContain("Applied support");
	});

	test("proposing a second belief while one is open is allowed", async () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{
				op: "propose",
				statement: "login is stateless",
				domain: "product",
				expectation: "no session reuse",
				evidenceRounds: 1,
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect((result.content[0] as { text: string }).text).toContain("Applied propose");
		expect(set.proposed()).toHaveLength(2);
	});

	test("support without evidence is rejected", async () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{ op: "support", beliefId: belief.id },
			undefined,
			undefined,
			undefined as never,
		);

		expect((result.content[0] as { text: string }).text).toContain("Belief rejected");
		expect((result.content[0] as { text: string }).text).toContain("evidence");
	});

	test("an op missing its required field is rejected", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute("tc-1", { op: "support" }, undefined, undefined, undefined as never);

		expect((result.content[0] as { text: string }).text).toContain("Belief rejected");
		expect((result.content[0] as { text: string }).text).toContain("beliefId");
	});
});

describe("declare_belief route op", () => {
	test("route applies a settled routing belief", async () => {
		const set = new BeliefSet();
		const routings = new RoutingSet();
		const tool = createDeclareBeliefToolDefinition(set, routings);
		const result = await tool.execute(
			"tc-1",
			{
				op: "route",
				statement: "本请求适合 fast path 执行",
				decision: "fast-path",
				suitabilityProbability: 0.9,
				successProbability: 0.85,
				estimatedSteps: 2,
				difficulty: "low",
			},
			undefined,
			undefined,
			undefined as never,
		);

		const routing = routings.routings[0]!;
		expect(routing.id).toBe("routing-1");
		expect(routing.decision).toBe("fast-path");
		expect(set.beliefs).toHaveLength(0);
		expect(set.proposed()).toHaveLength(0);
		expect((result.content[0] as { text: string }).text).toContain("Applied route");
	});

	test("route rejects a missing decision", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set, new RoutingSet());
		const result = await tool.execute(
			"tc-1",
			{
				op: "route",
				statement: "本请求适合 fast path 执行",
				suitabilityProbability: 0.9,
				successProbability: 0.9,
				estimatedSteps: 1,
				difficulty: "low",
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect((result.content[0] as { text: string }).text).toContain("Belief rejected");
		expect((result.content[0] as { text: string }).text).toContain("decision");
	});
});

describe("view_beliefs tool", () => {
	test("renders the current belief set as text", async () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createViewBeliefsToolDefinition(set);
		const result = await tool.execute("tc-1", {}, undefined, undefined, undefined as never);

		expect((result.content[0] as { text: string }).text).toContain("the cache is warm");
	});

	test("renders framing beliefs in addition to the frame", async () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		set.apply({
			op: "propose",
			statement: "the answer must establish X",
			domain: "framing",
			expectation: "no second mechanism",
			evidenceRounds: 1,
		});
		// The tool signature takes no role callback now, so it is role-independent.
		const tool = createViewBeliefsToolDefinition(set);
		const result = await tool.execute("tc-1", {}, undefined, undefined, undefined as never);
		const text = (result.content[0] as { text: string }).text;

		expect(text).toContain("[FRAME]");
		expect(text).toContain("[FRAMING]");
		expect(text).not.toContain("[SETTLED]");
	});
});
