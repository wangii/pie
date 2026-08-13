import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction/index.ts";
import type { Action, Anchor, EpistemicState, Frame, Observation } from "./epistemic-state.ts";
import type { SessionEntry } from "./session-manager.ts";
import { sessionEntryToContextMessages } from "./session-manager.ts";

export const PHASE_ZERO_CONTEXT_COMPILER_VERSION = "pie-phase-0/v1";
export const PHASE_ONE_CONTEXT_COMPILER_VERSION = "pie-phase-1-anchor/v1";
export const PHASE_TWO_CONTEXT_COMPILER_VERSION = "pie-phase-2-frame/v1";
export const PHASE_THREE_CONTEXT_COMPILER_VERSION = "pie-phase-3-action/v1";
export const PHASE_FOUR_CONTEXT_COMPILER_VERSION = "pie-phase-4-observation/v1";
export const ANCHOR_CONTEXT_MESSAGE_TYPE = "pie.anchor";
export const FRAME_CONTEXT_MESSAGE_TYPE = "pie.frame";
export const ACTION_CONTEXT_MESSAGE_TYPE = "pie.action";
export const OBSERVATION_CONTEXT_MESSAGE_TYPE = "pie.observation";

export type EmptyEpistemicState = Record<never, never>;

export type ContextOmissionReason =
	| "budget"
	| "historical_summary"
	| "not_model_facing"
	| "runtime_excluded"
	| "invalid_tool_sequence"
	| "outside_action_episode";

export interface ContextOmission {
	eventId: string;
	eventType: SessionEntry["type"];
	reason: ContextOmissionReason;
}

