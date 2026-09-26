import { describe, expect, test } from "vitest";
import { BeliefSet, FocusSet, RoutingSet } from "../src/core/belief-set.ts";
import {
	createDeclareBeliefToolDefinition,
	createFocusBeliefsToolDefinition,
	createRouteTaskToolDefinition,
	createSelectExperimentToolDefinition,
} from "../src/core/tools/declare-belief.ts";
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

describe("focus_beliefs tool", () => {
	test("names the settled beliefs it is keeping in scope", async () => {
		const set = new BeliefSet();
		const proposed = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const settled = set.apply({
			op: "propose",
			statement: "the replica is stale",
			domain: "code",
			expectation: "a read returns the stale replica",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: settled.id, evidence: "the read returned the stale replica" });
		const focusSet = new FocusSet();
		const tool = createFocusBeliefsToolDefinition(set, focusSet);

		const result = await tool.execute(
			"tc-1",
			{ beliefIds: [proposed.id, settled.id] },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;

		// Focus is scope, not an experiment: keeping a settled belief in it is legitimate, but the
		// return has to say it cannot be dispatched, or the next selection is a guess.
		expect(text).toContain(`Focused beliefs: ${proposed.id}, ${settled.id}`);
		expect(text).toContain(`Already settled (in scope, not selectable): ${settled.id}.`);
	});

	// The focus slice is owned by the controller, which compares the declared ids against the
	// slice it currently holds to tell a re-declaration from a real scope change (a real change
	// invalidates an experiment selected under the earlier scope). If the tool also writes the
	// slice, that comparison is made against the value the tool just wrote and always reports
	// "unchanged", so the invalidation silently never fires.
	test("leaves the focus write to the controller callback", async () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the cancellation signal reaches the request",
			domain: "code",
			expectation: "the request observes the cancellation",
			evidenceRounds: 1,
		});
		const focusSet = new FocusSet();
		let focusBeforeCallback: readonly string[] | undefined;
		const tool = createFocusBeliefsToolDefinition(set, focusSet, () => {
			focusBeforeCallback = focusSet.beliefIds;
		});

		await tool.execute("tc-1", { beliefIds: ["belief-1"] }, undefined, undefined, undefined as never);

		// The controller must still see the pre-declaration slice when its callback runs, and the
		// tool must leave the write to it rather than performing it first.
		expect(focusBeforeCallback).toEqual([]);
		expect(focusSet.beliefIds).toEqual([]);
	});

	test("writes the slice itself when no controller is attached", async () => {
		const set = new BeliefSet();
		set.apply({
			op: "propose",
			statement: "the cancellation signal reaches the request",
			domain: "code",
			expectation: "the request observes the cancellation",
			evidenceRounds: 1,
		});
		const focusSet = new FocusSet();
		const tool = createFocusBeliefsToolDefinition(set, focusSet);

		await tool.execute("tc-1", { beliefIds: ["belief-1"] }, undefined, undefined, undefined as never);

		expect(focusSet.beliefIds).toEqual(["belief-1"]);
	});
});

describe("view_beliefs tool", () => {
	test("tells a rejected selection what could be selected instead", async () => {
		const set = new BeliefSet();
		const open = set.apply({
			op: "propose",
			statement: "the cache is warm",
			domain: "code",
			expectation: "reads hit the cache",
			evidenceRounds: 1,
		});
		const settled = set.apply({
			op: "propose",
			statement: "the replica is stale",
			domain: "code",
			expectation: "a read returns the stale replica",
			evidenceRounds: 1,
		});
		set.apply({ op: "support", beliefId: settled.id, evidence: "the read returned the stale replica" });
		const focusSet = new FocusSet();
		focusSet.select([open.id, settled.id]);
		const tool = createSelectExperimentToolDefinition(set, focusSet);

		const rejected = tool.execute(
			"tc-1",
			{ beliefIds: [settled.id], intent: "whether the replica is stale" },
			undefined,
			undefined,
			undefined as never,
		);
		// A rejection that names only the failing id leaves the caller guessing id after id; the
		// selectable set is what makes the rejection self-correcting.
		await expect(rejected).rejects.toThrow(
			`Belief ${settled.id} is supported; only an unresolved belief can be selected. ` +
				`Selectable (unresolved, in focus): ${open.id}.`,
		);
	});
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

		expect((result.content[0] as { text: string }).text).toContain("[OPEN]");
		expect((result.content[0] as { text: string }).text).toContain("the cache is warm");
	});
});
