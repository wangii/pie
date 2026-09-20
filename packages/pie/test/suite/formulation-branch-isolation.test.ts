import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * M2: the problem formulation is task-level state, and it has to be as branch-isolated as the
 * transcript it belongs to.
 *
 * Navigating the session tree moves the leaf inside one session file and rebuilds the message
 * list, but the replayed domain is a second thing that describes "what the agent currently takes
 * this task to be" — and it only follows if something makes it. These tests pin that it does:
 * after navigation the client is told the understanding that existed at the point it navigated
 * to, not one that was published later on the branch it left.
 */
describe("domain state across session tree navigation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const proposeFirstProbe = fauxAssistantMessage([
		fauxToolCall("declare_belief", {
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		}),
		fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
		fauxToolCall("select_experiment", { intent: "what the answer must report", beliefIds: ["belief-1"] }),
	]);
	const observe = fauxAssistantMessage("Observed:\n- the post-logout read kept the value.");
	const adjudicate = fauxAssistantMessage([
		fauxToolCall("declare_belief", {
			op: "support",
			beliefId: "belief-1",
			evidence: "the post-logout read kept the value",
		}),
	]);
	const publishReading = fauxAssistantMessage([
		fauxToolCall("set_formulation", {
			interpretation: "persistence across logout is the question",
			focus: "the observations the tested beliefs predict",
			implication: "which conclusion the answer reports turns on what the probe shows",
			reason: "stated the current reading",
		}),
	]);
	const conclude = fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]);

	/** The assistant entries of the branch, in order — the tree positions a user can navigate to. */
	const assistantEntries = (harness: Harness) =>
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.map((entry) => entry.id);

	async function runBeliefLoop(harness: Harness): Promise<void> {
		harness.setResponses([
			proposeFirstProbe,
			observe,
			adjudicate,
			publishReading,
			conclude,
			conclude,
			fauxAssistantMessage("the cache survives logout"),
		]);
		await harness.session.prompt("is the cache persistent?");
	}

	it("rebuilds the replayed task state when the leaf moves to an earlier point", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		await runBeliefLoop(harness);

		const taskId = harness.eventsOfType("TaskOpened")[0].taskId;
		const published = harness.eventsOfType("ProblemFormulationRecorded");
		expect(published).toHaveLength(1);
		const before = harness.session.domainSnapshot.tasks.get(taskId);
		expect(before?.formulations).toHaveLength(1);

		// Navigate to the execution turn: after the task opened and its experiment was dispatched,
		// but before the reading was formed.
		const entries = assistantEntries(harness);
		expect(entries.length).toBeGreaterThanOrEqual(2);
		const result = await harness.session.navigateTree(entries[1], { summarize: false });
		expect(result.cancelled).toBe(false);

		// The domain follows the leaf. Leaving the abandoned branch's version in place would tell
		// the user the agent holds a reading that did not exist at the point the session now sits
		// at — and a client that trusts it would show a Frame the branch never had.
		const after = harness.session.domainSnapshot.tasks.get(taskId);
		expect(after?.formulations).toEqual([]);
		expect(harness.session.getFormulationState()?.current).toBeNull();

		// What had genuinely happened by that point survives: the round ran, so the required
		// decision is outstanding again rather than reading as answered.
		expect(after?.episodes[0].body.kind).toBe("belief-loop");
		expect(harness.session.getFormulationState()?.decisionOwed).toBe(true);
	});

	it("keeps only what the branch itself recorded when the leaf moves to the opening message", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		await runBeliefLoop(harness);

		const taskId = harness.eventsOfType("TaskOpened")[0].taskId;
		const firstUserEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(firstUserEntry).toBeDefined();
		const result = await harness.session.navigateTree(firstUserEntry!.id, { summarize: false });
		expect(result.cancelled).toBe(false);

		// Navigating to the opening user message cuts the branch just after the task opened — the
		// task itself was recorded before that point, so it stays, but nothing the abandoned branch
		// learned does: no version, and no round that would re-open the required decision.
		const after = harness.session.domainSnapshot.tasks.get(taskId);
		expect(after?.formulations).toEqual([]);
		expect(after?.episodes).toHaveLength(1);
		expect(after?.episodes[0].body.kind).toBe("pending");

		const state = harness.session.getFormulationState();
		expect(state).toBeDefined();
		expect(state?.current).toBeNull();
		expect(state?.deferral).toBeNull();
		expect(state?.corrections).toEqual([]);
		expect(state?.decisionOwed).toBe(false);
	});
});
