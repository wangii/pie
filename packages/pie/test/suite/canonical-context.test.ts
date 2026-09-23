import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * The session log is the authority for what the model sees: an appended context edit changes future
 * provider context without rewriting history, and `refreshContext()` brings the agent's derived
 * message view back in step with it.
 */
describe("canonical session context reaches the provider request", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const text = (messages: readonly unknown[]): string => messages.map(getMessageText).join("\n");

	/** Capture the messages the loop hands to the next provider request. */
	function captureNextRequest(h: Harness): () => readonly AgentMessage[] | undefined {
		let observed: readonly AgentMessage[] | undefined;
		const previous = h.session.agent.prepareNextTurnWithContext;
		h.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const snapshot = await previous?.(turn, signal);
			observed = (snapshot?.context ?? turn.context).messages;
			return snapshot;
		};
		return () => observed;
	}

	it("drops an omitted entry from the next request while the log keeps it", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("FIRST-ANSWER"), fauxAssistantMessage("SECOND-ANSWER")]);
		await h.session.prompt("first question");

		const entries = h.sessionManager.getEntries();
		const target = entries.find(
			(entry) => entry.type === "message" && text([entry.message]).includes("FIRST-ANSWER"),
		);
		expect(target).toBeDefined();
		const entriesBefore = entries.length;

		h.sessionManager.appendContextEdit(target!.id, null);
		h.session.refreshContext();

		// The derived view follows the projection; the raw history does not change.
		expect(text(h.session.messages)).not.toContain("FIRST-ANSWER");
		expect(h.sessionManager.getEntries().length).toBe(entriesBefore + 1);

		const observedRequest = captureNextRequest(h);
		h.setResponses([fauxAssistantMessage("THIRD-ANSWER")]);
		await h.session.prompt("second question");

		const request = observedRequest();
		expect(request).toBeDefined();
		expect(text(request!)).not.toContain("FIRST-ANSWER");
		expect(text(request!)).toContain("second question");
	});
});
