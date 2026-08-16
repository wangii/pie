import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, contentText, type Model } from "@earendil-works/pi-ai";
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
export const GROUNDING_CONTEXT_MESSAGE_TYPE = "pie.grounding";
export const FRAME_CONTEXT_MESSAGE_TYPE = "pie.frame";
export const ACTION_CONTEXT_MESSAGE_TYPE = "pie.action";
export const OBSERVATION_CONTEXT_MESSAGE_TYPE = "pie.observation";
export const ACTION_OUTCOME_CONTEXT_MESSAGE_TYPE = "pie.action-outcome";
export const FRAME_OUTCOME_CONTEXT_MESSAGE_TYPE = "pie.frame-outcome";
export const EXECUTION_EVIDENCE_CONTEXT_MESSAGE_TYPE = "pie.execution-evidence";

export type ContextProjectionRole = "default" | "execution" | "epistemic" | "finalAnswer";

export type EmptyEpistemicState = Record<never, never>;

export type ContextOmissionReason =
	| "budget"
	| "historical_summary"
	| "not_model_facing"
	| "runtime_excluded"
	| "invalid_tool_sequence"
	| "outside_action_episode"
	| "role_projection";

export interface ContextOmission {
	eventId: string;
	eventType: SessionEntry["type"];
	reason: ContextOmissionReason;
}

