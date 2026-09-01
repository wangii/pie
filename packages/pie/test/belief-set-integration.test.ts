import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import { statusOf } from "../src/core/belief-set.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

describe("belief-loop integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("initial propose surface separates routing control from beliefs", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);

		expect(harness.session.agent.state.tools.map((tool) => tool.name)).toEqual([
			"route_task",
			"declare_belief",
			"view_beliefs",
			"conclude",
		]);
		const prompt = harness.session.agent.state.systemPrompt;
		expect(prompt).toContain("Routing is control metadata, not a belief");
		expect(prompt).toContain("names as provisional pointers");
		expect(prompt).toContain("highest expected task-relevant information gain");
		expect(prompt).not.toContain("scope-discovery");
		expect(prompt).not.toContain("[code]");
		expect(prompt).not.toContain("framing belief");
	});

	test("dispatches one coherent proposed set directly without a planner role", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a post-logout read returns the cached value",
					evidenceRounds: 1,
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "logout does not reuse the prior session",
					domain: "product",
					expectation: "the post-logout request has a new session id",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage(
				"Observed:\n- the post-logout read returned the cached value.\n- the request used a new session id.",
			),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the post-logout read returned the cached value as predicted",
				}),
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the request used a new session id as predicted",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("The cache survives logout while the session is replaced."),
		]);

		await harness.session.prompt("review logout cache behavior");

		expect(harness.session.beliefs.map(statusOf)).toEqual(["supported", "supported"]);
		const executionPlans = harness
			.eventsOfType("PlanProduced")
			.filter((event) => event.plan.selectedToExplore.length > 0);
		expect(executionPlans).toHaveLength(1);
		expect(executionPlans[0]?.plan.selectedToExplore).toEqual(["belief-1", "belief-2"]);
		expect(harness.session.messages.some((message) => getMessageText(message).startsWith("Batch:"))).toBe(false);
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"The cache survives logout while the session is replaced.",
		);
	});

	test("execution preserves materially distinct raw evidence before distill adjudicates it", async () => {
		const inspectTool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Return code and documentation observations",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "foo.ts:42 returns X; README claims Y" }],
				details: undefined,
			}),
		};
		const harness = await createHarness({ tools: [inspectTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "implementation and documentation agree",
					domain: "code",
					expectation: "code and README describe the same result",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage([fauxToolCall("inspect", {})]),
			fauxAssistantMessage("Observed:\n- `foo.ts:42` returns X.\n- README claims Y."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "refute",
					beliefId: "belief-1",
					evidence: "foo.ts:42 returns X while README claims Y",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("The implementation and README disagree."),
		]);

		await harness.session.prompt("audit the behavior");

		expect(statusOf(harness.session.beliefs[0]!)).toBe("refuted");
		expect(harness.session.beliefs[0]?.refutedBy[0]?.evidence).toContain("foo.ts:42");
	});

	test("distill can directly refine a referent and expose a candidate for propose", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "authentication uses one mechanism",
					domain: "product",
					expectation: "one handler covers all authentication",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage(
				"Observed:\n- OAuth uses oauth.ts.\n- sessions use session.ts.\n- API tokens use token.ts.",
			),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "refine",
					beliefId: "belief-1",
					statement: "authentication has OAuth, session, and API-token mechanisms",
					expectation: "the mechanisms have distinct handlers",
					evidence: "oauth.ts, session.ts, and token.ts are distinct handlers",
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the three authentication mechanisms enforce the same revocation rule",
					domain: "product",
					expectation: "each handler checks the same revocation state",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("This residual uncertainty is material; probe it."),
			fauxAssistantMessage(
				"Observed:\n- OAuth, session, and API-token handlers all check the shared revocation store.",
			),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-3",
					evidence: "all three handlers check the shared revocation store",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("Authentication has three mechanisms with shared revocation."),
		]);

		await harness.session.prompt("review authentication");

		expect(statusOf(harness.session.beliefs[0]!)).toBe("superseded");
		expect(statusOf(harness.session.beliefs[1]!)).toBe("supported");
		expect(statusOf(harness.session.beliefs[2]!)).toBe("supported");
		expect(
			harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0),
		).toHaveLength(2);
	});

	test("retries an inconclusive experiment before allowing conclusion", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the remote cache survives logout",
					domain: "product",
					expectation: "a remote probe returns the cached value",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("Observed:\n- the remote cache endpoint was unavailable."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "inconclusive",
					beliefId: "belief-1",
					evidence: "the endpoint was unavailable before cache behavior could be observed",
				}),
			]),
			fauxAssistantMessage("Retry with the local cache configuration instead."),
			fauxAssistantMessage("Observed:\n- the local cache configuration preserves entries across logout."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the local cache configuration preserves entries across logout",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("The configured cache persists across logout."),
		]);

		await harness.session.prompt("does the remote cache persist?");

		expect(statusOf(harness.session.beliefs[0]!)).toBe("supported");
		expect(harness.session.beliefs[0]?.inconclusiveBy).toHaveLength(1);
		expect(
			harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0),
		).toHaveLength(2);
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"The configured cache persists across logout.",
		);
	});

	test("records rejected state mutations as error tool results", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", { op: "support", beliefId: "belief-1" }),
				fauxToolCall("route_task", {
					decision: "fast-path",
					reason: "invalid estimate",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 101,
					difficulty: "low",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("No valid state mutation was applied."),
		]);

		await harness.session.prompt("exercise invalid mutations");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(4);
		expect(results.slice(0, 2).every((result) => result.role === "toolResult" && result.isError)).toBe(true);
		expect(getMessageText(results[0])).toContain("Belief rejected");
		expect(getMessageText(results[1])).toContain("Routing rejected");
	});

	test("does not persist rejected adjudication text as distillation", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache is warm",
					domain: "code",
					expectation: "a read hits the cache",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage("Observed: the read hit the cache."),
			fauxAssistantMessage([fauxToolCall("declare_belief", { op: "support", beliefId: "belief-1" })]),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the observed read hit the cache",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("The cache is warm."),
		]);

		await harness.session.prompt("check the cache");

		const distillations = harness.eventsOfType("DistillationProduced");
		expect(distillations).toHaveLength(1);
		expect(distillations[0].distillation.contents).not.toContain("Belief rejected");
		expect(distillations[0].distillation.outputs).toHaveLength(1);
	});

	test("finalReport uses the default model rather than the fast-path model", async () => {
		const harness = await createHarness({
			models: [{ id: "default" }, { id: "fast" }],
			settings: { defaultModel: "faux/default", pie: { fastPathModel: "faux/fast" } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage([fauxToolCall("conclude", {})]),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("answer from the existing evidence");

		expect(harness.session.getRoleStatus()?.epistemic.model?.id).toBe("default");
		expect(harness.session.agent.state.model.id).toBe("default");
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"final answer",
		);
	});
});
