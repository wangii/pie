import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { projectMessagesFor } from "../src/core/belief-loop/message-projection.ts";
import type { LoopRole } from "../src/core/role-specs.ts";

/**
 * The projection masks a role's transcript so it only sees what its lane allows. The failure mode
 * this file pins is structural rather than cosmetic: every projection is sent to a provider as a
 * message list, and a `toolResult` whose `toolCall` was elided is an orphaned `tool` message, which
 * strict providers reject outright ("tool must be a response to tool_calls"). Masking a call
 * therefore has to mask its result in the same pass — including for tools added later.
 */

function toolResult(toolCallId: string, toolName: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	} as AgentMessage;
}

/** Tool results left with no surviving call anywhere in the projection. */
function orphanedToolResults(messages: readonly AgentMessage[]): string[] {
	const calls = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") calls.add(block.id);
		}
	}
	const orphans: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		if (!calls.has(message.toolCallId)) orphans.push(`${message.toolName}:${message.toolCallId}`);
	}
	return orphans;
}

const ROLES: LoopRole[] = ["propose", "distill", "execution", "finalReport"];

/**
 * A transcript with one turn per kind of tool: a probe, the belief bookkeeping, and the
 * formulation decision. Every role projects it differently, so it exercises every masking rule.
 */
function mixedTranscript(): AgentMessage[] {
	const setCall = fauxToolCall("set_formulation", {
		interpretation: "I read this as a persistence question",
		focus: "the value that outlives the request",
		implication: "check retention before touching eviction",
		reason: "first reading",
	});
	const deferCall = fauxToolCall("defer_formulation", {
		missingInformation: "whether the value is per-request or per-session",
		reason: "one probe cannot separate the two",
	});
	const probeCall = fauxToolCall("bash", { command: "ls" });
	const beliefCall = fauxToolCall("declare_belief", {
		op: "propose",
		statement: "the cache survives logout",
		domain: "product",
		expectation: "a post-logout read keeps the value",
		evidenceRounds: 1,
	});
	const viewCall = fauxToolCall("view_beliefs", {});
	const concludeCall = fauxToolCall("conclude", { result: "delivered", evidence: "observed" });

	return [
		{ role: "user", content: [{ type: "text", text: "is the cache persistent?" }], timestamp: 1 },
		fauxAssistantMessage([fauxThinking("weighing the readings"), setCall]),
		toolResult(
			setCall.id,
			"set_formulation",
			"Recorded formulation version 1: I read this as a persistence question",
		),
		fauxAssistantMessage([deferCall]),
		toolResult(deferCall.id, "defer_formulation", "Deferred stating a formulation. Missing: whether per-request"),
		fauxAssistantMessage([beliefCall, viewCall]),
		toolResult(beliefCall.id, "declare_belief", "Applied propose for belief-1"),
		toolResult(viewCall.id, "view_beliefs", "belief-1 proposed: the cache survives logout"),
		fauxAssistantMessage([probeCall]),
		toolResult(probeCall.id, "bash", "cache.ts:12 keeps the value"),
		fauxAssistantMessage([concludeCall]),
		toolResult(concludeCall.id, "conclude", "Investigation concluded."),
	];
}

describe("belief-loop message projection", () => {
	it.each(ROLES)("never leaves an orphaned tool result for the %s role", (role) => {
		const messages = mixedTranscript();
		const projected = projectMessagesFor(messages, role, messages.length);
		expect(orphanedToolResults(projected)).toEqual([]);
	});

	it("hides the formulation call and its echo from the execution role", () => {
		const messages = mixedTranscript();
		const projected = projectMessagesFor(messages, "execution", messages.length);
		const text = JSON.stringify(projected);

		// The probe role must not read the agent's own reading as an observation, nor be shown the
		// call it would have to imitate to state one of its own.
		expect(text).not.toContain("set_formulation");
		expect(text).not.toContain("defer_formulation");
		expect(text).not.toContain("I read this as a persistence question");
		expect(text).not.toContain("Deferred stating a formulation");
		// What it legitimately shares stays: the belief it is testing and the raw evidence.
		expect(text).toContain("the cache survives logout");
		expect(text).toContain("cache.ts:12 keeps the value");
	});

	it("keeps the formulation in the epistemic roles' transcript", () => {
		for (const role of ["propose", "distill"] as const) {
			const text = JSON.stringify(projectMessagesFor(mixedTranscript(), role, 0));
			expect(text).toContain("set_formulation");
			expect(text).toContain("I read this as a persistence question");
		}
	});
});