export interface ContextSelectionManifest {
	compilerVersion: string;
	projection: {
		role: ContextProjectionRole;
		policy: "transcript/v1" | "commitment-depth/v1" | "epistemic-breadth/v1";
		actionOutcomes?: {
			selected: Array<{
				actionId: string;
				startEntryId: string;
				transitionEntryId: string;
				frameRevisionEntryId: string | undefined;
				transition: "completed" | "unresolvable" | "escalated";
				tokens: number;
			}>;
			omitted: Array<{ actionId: string; startEntryId: string; reason: "budget" }>;
		};
		frameOutcomes?: {
			selected: Array<{
				frameId: string;
				version: number;
				revisionEntryId: string;
				transitionEntryId: string;
				transition: "replaced" | "died" | "falsified" | "expired";
				tokens: number;
			}>;
			omitted: Array<{ frameId: string; revisionEntryId: string; reason: "budget" }>;
		};
	};
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
			frameRevisionEntryId: string | undefined;
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

export interface ContextSelectionCounts {
	inputEventCount: number;
	selectedEventCount: number;
	excludedEventCount: number;
	omissionsByReason: Partial<Record<ContextOmissionReason, number>>;
}

export function summarizeContextSelection(
	manifest: Pick<ContextSelectionManifest, "inputEventIds" | "selectedEventIds" | "omissions">,
): ContextSelectionCounts {
	const omissionsByReason: Partial<Record<ContextOmissionReason, number>> = {};
	for (const omission of manifest.omissions) {
		omissionsByReason[omission.reason] = (omissionsByReason[omission.reason] ?? 0) + 1;
	}
	return {
		inputEventCount: manifest.inputEventIds.length,
		selectedEventCount: manifest.selectedEventIds.length,
		excludedEventCount: manifest.omissions.length,
		omissionsByReason,
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
	/** Transient codebase grounding, injected only while the initial Frame is being formed. */
	grounding?: AgentMessage;
	/** Role-specific projection. Omitted for the transcript-compatible baseline. */
	projectionRole?: ContextProjectionRole;
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

type ProjectedActionOutcome = {
	actionId: string;
	startEntryId: string;
	transitionEntryId: string;
	frameRevisionEntryId: string | undefined;
	transition: "completed" | "unresolvable" | "escalated";
	message: AgentMessage;
	tokens: number;
	currentFrame: boolean;
	order: number;
};

type ProjectedFrameOutcome = {
	frameId: string;
	version: number;
	revisionEntryId: string;
	transitionEntryId: string;
	transition: "replaced" | "died" | "falsified" | "expired";
	message: AgentMessage;
	tokens: number;
	order: number;
};

const CONTROL_DECISION_KINDS = new Set([
	"create_frame",
	"revise_frame",
	"replace_frame",
	"advance_frame",
	"explore",
	"ask",
	"decompose",
	"falsify_frame",
	"kill_frame",
	"revise_anchor",
	"authorize_action",
	"continue_action",
	"complete_action",
	"unresolvable_action",
	"escalate_action",
	"authorize_final",
	"report_inability",
]);

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

function isControlDecisionMessage(event: SessionEntry): boolean {
	if (event.type !== "message" || event.message.role !== "assistant") return false;
	if (event.message.content.some((part) => part.type === "toolCall")) return false;
	const raw = contentText(event.message.content, "").trim();
	const isDecision = (value: unknown): boolean => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		const kind = typeof record.kind === "string" ? record.kind : record.operation;
		return typeof kind === "string" && CONTROL_DECISION_KINDS.has(kind);
	};
	try {
		return isDecision(JSON.parse(raw));
	} catch {
		const starts = [...raw.matchAll(/\{/g)].map((match) => match.index).reverse();
		const ends = [...raw.matchAll(/\}/g)].map((match) => match.index + 1).reverse();
		for (const start of starts) {
			for (const end of ends) {
				if (end <= start) continue;
				try {
					if (isDecision(JSON.parse(raw.slice(start, end)))) return true;
				} catch {
					// Continue scanning for a bounded controller object in incidental prose.
				}
			}
		}
		return false;
	}
}

/**
 * The broad (epistemic) projection lets the controller adjudicate the active or
 * last-terminal Action. Projecting the execution role's raw tool-call/tool-result
 * traffic as structured messages shows the controller a "doer" transcript it then
 * imitates — emitting <invoke> text instead of a JSON decision — because the
 * concrete call/result pattern outweighs any "you have no tools" instruction.
 * Replace that transcript with one compact, derived evidence message: the probes
 * the execution role issued and what each observed, as plain text.
 */
const BROAD_EVIDENCE_MAX_RESULT_CHARS = 400;
const BROAD_EVIDENCE_MAX_ENTRIES = 24;

function summarizeToolArguments(arguments_: Record<string, unknown>): string {
	const json = JSON.stringify(arguments_);
	return json.length > 140 ? `${json.slice(0, 140)}…` : json;
}

function buildExecutionEvidenceMessage(
	events: readonly SessionEntry[],
	action: Action | undefined,
): AgentMessage | undefined {
	const startEntryId = episodeBoundary(events, action);
	if (!startEntryId) return undefined;
	const actionStartIndex = events.findIndex((event) => event.id === startEntryId);
	if (actionStartIndex < 0) return undefined;

	const lines: string[] = [];
	let entries = 0;
	for (let index = actionStartIndex + 1; index < events.length && entries < BROAD_EVIDENCE_MAX_ENTRIES; index++) {
		const event = events[index]!;
		if (event.type !== "message") continue;
		const message = event.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (entries >= BROAD_EVIDENCE_MAX_ENTRIES) break;
				lines.push(`- ${part.name} ${summarizeToolArguments(part.arguments)}`);
				entries++;
			}
		} else if (message.role === "toolResult") {
			const observed = contentText(message.content, "\n").trim();
			const bounded =
				observed.length > BROAD_EVIDENCE_MAX_RESULT_CHARS
					? `${observed.slice(0, BROAD_EVIDENCE_MAX_RESULT_CHARS)}…[excerpted; the tool returned ${observed.length} characters]`
					: observed;
			lines.push(bounded ? `  → ${bounded}` : "  → (no text result)");
			entries++;
		}
	}
	if (lines.length === 0) return undefined;
	const omitted = entries >= BROAD_EVIDENCE_MAX_ENTRIES ? "\n…[additional execution probes omitted]" : "";
	return {
		role: "custom",
		customType: EXECUTION_EVIDENCE_CONTEXT_MESSAGE_TYPE,
		content: `[EXECUTION EVIDENCE]\nWhat the execution role probed and observed in the current Action (long results are excerpted here, not truncated by the tool):\n${lines.join("\n")}${omitted}`,
		display: false,
		details: { actionId: action?.id, startEntryId },
		timestamp: Date.now(),
	};
}

