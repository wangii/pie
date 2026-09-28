import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * Session-scoped auto-approval: with the toggle on, a reading published by a run is approved as the
 * run settles and the continuation starts on its own; with the toggle off, the pause is exactly the
 * one the user is used to.
 */
describe("session auto-approval of published Frames", () => {
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

	/** A run whose first turn publishes a reading, then the spare responses a continuation can use. */
	async function publishFirstReading(h: Harness): Promise<void> {
		h.setResponses([
			fauxAssistantMessage([belief(), reading("local retry control"), focus(), select()]),
			fauxAssistantMessage("CONTINUED_ON_ITS_OWN"),
			fauxAssistantMessage("THIRD"),
		]);
		await h.session.prompt("Investigate identity ownership");
	}

	const customTexts = (h: Harness): string =>
		h.session.messages
			.filter((message) => message.role === "custom")
			.map((message) => {
				const customType = (message as { customType?: string }).customType ?? "?";
				return `${customType}: ${getMessageText(message)}`;
			})
			.join("\n");

	const assistantText = (h: Harness): string =>
		h.session.messages
			.filter((message) => message.role === "assistant")
			.map(getMessageText)
			.join("\n");

	it("approves and resumes without the user when the toggle is on", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.session.setAutoApproveFrame(true);
		await publishFirstReading(h);
		await h.session.waitForIdle();

		expect(h.session.autoApproveFrame).toBe(true);
		expect(h.session.getFormulationState()?.approved).toBe(true);
		expect(h.session.getFormulationState()?.awaitingResponse).toBe(false);
		expect(customTexts(h)).toContain("formulation_approved");
		// The approval started the continuation run, which consumed the next spare response.
		expect(assistantText(h)).toContain("CONTINUED_ON_ITS_OWN");
	});

	it("keeps waiting when the toggle is off", async () => {
		const h = await createHarness();
		harnesses.push(h);
		await publishFirstReading(h);
		await h.session.waitForIdle();

		expect(h.session.autoApproveFrame).toBe(false);
		expect(h.session.getFormulationState()?.awaitingResponse).toBe(true);
		expect(customTexts(h)).not.toContain("formulation_approved");
		expect(assistantText(h)).not.toContain("CONTINUED_ON_ITS_OWN");
		expect(h.getPendingResponseCount()).toBeGreaterThan(0);
	});

	it("resumes a reading that was already waiting when the toggle is turned on", async () => {
		const h = await createHarness();
		harnesses.push(h);
		await publishFirstReading(h);
		await h.session.waitForIdle();
		expect(h.session.getFormulationState()?.awaitingResponse).toBe(true);

		h.session.setAutoApproveFrame(true);
		await h.session.waitForIdle();

		expect(h.session.getFormulationState()?.approved).toBe(true);
		expect(h.session.getFormulationState()?.awaitingResponse).toBe(false);
		expect(customTexts(h)).toContain("formulation_approved");
		expect(assistantText(h)).toContain("CONTINUED_ON_ITS_OWN");
	});
});
