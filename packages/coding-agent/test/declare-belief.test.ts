import { describe, expect, test } from "vitest";
import { BeliefSet } from "../src/core/belief-set.ts";
import { createDeclareBeliefToolDefinition } from "../src/core/tools/declare-belief.ts";

describe("declare_belief tool", () => {
	test("propose applies a valid belief", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{ op: "propose", statement: "authorizationSource(1003,1001) returns stale-replica", domain: "code" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.open()).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("Applied propose");
	});

	test("a rejected belief is returned as text, not thrown", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{ op: "propose", statement: "npm test prints PASS", domain: "code" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.open()).toHaveLength(0);
		expect((result.content[0] as { text: string }).text).toContain("Belief rejected");
	});

	test("support reclassifies by beliefId", async () => {
		const set = new BeliefSet();
		const belief = set.apply({ op: "propose", statement: "the cache is warm", domain: "code" });
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute(
			"tc-1",
			{ op: "support", beliefId: belief.id },
			undefined,
			undefined,
			undefined as never,
		);

		expect(set.get(belief.id)?.status).toBe("supported");
		expect((result.content[0] as { text: string }).text).toContain("Applied support");
	});

	test("an op missing its required field is rejected", async () => {
		const set = new BeliefSet();
		const tool = createDeclareBeliefToolDefinition(set);
		const result = await tool.execute("tc-1", { op: "support" }, undefined, undefined, undefined as never);

		expect((result.content[0] as { text: string }).text).toContain("Belief rejected");
		expect((result.content[0] as { text: string }).text).toContain("beliefId");
	});
});