/**
 * The execution role is scoped to its current Action and its context projection
 * drops every event before the Action's start entry (`outside_action_episode`), so
 * a fresh Action begins with no memory of the files earlier Actions already located.
 * Summarize those prior probes — tool calls plus bounded results — so the execution
 * role reads the already-named paths directly instead of re-running `find`/`ls`/`wc`
 * discovery and exhausting its evidence budget on reconnaissance.
 */
function buildPriorExecutionEvidenceMessage(
	events: readonly SessionEntry[],
	action: Action | undefined,
): AgentMessage | undefined {
	if (!action) return undefined;
	const currentStartIndex = events.findIndex((event) => event.id === action.startEntryId);
	if (currentStartIndex <= 0) return undefined;

	const lines: string[] = [];
	for (let index = 0; index < currentStartIndex; index++) {
		const event = events[index]!;
		if (event.type !== "message") continue;
		const message = event.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				lines.push(`- ${part.name} ${summarizeToolArguments(part.arguments)}`);
			}
		} else if (message.role === "toolResult") {
			const observed = contentText(message.content, "\n").trim();
			const bounded =
				observed.length > BROAD_EVIDENCE_MAX_RESULT_CHARS
					? `${observed.slice(0, BROAD_EVIDENCE_MAX_RESULT_CHARS)}…[excerpted; the tool returned ${observed.length} characters]`
					: observed;
			lines.push(bounded ? `  → ${bounded}` : "  → (no text result)");
		}
	}
	if (lines.length === 0) return undefined;
	const retained = lines.slice(-BROAD_EVIDENCE_MAX_ENTRIES);
	const omitted = lines.length > retained.length ? "\n…[earlier execution probes omitted]" : "";
	return {
		role: "custom",
		customType: EXECUTION_EVIDENCE_CONTEXT_MESSAGE_TYPE,
		content: `[PRIOR EXECUTION EVIDENCE]\nWhat earlier Actions already probed and located; read the named paths directly and do not re-run find/ls/wc discovery:\n${retained.join("\n")}${omitted}`,
		display: false,
		details: { actionId: action?.id, priorToEntryId: action?.startEntryId },
		timestamp: Date.now(),
	};
}

function controlSourceEventIds(events: readonly SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const event of events) {
		if (
			event.type === "anchor_revision" ||
			event.type === "frame_revision" ||
			event.type === "frame_transition" ||
			event.type === "action_start" ||
			event.type === "action_transition"
		) {
			ids.add(event.sourceEventId);
		}
	}
	return ids;
}

/**
 * The episode whose world evidence a broad projection should retain. When an
 * Action is active its start entry is the boundary; otherwise the most recent
 * terminal failure transition (`unresolvable` or `escalated`) marks the
 * episode the next epistemic decision must be able to inspect.
 */
function episodeBoundary(events: readonly SessionEntry[], action: Action | undefined): string | undefined {
	if (action) return action.startEntryId;
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (
			event.type === "action_transition" &&
			(event.transition === "unresolvable" || event.transition === "escalated")
		) {
			return event.startEntryId;
		}
	}
	return undefined;
}

/** Tool-call/shell syntax emitted as literal text; mirrors the control-loop detector. */
const TOOL_CALL_SYNTAX_PATTERN = /<\s*(?:antml:)?(?:invoke|tool_call|tool_use|function_call|bash_command|bash)\b/iu;

function selectBroadRawEventIds(
	events: readonly SessionEntry[],
	action: Action | undefined,
	role: ContextProjectionRole,
): Set<string> {
	const selected = new Set<string>();
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (event.type === "message" && event.message.role === "user") {
			selected.add(event.id);
			break;
		}
	}
	if (role === "finalAnswer") return selected;

	// The episode's tool traffic is represented by a derived execution-evidence
	// message (buildExecutionEvidenceMessage), so raw tool-call/tool-result traffic
	// is never projected to the controller. Retain only the execution role's latest
	// prose narration — the "established result" the controller judges against —
	// excluding any message that carries structured tool calls or tool-call syntax.
	const startEntryId = episodeBoundary(events, action);
	if (!startEntryId) return selected;
	const actionStartIndex = events.findIndex((event) => event.id === startEntryId);
	if (actionStartIndex < 0) return selected;

	const controlSources = controlSourceEventIds(events);
	for (let index = events.length - 1; index > actionStartIndex; index--) {
		const event = events[index]!;
		if (event.type !== "message" || event.message.role !== "assistant") continue;
		if (controlSources.has(event.id) || isControlDecisionMessage(event)) continue;
		if (event.message.content.some((part) => part.type === "toolCall")) continue;
		if (TOOL_CALL_SYNTAX_PATTERN.test(contentText(event.message.content, "\n"))) continue;
		selected.add(event.id);
		break;
	}
	return selected;
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
			`[CURRENT FRAME]\nCommitment: ${frame.statement}\nExpectation: ${frame.expectation}\n` +
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

