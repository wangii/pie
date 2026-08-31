import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { type LoopRole, ROLE_SPECS } from "../role-specs.ts";

/**
 * Per-role transcript projection. Each belief-loop role sees a different projection of the
 * authoritative `agent.state.messages`:
 * - propose: the belief bookkeeping (declare_belief / view_beliefs results) is always visible
 *   — it is the operated-on object — while raw operational detail is always masked so the
 *   projected transcript stays append-only and cacheable.
 * - distill: like propose, but the current execution episode's raw evidence is shown exactly
 *   once (above the evidence watermark) so it can update beliefs on it.
 * - execution: the belief *mutation* echo (declare_belief) is masked so the probe role is
 *   not tempted to propose/update beliefs, but the read-only `view_beliefs` stays visible so
 *   it can recall the belief it is testing; raw operational detail stays.
 * - finalReport: raw operational detail is discarded; the settled beliefs remain.
 *
 * These are pure functions of (messages, role, evidenceWatermark) — no AgentSession state is
 * read or mutated here, so they are independently testable.
 */

/** A probe (execution) tool is anything outside the belief surface: `declare_belief` /
 *  `view_beliefs` / `conclude` mark the belief-side (epistemic) roles; anything else
 *  (read/bash/grep/…) marks the probe role. */
export function isProbeTool(name: string): boolean {
	return name !== "route_task" && name !== "declare_belief" && name !== "view_beliefs" && name !== "conclude";
}

/** Whether an assistant turn belongs to the probe role, i.e. it invoked a non-belief tool. */
function isProbeAssistant(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === "toolCall" && isProbeTool(block.name));
}

/** Whether an assistant turn carries a belief *mutation* tool call (`declare_belief` /
 *  `conclude`) — the epistemic role's exclusive surface, which the execution role must not
 *  imitate. `view_beliefs` is deliberately excluded: it is read-only and shared with the
 *  execution role. */
function isEpistemicMutation(message: AssistantMessage): boolean {
	return message.content.some(
		(block) =>
			block.type === "toolCall" &&
			(block.name === "route_task" || block.name === "declare_belief" || block.name === "conclude"),
	);
}

/** Distill a probe-role assistant turn for the epistemic/finalReport view: drop its
 *  thinking blocks and its tool calls entirely, keeping only the textual report. Eliding the
 *  call (rather than renaming it) is what stops a role from imitating the probe — and what
 *  keeps the transcript free of tool-call names the provider may reject. */
function maskProbeAssistant(message: AssistantMessage): AssistantMessage | undefined {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "thinking" || block.type === "toolCall") {
			continue;
		}
		content.push(block);
	}
	return content.length > 0 ? { ...message, content } : undefined;
}

/** Strip the plaintext thinking blocks from an epistemic-role assistant turn, keeping its
 *  text and every tool call (the belief bookkeeping the propose/distill roles operate on).
 *  Unlike `maskEpistemicAssistant`, no belief tool call is dropped — only the `thinking`
 *  blocks. Returns undefined when nothing but thinking survives. */
function maskEpistemicThinking(message: AssistantMessage): AssistantMessage | undefined {
	const content = message.content.filter((block) => block.type !== "thinking");
	return content.length > 0 ? { ...message, content } : undefined;
}

/** Distill an epistemic-role assistant turn for a role that must not see the belief
 *  bookkeeping: drop its thinking and its belief tool calls, keeping only its text. Eliding
 *  the call (rather than renaming it) is what stops the role from imitating the bookkeeping —
 *  and what keeps the transcript free of tool-call names the provider may reject. The
 *  read-only `view_beliefs` call is kept for the execution role (`keepViewBeliefs`, the
 *  default), which needs it to recall the frame it is probing; finalReport drops it too,
 *  since it has no tools and its `view_beliefs` result is masked to a note. */
function maskEpistemicAssistant(message: AssistantMessage, keepViewBeliefs = true): AssistantMessage | undefined {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			continue;
		}
		if (block.type === "toolCall") {
			const isMutation = block.name === "route_task" || block.name === "declare_belief" || block.name === "conclude";
			const isReadOnly = block.name === "view_beliefs";
			if (isMutation || (isReadOnly && !keepViewBeliefs)) {
				continue;
			}
		}
		content.push(block);
	}
	return content.length > 0 ? { ...message, content } : undefined;
}

/** Mask the belief tools' echo from a finalReport message: the explicit final-report context
 *  injected at the handoff replaces incidental `declare_belief`/`view_beliefs`/`conclude`
 *  results, which may be stale or partial, so they are dropped here rather than left to be read
 *  as facts. `conclude` is included so its "Investigation concluded." result does not orphan
 *  once `maskEpistemicAssistant` elides the call. */
function maskBeliefEchoes(message: AgentMessage): AgentMessage | undefined {
	if (
		message.role === "toolResult" &&
		(message.toolName === "route_task" ||
			message.toolName === "declare_belief" ||
			message.toolName === "view_beliefs" ||
			message.toolName === "conclude")
	) {
		return {
			role: "user",
			content: [{ type: "text", text: "[belief bookkeeping omitted]" }],
			timestamp: message.timestamp,
		};
	}
	return message;
}

