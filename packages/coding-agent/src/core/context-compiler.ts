import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction/index.ts";
import type { SessionEntry } from "./session-manager.ts";
import { sessionEntryToContextMessages } from "./session-manager.ts";

export const PHASE_ZERO_CONTEXT_COMPILER_VERSION = "pie-phase-0/v1";

export type EmptyEpistemicState = Record<never, never>;

export type ContextOmissionReason =
	| "budget"
	| "historical_summary"
	| "not_model_facing"
	| "runtime_excluded"
	| "invalid_tool_sequence";

export interface ContextOmission {
	eventId: string;
	eventType: SessionEntry["type"];
	reason: ContextOmissionReason;
}

export interface ContextSelectionManifest {
	compilerVersion: typeof PHASE_ZERO_CONTEXT_COMPILER_VERSION;
	inputEventIds: string[];
	selectedEventIds: string[];
	omissions: ContextOmission[];
	budget: {
		contextWindow: number;
		reservedOutputTokens: number;
		availableInputTokens: number;
		requiredTokens: number;
		selectedMessageTokens: number;
		outputMessageTokens: number;
	};
}

export interface ContextCompilerInput {
	rawEvents: readonly SessionEntry[];
	epistemicState: EmptyEpistemicState;
	runtimeMessages: readonly AgentMessage[];
	model: Model<Api>;
	systemPrompt: string;
	tools: readonly AgentTool[];
	reservedOutputTokens: number;
	inputTokenLimit?: number;
	signal?: AbortSignal;
	transformMessages?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
}

export interface ContextCompilation {
	messages: AgentMessage[];
	manifest: ContextSelectionManifest;
}

export interface ContextCompiler {
	compile(input: ContextCompilerInput): Promise<ContextCompilation>;
}

export class ContextBudgetError extends Error {
	readonly availableInputTokens: number;
	readonly minimumRequiredTokens: number;

	constructor(availableInputTokens: number, minimumRequiredTokens: number) {
		super(
			`Pie could not build a valid model context within the ${availableInputTokens}-token input budget. ` +
				`The minimum coherent projection needs approximately ${minimumRequiredTokens} tokens. ` +
				"Reduce the current request or tool output, or switch to a model with a larger context window.",
		);
		this.name = "ContextBudgetError";
		this.availableInputTokens = availableInputTokens;
		this.minimumRequiredTokens = minimumRequiredTokens;
	}
}

type ProjectedEvent = {
	event: SessionEntry;
	messages: AgentMessage[];
	tokens: number;
};

type CoherentWindow = {
	events: ProjectedEvent[];
	tokens: number;
	valid: boolean;
};

function safeJsonLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function estimateRequiredTokens(systemPrompt: string, tools: readonly AgentTool[]): number {
	return Math.ceil((systemPrompt.length + safeJsonLength(tools)) / 4);
}

function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateTokens(message);
	return tokens;
}

function isRuntimeExcluded(event: SessionEntry, runtimeMessages: ReadonlySet<AgentMessage>): boolean {
	if (event.type !== "message" || event.message.role !== "assistant" || runtimeMessages.has(event.message)) {
		return false;
	}
	return event.message.stopReason === "error" || event.message.stopReason === "length";
}

function validateToolSequence(events: readonly ProjectedEvent[]): boolean {
	const pendingToolCalls = new Set<string>();
	for (const { messages } of events) {
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") pendingToolCalls.add(block.id);
				}
			} else if (message.role === "toolResult") {
				if (!pendingToolCalls.delete(message.toolCallId)) return false;
			}
		}
	}
	return pendingToolCalls.size === 0;
}

function buildCoherentWindows(events: readonly ProjectedEvent[]): CoherentWindow[] {
	const windows: CoherentWindow[] = [];
	let current: ProjectedEvent[] = [];

	for (const event of events) {
		const startsTurn = event.messages.some((message) => message.role === "user");
		if (startsTurn && current.length > 0) {
			windows.push({
				events: current,
				tokens: current.reduce((sum, candidate) => sum + candidate.tokens, 0),
				valid: validateToolSequence(current),
			});
			current = [];
		}
		current.push(event);
	}

	if (current.length > 0) {
		windows.push({
			events: current,
			tokens: current.reduce((sum, candidate) => sum + candidate.tokens, 0),
			valid: validateToolSequence(current),
		});
	}
	return windows;
}

/**
 * Phase 0 compiler: deterministic structural projection from the active raw branch.
 * Compaction and branch summaries remain in provenance but are never treated as cognition.
 */
