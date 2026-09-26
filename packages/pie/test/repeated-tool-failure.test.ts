import type { PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BeliefLoopController, countRepeatedFailure } from "../src/core/belief-loop/belief-loop-controller.ts";
import { SessionManager } from "../src/core/session-manager.ts";

/** A controller plus the steer texts it asked the host to inject. */
function createController(): { controller: BeliefLoopController; steers: string[] } {
	const steers: string[] = [];
	const host = {
		sessionManager: SessionManager.inMemory(process.cwd(), { id: "session-1" }),
		_emit: () => {},
		_fullActiveToolNames: ["declare_belief"],
		_messageText: (message: { content: unknown }) => {
			const content = message.content;
			return typeof content === "string" ? content : JSON.stringify(content);
		},
		agent: {
			steer: ({ content }: { content: Array<{ text: string }> }) => {
				steers.push(content.map((part) => part.text).join("\n"));
			},
		},
	} as unknown as AgentSession;
	return { controller: new BeliefLoopController(host), steers };
}

/**
 * The escalation wiring lives behind a private method that runs at the top of `advanceRole`,
 * before every early return. It is driven directly here so the test does not need the whole
 * role surface (tool registry, system prompt) that a full turn would require.
 */
function noteFailures(controller: BeliefLoopController, toolName: string, reason: string, times: number): void {
	const note = (
		controller as unknown as { noteRepeatedFailures(turn: PrepareNextTurnContext): void }
	).noteRepeatedFailures.bind(controller);
	for (let i = 0; i < times; i += 1) {
		note({
			toolResults: [
				{
					role: "toolResult",
					toolName,
					toolCallId: `tc-${i}`,
					content: [{ type: "text", text: `${reason}\nsecond line` }],
					isError: true,
					timestamp: 0,
				},
			],
		} as unknown as PrepareNextTurnContext);
	}
}

describe("repeated tool failure escalation", () => {
	test("counts one signature and escalates once at the threshold", () => {
		const counts = new Map<string, number>();
		const nudged = new Set<string>();
		const note = (toolName: string, reason: string) => countRepeatedFailure(counts, nudged, toolName, reason, 3);

		// The first two identical failures teach the caller nothing new, so they only accumulate.
		expect(note("review_applicability", "unknown belief belief-3").escalate).toBe(false);
		expect(note("review_applicability", "unknown belief belief-3").escalate).toBe(false);
		expect(note("review_applicability", "unknown belief belief-3")).toEqual({
			signature: "review_applicability: unknown belief belief-3",
			count: 3,
			escalate: true,
		});

		// The third is the one that speaks, and re-issuing the same call does not re-nag.
		expect(note("review_applicability", "unknown belief belief-3").escalate).toBe(false);
		expect(note("review_applicability", "unknown belief belief-3").count).toBe(5);
		expect(nudged.size).toBe(1);
	});

	test("keeps signatures apart, including the first line of the reason", () => {
		const counts = new Map<string, number>();
		const nudged = new Set<string>();
		const note = (toolName: string, reason: string) => countRepeatedFailure(counts, nudged, toolName, reason, 3);

		note("select_experiment", "Belief belief-10 is supported");
		note("select_experiment", "Belief belief-10 is supported");
		note("declare_belief", "Belief belief-10 is supported");
		// Two distinct signatures of two and one: nothing has reached the threshold on its own.
		expect([...counts.values()].sort()).toEqual([1, 2]);
		expect(note("select_experiment", "Belief belief-10 is supported").escalate).toBe(true);
	});

	test("steers the host once the same failure has been seen three times", () => {
		const { controller, steers } = createController();

		// Two identical failures are silent; the third injects the escalation, and only once.
		noteFailures(controller, "review_applicability", "unknown belief belief-3", 2);
		expect(steers).toEqual([]);
		noteFailures(controller, "review_applicability", "unknown belief belief-3", 1);
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("rejected 3 times");
		noteFailures(controller, "review_applicability", "unknown belief belief-3", 5);
		expect(steers).toHaveLength(1);
	});

	test("does not escalate a success or a different signature", () => {
		const { controller, steers } = createController();
		noteFailures(controller, "declare_belief", "refine requires a non-empty `expectation`", 3);
		noteFailures(controller, "select_experiment", "Belief belief-10 is supported", 2);
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("declare_belief");
	});
});