function actionOutcomeMessage(
	start: Extract<SessionEntry, { type: "action_start" }>,
	transition: Extract<SessionEntry, { type: "action_transition" }>,
	frame: Extract<SessionEntry, { type: "frame_revision" }> | undefined,
): AgentMessage {
	const challenge = transition.challenge ? `\nChallenge: ${transition.challenge}` : "";
	const frameRelation = frame
		? `\nFrame: ${frame.frameId} v${frame.version} — ${frame.statement}`
		: `\nFrame revision: ${start.frameRevisionEntryId}`;
	return {
		role: "custom",
		customType: ACTION_OUTCOME_CONTEXT_MESSAGE_TYPE,
		content:
			`[ACTION OUTCOME ${start.actionId}]${frameRelation}\nIntent: ${start.intent}\n` +
			`Completion condition: ${start.completionCondition}\nOutcome: ${transition.transition}${challenge}\n` +
			`Prediction error: ${transition.reason}`,
		display: false,
		details: {
			actionId: start.actionId,
			startEntryId: start.id,
			transitionEntryId: transition.id,
			frameRevisionEntryId: start.frameRevisionEntryId,
			sourceEventId: transition.sourceEventId,
		},
		timestamp: new Date(transition.timestamp).getTime(),
	};
}

function projectActionOutcomes(
	events: readonly SessionEntry[],
	currentFrame: Frame | undefined,
): ProjectedActionOutcome[] {
	const starts = new Map<string, Extract<SessionEntry, { type: "action_start" }>>();
	const frames = new Map<string, Extract<SessionEntry, { type: "frame_revision" }>>();
	const outcomes: ProjectedActionOutcome[] = [];
	for (const [order, event] of events.entries()) {
		if (event.type === "frame_revision") {
			frames.set(event.id, event);
		} else if (event.type === "action_start") {
			starts.set(event.id, event);
		} else if (event.type === "action_transition") {
			const start = starts.get(event.startEntryId);
			if (!start) continue;
			const message = actionOutcomeMessage(start, event, frames.get(start.frameRevisionEntryId ?? ""));
			outcomes.push({
				actionId: start.actionId,
				startEntryId: start.id,
				transitionEntryId: event.id,
				frameRevisionEntryId: start.frameRevisionEntryId,
				transition: event.transition,
				message,
				tokens: estimateMessagesTokens([message]),
				currentFrame: start.frameRevisionEntryId === currentFrame?.revisionEntryId,
				order,
			});
		}
	}
	return outcomes;
}

function frameOutcomeMessage(
	revision: Extract<SessionEntry, { type: "frame_revision" }>,
	transition: Extract<SessionEntry, { type: "frame_transition" }>,
): AgentMessage {
	const replacement = transition.replacementFrameId ? `\nReplacement: ${transition.replacementFrameId}` : "";
	return {
		role: "custom",
		customType: FRAME_OUTCOME_CONTEXT_MESSAGE_TYPE,
		content:
			`[FRAME OUTCOME ${transition.frameId}]\nCommitment: ${revision.statement}\n` +
			`Expectation: ${revision.expectation}\nOutcome: ${transition.transition}${replacement}\n` +
			`Terminal reason: ${transition.reason}`,
		display: false,
		details: {
			frameId: transition.frameId,
			version: transition.version,
			revisionEntryId: transition.revisionEntryId,
			transitionEntryId: transition.id,
			sourceEventId: transition.sourceEventId,
		},
		timestamp: new Date(transition.timestamp).getTime(),
	};
}

