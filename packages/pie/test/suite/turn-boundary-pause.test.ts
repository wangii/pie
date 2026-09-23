import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { BeliefLoopController } from "../../src/core/belief-loop/belief-loop-controller.ts";
import { createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * Pie pauses the run while the belief loop waits for the user's answer to a revised Frame.
 *
 * Agent core replaced `shouldStopAfterTurn` with `finishTurn`, so the pause is now a turn-boundary
 * decision: the turn that published the revision finishes, and the loop exits instead of starting
 * another provider request. These tests keep the boundary honest — a spare provider response must
 * stay unconsumed, or the pause has quietly become "keep going".
 */
describe("turn boundary pause on a revised Frame", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const reading = (interpretation: string) =>
		fauxToolCall("set_formulation", {
			interpretation,
			focus: "the path the reading attends to",
			implication: "which conclusion the answer reports turns on that path",
			reason: "the task scope changed",
		});
	const belief = () =>
		fauxToolCall("declare_belief", {
			op: "propose",
			statement: "identity survives a retry",
			domain: "code",
			expectation: "the same identity is reused",
			evidenceRounds: 1,
		});
	const focus = () => fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] });
	const select = () =>
		fauxToolCall("select_experiment", { beliefIds: ["belief-1"], intent: "whether identity is reused" });
	const adjudicate = () =>
		fauxToolCall("declare_belief", {
			op: "inconclusive",
			beliefId: "belief-1",
			evidence: "the probe never reached a second attempt",
		});

	/** One dispatched round under v1, then the revision to v2 that pauses the task. */
	async function roundThenRevision(h: Harness): Promise<void> {
		h.setResponses([
			fauxAssistantMessage([belief(), reading("local retry control"), focus(), select()]),
			fauxAssistantMessage("Observed: the retry reused the same identity"),
			fauxAssistantMessage([adjudicate()]),
			fauxAssistantMessage([reading("cross-component identity ownership")]),
			fauxAssistantMessage("LEAKED"),
		]);
		await h.session.prompt("Investigate identity ownership");
	}

	const assistantText = (h: Harness): string =>
		h.session.messages
			.filter((message) => message.role === "assistant")
			.map(getMessageText)
			.join("\n");

	/**
	 * A second session over an existing harness's agent, so the hook it installs composes with
	 * whatever turn boundary the agent already carries.
	 */
	const sessionOver = async (h: Harness): Promise<AgentSession> =>
		new AgentSession({
			agent: h.session.agent,
			sessionManager: h.sessionManager,
			settingsManager: h.settingsManager,
			cwd: h.tempDir,
			modelRuntime: getModelRuntime(await createModelRegistry(h.authStorage, h.tempDir)),
			resourceLoader: createTestResourceLoader(),
		});

	it("ends the run after the turn that published the revision", async () => {
		const h = await createHarness();
		harnesses.push(h);
		await roundThenRevision(h);

		// The revision is what paused the task, and the loop stopped instead of making another
		// provider request: the spare response is still queued and never reached the transcript.
		expect(h.getPendingResponseCount()).toBe(1);
		expect(assistantText(h)).not.toContain("LEAKED");
	});

	it("decides the turn boundary from the pause and leaves normal scheduling alone otherwise", async () => {
		const h = await createHarness();
		harnesses.push(h);
		await roundThenRevision(h);

		const hook = h.session.agent.finishTurn;
		expect(hook).toBeDefined();
		// Still waiting on the user: the installed hook ends the run.
		expect(await hook!({} as never, undefined)).toEqual({ action: "end" });

		// Once the response is answered, the hook stops forcing an end and normal scheduling stands.
		const correction = h.session.submitFormulationCorrection("also consider the other path")!;
		const c = new BeliefLoopController(h.session);
		c.answerFormulationCorrection(correction.id, "I keep the revised reading.");
		expect(await hook!({} as never, undefined)).toBeUndefined();
	});

	it("keeps a turn boundary that was already installed", async () => {
		const h = await createHarness();
		const agent = h.session.agent;
		// Each construction composes with whatever hook the agent already carries, so the installed
		// hook's own decision has to survive: it ends, continues, or defers exactly as it did.
		agent.finishTurn = async () => ({ action: "continue" });
		const continueSession = await sessionOver(h);
		expect(await continueSession.agent.finishTurn!({} as never, undefined)).toEqual({ action: "continue" });

		agent.finishTurn = async () => ({ action: "end" });
		const endSession = await sessionOver(h);
		expect(await endSession.agent.finishTurn!({} as never, undefined)).toEqual({ action: "end" });
		h.cleanup();
	});

	it("does not run an installed turn boundary while the revision is unanswered", async () => {
		const h = await createHarness();
		harnesses.push(h);
		await roundThenRevision(h);

		// The old stop hook was short-circuited: while the task waits on the user's answer, the turn
		// boundary ends the run without running whatever hook was already installed.
		let calls = 0;
		h.session.agent.finishTurn = async () => {
			calls += 1;
			return { action: "continue" };
		};
		const composed = await sessionOver(h);
		expect(await composed.agent.finishTurn!({} as never, undefined)).toEqual({ action: "end" });
		expect(calls).toBe(0);

		// Answering the revision releases the pause, and then the installed hook decides again. The
		// answer goes through the composed session's own loop, which is the state its hook reads.
		const composedLoop = (composed as unknown as { _beliefLoop: BeliefLoopController })._beliefLoop;
		const correction = composed.submitFormulationCorrection("also consider the other path")!;
		composedLoop.answerFormulationCorrection(correction.id, "I keep the revised reading.");
		expect(await composed.agent.finishTurn!({} as never, undefined)).toEqual({ action: "continue" });
		expect(calls).toBe(1);
	});

	it("does not drain a queued steering message when the revision pauses the run", async () => {
		let h: Harness | undefined;
		const steerTool: AgentTool = {
			name: "queue_steering",
			label: "queue steering",
			description: "Queue a steering message during the turn",
			parameters: Type.Object({}),
			execute: async () => {
				h?.session.agent.steer({
					role: "user",
					content: [{ type: "text", text: "STEERED" }],
					timestamp: Date.now(),
				});
				return { content: [{ type: "text", text: "queued" }], details: undefined };
			},
		};
		h = await createHarness({ tools: [steerTool] });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([belief(), reading("local retry control"), focus(), select()]),
			fauxAssistantMessage("Observed: the retry reused the same identity"),
			fauxAssistantMessage([adjudicate()]),
			fauxAssistantMessage([reading("cross-component identity ownership"), fauxToolCall("queue_steering", {})]),
			fauxAssistantMessage("LEAKED"),
		]);
		await h.session.prompt("Investigate identity ownership");

		// The pause exits before polling the queues: the steering message the turn queued is not
		// appended, and no further provider request is made with it.
		expect(h.getPendingResponseCount()).toBe(1);
		const transcript = h.session.messages.map(getMessageText).join("\n");
		expect(transcript).not.toContain("STEERED");
		expect(transcript).not.toContain("LEAKED");
	});
});
