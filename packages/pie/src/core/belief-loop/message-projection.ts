import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { BELIEF_SURFACE_TOOLS, type LoopRole, ROLE_SPECS } from "../role-specs.ts";

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

/**
 * The control-only belief surface, shared with the role specs.
 *
 * Everything on it is bookkeeping an epistemic role operates on rather than an observation about
 * the world, which is why the projection has to know the whole set: a tool that is missing from
 * it is misread as a probe (masking the turn that used it and treating its result as raw
 * evidence), and the execution role would be offered a surface it must not imitate.
 */
const BELIEF_SURFACE = new Set<string>(BELIEF_SURFACE_TOOLS);

/** The mutating half of the surface: everything except the read-only `view_beliefs`, which the
 *  execution role legitimately shares. */
const BELIEF_MUTATIONS = new Set<string>(BELIEF_SURFACE_TOOLS.filter((name) => name !== "view_beliefs"));

/** A probe (execution) tool is anything outside the belief surface: the belief-side tools mark
 *  the epistemic roles; anything else (read/bash/grep/…) marks the probe role. */
export function isProbeTool(name: string): boolean {
	return !BELIEF_SURFACE.has(name);
}

/** Whether an assistant turn belongs to the probe role, i.e. it invoked a non-belief tool. */
function isProbeAssistant(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === "toolCall" && isProbeTool(block.name));
}

/** Whether an assistant turn carries a belief *mutation* tool call — the epistemic role's
 *  exclusive surface, which the execution role must not imitate. */
function isEpistemicMutation(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === "toolCall" && BELIEF_MUTATIONS.has(block.name));
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
 *  default), which needs it to recall the episode it is probing; finalReport drops it too,
 *  since it has no tools and its `view_beliefs` result is masked to a note. */
function maskEpistemicAssistant(message: AssistantMessage, keepViewBeliefs = true): AssistantMessage | undefined {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			continue;
		}
		if (block.type === "toolCall") {
			const isReadOnly = block.name === "view_beliefs";
			if (BELIEF_MUTATIONS.has(block.name) || (isReadOnly && !keepViewBeliefs)) {
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
	if (message.role === "toolResult" && BELIEF_SURFACE.has(message.toolName)) {
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
 * Redact the belief *mutation* surface (declare_belief / conclude / set_formulation / …) from one
 * message, for the execution role. The execution role probes and reports; belief updates,
 * formulation publication, and concluding happen in the epistemic role, so exposing the mutation
 * echo — both its "Applied propose/support/refute" results and its tool-call blocks on the
 * epistemic role's assistant turns — only invites the probe role to step out of its lane instead
 * of reporting a plain observation.
 *
 * The results are keyed off `BELIEF_MUTATIONS` rather than a hand-written list because the two
 * halves have to agree: `maskEpistemicAssistant` elides *every* mutation call, so a result left
 * behind for one it dropped is an orphaned `tool` message with no surviving call — which strict
 * providers reject outright ("tool must be a response to tool_calls"). Deriving both from the one
 * set is what makes a newly added mutation tool safe by default.
 *
 * The read-only `view_beliefs` result is left intact — the execution role needs it to recall the
 * belief it is testing.
 */
function maskBeliefBookkeeping(message: AgentMessage): AgentMessage | undefined {
	switch (message.role) {
		case "toolResult": {
			if (!BELIEF_MUTATIONS.has(message.toolName)) return message;
			const placeholders: Record<string, string> = {
				route_task: "[routing decision omitted]",
				focus_beliefs: "[focus declaration omitted]",
				review_applicability: "[applicability review omitted]",
				select_experiment: "[experiment selection omitted]",
				declare_belief: "[belief update omitted]",
				conclude: "[investigation concluded]",
			};
			return {
				role: "user",
				content: [{ type: "text", text: placeholders[message.toolName] ?? "[belief bookkeeping omitted]" }],
				timestamp: message.timestamp,
			};
		}
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