export interface ContextSelectionManifest {
	compilerVersion: string;
	inputEventIds: string[];
	selectedEventIds: string[];
	omissions: ContextOmission[];
	epistemicState: {
		anchor?: {
			id: string;
			revision: number;
			revisionEntryId: string;
			sourceEventId: string;
			tokens: number;
		};
		frame?: {
			id: string;
			version: number;
			revisionEntryId: string;
			sourceEventId: string;
			horizon: number;
			completedModelResponses: number;
			remainingModelResponses: number;
			tokens: number;
		};
		action?: {
			id: string;
			startEntryId: string;
			frameRevisionEntryId: string;
			sourceEventId: string;
			completedModelResponses: number;
			tokens: number;
		};
		observations?: {
			selected: Array<{
				id: string;
				entryId: string;
				sourceEventIds: readonly string[];
				anchorRelevant: boolean;
				frameRelevant: boolean;
				tokens: number;
			}>;
			omitted: Array<{ id: string; entryId: string; reason: "budget" | "not_relevant" }>;
		};
	};
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
	epistemicState: EpistemicState;
	runtimeMessages: readonly AgentMessage[];
	model: Model<Api>;
	systemPrompt: string;
	tools: readonly AgentTool[];
	/** Compiler-owned transient request instruction; never persisted as a raw event. */
	requestInstruction?: AgentMessage;
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

type ProjectedObservation = {
	observation: Observation;
	message: AgentMessage;
	tokens: number;
	anchorRelevant: boolean;
	frameRelevant: boolean;
	order: number;
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

function anchorMessage(anchor: Anchor): AgentMessage {
	return {
		role: "custom",
		customType: ANCHOR_CONTEXT_MESSAGE_TYPE,
		content: `[ANCHOR]\n${anchor.statement}`,
		display: false,
		details: {
			anchorId: anchor.id,
			revision: anchor.revision,
			revisionEntryId: anchor.revisionEntryId,
			sourceEventId: anchor.sourceEventId,
		},
		timestamp: new Date(anchor.timestamp).getTime(),
	};
}

function frameMessage(frame: Frame): AgentMessage {
	const remainingModelResponses = Math.max(0, frame.horizon - frame.completedModelResponses);
	return {
		role: "custom",
		customType: FRAME_CONTEXT_MESSAGE_TYPE,
		content:
			`[CURRENT FRAME]\nCommitment: ${frame.statement}\nFalsifier: ${frame.falsifier}\n` +
			`Response lease: ${frame.completedModelResponses}/${frame.horizon} completed; ${remainingModelResponses} model responses remain`,
		display: false,
		details: {
			frameId: frame.id,
			version: frame.version,
			revisionEntryId: frame.revisionEntryId,
			sourceEventId: frame.sourceEventId,
			horizon: frame.horizon,
			completedModelResponses: frame.completedModelResponses,
		},
		timestamp: new Date(frame.timestamp).getTime(),
	};
}

function actionMessage(action: Action): AgentMessage {
	return {
		role: "custom",
		customType: ACTION_CONTEXT_MESSAGE_TYPE,
		content:
			`[CURRENT ACTION]\nIntent: ${action.intent}\nCompletion condition: ${action.completionCondition}\n` +
			"Contract: frozen for this episode. Tools and execution strategy may change; intent and completion condition may not. " +
			"If the condition cannot be met under the current Frame and constraints, return exactly UNRESOLVABLE.",
		display: false,
		details: {
			actionId: action.id,
			startEntryId: action.startEntryId,
			frameRevisionEntryId: action.frameRevisionEntryId,
			sourceEventId: action.sourceEventId,
			completedModelResponses: action.completedModelResponses,
		},
		timestamp: new Date(action.timestamp).getTime(),
	};
}

function observationMessage(observation: Observation, anchorRelevant: boolean, frameRelevant: boolean): AgentMessage {
	const relevance =
		frameRelevant && anchorRelevant ? "current Frame and Anchor" : frameRelevant ? "current Frame" : "Anchor";
	return {
		role: "custom",
		customType: OBSERVATION_CONTEXT_MESSAGE_TYPE,
		content: `[OBSERVATION ${observation.id}]\n${observation.statement}\nRelevance: ${relevance}`,
		display: false,
		details: {
			observationId: observation.id,
			entryId: observation.entryId,
			sourceEventIds: observation.sourceEventIds,
			anchorId: observation.anchorId,
			anchorRevisionEntryId: observation.anchorRevisionEntryId,
			frameId: observation.frameId,
			frameRevisionEntryId: observation.frameRevisionEntryId,
		},
		timestamp: new Date(observation.timestamp).getTime(),
	};
}

async function compileProjection(
	input: ContextCompilerInput,
	compilerVersion: string,
	anchor: Anchor | undefined,
	frame: Frame | undefined,
	action: Action | undefined,
	observations: readonly Observation[],
): Promise<ContextCompilation> {
	const runtimeMessages = new Set(input.runtimeMessages);
	const omissionsById = new Map<string, ContextOmission>();
	const projectedEvents: ProjectedEvent[] = [];

	const actionSourceIndex = action ? input.rawEvents.findIndex((event) => event.id === action.sourceEventId) : -1;
	if (action && actionSourceIndex < 0) {
		throw new Error(`Action ${action.id} source event ${action.sourceEventId} is absent from compiler input.`);
	}

	for (const [eventIndex, event] of input.rawEvents.entries()) {
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
		if (action && eventIndex < actionSourceIndex && messages.length > 0) {
			omissionsById.set(event.id, {
				eventId: event.id,
				eventType: event.type,
				reason: "outside_action_episode",
			});
			continue;
		}
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
	const anchorMessages = anchor ? [anchorMessage(anchor)] : [];
	const frameMessages = frame ? [frameMessage(frame)] : [];
	const actionMessages = action ? [actionMessage(action)] : [];
	const requestInstructionMessages = input.requestInstruction ? [input.requestInstruction] : [];
	const anchorTokens = estimateMessagesTokens(anchorMessages);
	const frameTokens = estimateMessagesTokens(frameMessages);
	const actionTokens = estimateMessagesTokens(actionMessages);
	const requestInstructionTokens = estimateMessagesTokens(requestInstructionMessages);
	const requiredStateTokens = anchorTokens + frameTokens + actionTokens + requestInstructionTokens;
	const windows = buildCoherentWindows(projectedEvents);
	const newestWindow = windows.at(-1);
	if (newestWindow && !newestWindow.valid) {
		for (const event of newestWindow.events) {
			omissionsById.set(event.event.id, {
				eventId: event.event.id,
				eventType: event.event.type,
				reason: "invalid_tool_sequence",
			});
		}
		throw new ContextBudgetError(availableInputTokens, requiredTokens + requiredStateTokens + newestWindow.tokens);
	}

	const projectedObservations: ProjectedObservation[] = observations.map((observation, order) => {
		const anchorRelevant = anchor !== undefined && observation.anchorRevisionEntryId === anchor.revisionEntryId;
		const frameRelevant = frame !== undefined && observation.frameRevisionEntryId === frame.revisionEntryId;
		const message = observationMessage(observation, anchorRelevant, frameRelevant);
		return {
			observation,
			message,
			tokens: estimateMessagesTokens([message]),
			anchorRelevant,
			frameRelevant,
			order,
		};
	});
	const selectedObservationIds = new Set<string>();
	let selectedObservationTokens = 0;
	const observationBudget = Math.max(
		0,
		availableInputTokens - requiredTokens - requiredStateTokens - (newestWindow?.tokens ?? 0),
	);
	const prioritizedObservations = projectedObservations
		.filter((candidate) => candidate.frameRelevant || candidate.anchorRelevant)
		.sort((left, right) => {
			if (left.frameRelevant !== right.frameRelevant) return left.frameRelevant ? -1 : 1;
			return right.order - left.order;
		});
	for (const candidate of prioritizedObservations) {
		if (selectedObservationTokens + candidate.tokens <= observationBudget) {
			selectedObservationIds.add(candidate.observation.id);
			selectedObservationTokens += candidate.tokens;
		}
	}
	const selectedObservations = projectedObservations.filter((candidate) =>
		selectedObservationIds.has(candidate.observation.id),
	);
	const observationMessages = selectedObservations.map((candidate) => candidate.message);
	const retainedMessages = [...anchorMessages, ...frameMessages, ...observationMessages, ...actionMessages];
	const retainedStateTokens = requiredStateTokens + selectedObservationTokens;
	const messageBudget = Math.max(0, availableInputTokens - requiredTokens - retainedStateTokens);
	const selectedIds = new Set<string>();
	let selectedEventTokens = 0;

	const allMessagesTokens = windows.reduce((sum, window) => sum + window.tokens, 0);
	const allWindowsValid = windows.every((window) => window.valid);
	if (allWindowsValid && allMessagesTokens <= messageBudget) {
		for (const event of projectedEvents) selectedIds.add(event.event.id);
		selectedEventTokens = allMessagesTokens;
	} else if (newestWindow) {
		if (newestWindow.tokens > messageBudget) {
			throw new ContextBudgetError(availableInputTokens, requiredTokens + requiredStateTokens + newestWindow.tokens);
		}

		for (let index = windows.length - 1; index >= 0; index--) {
			const window = windows[index]!;
			if (!window.valid || selectedEventTokens + window.tokens > messageBudget) break;
			for (const event of window.events) selectedIds.add(event.event.id);
			selectedEventTokens += window.tokens;
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
	const transformedMessages = input.transformMessages
		? await input.transformMessages(selectedMessages, input.signal)
		: selectedMessages;
	// Epistemic state is compiler-owned, so transcript transforms cannot omit or rewrite it.
	const messages = [...retainedMessages, ...transformedMessages, ...requestInstructionMessages];
	const outputMessageTokens = estimateMessagesTokens(messages);
	if (requiredTokens + outputMessageTokens > availableInputTokens) {
		throw new ContextBudgetError(availableInputTokens, requiredTokens + outputMessageTokens);
	}

	return {
		messages,
		manifest: {
			compilerVersion,
			inputEventIds: input.rawEvents.map((event) => event.id),
			selectedEventIds: selectedEvents.map((event) => event.event.id),
			omissions: input.rawEvents.flatMap((event) => {
				const omission = omissionsById.get(event.id);
				return omission ? [omission] : [];
			}),
			epistemicState: {
				anchor: anchor
					? {
							id: anchor.id,
							revision: anchor.revision,
							revisionEntryId: anchor.revisionEntryId,
							sourceEventId: anchor.sourceEventId,
							tokens: anchorTokens,
						}
					: undefined,
				frame: frame
					? {
							id: frame.id,
							version: frame.version,
							revisionEntryId: frame.revisionEntryId,
							sourceEventId: frame.sourceEventId,
							horizon: frame.horizon,
							completedModelResponses: frame.completedModelResponses,
							remainingModelResponses: Math.max(0, frame.horizon - frame.completedModelResponses),
							tokens: frameTokens,
						}
					: undefined,
				action: action
					? {
							id: action.id,
							startEntryId: action.startEntryId,
							frameRevisionEntryId: action.frameRevisionEntryId,
							sourceEventId: action.sourceEventId,
							completedModelResponses: action.completedModelResponses,
							tokens: actionTokens,
						}
					: undefined,
				observations:
					observations.length > 0
						? {
								selected: selectedObservations.map((candidate) => ({
									id: candidate.observation.id,
									entryId: candidate.observation.entryId,
									sourceEventIds: candidate.observation.sourceEventIds,
									anchorRelevant: candidate.anchorRelevant,
									frameRelevant: candidate.frameRelevant,
									tokens: candidate.tokens,
								})),
								omitted: projectedObservations
									.filter((candidate) => !selectedObservationIds.has(candidate.observation.id))
									.map((candidate) => ({
										id: candidate.observation.id,
										entryId: candidate.observation.entryId,
										reason:
											candidate.frameRelevant || candidate.anchorRelevant
												? ("budget" as const)
												: ("not_relevant" as const),
									})),
							}
						: undefined,
			},
			budget: {
				contextWindow,
				reservedOutputTokens,
				availableInputTokens,
				requiredTokens,
				selectedMessageTokens: retainedStateTokens + selectedEventTokens,
				outputMessageTokens,
			},
		},
	};
}

/** Deterministic structural projection with empty epistemic state. */
export class PhaseZeroContextCompiler implements ContextCompiler {
	async compile(input: ContextCompilerInput): Promise<ContextCompilation> {
		return compileProjection(input, PHASE_ZERO_CONTEXT_COMPILER_VERSION, undefined, undefined, undefined, []);
	}
}

/** Phase 1 projection: Phase 0 selection plus an always-retained durable Anchor. */
export class PhaseOneContextCompiler implements ContextCompiler {
	async compile(input: ContextCompilerInput): Promise<ContextCompilation> {
		return compileProjection(
			input,
			PHASE_ONE_CONTEXT_COMPILER_VERSION,
			input.epistemicState.anchor,
			undefined,
			undefined,
			[],
		);
	}
}

/** Phase 2 projection: Phase 1 selection plus the current admissible finite-lived Frame. */
export class PhaseTwoContextCompiler implements ContextCompiler {
	async compile(input: ContextCompilerInput): Promise<ContextCompilation> {
		return compileProjection(
			input,
			PHASE_TWO_CONTEXT_COMPILER_VERSION,
			input.epistemicState.anchor,
			input.epistemicState.frame,
			undefined,
			[],
		);
	}
}

/** Phase 3 projection: Phase 2 state plus a frozen Action and its episode-local execution window. */
export class PhaseThreeContextCompiler implements ContextCompiler {
	async compile(input: ContextCompilerInput): Promise<ContextCompilation> {
		return compileProjection(
			input,
			PHASE_THREE_CONTEXT_COMPILER_VERSION,
			input.epistemicState.anchor,
			input.epistemicState.frame,
			input.epistemicState.action,
			[],
		);
	}
}

/** Phase 4 projection: relevant durable Observations precede the current Action within a bounded budget. */
export class PhaseFourContextCompiler implements ContextCompiler {
	async compile(input: ContextCompilerInput): Promise<ContextCompilation> {
		return compileProjection(
			input,
			PHASE_FOUR_CONTEXT_COMPILER_VERSION,
			input.epistemicState.anchor,
			input.epistemicState.frame,
			input.epistemicState.action,
			input.epistemicState.observations ?? [],
		);
	}
}