function projectFrameOutcomes(events: readonly SessionEntry[]): ProjectedFrameOutcome[] {
	const revisions = new Map<string, Extract<SessionEntry, { type: "frame_revision" }>>();
	const outcomes: ProjectedFrameOutcome[] = [];
	for (const [order, event] of events.entries()) {
		if (event.type === "frame_revision") {
			revisions.set(event.id, event);
		} else if (event.type === "frame_transition") {
			const revision = revisions.get(event.revisionEntryId);
			if (!revision) continue;
			const message = frameOutcomeMessage(revision, event);
			outcomes.push({
				frameId: event.frameId,
				version: event.version,
				revisionEntryId: event.revisionEntryId,
				transitionEntryId: event.id,
				transition: event.transition,
				message,
				tokens: estimateMessagesTokens([message]),
				order,
			});
		}
	}
	return outcomes;
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
	const projectionRole = input.projectionRole ?? "default";
	const broadProjection = projectionRole === "epistemic" || projectionRole === "finalAnswer";
	const broadRawEventIds = broadProjection
		? selectBroadRawEventIds(input.rawEvents, action, projectionRole)
		: undefined;
	const controllerSources = projectionRole === "default" ? new Set<string>() : controlSourceEventIds(input.rawEvents);

	const actionBoundaryId = projectionRole === "execution" ? action?.startEntryId : action?.sourceEventId;
	const actionBoundaryIndex = actionBoundaryId
		? input.rawEvents.findIndex((event) => event.id === actionBoundaryId)
		: -1;
	if (action && actionBoundaryIndex < 0) {
		throw new Error(`Action ${action.id} boundary event ${actionBoundaryId} is absent from compiler input.`);
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
		const rawMessages = sessionEntryToContextMessages(event).filter(
			(message) => message.role !== "bashExecution" || !message.excludeFromContext,
		);
		const messages = rawMessages;
		if (
			projectionRole !== "default" &&
			event.type === "message" &&
			event.message.role === "assistant" &&
			(controllerSources.has(event.id) || isControlDecisionMessage(event))
		) {
			omissionsById.set(event.id, { eventId: event.id, eventType: event.type, reason: "role_projection" });
			continue;
		}
		if (projectionRole === "execution" && action && eventIndex <= actionBoundaryIndex && messages.length > 0) {
			omissionsById.set(event.id, {
				eventId: event.id,
				eventType: event.type,
				reason: "outside_action_episode",
			});
			continue;
		}
		if (projectionRole === "default" && action && eventIndex < actionBoundaryIndex && messages.length > 0) {
			omissionsById.set(event.id, {
				eventId: event.id,
				eventType: event.type,
				reason: "outside_action_episode",
			});
			continue;
		}
		if (broadRawEventIds && messages.length > 0 && !broadRawEventIds.has(event.id)) {
			omissionsById.set(event.id, { eventId: event.id, eventType: event.type, reason: "role_projection" });
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
	const groundingMessages =
		input.grounding && projectionRole === "epistemic" && anchor && !frame ? [input.grounding] : [];
	const frameMessages = frame ? [frameMessage(frame)] : [];
	const actionMessages = action ? [actionMessage(action)] : [];
	const executionEvidence =
		projectionRole === "epistemic"
			? buildExecutionEvidenceMessage(input.rawEvents, action)
			: projectionRole === "execution"
				? buildPriorExecutionEvidenceMessage(input.rawEvents, action)
				: undefined;
	const executionEvidenceMessages = executionEvidence ? [executionEvidence] : [];
	const requestInstructionMessages = input.requestInstruction ? [input.requestInstruction] : [];
	const anchorTokens = estimateMessagesTokens(anchorMessages);
	const groundingTokens = estimateMessagesTokens(groundingMessages);
	const frameTokens = estimateMessagesTokens(frameMessages);
	const actionTokens = estimateMessagesTokens(actionMessages);
	const executionEvidenceTokens = estimateMessagesTokens(executionEvidenceMessages);
	const requestInstructionTokens = estimateMessagesTokens(requestInstructionMessages);
	const requiredStateTokens =
		anchorTokens + groundingTokens + frameTokens + actionTokens + executionEvidenceTokens + requestInstructionTokens;
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

	const projectedActionOutcomes = broadProjection ? projectActionOutcomes(input.rawEvents, frame) : [];
	const projectedFrameOutcomes = broadProjection ? projectFrameOutcomes(input.rawEvents) : [];
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
	const selectedFrameOutcomeIds = new Set<string>();
	let selectedFrameOutcomeTokens = 0;
	const frameOutcomeBudget = Math.max(0, observationBudget - selectedObservationTokens);
	const prioritizedFrameOutcomes = [...projectedFrameOutcomes].sort((left, right) => right.order - left.order);
	for (const candidate of prioritizedFrameOutcomes) {
		if (selectedFrameOutcomeTokens + candidate.tokens <= frameOutcomeBudget) {
			selectedFrameOutcomeIds.add(candidate.transitionEntryId);
			selectedFrameOutcomeTokens += candidate.tokens;
		}
	}
	const selectedFrameOutcomes = projectedFrameOutcomes.filter((candidate) =>
		selectedFrameOutcomeIds.has(candidate.transitionEntryId),
	);
	const frameOutcomeMessages = selectedFrameOutcomes.map((candidate) => candidate.message);
	const selectedActionOutcomeIds = new Set<string>();
	let selectedActionOutcomeTokens = 0;
	const actionOutcomeBudget = Math.max(0, frameOutcomeBudget - selectedFrameOutcomeTokens);
	const prioritizedActionOutcomes = [...projectedActionOutcomes].sort((left, right) => {
		if (left.currentFrame !== right.currentFrame) return left.currentFrame ? -1 : 1;
		return right.order - left.order;
	});
	for (const candidate of prioritizedActionOutcomes) {
		if (selectedActionOutcomeTokens + candidate.tokens <= actionOutcomeBudget) {
			selectedActionOutcomeIds.add(candidate.startEntryId);
			selectedActionOutcomeTokens += candidate.tokens;
		}
	}
	const selectedActionOutcomes = projectedActionOutcomes.filter((candidate) =>
		selectedActionOutcomeIds.has(candidate.startEntryId),
	);
	const actionOutcomeMessages = selectedActionOutcomes.map((candidate) => candidate.message);
	const retainedMessages = [
		...anchorMessages,
		...groundingMessages,
		...frameMessages,
		...frameOutcomeMessages,
		...observationMessages,
		...actionOutcomeMessages,
		...actionMessages,
		...executionEvidenceMessages,
	];
	const retainedStateTokens =
		requiredStateTokens + selectedObservationTokens + selectedFrameOutcomeTokens + selectedActionOutcomeTokens;
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
			projection: {
				role: projectionRole,
				policy:
					projectionRole === "execution"
						? "commitment-depth/v1"
						: broadProjection
							? "epistemic-breadth/v1"
							: "transcript/v1",
				actionOutcomes:
					projectedActionOutcomes.length > 0
						? {
								selected: selectedActionOutcomes.map((candidate) => ({
									actionId: candidate.actionId,
									startEntryId: candidate.startEntryId,
									transitionEntryId: candidate.transitionEntryId,
									frameRevisionEntryId: candidate.frameRevisionEntryId,
									transition: candidate.transition,
									tokens: candidate.tokens,
								})),
								omitted: projectedActionOutcomes
									.filter((candidate) => !selectedActionOutcomeIds.has(candidate.startEntryId))
									.map((candidate) => ({
										actionId: candidate.actionId,
										startEntryId: candidate.startEntryId,
										reason: "budget" as const,
									})),
							}
						: undefined,
				frameOutcomes:
					projectedFrameOutcomes.length > 0
						? {
								selected: selectedFrameOutcomes.map((candidate) => ({
									frameId: candidate.frameId,
									version: candidate.version,
									revisionEntryId: candidate.revisionEntryId,
									transitionEntryId: candidate.transitionEntryId,
									transition: candidate.transition,
									tokens: candidate.tokens,
								})),
								omitted: projectedFrameOutcomes
									.filter((candidate) => !selectedFrameOutcomeIds.has(candidate.transitionEntryId))
									.map((candidate) => ({
										frameId: candidate.frameId,
										revisionEntryId: candidate.revisionEntryId,
										reason: "budget" as const,
									})),
							}
						: undefined,
			},
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