/**
 * Redact raw operational detail from one message, preserving the belief bookkeeping. Two
 * independent layers:
 * - the probe-role assistant turn is always elided (thinking dropped, tool calls removed) —
 *   seeing the probe call `bash`/`read` is what drives a role to imitate it, so this is
 *   age-independent;
 * - a tool result whose call was elided (a probe tool, or a belief tool called inside a probe
 *   turn) is folded into a plain text note — masked to a placeholder only when `maskResult` is
 *   true. The propose/finalReport roles pass `true` unconditionally (append-only, cacheable);
 *   the distill role passes `index < watermark` so it sees the current episode's raw evidence
 *   once, then it is masked.
 */
function maskOperationalDetail(
	message: AgentMessage,
	maskResult: boolean,
	elidedProbeToolCalls: Set<string>,
	stripEpistemicThinking = false,
): AgentMessage | undefined {
	switch (message.role) {
		case "toolResult":
			if (isProbeTool(message.toolName) || elidedProbeToolCalls.has(message.toolCallId)) {
				if (maskResult) {
					return {
						role: "user",
						content: [{ type: "text", text: "[operational detail omitted]" }],
						timestamp: message.timestamp,
					};
				}
				return { role: "user", content: message.content, timestamp: message.timestamp };
			}
			return message;
		case "bashExecution":
			return maskResult ? { ...message, output: "[output omitted]" } : message;
		case "assistant":
			if (isProbeAssistant(message)) {
				return maskProbeAssistant(message);
			}
			return stripEpistemicThinking ? maskEpistemicThinking(message) : message;
		default:
			return message;
	}
}

/**
 * Redact the belief *mutation* surface (declare_belief / conclude) from one message, for the
 * execution role. The execution role probes and reports; belief updates and concluding happen
 * in the epistemic role, so exposing the mutation echo — both its "Applied propose/support/
 * refute" results and its tool-call blocks on the epistemic role's assistant turns — only
 * invites the probe role to step out of its lane instead of reporting a plain observation.
 * The read-only `view_beliefs` result is left intact — the execution role needs it to recall
 * the belief it is testing.
 */
function maskBeliefBookkeeping(message: AgentMessage): AgentMessage | undefined {
	switch (message.role) {
		case "toolResult":
			if (message.toolName === "route_task") {
				return {
					role: "user",
					content: [{ type: "text", text: "[routing decision omitted]" }],
					timestamp: message.timestamp,
				};
			}
			if (message.toolName === "declare_belief") {
				return {
					role: "user",
					content: [{ type: "text", text: "[belief update omitted]" }],
					timestamp: message.timestamp,
				};
			}
			if (message.toolName === "conclude") {
				return {
					role: "user",
					content: [{ type: "text", text: "[investigation concluded]" }],
					timestamp: message.timestamp,
				};
			}
			return message;
		case "assistant":
			return isEpistemicMutation(message) ? maskEpistemicAssistant(message) : message;
		default:
			return message;
	}
}

/**
 * Tool-call ids elided from the belief-side view: every tool call in a probe (execution) turn.
 * `maskProbeAssistant` drops them all, so any `toolResult` carrying one of these ids has no
 * surviving call and must be folded rather than left as an orphaned `tool` message (which strict
 * providers reject with "tool must be a response to tool_calls").
 */
function elidedProbeToolCallIds(messages: AgentMessage[]): Set<string> {
	const elided = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !isProbeAssistant(message)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "toolCall") {
				elided.add(block.id);
			}
		}
	}
	return elided;
}

/** Project one message for a role. Returns undefined when the projection reduces the message
 *  to nothing (e.g. a probe turn whose tool calls and thinking are all elided). */
function projectMessage(
	message: AgentMessage,
	index: number,
	role: LoopRole,
	elidedProbeToolCalls: Set<string>,
	evidenceWatermark: number,
): AgentMessage | undefined {
	switch (ROLE_SPECS[role].projection) {
		case "belief":
			return maskOperationalDetail(message, true, elidedProbeToolCalls, true);
		case "distill":
			return maskOperationalDetail(message, index < evidenceWatermark, elidedProbeToolCalls, true);
		case "execution":
			return maskBeliefBookkeeping(message);
		case "finalReport": {
			const masked = maskOperationalDetail(message, true, elidedProbeToolCalls);
			if (masked === undefined) return undefined;
			const stripped = masked.role === "assistant" ? maskEpistemicAssistant(masked, false) : masked;
			return stripped === undefined ? undefined : maskBeliefEchoes(stripped);
		}
	}
}

/** Project the full transcript for an explicit role (used to size each role's context). */
export function projectMessagesFor(
	messages: AgentMessage[],
	role: LoopRole,
	evidenceWatermark: number,
): AgentMessage[] {
	const elided = elidedProbeToolCallIds(messages);
	return messages
		.map((message, index) => projectMessage(message, index, role, elided, evidenceWatermark))
		.filter((message): message is AgentMessage => message !== undefined);
}

/** The transcript for the next role's turn, projected from the authoritative message list.
 *  Returns the raw messages unchanged when the belief loop is not usable. */
export function projectContextMessages(
	messages: AgentMessage[],
	role: LoopRole,
	evidenceWatermark: number,
	beliefSetUsable: boolean,
): AgentMessage[] {
	if (!beliefSetUsable) {
		return messages.slice();
	}
	return projectMessagesFor(messages, role, evidenceWatermark);
}
