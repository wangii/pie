import { describe, expect, test } from "vitest";
import { BeliefSet } from "../src/core/belief-set.ts";
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
});