export class PhaseZeroContextCompiler implements ContextCompiler {
	async compile(input: ContextCompilerInput): Promise<ContextCompilation> {
		const runtimeMessages = new Set(input.runtimeMessages);
		const omissionsById = new Map<string, ContextOmission>();
		const projectedEvents: ProjectedEvent[] = [];

		for (const event of input.rawEvents) {
			if (event.type === "compaction" || event.type === "branch_summary") {
				omissionsById.set(event.id, { eventId: event.id, eventType: event.type, reason: "historical_summary" });
				continue;
			}
			if (isRuntimeExcluded(event, runtimeMessages)) {
				omissionsById.set(event.id, { eventId: event.id, eventType: event.type, reason: "runtime_excluded" });
				continue;
			}
			const messages = sessionEntryToContextMessages(event).filter(
				(message) => message.role !== "bashExecution" || !message.excludeFromContext,
			);
			if (messages.length === 0) {
				omissionsById.set(event.id, { eventId: event.id, eventType: event.type, reason: "not_model_facing" });
				continue;
			}
			projectedEvents.push({ event, messages, tokens: estimateMessagesTokens(messages) });
		}

		const contextWindow = Math.max(0, input.model.contextWindow);
		const reservedOutputTokens = Math.max(0, Math.min(input.reservedOutputTokens, contextWindow));
		const availableInputTokens = Math.max(
			0,
			Math.min(contextWindow - reservedOutputTokens, input.inputTokenLimit ?? Number.POSITIVE_INFINITY),
		);
		const requiredTokens = estimateRequiredTokens(input.systemPrompt, input.tools);
		const messageBudget = Math.max(0, availableInputTokens - requiredTokens);
		const windows = buildCoherentWindows(projectedEvents);
		const selectedIds = new Set<string>();
		let selectedMessageTokens = 0;

		const allMessagesTokens = windows.reduce((sum, window) => sum + window.tokens, 0);
		const allWindowsValid = windows.every((window) => window.valid);
		if (allWindowsValid && allMessagesTokens <= messageBudget) {
			for (const event of projectedEvents) selectedIds.add(event.event.id);
			selectedMessageTokens = allMessagesTokens;
		} else if (windows.length > 0) {
			const newestWindow = windows[windows.length - 1]!;
			if (!newestWindow.valid) {
				for (const event of newestWindow.events) {
					omissionsById.set(event.event.id, {
						eventId: event.event.id,
						eventType: event.event.type,
						reason: "invalid_tool_sequence",
					});
				}
				throw new ContextBudgetError(availableInputTokens, requiredTokens + newestWindow.tokens);
			}
			if (newestWindow.tokens > messageBudget) {
				throw new ContextBudgetError(availableInputTokens, requiredTokens + newestWindow.tokens);
			}

			for (let index = windows.length - 1; index >= 0; index--) {
				const window = windows[index]!;
				if (!window.valid || selectedMessageTokens + window.tokens > messageBudget) break;
				for (const event of window.events) selectedIds.add(event.event.id);
				selectedMessageTokens += window.tokens;
			}
		}

		for (const event of projectedEvents) {
			if (!selectedIds.has(event.event.id) && !omissionsById.has(event.event.id)) {
				omissionsById.set(event.event.id, {
					eventId: event.event.id,
					eventType: event.event.type,
					reason: "budget",
				});
			}
		}

		const selectedEvents = projectedEvents.filter((event) => selectedIds.has(event.event.id));
		const selectedMessages = selectedEvents.flatMap((event) => event.messages);
		const messages = input.transformMessages
			? await input.transformMessages(selectedMessages, input.signal)
			: selectedMessages;
		const outputMessageTokens = estimateMessagesTokens(messages);
		if (requiredTokens + outputMessageTokens > availableInputTokens) {
			throw new ContextBudgetError(availableInputTokens, requiredTokens + outputMessageTokens);
		}

		return {
			messages,
			manifest: {
				compilerVersion: PHASE_ZERO_CONTEXT_COMPILER_VERSION,
				inputEventIds: input.rawEvents.map((event) => event.id),
				selectedEventIds: selectedEvents.map((event) => event.event.id),
				omissions: input.rawEvents.flatMap((event) => {
					const omission = omissionsById.get(event.id);
					return omission ? [omission] : [];
				}),
				budget: {
					contextWindow,
					reservedOutputTokens,
					availableInputTokens,
					requiredTokens,
					selectedMessageTokens,
					outputMessageTokens,
				},
			},
		};
	}
}
