import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import { statusOf } from "../src/core/belief-set.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/**
 * One propose turn's control calls: state how the task is currently read, declare the scope, and
 * choose the experiment that tests the reading.
 *
 * The formulation call comes first on purpose. Publishing is the decision propose owes once a
 * round has completed, and it voids any experiment selected before it — so a turn that both
 * states a reading and selects an experiment publishes first, exactly as a real propose turn
 * must. A second identical publication in a later turn is a no-op, so using this helper for every
 * selection is safe.
 */
const select = (beliefIds: string[], intent = "which action to take") => [
	fauxToolCall("set_formulation", {
		interpretation: "I currently read this as a question about which behavior actually holds",
		focus: "the observations the selected beliefs predict",
		implication: "which conclusion the answer must report turns on what the probe shows",
		reason: "initial reading before the first probe",
	}),
	fauxToolCall("focus_beliefs", { beliefIds }),
	fauxToolCall("select_experiment", { intent, beliefIds }),
];

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
			"focus_beliefs",
			"select_experiment",
			"set_formulation",
			"defer_formulation",
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
				...select(["belief-1", "belief-2"]),
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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
				...select(["belief-1"]),
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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
				...select(["belief-1"]),
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
			fauxAssistantMessage([...select(["belief-3"])]),
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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
				...select(["belief-1"]),
			]),
			fauxAssistantMessage("Observed:\n- the remote cache endpoint was unavailable."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "inconclusive",
					beliefId: "belief-1",
					evidence: "the endpoint was unavailable before cache behavior could be observed",
				}),
			]),
			fauxAssistantMessage([...select(["belief-1"])]),
			fauxAssistantMessage("Observed:\n- the local cache configuration preserves entries across logout."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the local cache configuration preserves entries across logout",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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

	test("an unresolved belief outside the focus neither dispatches nor blocks conclusion", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cancellation signal reaches the request",
					domain: "code",
					expectation: "the request observes the cancellation",
					evidenceRounds: 1,
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives across logins",
					domain: "product",
					expectation: "a post-login read returns the prior value",
					evidenceRounds: 1,
				}),
				fauxToolCall("set_formulation", {
					interpretation: "I currently read this as a question about which behavior actually holds",
					focus: "the observations the focused belief predicts",
					implication: "which conclusion the answer must report turns on what the probe shows",
					reason: "initial reading before the first probe",
				}),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				fauxToolCall("select_experiment", {
					intent: "whether to change the adapter",
					beliefIds: ["belief-1"],
				}),
			]),
			fauxAssistantMessage("Observed:\n- the request observes the cancellation."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the request observed the cancellation",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("conclude", { result: "changed the adapter", evidence: "the test passed" }),
			]),
			fauxAssistantMessage([
				fauxToolCall("conclude", { result: "changed the adapter", evidence: "the test passed" }),
			]),
			fauxAssistantMessage("Cancellation now propagates."),
		]);

		await harness.session.prompt("fix cancellation");

		const executionPlans = harness
			.eventsOfType("PlanProduced")
			.filter((event) => event.plan.selectedToExplore.length > 0);
		expect(executionPlans).toHaveLength(1);
		expect(executionPlans[0]?.plan.selectedToExplore).toEqual(["belief-1"]);
		expect(statusOf(harness.session.beliefs[1]!)).toBe("proposed");
	});

	test("rejects an experiment selection until the task declares its focus", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cancellation signal reaches the request",
					domain: "code",
					expectation: "the request observes the cancellation",
					evidenceRounds: 1,
				}),
				// No focus_beliefs before the selection: the task has not said what it acts on.
				fauxToolCall("select_experiment", {
					intent: "whether to change the adapter",
					beliefIds: ["belief-1"],
				}),
			]),
			fauxAssistantMessage([...select(["belief-1"])]),
			fauxAssistantMessage("Observed:\n- the request observes the cancellation."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the request observed the cancellation",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("Cancellation propagates."),
		]);

		await harness.session.prompt("fix cancellation");

		const selections = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "select_experiment",
		);
		expect(selections).toHaveLength(2);
		expect(selections[0]?.role === "toolResult" && selections[0].isError).toBe(true);
		expect(getMessageText(selections[0]!)).toContain("Declare the task focus with focus_beliefs");
		expect(selections[1]?.role === "toolResult" && selections[1].isError).toBe(false);
	});

	test("re-declaring the same focus keeps an already selected experiment", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cancellation signal reaches the request",
					domain: "code",
					expectation: "the request observes the cancellation",
					evidenceRounds: 1,
				}),
				fauxToolCall("set_formulation", {
					interpretation: "I currently read this as a question about which behavior actually holds",
					focus: "the observations the focused belief predicts",
					implication: "which conclusion the answer must report turns on what the probe shows",
					reason: "initial reading before the first probe",
				}),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
			]),
			// Tools run in call order, so the selection lands before the same focus is restated.
			// Restating an unchanged scope must not discard the selection.
			fauxAssistantMessage([
				fauxToolCall("select_experiment", {
					intent: "whether to change the adapter",
					beliefIds: ["belief-1"],
				}),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
			]),
			fauxAssistantMessage("Observed:\n- the request observes the cancellation."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the request observed the cancellation",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("Cancellation propagates."),
		]);

		await harness.session.prompt("fix cancellation");

		const plans = harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.plan.selectedToExplore).toEqual(["belief-1"]);
		expect(plans[0]?.plan.intent).toBe("whether to change the adapter");
	});

	test("view_beliefs reports the task focus alongside retained belief history", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cancellation signal reaches the request",
					domain: "code",
					expectation: "the request observes the cancellation",
					evidenceRounds: 1,
				}),
				...select(["belief-1"]),
			]),
			fauxAssistantMessage("Observed:\n- the request observes the cancellation."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the request observed the cancellation",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("Cancellation propagates."),
		]);

		await harness.session.prompt("fix cancellation");

		const viewBeliefs = harness.session.getRegisteredTool("view_beliefs");
		expect(viewBeliefs).toBeDefined();
		const result = await viewBeliefs!.execute("view-beliefs", {});
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain("[FOCUS] belief-1");
		expect(text).toContain("(supported)");
	});

	test("retained unresolved history from an earlier task neither dispatches nor blocks the next task", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			// Task 1 proposes a belief, never focuses it, and concludes: the belief stays proposed.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives across logins",
					domain: "product",
					expectation: "a post-login read returns the prior value",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("conclude", { result: "answered the first question", evidence: "read the config" }),
			]),
			fauxAssistantMessage([
				fauxToolCall("conclude", { result: "answered the first question", evidence: "read the config" }),
			]),
			fauxAssistantMessage("The first task is answered."),
			// Task 2 declares its own belief. The leftover from task 1 is still proposed, so this
			// turn is where an unfiltered nudge would drag it back into scope.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cancellation signal reaches the request",
					domain: "code",
					expectation: "the request observes the cancellation",
					evidenceRounds: 1,
				}),
			]),
			fauxAssistantMessage([...select(["belief-2"])]),
			fauxAssistantMessage("Observed:\n- the request observes the cancellation."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-2",
					evidence: "the request observed the cancellation",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "fixed cancellation", evidence: "test passed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "fixed cancellation", evidence: "test passed" })]),
			fauxAssistantMessage("Cancellation propagates."),
		]);

		await harness.session.prompt("answer the first question");
		await harness.session.prompt("fix cancellation");

		// Only the second task's own belief was ever dispatched.
		const plans = harness.eventsOfType("PlanProduced").filter((event) => event.plan.selectedToExplore.length > 0);
		expect(plans.at(-1)?.plan.selectedToExplore).toEqual(["belief-2"]);
		// The second task was nudged about its own belief only; the retained leftover was not put
		// back in scope by the controller, so it cannot re-enter the task's attention on its own.
		const secondTaskStart = harness.session.messages.findIndex(
			(message) => message.role === "user" && getMessageText(message) === "fix cancellation",
		);
		const steers = harness.session.messages
			.slice(secondTaskStart)
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");
		expect(steers).toContain("the cancellation signal reaches the request");
		expect(steers).not.toContain("the cache survives across logins");
		// The leftover record survived the boundary, unadjudicated and harmless.
		expect(statusOf(harness.session.beliefs[0]!)).toBe("proposed");
		expect(statusOf(harness.session.beliefs[1]!)).toBe("supported");
		// The second task reached its own conclusion; the leftover never blocked it.
		expect(
			harness.session.messages
				.filter((message) => message.role === "assistant")
				.map(getMessageText)
				.filter(Boolean)
				.at(-1),
		).toBe("Cancellation propagates.");
	});

	test("a rejected conclude does not complete the task", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			// Blank fields: the call is refused, so no task outcome is recorded and the handoff
			// must not advance on the strength of the call alone.
			fauxAssistantMessage([fauxToolCall("conclude", { result: " ", evidence: " " })]),
			fauxAssistantMessage([
				fauxToolCall("conclude", {
					result: "changed the adapter to forward the cancellation signal",
					evidence: "the cancel propagation test passed",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("conclude", {
					result: "changed the adapter to forward the cancellation signal",
					evidence: "the cancel propagation test passed",
				}),
			]),
			fauxAssistantMessage("Cancellation now propagates."),
		]);

		await harness.session.prompt("fix cancellation");

		const concludes = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "conclude",
		);
		expect(concludes).toHaveLength(3);
		expect(concludes[0]?.role === "toolResult" && concludes[0].isError).toBe(true);
		expect(getMessageText(concludes[0]!)).toContain("non-empty `result` is required");
		expect(concludes[1]?.role === "toolResult" && concludes[1].isError).toBe(false);

		// The handoff happened only after a real delivery was recorded.
		const userText = harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");
		expect(userText).toContain("Concluding was rejected");
		expect(userText).toContain("changed the adapter to forward the cancellation signal");
	});

	test("records the delivered result as a task outcome separate from belief settlement", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cancellation signal reaches the request",
					domain: "code",
					expectation: "the request observes the cancellation",
					evidenceRounds: 1,
				}),
				...select(["belief-1"]),
			]),
			fauxAssistantMessage("Observed:\n- the request observes the cancellation."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the request observed the cancellation",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("conclude", {
					result: "changed the adapter to forward the cancellation signal",
					evidence: "the cancel propagation test passed",
					blockers: "the upstream timeout path is untested",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("conclude", {
					result: "changed the adapter to forward the cancellation signal",
					evidence: "the cancel propagation test passed",
					blockers: "the upstream timeout path is untested",
				}),
			]),
			fauxAssistantMessage("Cancellation now propagates."),
		]);

		await harness.session.prompt("fix cancellation");

		const userText = harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");
		expect(userText).toContain("Task outcome (delivered result, separate from belief settlement):");
		expect(userText).toContain("changed the adapter to forward the cancellation signal");
		expect(userText).toContain("the cancel propagation test passed");
		expect(userText).toContain("the upstream timeout path is untested");

		const persisted = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "task_outcome",
		);
		expect(persisted).toBeDefined();
		expect((persisted as { details?: { delivered?: string } }).details?.delivered).toContain(
			"changed the adapter to forward the cancellation signal",
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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
				...select(["belief-1"]),
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
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
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("answer from the existing evidence");

		expect(harness.session.getRoleStatus()?.epistemic.model?.id).toBe("default");
		expect(harness.session.agent.state.model.id).toBe("default");
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"final answer",
		);
	});

	test("carries an adjudicated inconclusive belief into finalReport", async () => {
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
				...select(["belief-1"]),
			]),
			fauxAssistantMessage("Observed:\n- the remote cache endpoint was unavailable."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "inconclusive",
					beliefId: "belief-1",
					evidence: "the endpoint was unavailable before cache behavior could be observed",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("The cache could not be observed; the outcome is open."),
		]);

		await harness.session.prompt("does the remote cache persist?");

		// The belief remains inconclusive: it is not retried nor dropped, so the guard did
		// not block conclusion the way an *unadjudicated* proposal would. It survives to the
		// terminal context as a preserve-uncertainty entry.
		expect(statusOf(harness.session.beliefs[0]!)).toBe("inconclusive");
		const finalContext = harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");
		expect(finalContext).toContain("Inconclusive beliefs (preserve uncertainty):");
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"The cache could not be observed; the outcome is open.",
		);
	});

	test("a plain propose turn with no open work still gets one adversarial reflection", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("There is nothing left to investigate."),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("Nothing further to establish."),
		]);

		await harness.session.prompt("answer from the existing evidence");

		const userText = harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");
		expect(userText).toContain("Before concluding, perform one cheap adversarial check");
	});

	test("states budget exhaustion without inferring the experiment was cutoff", async () => {
		const inspectTool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Return an observation",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "observed something" }],
				details: undefined,
			}),
		};
		const harness = await createHarness({ tools: [inspectTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a probe returns the cached value",
					evidenceRounds: 1,
				}),
				...select(["belief-1"]),
			]),
			// Two probe calls exhaust the episode horizon (ceil(1 * 1.3) = 2).
			fauxAssistantMessage([fauxToolCall("inspect", {})]),
			fauxAssistantMessage([fauxToolCall("inspect", {})]),
			// Lease nudge, then a report turn settling to distill.
			fauxAssistantMessage("Observed:\n- a partial observation."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the observed value confirms the cache persists",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("The cache persists."),
		]);

		await harness.session.prompt("does the cache persist?");

		const userText = harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");
		// The nudge and handoff state the budget was spent without claiming the run was
		// incomplete, so a distill may still support/refute on the evidence actually gathered.
		expect(userText).not.toContain("You have gathered enough evidence for this experiment");
		expect(userText).toContain("execution budget for this experiment");
		expect(userText).toContain("budget was exhausted");
		expect(userText).toContain("not a claim that the experiment was complete or incomplete");
		expect(statusOf(harness.session.beliefs[0]!)).toBe("supported");
	});
});
