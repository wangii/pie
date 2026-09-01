import { describe, expect, test } from "vitest";
import { BeliefSet, RoutingSet } from "../src/core/belief-set.ts";
import { createDeclareBeliefToolDefinition, createRouteTaskToolDefinition } from "../src/core/tools/declare-belief.ts";
import { createViewBeliefsToolDefinition } from "../src/core/tools/view-beliefs.ts";

describe("declare_belief tool", () => {
	test("proposes a provisional world belief", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{
				statement: "authorizationSource returns a stale replica",
				domain: "code",
				expectation: "the implementation reads the stale replica",
				evidenceRounds: 2,
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.proposed()).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).toContain("Applied propose");
	});

	test("rejects control state disguised as an unsupported domain", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const execution = tool.execute(
			"tc-1",
			{
				statement: "the final answer must establish X",
				domain: "framing" as never,
				expectation: "X is covered",
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.beliefs).toHaveLength(0);
		await expect(execution).rejects.toThrow("Belief rejected");
		expect(tool.executionMode).toBe("sequential");
	});

	test("support treats a fulfilled prediction as evidence", async () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		await tool.execute(
			"tc-1",
			{ op: "support", beliefId: belief.id, evidence: "the observed read hit the cache" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.get(belief.id)?.supportedBy).toEqual([{ evidence: "the observed read hit the cache" }]);
	});

	test("records an inconclusive experiment without treating it as support or refutation", async () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		await tool.execute(
			"tc-1",
			{ op: "inconclusive", beliefId: belief.id, evidence: "the cache service was unavailable" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.get(belief.id)?.inconclusiveBy).toEqual([{ evidence: "the cache service was unavailable" }]);
		expect(set.proposed()).toHaveLength(0);
	});

	test("refine directly records the evidence-supported world-model correction", async () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "authentication is one mechanism",
			domain: "product",
			expectation: "one mechanism handles all authentication",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		await tool.execute(
			"tc-1",
			{
				op: "refine",
				beliefId: belief.id,
				statement: "authentication has OAuth, session, and API-token mechanisms",
				expectation: "the three mechanisms have distinct code paths",
				evidence: "three distinct handlers were observed",
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.beliefs[1]?.supportedBy).toEqual([{ evidence: "three distinct handlers were observed" }]);
	});

	test("rejects adjudication without evidence", async () => {
		const set = new BeliefSet();
		const belief = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const tool = createDeclareBeliefToolDefinition(set);
		const execution = tool.execute(
			"tc-1",
			{ op: "support", beliefId: belief.id },
			undefined,
			undefined,
			undefined as never,
		);

		await expect(execution).rejects.toThrow("Belief rejected");
	});
});

describe("route_task tool", () => {
	test("stores routing separately from beliefs", async () => {
		const beliefs = new BeliefSet();
		const routings = new RoutingSet();
		const tool = createRouteTaskToolDefinition(routings);
		const result = await tool.execute(
			"tc-1",
			{
				decision: "fast-path",
				reason: "no unresolved uncertainty can change this read-only action",
				suitabilityProbability: 0.9,
				successProbability: 0.85,
				estimatedSteps: 2,
				difficulty: "low",
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(routings.routings).toHaveLength(1);
		expect(beliefs.beliefs).toHaveLength(0);
		expect((result.content[0] as { text: string }).text).toContain("Applied routing");
		expect(tool.executionMode).toBe("sequential");
	});

	test("throws rejected routing so the agent records an error result", async () => {
		const tool = createRouteTaskToolDefinition(new RoutingSet());
		await expect(
			tool.execute(
				"tc-1",
				{
					decision: "fast-path",
					reason: "invalid estimate",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 101,
					difficulty: "low",
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Routing rejected");
	});
});

describe("view_beliefs tool", () => {
	test("renders open and adjudicated world beliefs", async () => {
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

		expect((result.content[0] as { text: string }).text).toContain("[FRAME]");
		expect((result.content[0] as { text: string }).text).toContain("the cache is warm");
	});
});
