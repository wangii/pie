/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import {
	type ContextCompiler,
	type ContextOmissionReason,
	type ContextSelectionManifest,
	PhaseFourContextCompiler,
	PhaseOneContextCompiler,
	PhaseThreeContextCompiler,
	PhaseTwoContextCompiler,
	PhaseZeroContextCompiler,
	summarizeContextSelection,
} from "./context-compiler.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import {
	type Action,
	type ActionTerminalTransition,
	type Anchor,
	type Frame,
	type FrameTerminalTransition,
	type Observation,
	restoreEpistemicState,
} from "./epistemic-state.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import {
	DEFAULT_FRAME_LEASE_POLICY,
	deriveFrameLease,
	type FrameLeaseCalculation,
	type ProvisionalActionContract,
} from "./frame-lease-budget.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import {
	type PieControlDecision,
	PieProductionLoop,
	type PieProductionLoopState,
	type PieProductionRequestRole,
} from "./pie-agent-loop.ts";
import type { PieModelRole, PieModelRoutes } from "./pie-models.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createFrameActionGraphToolDefinition } from "./tools/frame-action-graph.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

export type OperationalErrorClass =
	| "pre_execution_rejection"
	| "invocation_failure"
	| "completed_negative_result"
	| "interrupted_execution"
	| "ambiguous_mutation";

export interface OperationalErrorStatus {
	classification: OperationalErrorClass;
	toolCallId: string;
	toolName: string;
	attempt: number;
	maxAttempts: number;
	actionId?: string;
	message: string;
	frozenContract: boolean;
	requiresInspection: boolean;
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "context_compiled"; manifest: ContextSelectionManifest }
	| ({ type: "operational_error" } & OperationalErrorStatus)
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Context projection policy. Defaults to Pie's deterministic Phase 4 Observation compiler. */
	contextCompiler?: ContextCompiler;
	/** Enable Anchor creation and projection. Set false for the Phase 0 baseline. Default: true. */
	anchorEnabled?: boolean;
	/** Enable Frame state and projection. Set false for Phase 2 ablation. Defaults to anchorEnabled. */
	frameEnabled?: boolean;
	/** Enable Action episodes and episode-local projection. Set false for Phase 3 ablation. Defaults to frameEnabled. */
	actionEnabled?: boolean;
	/** Enable durable selective Observations. Set false for Phase 4 ablation. Defaults to actionEnabled. */
	observationEnabled?: boolean;
	/** Initial compiler input budget override for controlled evaluations. */
	contextInputTokenLimit?: number;
	/** Resolved production-loop model routes. Undefined routes follow the session model. */
	pieModelRoutes?: PieModelRoutes;
	/** Inclusive bounds for the deterministically derived production Frame lease. */
	frameHorizonRange?: { min: number; max: number };
	/** Legacy fallback when a restored Frame has no transient lease derivation. */
	actionResponseLimit?: number;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface FrameDefinition {
	statement: string;
	falsifier: string;
	/** Positive number of completed model responses before mandatory reconsideration. */
	horizon: number;
}

export type FrameDirective =
	| ({ type: "create" } & FrameDefinition)
	| ({ type: "revise"; revisionReason?: string } & FrameDefinition)
	| ({ type: "replace"; reason: string } & FrameDefinition)
	| { type: "falsify" | "die"; reason: string };

export interface ActionDefinition {
	intent: string;
	completionCondition: string;
}

export type ActionDirective =
	| ({ type: "start" } & ActionDefinition)
	| { type: "complete" | "unresolvable"; reason: string }
	| { type: "escalate"; challenge: "anchor" | "frame"; reason: string };

export interface ObservationDefinition {
	statement: string;
	affects: "anchor" | "frame" | "anchor_and_frame";
	/** Exact toolResult or bashExecution event identities from the current Action episode. */
	sourceEventIds: readonly string[];
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Explicit task-success semantics to create or revise before this model turn. */
	anchor?: { statement: string; revisionReason?: string };
	/** Explicit Frame state operation to apply before this model turn. */
	frame?: FrameDirective;
	/** Explicit Action episode operation to apply before this model turn. */
	action?: ActionDirective;
	/** Explicitly materialize epistemically relevant execution evidence before this model turn. */
	observation?: ObservationDefinition;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

/** Concise, derived diagnostics for Pie's active state and most recent context projection. */
export interface ObservationProvenanceDiagnostic {
	rawEventId: string;
	toolCallId?: string;
	toolName: string;
	arguments?: unknown;
	command?: string;
	isError?: boolean;
	exitCode?: number;
	cancelled?: boolean;
	output: string;
}

export interface EpistemicDiagnostics {
	enabled: {
		anchor: boolean;
		frame: boolean;
		action: boolean;
		observation: boolean;
	};
	state: {
		anchor?: Pick<Anchor, "id" | "revision" | "statement" | "revisionEntryId">;
		frame?: Pick<
			Frame,
			"id" | "version" | "statement" | "falsifier" | "revisionEntryId" | "horizon" | "completedModelResponses"
		>;
		action?: Pick<Action, "id" | "intent" | "completionCondition" | "startEntryId" | "completedModelResponses">;
		lastAction?: {
			id: string;
			startEntryId: string;
			transition?: ActionTerminalTransition;
			transitionEntryId?: string;
			reason?: string;
		};
		observations: Array<
			Pick<Observation, "id" | "statement" | "entryId" | "sourceEventIds"> & {
				provenance: ObservationProvenanceDiagnostic[];
			}
		>;
	};
	provenance: {
		rawEventCount: number;
		activeBranchEventCount: number;
		legacySummaryCount: number;
	};
	runtime?: {
		loopState: PieProductionLoopState;
		inputReady: boolean;
		recovery?: OperationalErrorStatus;
	};
	context?: {
		compilerVersion: string;
		inputEventCount: number;
		selectedEventCount: number;
		excludedEventCount: number;
		omissionsByReason: Partial<Record<ContextOmissionReason, number>>;
		availableInputTokens: number;
		outputMessageTokens: number;
	};
	leaseBudget?: {
		derivation: "available" | "unavailable";
		frameRevisionEntryId: string;
		provisionalActionCount?: number;
		expectedEvidenceRounds?: number[];
		consumedEvidenceRounds?: number;
		activeExpectedEvidenceRounds?: number;
		activeBudgetReason?: string;
		unusedEvidenceRounds?: number;
		costs?: FrameLeaseCalculation["costs"];
	};
}

interface ActiveFrameLeaseBudget {
	frameRevisionEntryId: string;
	calculation: FrameLeaseCalculation;
	actions: Array<ProvisionalActionContract & { contractId: string; actionStartEntryId?: string }>;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const DEFAULT_ACTION_RESPONSE_LIMIT = 6;
const DEFAULT_MAX_FRAME_HORIZON = 32;

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private readonly _maxOperationalRepairAttempts = 3;
	private _operationalRepairAttempts = 0;
	private _operationalActionId: string | undefined;
	private _latestOperationalError: OperationalErrorStatus | undefined;
	private _pendingRepairExhaustion:
		| { actionId: string; toolCallId: string; classification: OperationalErrorClass }
		| undefined;
	private _toolInvocationArgs = new Map<string, unknown>();
	private _ambiguousMutation: { actionId: string; signature: string } | undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private readonly _contextCompiler: ContextCompiler;
	private readonly _anchorEnabled: boolean;
	private readonly _frameEnabled: boolean;
	private readonly _actionEnabled: boolean;
	private readonly _observationEnabled: boolean;
	private readonly _pieModelRoutes: PieModelRoutes;
	private _activeRequestModel: Model<any> | undefined;
	private _activeProductionRequestRole: PieProductionRequestRole | undefined;
	private readonly _frameHorizonRange: { min: number; max: number };
	private readonly _actionResponseLimit: number;
	private _frameLeaseBudget: ActiveFrameLeaseBudget | undefined;
	private _controlRepairAttempts = 0;
	private readonly _maxControlRepairAttempts = 3;
	private _lastControlError: string | undefined;
	private _pendingFinalAuthorization: { kind: "satisfied" | "inability"; reason: string } | undefined;
	private _productionControlEnabled = false;
	private _pendingAnchorRevision: { statement: string; revisionReason?: string } | undefined;
	private _pendingFrameDirective: FrameDirective | undefined;
	private _pendingActionDirective: ActionDirective | undefined;
	private _pendingObservation: ObservationDefinition | undefined;
	private _automaticActionRequest = false;
	private _latestContextManifest: ContextSelectionManifest | undefined;
	private readonly _configuredContextInputTokenLimit: number | undefined;
	private _contextInputTokenLimit: number | undefined;
	private _contextBudgetModelKey: string | undefined;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._anchorEnabled = config.anchorEnabled ?? true;
		this._frameEnabled = config.frameEnabled ?? this._anchorEnabled;
		this._actionEnabled = config.actionEnabled ?? this._frameEnabled;
		this._observationEnabled = config.observationEnabled ?? this._actionEnabled;
		this._pieModelRoutes =
			config.pieModelRoutes ??
			({
				epistemic: undefined,
				execution: undefined,
				observation: undefined,
				verification: undefined,
				finalAnswer: undefined,
			} satisfies PieModelRoutes);
		if (this._frameEnabled && !this._anchorEnabled) {
			throw new Error("Frame requires Anchor to be enabled.");
		}
		if (this._actionEnabled && !this._frameEnabled) {
			throw new Error("Action episodes require Frame to be enabled.");
		}
		if (this._observationEnabled && !this._actionEnabled) {
			throw new Error("Observations require Action episodes to be enabled.");
		}
		this._contextCompiler =
			config.contextCompiler ??
			(this._observationEnabled
				? new PhaseFourContextCompiler()
				: this._actionEnabled
					? new PhaseThreeContextCompiler()
					: this._frameEnabled
						? new PhaseTwoContextCompiler()
						: this._anchorEnabled
							? new PhaseOneContextCompiler()
							: new PhaseZeroContextCompiler());
		this._configuredContextInputTokenLimit = config.contextInputTokenLimit;
		this._contextInputTokenLimit = config.contextInputTokenLimit;
		const actionResponseLimit = config.actionResponseLimit ?? DEFAULT_ACTION_RESPONSE_LIMIT;
		if (!Number.isSafeInteger(actionResponseLimit) || actionResponseLimit < 2) {
			throw new Error("Action response limit must be an integer of at least 2 so control transfer remains bounded.");
		}
		this._actionResponseLimit = actionResponseLimit;
		const frameHorizonRange = config.frameHorizonRange ?? { min: 1, max: DEFAULT_MAX_FRAME_HORIZON };
		if (
			!Number.isSafeInteger(frameHorizonRange.min) ||
			!Number.isSafeInteger(frameHorizonRange.max) ||
			frameHorizonRange.min < 1 ||
			frameHorizonRange.max < frameHorizonRange.min
		) {
			throw new Error("Frame horizon range must contain positive ordered integers.");
		}
		this._frameHorizonRange = frameHorizonRange;

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installContextCompiler();
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._bindPieProductionLifecycle();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private _emitAppendedEntry(entryId: string): void {
		const entry = this.sessionManager.getEntry(entryId);
		if (entry) this._emit({ type: "entry_appended", entry });
	}

	private _appendFrameRevision(
		definition: FrameDefinition,
		sourceEventId: string,
		current?: Frame,
		revisionReason?: string,
		frameId = current?.id ?? `frame-${randomUUID()}`,
	): void {
		this._emitAppendedEntry(
			this.sessionManager.appendFrameRevision({
				frameId,
				version: (current?.version ?? 0) + 1,
				statement: definition.statement,
				falsifier: definition.falsifier,
				horizon: definition.horizon,
				previousRevisionId: current?.revisionEntryId ?? null,
				sourceEventId,
				revisionReason,
			}),
		);
	}

	private _appendFrameTransition(
		frame: Frame,
		transition: FrameTerminalTransition,
		sourceEventId: string,
		reason: string,
		replacementFrameId?: string,
	): void {
		this._emitAppendedEntry(
			this.sessionManager.appendFrameTransition({
				frameId: frame.id,
				version: frame.version,
				revisionEntryId: frame.revisionEntryId,
				transition,
				sourceEventId,
				reason,
				replacementFrameId,
			}),
		);
	}

	private _applyFrameDirective(directive: FrameDirective, sourceEventId: string, current: Frame | undefined): void {
		if (directive.type === "create") {
			if (current) throw new Error("A Frame is already active; revise or replace it explicitly.");
			this._appendFrameRevision(directive, sourceEventId);
			return;
		}
		if (!current) throw new Error(`Cannot ${directive.type} a Frame because no Frame is active.`);
		if (directive.type === "revise") {
			this._appendFrameRevision(directive, sourceEventId, current, directive.revisionReason);
			return;
		}
		if (directive.type === "replace") {
			const replacementFrameId = `frame-${randomUUID()}`;
			this._appendFrameTransition(current, "replaced", sourceEventId, directive.reason, replacementFrameId);
			this._appendFrameRevision(directive, sourceEventId, undefined, undefined, replacementFrameId);
			return;
		}
		this._appendFrameTransition(
			current,
			directive.type === "falsify" ? "falsified" : "died",
			sourceEventId,
			directive.reason,
		);
	}

	private _appendActionStart(definition: ActionDefinition, sourceEventId: string, frame: Frame): void {
		this._emitAppendedEntry(
			this.sessionManager.appendActionStart({
				actionId: `action-${randomUUID()}`,
				intent: definition.intent,
				completionCondition: definition.completionCondition,
				frameRevisionEntryId: frame.revisionEntryId,
				sourceEventId,
			}),
		);
	}

	private _appendActionTransition(
		action: Action,
		transition: ActionTerminalTransition,
		sourceEventId: string,
		reason: string,
		challenge?: "anchor" | "frame",
	): void {
		this._emitAppendedEntry(
			this.sessionManager.appendActionTransition({
				actionId: action.id,
				startEntryId: action.startEntryId,
				transition,
				sourceEventId,
				reason,
				challenge,
			}),
		);
	}

	private _applyActionDirective(
		directive: ActionDirective,
		sourceEventId: string,
		state: ReturnType<typeof restoreEpistemicState>,
	): void {
		if (directive.type === "start") {
			if (state.action) throw new Error("An Action episode is already active.");
			if (!state.frame) throw new Error("Create an admissible Frame before starting an Action.");
			this._appendActionStart(directive, sourceEventId, state.frame);
			return;
		}
		if (!state.action) throw new Error(`Cannot ${directive.type} because no Action episode is active.`);
		this._appendActionTransition(
			state.action,
			directive.type === "complete" ? "completed" : directive.type === "unresolvable" ? "unresolvable" : "escalated",
			sourceEventId,
			directive.reason,
			directive.type === "escalate" ? directive.challenge : undefined,
		);
	}

	private _validateObservationDefinition(
		definition: ObservationDefinition,
		state: ReturnType<typeof restoreEpistemicState>,
	): void {
		if (!definition.statement.trim()) throw new Error("Observation statement must not be empty.");
		if (definition.sourceEventIds.length === 0) {
			throw new Error("Observation must reference at least one execution result.");
		}
		if (new Set(definition.sourceEventIds).size !== definition.sourceEventIds.length) {
			throw new Error("Observation provenance must not contain duplicate event identities.");
		}
		if (!state.action) throw new Error("Observation materialization requires an active Action episode.");
		if ((definition.affects === "anchor" || definition.affects === "anchor_and_frame") && !state.anchor) {
			throw new Error("Observation cannot affect Anchor satisfaction because no Anchor is active.");
		}
		if ((definition.affects === "frame" || definition.affects === "anchor_and_frame") && !state.frame) {
			throw new Error("Observation cannot affect Frame admissibility because no Frame is active.");
		}
		const branch = this.sessionManager.getBranch();
		const actionStartIndex = branch.findIndex((entry) => entry.id === state.action?.startEntryId);
		for (const sourceEventId of definition.sourceEventIds) {
			const sourceIndex = branch.findIndex((entry) => entry.id === sourceEventId);
			const source = sourceIndex < 0 ? undefined : branch[sourceIndex];
			if (
				sourceIndex <= actionStartIndex ||
				source?.type !== "message" ||
				(source.message.role !== "toolResult" && source.message.role !== "bashExecution")
			) {
				throw new Error(
					`Observation source ${sourceEventId} must be an exact execution result after the current Action started.`,
				);
			}
		}
	}

	private _appendObservation(
		definition: ObservationDefinition,
		state: ReturnType<typeof restoreEpistemicState>,
	): void {
		this._validateObservationDefinition(definition, state);
		const targetsAnchor = definition.affects === "anchor" || definition.affects === "anchor_and_frame";
		const targetsFrame = definition.affects === "frame" || definition.affects === "anchor_and_frame";
		this._emitAppendedEntry(
			this.sessionManager.appendObservation({
				observationId: `observation-${randomUUID()}`,
				statement: definition.statement,
				sourceEventIds: [...definition.sourceEventIds],
				anchorId: targetsAnchor ? state.anchor?.id : undefined,
				anchorRevisionEntryId: targetsAnchor ? state.anchor?.revisionEntryId : undefined,
				frameId: targetsFrame ? state.frame?.id : undefined,
				frameRevisionEntryId: targetsFrame ? state.frame?.revisionEntryId : undefined,
			}),
		);
	}

	/**
	 * The terminal outcome of a controller-authored Action is execution feedback:
	 * what the episode found that blocks completion (unresolvable) or challenges the
	 * Frame/Anchor (escalated). Materialize it as a durable Observation so the next
	 * epistemic decision can act on it instead of re-deriving or losing it.
	 *
	 * Harness-generated terminal transitions (lease expiry, round exhaustion) never
	 * reach this path; they are bounded-return mechanics, not controller feedback.
	 * An episode with no finalized execution result has no provenance to cite, so
	 * nothing is materialized. `complete_action` does not call this method: success
	 * is progress, not feedback.
	 */
	private _materializeTerminalActionFeedback(
		state: ReturnType<typeof restoreEpistemicState>,
		action: Action,
		reason: string,
	): void {
		if (!this._observationEnabled || !state.anchor || !state.frame) return;
		const branch = this.sessionManager.getBranch();
		const startIndex = branch.findIndex((entry) => entry.id === action.startEntryId);
		if (startIndex < 0) return;
		const sourceEventIds: string[] = [];
		for (let index = startIndex + 1; index < branch.length; index++) {
			const entry = branch[index]!;
			if (
				entry.type === "message" &&
				(entry.message.role === "toolResult" || entry.message.role === "bashExecution")
			) {
				sourceEventIds.push(entry.id);
			}
		}
		if (sourceEventIds.length === 0) return;
		// Terminal feedback is task-level evidence: it bears on both the current
		// Frame (why the episode ended) and the Anchor (what the world showed), so
		// it stays relevant after the Frame dies.
		this._appendObservation({ statement: reason, affects: "anchor_and_frame", sourceEventIds }, state);
	}

	private _installContextCompiler(): void {
		const transformMessages = this.agent.transformContext;
		this.agent.transformContext = async (runtimeMessages, signal) => {
			const model = this._activeRequestModel ?? this.agent.state.model;
			const modelKey = `${model.provider}\0${model.id}\0${model.contextWindow}`;
			if (this._contextBudgetModelKey !== modelKey) {
				this._contextBudgetModelKey = modelKey;
				this._contextInputTokenLimit = this._configuredContextInputTokenLimit;
			}
			let rawEvents = this.sessionManager.getBranch();
			let epistemicState = this._anchorEnabled ? restoreEpistemicState(rawEvents) : {};
			const source = rawEvents
				.slice()
				.reverse()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			const requestedObservation = this._pendingObservation;
			if (this._observationEnabled && requestedObservation) {
				this._appendObservation(requestedObservation, epistemicState);
				this._pendingObservation = undefined;
				rawEvents = this.sessionManager.getBranch();
				epistemicState = restoreEpistemicState(rawEvents);
			}
			const requestedActionDirective = this._pendingActionDirective;
			if (
				this._actionEnabled &&
				requestedActionDirective &&
				requestedActionDirective.type !== "start" &&
				source?.type === "message"
			) {
				this._applyActionDirective(requestedActionDirective, source.id, epistemicState);
				this._pendingActionDirective = undefined;
				rawEvents = this.sessionManager.getBranch();
				epistemicState = restoreEpistemicState(rawEvents);
			}
			const requestedAnchorRevision = this._pendingAnchorRevision;
			if (this._anchorEnabled && requestedAnchorRevision && source?.type === "message") {
				const current = epistemicState.anchor;
				this._emitAppendedEntry(
					this.sessionManager.appendAnchorRevision({
						anchorId: current?.id ?? `anchor-${source.id}`,
						revision: (current?.revision ?? 0) + 1,
						statement: requestedAnchorRevision.statement,
						previousRevisionId: current?.revisionEntryId ?? null,
						sourceEventId: source.id,
						revisionReason: requestedAnchorRevision.revisionReason,
					}),
				);
				this._pendingAnchorRevision = undefined;
				rawEvents = this.sessionManager.getBranch();
				epistemicState = restoreEpistemicState(rawEvents);
			}
			const requestedFrameDirective = this._pendingFrameDirective;
			if (this._frameEnabled && requestedFrameDirective && source?.type === "message") {
				this._applyFrameDirective(requestedFrameDirective, source.id, epistemicState.frame);
				this._pendingFrameDirective = undefined;
				rawEvents = this.sessionManager.getBranch();
				epistemicState = restoreEpistemicState(rawEvents);
			}
			if (this._actionEnabled && requestedActionDirective?.type === "start" && source?.type === "message") {
				this._applyActionDirective(requestedActionDirective, source.id, epistemicState);
				this._pendingActionDirective = undefined;
				rawEvents = this.sessionManager.getBranch();
				epistemicState = restoreEpistemicState(rawEvents);
			}
			const frame = epistemicState.frame;
			const latestEntry = rawEvents.at(-1);
			const explicitActionAdjudicationPending = latestEntry?.type === "action_transition";
			if (
				this._frameEnabled &&
				!requestedFrameDirective &&
				!explicitActionAdjudicationPending &&
				frame &&
				frame.completedModelResponses >= frame.horizon &&
				frame.lastResponseEventId
			) {
				if (epistemicState.action) {
					this._appendActionTransition(
						epistemicState.action,
						"unresolvable",
						frame.lastResponseEventId,
						`The containing Frame reached its ${frame.horizon}-response horizon before the completion condition was met.`,
					);
					rawEvents = this.sessionManager.getBranch();
					epistemicState = restoreEpistemicState(rawEvents);
				}
				this._appendFrameTransition(
					frame,
					"expired",
					frame.lastResponseEventId,
					`Frame version ${frame.version} reached its ${frame.horizon}-response horizon.`,
				);
				rawEvents = this.sessionManager.getBranch();
				epistemicState = restoreEpistemicState(rawEvents);
			}
			const compilation = await this._contextCompiler.compile({
				rawEvents,
				epistemicState,
				runtimeMessages,
				model,
				systemPrompt: this._activeProductionRequestRole
					? `${this.agent.state.systemPrompt}\n\n${this._productionSystemPrompt(this._activeProductionRequestRole)}`
					: this.agent.state.systemPrompt,
				tools:
					this._activeProductionRequestRole && this._activeProductionRequestRole !== "execution"
						? []
						: this.agent.state.tools,
				projectionRole: this._activeProductionRequestRole ?? "default",
				requestInstruction: this._activeProductionRequestRole
					? {
							role: "custom",
							customType: "pie.production-request",
							content: `[PIE ${this._activeProductionRequestRole.toUpperCase()} REQUEST]\n${this._productionSystemPrompt(this._activeProductionRequestRole)}`,
							display: false,
							details: { role: this._activeProductionRequestRole },
							timestamp: Date.now(),
						}
					: undefined,
				reservedOutputTokens: Math.min(
					this.settingsManager.getCompactionReserveTokens(),
					model.maxTokens,
					Math.floor(model.contextWindow * 0.25),
				),
				inputTokenLimit: this._contextInputTokenLimit,
				signal,
				transformMessages,
			});
			this._latestContextManifest = compilation.manifest;
			this._emit({ type: "context_compiled", manifest: compilation.manifest });
			return compilation.messages;
		};
	}

	private _pieModelForRole(role: PieModelRole): Model<any> {
		return this._pieModelRoutes[role] ?? this.agent.state.model;
	}

	private _productionSystemPrompt(role: PieProductionRequestRole): string {
		if (role === "execution") {
			const state = restoreEpistemicState(this.sessionManager.getBranch());
			const action = state.action;
			const actionBudget = this._leaseBudgetForAction(state);
			const consumedRounds = action ? this._consumedEvidenceRounds(action.startEntryId) : 0;
			const responseBudget = actionBudget
				? ` This episode has consumed ${consumedRounds}/${actionBudget.expectedEvidenceRounds} serial evidence rounds. ` +
					`Accepted dependency: ${actionBudget.budgetReason}. The estimate is an upper lease, not a quota.`
				: action
					? ` This restored episode has no transient round derivation; the legacy ${this._actionResponseLimit}-response safety bound applies.`
					: "";
			return (
				"Execute only the frozen CURRENT ACTION under the CURRENT FRAME. The CURRENT ACTION is the complete and exclusive " +
				"scope of this request, even if the user asked for later work. Do not perform, anticipate, or combine a later episode. " +
				"You may use multiple tools and model responses and may repair local execution strategy, but you must not change " +
				"the Action intent or completion condition." +
				responseBudget +
				" Batch independent read-only tool calls in one response when their execution contracts permit it. Do not spend a " +
				"response only narrating progress: either gather evidence needed by the completion condition or state the established result. " +
				"As soon as the exact completion condition is established, stop this generation immediately: do not call another " +
				"tool, do not begin the next task step, and do not produce the user's final answer. A provider stop ends only this " +
				"generation; it does not complete the Action or authorize a final answer. Return exactly UNRESOLVABLE only when " +
				"the frozen completion condition cannot be met under current constraints. If it is unmeetable because it demands an " +
				"unbounded enumeration (every/all occurrences or a complete catalog) rather than because the world contradicts it, do not " +
				"fabricate completion: return UNRESOLVABLE whose reason names (a) the bounded result you did establish and (b) the " +
				"narrower single-observable condition that remains. This is the controlled scope-narrowing exit; never silently widen, " +
				"narrow, or rewrite the frozen condition while executing under it."
			);
		}
		if (role === "finalAnswer") {
			const authorization = this._pendingFinalAuthorization;
			return authorization?.kind === "inability"
				? `Epistemic control authorized a bounded inability report: ${authorization.reason}. Give the user a concise actionable report. Do not call tools.`
				: `Epistemic control established Anchor satisfaction and authorized the final answer: ${authorization?.reason ?? "authorized"}. Give only the user-visible final answer. Do not call tools.`;
		}
		const state = restoreEpistemicState(this.sessionManager.getBranch());
		const activeActionBudget = this._leaseBudgetForAction(state);
		const consumedEvidenceRounds = state.action ? this._consumedEvidenceRounds(state.action.startEntryId) : 0;
		const actionBudgetExhausted =
			state.action !== undefined &&
			(activeActionBudget
				? consumedEvidenceRounds >= activeActionBudget.expectedEvidenceRounds
				: state.action.completedModelResponses >= this._actionResponseLimit);
		const policy = DEFAULT_FRAME_LEASE_POLICY;
		const availableActionContracts = !state.action
			? this._leaseBudgetForFrame(state.frame)?.actions.filter((candidate) => !candidate.actionStartEntryId)
			: undefined;
		const availableActionContractsPrompt = availableActionContracts
			? availableActionContracts.length > 0
				? ` Available provisional Action contracts for the current Frame:\n${availableActionContracts
						.map((candidate) =>
							JSON.stringify({
								actionContractId: candidate.contractId,
								intent: candidate.intent,
								completionCondition: candidate.completionCondition,
								expectedEvidenceRounds: candidate.expectedEvidenceRounds,
								budgetReason: candidate.budgetReason,
							}),
						)
						.join("\n")}\nAuthorize one by its actionContractId; do not reproduce or paraphrase its text.`
				: " No unused provisional Action contracts remain for the current Frame."
			: "";
		const allowed = state.action
			? actionBudgetExhausted
				? "complete_action, unresolvable_action, or escalate_action"
				: "continue_action, complete_action, unresolvable_action, or escalate_action"
			: state.frame
				? "authorize_action, revise_frame, replace_frame, falsify_frame, kill_frame, authorize_final, or report_inability"
				: state.anchor
					? "create_frame, revise_anchor, authorize_final, or report_inability"
					: "report_inability";
		return (
			"PIE CONTROL REQUEST. This request is not a user-answer or tool-execution turn. Do not execute the user task, " +
			"do not call or simulate tools, and do not output requested answer tokens. Return exactly one JSON object, with " +
			"the discriminator property named exactly kind, and no prose or markdown. The first character must be { and the " +
			"last character must be }. " +
			(this._lastControlError ? `The previous decision was rejected: ${this._lastControlError} ` : "") +
			`The current state permits only: ${allowed}.` +
			availableActionContractsPrompt +
			` For create_frame, revise_frame, or replace_frame, enumerate 1-${policy.maxActions} provisional bounded Actions; do not supply horizon. ` +
			`Each provisional Action has intent, completionCondition, expectedEvidenceRounds (integer 1-${policy.maxEvidenceRounds}), and budgetReason. ` +
			"One evidence round is one model response that emits one or more independent evidence-producing tool calls; parallel read-only calls in that response count once. A later round is valid only when its probe depends on a result unavailable before the preceding round. " +
			"Complexity, uncertainty, file count, or tool-call count do not justify extra rounds. Unknown source locations require a discovery-only Action before source reading. " +
			`The harness derives horizon within ${this._frameHorizonRange.min}-${this._frameHorizonRange.max}: initial control ${policy.initialControlAllowance} + per Action authorization ${policy.actionAuthorizationCost} + evidence rounds + terminal adjudication ${policy.actionTerminalAdjudicationCost} + final Frame adjudication ${policy.finalFrameAdjudicationCost}. ` +
			"When an accepted evidence-round estimate is exhausted, continue_action is forbidden and control must return without automatic renewal. " +
			'Schemas: {"kind":"create_frame","statement":string,"falsifier":string,"actions":[{"intent":string,"completionCondition":string,"expectedEvidenceRounds":integer,"budgetReason":string}]}; ' +
			"revise_frame and replace_frame use the same actions array and also require reason; falsify_frame, kill_frame, continue_action, " +
			"complete_action, unresolvable_action, authorize_final, and report_inability require reason; " +
			"revise_anchor requires statement and reason; authorize_action requires only actionContractId from one listed unused provisional contract; " +
			"escalate_action requires challenge (anchor or frame) and reason. A Frame must assert one provisional causal or " +
			"behavioral relation that authorizes investigation; it must not restate the request, begin with a task verb, or include " +
			"the requested deliverable. Its falsifier names an exact observable world result that contradicts that relation, not " +
			"an inability to finish the investigation. A Frame must not assert an unbounded completeness claim (for example that " +
			"some set of files contains all prompt sources, that every entry point is in one place, or that a list is exhaustive). " +
			"When the Anchor asks for an exhaustive inventory (all, every, complete), decompose it: each Frame asserts one bounded, " +
			"checkable slice of the Anchor and leaves the remaining slices to subsequent Frames; authorize_final only when every " +
			"slice you intend to cover has been established. Prefer a discovery Frame first that settles the bounded fact of where " +
			"the LLM call entry points are, before Frames that enumerate their prompt sources. An Action is one bounded episode with one externally checkable completion " +
			"result, not the whole task, a report, or a bundle of diagnosis, repair, and verification. A completion condition is bounded only when one observable result can " +
			"confirm it: a single file read in full, a single symbol's declaration, or a single diff or command output. Do not " +
			"write a condition that enumerates every or all occurrences, every declaration site, or a complete inventory; such a " +
			"condition is unbounded and cannot finish inside its evidence-round budget. A read or discovery episode's completion is " +
			"the read itself (its tool calls and results are already recorded in the transcript), not an extracted catalog of " +
			"everything it contains; perform synthesis in the control decision that follows, not inside the episode. For authorize_action, " +
			"select a listed actionContractId instead of regenerating contract text. If source locations needed by the condition are not yet known, authorize a discovery-only Action that records those locations before a source-reading or comparison Action. " +
			"Split evidence collection, mutation, and verification into separate Actions when they establish different results. A plain assistant stop, " +
			"successful tool call, or final-looking prose proves neither Action completion nor Anchor satisfaction. When an Action " +
			"is active, adjudicate only that exact frozen intent and completion condition. Ignore and do not credit execution " +
			"outside its scope; such execution cannot merge a later Action into the current episode. After complete_action, " +
			"reconsider separately before authorizing the next Action. After unresolvable_action, treat the reason as evidence " +
			"against the Frame: if it contradicts the Frame's premise or establishes its falsifier, falsify_frame or kill_frame " +
			"instead of authorizing a remaining Action whose completion condition presupposes the contradicted premise. " +
			"When an unresolvable reason shows the completion condition was over-scoped (unbounded enumeration) rather than " +
			"contradicted by the world, authorize a new, narrower Action that establishes the bounded sub-result named in the reason; " +
			"do not re-authorize the same over-scoped contract. " +
			"Use escalate_action only when the finalized results themselves contradict or undermine the Frame relation or the " +
			"Anchor success semantics; use unresolvable_action when the episode cannot complete under current constraints, " +
			"naming in reason what was found and what remains unknown."
		);
	}

	private _latestAssistantEventId(): string {
		const entry = this.sessionManager
			.getBranch()
			.slice()
			.reverse()
			.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
		if (!entry) throw new Error("Pie control requires a persisted assistant response as provenance.");
		return entry.id;
	}

	private _normalizeSemanticText(text: string): string {
		return text
			.normalize("NFKC")
			.toLocaleLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	}

	private _semanticCharacterContainment(left: string, right: string): number {
		const grams = (text: string): Set<string> => {
			const characters = Array.from(this._normalizeSemanticText(text).replace(/\s+/g, ""));
			if (characters.length < 3) return new Set(characters.length > 0 ? [characters.join("")] : []);
			return new Set(characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join("")));
		};
		const leftGrams = grams(left);
		const rightGrams = grams(right);
		if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
		let intersection = 0;
		for (const gram of leftGrams) {
			if (rightGrams.has(gram)) intersection++;
		}
		return intersection / Math.min(leftGrams.size, rightGrams.size);
	}

	private _parseControlDecision(message: AssistantMessage): PieControlDecision {
		if (message.content.some((part) => part.type === "toolCall")) {
			throw new Error("Epistemic control must not invoke tools.");
		}
		const text = contentText(message.content, "").trim();
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			const starts = [...text.matchAll(/\{/g)].map((match) => match.index).reverse();
			const ends = [...text.matchAll(/\}/g)].map((match) => match.index + 1).reverse();
			for (const start of starts) {
				for (const end of ends) {
					if (end <= start) continue;
					try {
						const candidate: unknown = JSON.parse(text.slice(start, end));
						if (
							candidate &&
							typeof candidate === "object" &&
							!Array.isArray(candidate) &&
							("kind" in candidate || "operation" in candidate)
						) {
							value = candidate;
							break;
						}
					} catch {
						// Keep scanning for one explicit decision object in incidental prose.
					}
				}
				if (value !== undefined) break;
			}
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Epistemic control response must contain one JSON decision object.");
		}
		if (!("kind" in value) && "operation" in value && typeof value.operation === "string") {
			return { ...value, kind: value.operation } as unknown as PieControlDecision;
		}
		if (!("kind" in value)) throw new Error("Epistemic control decision requires the kind discriminator.");
		return value as PieControlDecision;
	}

	private _prepareControllerFrame(
		definition: Extract<PieControlDecision, { kind: "create_frame" | "revise_frame" | "replace_frame" }>,
		state: ReturnType<typeof restoreEpistemicState>,
	): { frame: FrameDefinition; budget: ActiveFrameLeaseBudget } {
		if ("horizon" in definition) {
			throw new Error(
				"Production Frame horizon is derived from provisional Actions; do not supply horizon directly.",
			);
		}
		if (
			typeof definition.statement !== "string" ||
			typeof definition.falsifier !== "string" ||
			!Array.isArray(definition.actions)
		) {
			throw new Error("Production Frame decision requires statement, falsifier, and provisional actions.");
		}
		for (const candidate of definition.actions) {
			if (
				!candidate ||
				typeof candidate !== "object" ||
				typeof candidate.intent !== "string" ||
				typeof candidate.completionCondition !== "string" ||
				typeof candidate.budgetReason !== "string"
			) {
				throw new Error(
					"Each provisional Action requires a valid contract, expectedEvidenceRounds, and budgetReason.",
				);
			}
		}
		const anchor = state.anchor;
		const statement = this._normalizeSemanticText(definition.statement);
		const anchorStatement = anchor ? this._normalizeSemanticText(anchor.statement) : "";
		const startsWithTaskVerb =
			/^(?:investigate|analy[sz]e|inspect|trace|locate|determine|review|fix|implement|complete|deliver|produce|consider|check|verify)(?:\s|$)/u.test(
				statement,
			) || /^(?:调查|分析|检查|追踪|定位|确定|修复|实现|完成|交付|考虑|核对|验证)/u.test(statement);
		const repeatsAnchor =
			statement === anchorStatement ||
			(anchor !== undefined &&
				anchorStatement.length >= 80 &&
				this._semanticCharacterContainment(definition.statement, anchor.statement) >= 0.72);
		const predictsOwnFalsifier = /\bfalsifier\b/u.test(statement) || /(?:反证|证伪结果|否证结果)/u.test(statement);
		const conditionsTruthOnProbe =
			/\b(?:accurate(?:ly)?|correct(?:ly)?|true|valid|explains?)\b.*\b(?:only if|if and only if|provided that)\b/u.test(
				statement,
			) || /(?:准确|正确|成立|有效).*(?:仅当|当且仅当|前提是)/u.test(statement);
		if (
			!statement ||
			statement.length < 12 ||
			startsWithTaskVerb ||
			repeatsAnchor ||
			predictsOwnFalsifier ||
			conditionsTruthOnProbe
		) {
			throw new Error(
				"Frame statement must assert one provisional world relation rather than restate or execute the Anchor.",
			);
		}
		const assertsCompleteness =
			(/\b(?:all|every|each)\b/u.test(statement) &&
				/\b(?:prompt|source|file|site|entry|path|location|definition|call|module|layer|tool|message|template)s?\b/u.test(
					statement,
				)) ||
			/\b(?:complete|exhaustive|entire|no (?:other|additional|further|unaccounted|remaining)|the only|only these)\b/u.test(
				statement,
			) ||
			/(?:所有|全部|每个|每一|唯一|无(?:遗漏|其他|剩余)|完整|穷举)/u.test(statement);
		if (assertsCompleteness) {
			throw new Error(
				"Frame statement must assert one bounded slice of the Anchor, not an unbounded completeness claim over all sources, files, or entry points; decompose the Anchor and leave the remaining slices to subsequent Frames.",
			);
		}
		const falsifier = this._normalizeSemanticText(definition.falsifier);
		if (
			falsifier.length < 12 ||
			this._semanticCharacterContainment(definition.statement, definition.falsifier) >= 0.7 ||
			/^(?:cannot|can not|unable to|failure to|no (?:specific |concrete )?)(?:complete|finish|locate|find|identify|mismatch|ambiguity|site|cause|fix|edit)/u.test(
				falsifier,
			) ||
			/^(?:无法|不能|未能|没有找到|找不到|无具体)(?:完成|定位|发现|识别|问题|原因|修复)/u.test(falsifier) ||
			falsifier === "the frame is wrong" ||
			falsifier === "this is not true"
		) {
			throw new Error(
				"Frame falsifier must name a concrete observable result that contradicts, rather than restates, the Frame relation.",
			);
		}
		for (const candidate of definition.actions ?? []) this._validateControllerAction(candidate, state);
		const calculation = deriveFrameLease(definition.actions ?? []);
		if (calculation.horizon < this._frameHorizonRange.min || calculation.horizon > this._frameHorizonRange.max) {
			throw new Error(
				`Derived Frame horizon ${calculation.horizon} is outside ${this._frameHorizonRange.min}-${this._frameHorizonRange.max}; narrow the Frame or choose a smaller provisional Action set.`,
			);
		}
		const frame = {
			statement: definition.statement.trim(),
			falsifier: definition.falsifier.trim(),
			horizon: calculation.horizon,
		};
		return {
			frame,
			budget: {
				frameRevisionEntryId: "",
				calculation,
				actions: definition.actions.map((candidate, index) => ({
					...candidate,
					contractId: `A${index + 1}`,
					intent: candidate.intent.trim(),
					completionCondition: candidate.completionCondition.trim(),
					budgetReason: candidate.budgetReason.trim(),
				})),
			},
		};
	}

	private _validateControllerAction(
		definition: ActionDefinition,
		state: ReturnType<typeof restoreEpistemicState>,
	): void {
		this._validateActionDefinition(definition);
		const intent = this._normalizeSemanticText(definition.intent);
		const completion = this._normalizeSemanticText(definition.completionCondition);
		const anchor = state.anchor ? this._normalizeSemanticText(state.anchor.statement) : "";
		const bundlesWholeTask =
			/\b(?:end to end|whole (?:task|request)|entire (?:task|request)|final answer)\b/u.test(intent) ||
			/\b(?:written (?:inventory|report)|concrete diagnosis|proposed fix|final answer|whole (?:task|request)|entire (?:task|request)|confirmed absence)\b/u.test(
				completion,
			) ||
			/(?:完整|全部|整个)(?:任务|请求|调查)|最终答案|诊断.*修复|修复.*验证/u.test(`${intent} ${completion}`);
		const enumeratesUnbounded =
			/(?:every|enumerate|exhaustive|comprehensive|no unaccounted|no remaining|complete (?:list|inventory|catalog|map)|catalog)/u.test(
				`${intent} ${completion}`,
			) ||
			/(?:每个|每一|所有|全部|无遗漏|无剩余|穷举|逐一|完整(?:清单|目录|映射)|详尽|枚举)/u.test(
				`${intent} ${completion}`,
			);
		if (intent === anchor || bundlesWholeTask) {
			throw new Error(
				"Action must authorize one finite episode with one checkable result, not the whole task or a bundled deliverable.",
			);
		}
		if (enumeratesUnbounded) {
			throw new Error(
				"Action completion condition must be confirmable by one bounded observable result; drop universal enumeration (every/all/no-unaccounted/complete catalog) and name the single file, symbol, or diff this episode will establish.",
			);
		}
	}

	private _consumedEvidenceRounds(actionStartEntryId: string): number {
		const branch = this.sessionManager.getBranch();
		const startIndex = branch.findIndex((entry) => entry.id === actionStartEntryId);
		if (startIndex < 0) return 0;
		let rounds = 0;
		for (let index = startIndex + 1; index < branch.length; index++) {
			const entry = branch[index]!;
			if (entry.type === "action_transition" && entry.startEntryId === actionStartEntryId) break;
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((part) => part.type === "toolCall")
			) {
				rounds++;
			}
		}
		return rounds;
	}

	private _leaseBudgetForFrame(frame: Frame | undefined): ActiveFrameLeaseBudget | undefined {
		return frame && this._frameLeaseBudget?.frameRevisionEntryId === frame.revisionEntryId
			? this._frameLeaseBudget
			: undefined;
	}

	private _leaseBudgetForAction(
		state: ReturnType<typeof restoreEpistemicState>,
	): (ProvisionalActionContract & { contractId: string; actionStartEntryId: string }) | undefined {
		if (!state.action) return undefined;
		return this._leaseBudgetForFrame(state.frame)?.actions.find(
			(candidate): candidate is ProvisionalActionContract & { contractId: string; actionStartEntryId: string } =>
				candidate.actionStartEntryId === state.action?.startEntryId,
		);
	}

	private _expireProductionFrame(sourceEventId: string): boolean {
		let state = restoreEpistemicState(this.sessionManager.getBranch());
		const frame = state.frame;
		if (!frame || frame.completedModelResponses < frame.horizon) return false;
		if (state.action) {
			this._appendActionTransition(
				state.action,
				"unresolvable",
				sourceEventId,
				`The containing Frame reached its ${frame.horizon}-response lease before the frozen completion condition was met.`,
			);
			state = restoreEpistemicState(this.sessionManager.getBranch());
		}
		this._appendFrameTransition(
			frame,
			"expired",
			sourceEventId,
			`Frame version ${frame.version} reached its ${frame.horizon}-response lease.`,
		);
		return true;
	}

	private _applyProductionControl(decision: PieControlDecision, sourceEventId: string): PieProductionRequestRole {
		let state = restoreEpistemicState(this.sessionManager.getBranch());
		const reason = "reason" in decision ? decision.reason?.trim() : undefined;
		if ("reason" in decision && !reason) throw new Error(`Control decision ${decision.kind} requires a reason.`);
		switch (decision.kind) {
			case "create_frame": {
				if (state.frame) throw new Error("A Frame is already active; revise or replace it explicitly.");
				const prepared = this._prepareControllerFrame(decision, state);
				this._applyFrameDirective({ type: "create", ...prepared.frame }, sourceEventId, undefined);
				const created = restoreEpistemicState(this.sessionManager.getBranch()).frame!;
				prepared.budget.frameRevisionEntryId = created.revisionEntryId;
				this._frameLeaseBudget = prepared.budget;
				return "epistemic";
			}
			case "revise_frame":
			case "replace_frame": {
				if (state.action) throw new Error("Terminate the active Action before changing its Frame.");
				if (!state.frame) throw new Error(`Cannot ${decision.kind} because no Frame is active.`);
				const prepared = this._prepareControllerFrame(decision, state);
				this._applyFrameDirective(
					decision.kind === "revise_frame"
						? { type: "revise", ...prepared.frame, revisionReason: reason }
						: { type: "replace", ...prepared.frame, reason: reason! },
					sourceEventId,
					state.frame,
				);
				const revised = restoreEpistemicState(this.sessionManager.getBranch()).frame!;
				prepared.budget.frameRevisionEntryId = revised.revisionEntryId;
				this._frameLeaseBudget = prepared.budget;
				return "epistemic";
			}
			case "falsify_frame":
			case "kill_frame":
				if (state.action) throw new Error("Terminate the active Action before terminating its Frame.");
				if (!state.frame) throw new Error("No Frame is active.");
				this._appendFrameTransition(
					state.frame,
					decision.kind === "falsify_frame" ? "falsified" : "died",
					sourceEventId,
					reason!,
				);
				return "epistemic";
			case "revise_anchor":
				if (state.action || state.frame)
					throw new Error("Terminate the active Action and Frame before revising the Anchor.");
				if (!state.anchor) throw new Error("No Anchor is active.");
				if (!decision.statement?.trim()) throw new Error("Anchor statement must not be empty.");
				this._emitAppendedEntry(
					this.sessionManager.appendAnchorRevision({
						anchorId: state.anchor.id,
						revision: state.anchor.revision + 1,
						statement: decision.statement.trim(),
						previousRevisionId: state.anchor.revisionEntryId,
						sourceEventId,
						revisionReason: reason,
					}),
				);
				return "epistemic";
			case "authorize_action": {
				if (state.action) throw new Error("An Action episode is already active.");
				if (!state.frame) throw new Error("Create an admissible Frame before authorizing an Action.");
				if (typeof decision.actionContractId !== "string" || !decision.actionContractId.trim()) {
					throw new Error("Action authorization requires a listed actionContractId.");
				}
				const leaseBudget = this._leaseBudgetForFrame(state.frame);
				if (!leaseBudget) {
					throw new Error(
						"Frame lease derivation is unavailable after restoration; revise the Frame before authorizing another Action.",
					);
				}
				const planned = leaseBudget.actions.find(
					(candidate) =>
						candidate.actionStartEntryId === undefined &&
						candidate.contractId === decision.actionContractId.trim(),
				);
				if (!planned) {
					throw new Error(
						`Action contract ${decision.actionContractId.trim()} is not an unused contract listed for the current Frame.`,
					);
				}
				this._appendActionStart(planned, sourceEventId, state.frame);
				state = restoreEpistemicState(this.sessionManager.getBranch());
				planned.actionStartEntryId = state.action?.startEntryId;
				this._operationalActionId = state.action?.id;
				this._operationalRepairAttempts = 0;
				this._latestOperationalError = undefined;
				this._pendingRepairExhaustion = undefined;
				this._ambiguousMutation = undefined;
				return "execution";
			}
			case "continue_action": {
				if (!state.action) throw new Error("No Action is active to continue.");
				const actionBudget = this._leaseBudgetForAction(state);
				const consumedRounds = this._consumedEvidenceRounds(state.action.startEntryId);
				const exhausted = actionBudget
					? consumedRounds >= actionBudget.expectedEvidenceRounds ||
						state.action.completedModelResponses >=
							actionBudget.expectedEvidenceRounds + DEFAULT_FRAME_LEASE_POLICY.actionTerminalAdjudicationCost
					: state.action.completedModelResponses >= this._actionResponseLimit;
				if (exhausted) {
					const budgetDescription = actionBudget
						? `${actionBudget.expectedEvidenceRounds}-round serial evidence budget`
						: `${this._actionResponseLimit}-response legacy execution budget`;
					this._appendActionTransition(
						state.action,
						"unresolvable",
						sourceEventId,
						`Action reached its ${budgetDescription} without establishing the frozen completion condition.`,
					);
					return "epistemic";
				}
				return "execution";
			}
			case "unresolvable_action":
				if (!state.action) throw new Error("Cannot unresolvable_action because no Action is active.");
				this._materializeTerminalActionFeedback(state, state.action, reason!);
				this._appendActionTransition(state.action, "unresolvable", sourceEventId, reason!);
				return "epistemic";
			case "escalate_action":
				if (!state.action) throw new Error("Cannot escalate_action because no Action is active.");
				this._materializeTerminalActionFeedback(state, state.action, reason!);
				this._appendActionTransition(state.action, "escalated", sourceEventId, reason!, decision.challenge);
				return "epistemic";
			case "complete_action":
				if (!state.action) throw new Error("Cannot complete_action because no Action is active.");
				this._appendActionTransition(state.action, "completed", sourceEventId, reason!);
				return "epistemic";
			case "authorize_final":
			case "report_inability":
				if (state.action) throw new Error("Terminate the active Action before authorizing terminal output.");
				this._pendingFinalAuthorization = {
					kind: decision.kind === "authorize_final" ? "satisfied" : "inability",
					reason: reason!,
				};
				return "finalAnswer";
			default:
				throw new Error("Unknown Pie control decision.");
		}
	}

	private _bindPieProductionLifecycle(): void {
		if (!(this.agent.loopRunner instanceof PieProductionLoop)) return;
		const loop = this.agent.loopRunner;

		this.agent.prepareModelRequest = ({ context }) => {
			const requestRole = loop.requestRole;
			const modelRole: PieModelRole = requestRole === "finalAnswer" ? "finalAnswer" : requestRole;
			const model = this._pieModelForRole(modelRole);
			this._activeRequestModel = model;
			this._activeProductionRequestRole = requestRole;
			return {
				context: {
					...context,
					systemPrompt: `${context.systemPrompt}\n\n${this._productionSystemPrompt(requestRole)}`,
					tools: requestRole === "finalAnswer" || requestRole === "epistemic" ? [] : context.tools,
				},
				model,
				thinkingLevel: clampThinkingLevel(model, this.agent.state.thinkingLevel) as ThinkingLevel,
			};
		};

		loop.bindLifecycle({
			beginRequest: (messages, kind) => {
				this._productionControlEnabled = this._anchorEnabled && this._frameEnabled && this._actionEnabled;
				this._pendingFinalAuthorization = undefined;
				this._controlRepairAttempts = 0;
				this._lastControlError = undefined;
				this._automaticActionRequest = this._productionControlEnabled;
				if (!this._productionControlEnabled || kind === "follow_up") return;
				if (
					this._pendingAnchorRevision ||
					this._pendingFrameDirective ||
					this._pendingActionDirective ||
					this._pendingObservation
				) {
					return;
				}
				const branch = this.sessionManager.getBranch();
				const state = restoreEpistemicState(branch);
				if (state.anchor) return;
				const sourceEventId = branch
					.slice()
					.reverse()
					.find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
				if (!sourceEventId) throw new Error("Pie production request requires a persisted user event.");
				const statement = messages
					.filter((message) => message.role === "user")
					.map((message) => contentText(message.content, ""))
					.filter((text) => text.trim().length > 0)
					.join("\n\n");
				if (!statement) throw new Error("Pie production request requires non-empty task-success semantics.");
				this._emitAppendedEntry(
					this.sessionManager.appendAnchorRevision({
						anchorId: `anchor-${sourceEventId}`,
						revision: 1,
						statement,
						previousRevisionId: null,
						sourceEventId,
					}),
				);
			},
			initialRole: () => {
				if (!this._productionControlEnabled) return "execution";
				if (this._pendingActionDirective?.type === "start") return "execution";
				return "epistemic";
			},
			handleControlResponse: (message) => {
				const sourceEventId = this._latestAssistantEventId();
				try {
					const decision = this._parseControlDecision(message);
					const state = restoreEpistemicState(this.sessionManager.getBranch());
					const frameLeaseExhausted =
						state.frame !== undefined && state.frame.completedModelResponses >= state.frame.horizon;
					const explicitActionDecision =
						state.action !== undefined &&
						(decision.kind === "complete_action" ||
							decision.kind === "unresolvable_action" ||
							decision.kind === "escalate_action");
					const explicitFrameDecision =
						!state.action &&
						(decision.kind === "revise_frame" ||
							decision.kind === "replace_frame" ||
							decision.kind === "falsify_frame" ||
							decision.kind === "kill_frame" ||
							decision.kind === "authorize_final" ||
							decision.kind === "report_inability");
					if (frameLeaseExhausted && !explicitActionDecision && !explicitFrameDecision) {
						this._expireProductionFrame(sourceEventId);
						this._controlRepairAttempts = 0;
						this._lastControlError = undefined;
						return { nextRole: "epistemic" };
					}
					const nextRole = this._applyProductionControl(decision, sourceEventId);
					this._controlRepairAttempts = 0;
					this._lastControlError = undefined;
					return { nextRole };
				} catch (error) {
					this._controlRepairAttempts++;
					this._lastControlError = error instanceof Error ? error.message : String(error);
					if (this._controlRepairAttempts >= this._maxControlRepairAttempts) {
						throw new Error(
							`Pie epistemic control failed validation after ${this._maxControlRepairAttempts} bounded attempts: ${this._lastControlError}`,
						);
					}
					return { nextRole: "epistemic" };
				}
			},
			handleExecutionResponse: (_message, toolResults) => {
				if (!this._productionControlEnabled) {
					return toolResults.length > 0
						? { nextRole: "execution" }
						: { nextRole: "execution", terminal: "completed" };
				}
				const sourceEventId = this._latestAssistantEventId();
				if (this._expireProductionFrame(sourceEventId)) return { nextRole: "epistemic" };
				const state = restoreEpistemicState(this.sessionManager.getBranch());
				if (!state.action) return { nextRole: "epistemic" };
				const actionBudget = this._leaseBudgetForAction(state);
				if (actionBudget) {
					if (
						this._consumedEvidenceRounds(state.action.startEntryId) >= actionBudget.expectedEvidenceRounds ||
						state.action.completedModelResponses >=
							actionBudget.expectedEvidenceRounds + DEFAULT_FRAME_LEASE_POLICY.actionTerminalAdjudicationCost - 1
					) {
						return { nextRole: "epistemic" };
					}
				} else if (state.action.completedModelResponses >= this._actionResponseLimit - 1) {
					return { nextRole: "epistemic" };
				}
				if (toolResults.length > 0) return { nextRole: "execution" };
				return { nextRole: "epistemic" };
			},
			completeFinalAnswer: () => {
				this._latestOperationalError = undefined;
				this._ambiguousMutation = undefined;
				this._automaticActionRequest = false;
				this._pendingFinalAuthorization = undefined;
			},
			interruptRequest: (reason) => {
				if (!this._automaticActionRequest) return;
				const branch = this.sessionManager.getBranch();
				const state = restoreEpistemicState(branch);
				const sourceEventId = branch.at(-1)?.id;
				if (state.action && sourceEventId && sourceEventId !== state.action.startEntryId) {
					this._appendActionTransition(state.action, "unresolvable", sourceEventId, reason);
				}
				this._automaticActionRequest = false;
			},
		});
	}

	private _toolCallSignature(toolName: string, args: unknown): string {
		try {
			return `${toolName}\0${JSON.stringify(args)}`;
		} catch {
			return `${toolName}\0[unserializable]`;
		}
	}

	private _executionResultText(result: unknown): string {
		if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
		return result.content
			.flatMap((part) =>
				part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
					? [String(part.text)]
					: [],
			)
			.join("\n");
	}

	private _isPotentialMutation(toolName: string, args: unknown): boolean {
		if (toolName === "edit" || toolName === "write") return true;
		if (toolName !== "bash" || !args || typeof args !== "object" || !("command" in args)) return false;
		const command = String(args.command);
		return /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|install|mkdir|touch|truncate|chmod|chown|git\s+(?:add|commit|checkout|restore|reset|clean)|npm\s+(?:install|uninstall)|(?:python|node|perl|ruby)\s+-e)\b|(?:^|[^<])>{1,2}/.test(
			command,
		);
	}

	private _classifyOperationalError(toolName: string, args: unknown, result: unknown): OperationalErrorClass {
		const text = this._executionResultText(result).toLowerCase();
		if (/aborted|cancelled|canceled|timed out|timeout|signal/.test(text)) return "interrupted_execution";
		if (
			/not executed|not replayed|not found$|schema|validation|invalid tool arguments|required property|execution was blocked|blocked command|policy/.test(
				text,
			)
		) {
			return "pre_execution_rejection";
		}
		if (this._isPotentialMutation(toolName, args)) return "ambiguous_mutation";
		if (
			/command not found|enoent|no such file|permission denied|invalid (?:path|option)|unknown option|spawn/.test(
				text,
			)
		) {
			return "invocation_failure";
		}
		return "completed_negative_result";
	}

	private _recordOperationalError(event: Extract<AgentEvent, { type: "tool_execution_end" }>): void {
		const args = this._toolInvocationArgs.get(event.toolCallId);
		this._toolInvocationArgs.delete(event.toolCallId);
		if (!event.isError) {
			this._latestOperationalError = undefined;
			if (["read", "grep", "find", "ls"].includes(event.toolName)) this._ambiguousMutation = undefined;
			return;
		}
		const action = this._actionEnabled ? restoreEpistemicState(this.sessionManager.getBranch()).action : undefined;
		if (this._operationalActionId !== action?.id) {
			this._operationalActionId = action?.id;
			this._operationalRepairAttempts = 0;
			this._latestOperationalError = undefined;
			this._ambiguousMutation = undefined;
		}
		this._operationalRepairAttempts++;
		const boundedAttempt = Math.min(this._operationalRepairAttempts, this._maxOperationalRepairAttempts);
		const classification = this._classifyOperationalError(event.toolName, args, event.result);
		const status: OperationalErrorStatus = {
			classification,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			attempt: boundedAttempt,
			maxAttempts: this._maxOperationalRepairAttempts,
			actionId: action?.id,
			message: this._executionResultText(event.result) || "Tool execution failed.",
			frozenContract: action !== undefined,
			requiresInspection: classification === "ambiguous_mutation",
		};
		this._latestOperationalError = status;
		this._emit({ type: "operational_error", ...status });
		if (classification === "ambiguous_mutation" && action) {
			this._ambiguousMutation = {
				actionId: action.id,
				signature: this._toolCallSignature(event.toolName, args),
			};
		}
		if (
			action &&
			this._operationalRepairAttempts >= this._maxOperationalRepairAttempts &&
			!this._pendingRepairExhaustion
		) {
			this._pendingRepairExhaustion = { actionId: action.id, toolCallId: event.toolCallId, classification };
		}
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			this._toolInvocationArgs.set(toolCall.id, args);
			const action = this._actionEnabled ? restoreEpistemicState(this.sessionManager.getBranch()).action : undefined;
			if (
				this._ambiguousMutation &&
				action?.id === this._ambiguousMutation.actionId &&
				this._toolCallSignature(toolCall.name, args) === this._ambiguousMutation.signature
			) {
				return {
					block: true,
					reason:
						"Ambiguous mutation was not replayed. Inspect current world state with a read-only tool or return UNRESOLVABLE; the Action contract remains frozen.",
				};
			}
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			if (!isError && ["read", "grep", "find", "ls"].includes(toolCall.name)) {
				this._ambiguousMutation = undefined;
			}
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			const normalizedContent = await normalizeToolResultImages(content, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});

			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first. Epistemic controller responses remain raw
		// provenance but are not rendered as user-facing assistant output.
		await this._emitExtensionEvent(event);
		const hidesControllerMessage =
			this._productionControlEnabled &&
			this._activeProductionRequestRole === "epistemic" &&
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant";

		// Notify all listeners
		if (!hidesControllerMessage) {
			this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		}
		if (event.type === "tool_execution_end") this._recordOperationalError(event);

		// Handle session persistence
		if (event.type === "message_end") {
			let persistedMessageEntryId: string | undefined;
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				persistedMessageEntryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				persistedMessageEntryId = this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (
				event.message.role === "toolResult" &&
				persistedMessageEntryId &&
				this._pendingRepairExhaustion?.toolCallId === event.message.toolCallId
			) {
				const pending = this._pendingRepairExhaustion;
				const action = this._actionEnabled
					? restoreEpistemicState(this.sessionManager.getBranch()).action
					: undefined;
				if (action?.id === pending.actionId) {
					this._appendActionTransition(
						action,
						"unresolvable",
						persistedMessageEntryId,
						`Operational repair exhausted after ${this._maxOperationalRepairAttempts}/${this._maxOperationalRepairAttempts} failed attempts; last class: ${pending.classification}. The frozen completion condition was not weakened.`,
					);
				}
				this._pendingRepairExhaustion = undefined;
			}

			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}

				if (
					this._actionEnabled &&
					persistedMessageEntryId &&
					assistantMsg.stopReason === "stop" &&
					contentText(assistantMsg.content, "").trim() === "UNRESOLVABLE"
				) {
					const action = restoreEpistemicState(this.sessionManager.getBranch()).action;
					if (action) {
						this._appendActionTransition(
							action,
							"unresolvable",
							persistedMessageEntryId,
							"The model returned UNRESOLVABLE for the frozen completion condition.",
						);
					}
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/** Diagnostics for the most recent model-facing context compilation. */
	get latestContextManifest(): ContextSelectionManifest | undefined {
		return this._latestContextManifest;
	}

	/** Return a concise derived view; raw entries and the full manifest remain the sources of truth. */
	getEpistemicDiagnostics(): EpistemicDiagnostics {
		const branch = this.sessionManager.getBranch();
		const state = this._anchorEnabled ? restoreEpistemicState(branch) : {};
		const manifest = this._latestContextManifest;
		const contextCounts = manifest ? summarizeContextSelection(manifest) : undefined;
		const toolCalls = new Map<string, { name: string; arguments: unknown }>();
		let lastAction:
			| {
					id: string;
					startEntryId: string;
					transition?: ActionTerminalTransition;
					transitionEntryId?: string;
					reason?: string;
			  }
			| undefined;
		for (const entry of branch) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				for (const part of entry.message.content) {
					if (part.type === "toolCall") {
						toolCalls.set(part.id, { name: part.name, arguments: part.arguments });
					}
				}
			} else if (entry.type === "action_start") {
				lastAction = { id: entry.actionId, startEntryId: entry.id };
			} else if (entry.type === "action_transition" && lastAction?.startEntryId === entry.startEntryId) {
				lastAction = {
					...lastAction,
					transition: entry.transition,
					transitionEntryId: entry.id,
					reason: entry.reason,
				};
			}
		}
		const frameLeaseBudget =
			this._leaseBudgetForFrame(state.frame) ?? (!state.frame ? this._frameLeaseBudget : undefined);
		const activeActionBudget = this._leaseBudgetForAction(state);
		const consumedEvidenceRounds = state.action ? this._consumedEvidenceRounds(state.action.startEntryId) : undefined;
		const unusedEvidenceRounds = frameLeaseBudget?.actions.reduce(
			(sum, candidate) =>
				sum +
				(candidate.actionStartEntryId
					? Math.max(
							0,
							candidate.expectedEvidenceRounds - this._consumedEvidenceRounds(candidate.actionStartEntryId),
						)
					: candidate.expectedEvidenceRounds),
			0,
		);
		const observationProvenance = (observation: Observation): ObservationProvenanceDiagnostic[] =>
			observation.sourceEventIds.flatMap((sourceEventId): ObservationProvenanceDiagnostic[] => {
				const source = branch.find((entry) => entry.id === sourceEventId);
				if (source?.type !== "message") return [];
				if (source.message.role === "toolResult") {
					const call = toolCalls.get(source.message.toolCallId);
					return [
						{
							rawEventId: source.id,
							toolCallId: source.message.toolCallId,
							toolName: source.message.toolName || call?.name || "unknown",
							arguments: call?.arguments,
							isError: source.message.isError,
							output: contentText(source.message.content, ""),
						},
					];
				}
				if (source.message.role === "bashExecution") {
					return [
						{
							rawEventId: source.id,
							toolName: "bash",
							command: source.message.command,
							exitCode: source.message.exitCode,
							cancelled: source.message.cancelled,
							isError: source.message.cancelled || source.message.exitCode !== 0,
							output: source.message.output,
						},
					];
				}
				return [];
			});
		return {
			enabled: {
				anchor: this._anchorEnabled,
				frame: this._frameEnabled,
				action: this._actionEnabled,
				observation: this._observationEnabled,
			},
			state: {
				anchor: state.anchor
					? {
							id: state.anchor.id,
							revision: state.anchor.revision,
							statement: state.anchor.statement,
							revisionEntryId: state.anchor.revisionEntryId,
						}
					: undefined,
				frame: state.frame
					? {
							id: state.frame.id,
							version: state.frame.version,
							statement: state.frame.statement,
							falsifier: state.frame.falsifier,
							revisionEntryId: state.frame.revisionEntryId,
							horizon: state.frame.horizon,
							completedModelResponses: state.frame.completedModelResponses,
						}
					: undefined,
				action: state.action
					? {
							id: state.action.id,
							intent: state.action.intent,
							completionCondition: state.action.completionCondition,
							startEntryId: state.action.startEntryId,
							completedModelResponses: state.action.completedModelResponses,
						}
					: undefined,
				lastAction,
				observations: (state.observations ?? []).map((observation) => ({
					id: observation.id,
					statement: observation.statement,
					entryId: observation.entryId,
					sourceEventIds: observation.sourceEventIds,
					provenance: observationProvenance(observation),
				})),
			},
			provenance: {
				rawEventCount: this.sessionManager.getEntries().length,
				activeBranchEventCount: branch.length,
				legacySummaryCount: this.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "compaction" || entry.type === "branch_summary").length,
			},
			runtime:
				this.agent.loopRunner instanceof PieProductionLoop
					? {
							loopState: this.agent.loopRunner.state,
							inputReady: this.isIdle,
							recovery: this._latestOperationalError,
						}
					: undefined,
			context:
				manifest && contextCounts
					? {
							compilerVersion: manifest.compilerVersion,
							...contextCounts,
							availableInputTokens: manifest.budget.availableInputTokens,
							outputMessageTokens: manifest.budget.outputMessageTokens,
						}
					: undefined,
			leaseBudget: frameLeaseBudget
				? {
						derivation: "available",
						frameRevisionEntryId: frameLeaseBudget.frameRevisionEntryId,
						provisionalActionCount: frameLeaseBudget.calculation.provisionalActionCount,
						expectedEvidenceRounds: frameLeaseBudget.calculation.expectedEvidenceRounds,
						consumedEvidenceRounds,
						activeExpectedEvidenceRounds: activeActionBudget?.expectedEvidenceRounds,
						activeBudgetReason: activeActionBudget?.budgetReason,
						unusedEvidenceRounds,
						costs: frameLeaseBudget.calculation.costs,
					}
				: state.frame
					? {
							derivation: "unavailable",
							frameRevisionEntryId: state.frame.revisionEntryId,
						}
					: undefined,
		};
	}

	/** Current durable Anchor on the active branch. */
	get anchor(): Anchor | undefined {
		return this._anchorEnabled ? restoreEpistemicState(this.sessionManager.getBranch()).anchor : undefined;
	}

	/** Explicitly revise task-success semantics without overwriting prior revisions. */
	reviseAnchor(statement: string, options?: { sourceEventId?: string; revisionReason?: string }): Anchor {
		if (!this._anchorEnabled) {
			throw new Error("Anchor is disabled for this session.");
		}
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before revising the Anchor.");
		}
		const branch = this.sessionManager.getBranch();
		const state = restoreEpistemicState(branch);
		if (state.action) {
			throw new Error("Complete, escalate, or mark the current Action UNRESOLVABLE before revising the Anchor.");
		}
		const current = state.anchor;
		if (!current) {
			throw new Error("Anchor has not been initialized by a user request.");
		}
		const sourceEventId =
			options?.sourceEventId ??
			branch
				.slice()
				.reverse()
				.find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
		if (!sourceEventId) {
			throw new Error("Anchor revision requires a source event on the active branch.");
		}
		this._emitAppendedEntry(
			this.sessionManager.appendAnchorRevision({
				anchorId: current.id,
				revision: current.revision + 1,
				statement,
				previousRevisionId: current.revisionEntryId,
				sourceEventId,
				revisionReason: options?.revisionReason,
			}),
		);
		return restoreEpistemicState(this.sessionManager.getBranch()).anchor!;
	}

	/** Current admissible Frame on the active branch. */
	get frame(): Frame | undefined {
		return this._frameEnabled ? restoreEpistemicState(this.sessionManager.getBranch()).frame : undefined;
	}

	private _validateFrameDefinition(definition: FrameDefinition): void {
		if (!definition.statement.trim()) throw new Error("Frame statement must not be empty.");
		if (!definition.falsifier.trim()) throw new Error("Frame falsifier must not be empty.");
		if (!Number.isSafeInteger(definition.horizon) || definition.horizon < 1) {
			throw new Error("Frame horizon must be a positive integer.");
		}
	}

	private _resolveEpistemicSourceEventId(sourceEventId: string | undefined): string {
		const branch = this.sessionManager.getBranch();
		const resolved =
			sourceEventId ??
			branch
				.slice()
				.reverse()
				.find((entry) => entry.type === "message")?.id;
		if (!resolved || !branch.some((entry) => entry.id === resolved)) {
			throw new Error("Epistemic state operation requires a source event on the active branch.");
		}
		return resolved;
	}

	private _assertFrameMutationAllowed(): void {
		if (!this._frameEnabled) throw new Error("Frame is disabled for this session.");
		if (this.isStreaming) throw new Error("Wait for the current response to finish before changing the Frame.");
		if (restoreEpistemicState(this.sessionManager.getBranch()).action) {
			throw new Error("Complete, escalate, or mark the current Action UNRESOLVABLE before changing the Frame.");
		}
	}

	/** Create the first version of a new Frame identity. */
	createFrame(definition: FrameDefinition, options?: { sourceEventId?: string }): Frame {
		this._assertFrameMutationAllowed();
		this._validateFrameDefinition(definition);
		const state = restoreEpistemicState(this.sessionManager.getBranch());
		if (!state.anchor) throw new Error("Create an Anchor before creating a Frame.");
		this._applyFrameDirective(
			{ type: "create", ...definition },
			this._resolveEpistemicSourceEventId(options?.sourceEventId),
			state.frame,
		);
		return restoreEpistemicState(this.sessionManager.getBranch()).frame!;
	}

	/** Create an explicit new version without mutating the previous Frame version. */
	reviseFrame(definition: FrameDefinition, options?: { sourceEventId?: string; revisionReason?: string }): Frame {
		this._assertFrameMutationAllowed();
		this._validateFrameDefinition(definition);
		const state = restoreEpistemicState(this.sessionManager.getBranch());
		this._applyFrameDirective(
			{ type: "revise", ...definition, revisionReason: options?.revisionReason },
			this._resolveEpistemicSourceEventId(options?.sourceEventId),
			state.frame,
		);
		return restoreEpistemicState(this.sessionManager.getBranch()).frame!;
	}

	/** Terminate the current identity as replaced, then create a distinct Frame identity. */
	replaceFrame(definition: FrameDefinition, options: { reason: string; sourceEventId?: string }): Frame {
		this._assertFrameMutationAllowed();
		this._validateFrameDefinition(definition);
		if (!options.reason.trim()) throw new Error("Frame replacement reason must not be empty.");
		const state = restoreEpistemicState(this.sessionManager.getBranch());
		this._applyFrameDirective(
			{ type: "replace", ...definition, reason: options.reason },
			this._resolveEpistemicSourceEventId(options.sourceEventId),
			state.frame,
		);
		return restoreEpistemicState(this.sessionManager.getBranch()).frame!;
	}

	/** Explicitly terminate the current Frame after falsification or deliberate death. */
	terminateFrame(transition: "falsified" | "died", options: { reason: string; sourceEventId?: string }): void {
		this._assertFrameMutationAllowed();
		if (!options.reason.trim()) throw new Error("Frame transition reason must not be empty.");
		const state = restoreEpistemicState(this.sessionManager.getBranch());
		this._applyFrameDirective(
			{ type: transition === "falsified" ? "falsify" : "die", reason: options.reason },
			this._resolveEpistemicSourceEventId(options.sourceEventId),
			state.frame,
		);
	}

	/** Durable Observations on the active branch. */
	get observations(): readonly Observation[] {
		return this._observationEnabled
			? (restoreEpistemicState(this.sessionManager.getBranch()).observations ?? [])
			: [];
	}

	/** Materialize an execution result only when it changes Anchor satisfaction or Frame admissibility. */
	materializeObservation(definition: ObservationDefinition): Observation {
		if (!this._observationEnabled) throw new Error("Observations are disabled for this session.");
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before materializing an Observation.");
		}
		this._appendObservation(definition, restoreEpistemicState(this.sessionManager.getBranch()));
		return this.observations.at(-1)!;
	}

	/** Current active Action episode on the active branch. */
	get action(): Action | undefined {
		return this._actionEnabled ? restoreEpistemicState(this.sessionManager.getBranch()).action : undefined;
	}

	private _validateActionDefinition(definition: ActionDefinition): void {
		if (!definition.intent.trim()) throw new Error("Action intent must not be empty.");
		if (!definition.completionCondition.trim()) throw new Error("Action completion condition must not be empty.");
	}

	private _assertActionMutationAllowed(): void {
		if (!this._actionEnabled) throw new Error("Action episodes are disabled for this session.");
		if (this.isStreaming) throw new Error("Wait for the current response to finish before changing the Action.");
	}

	/** Start one finite episode with a contract that cannot be revised in place. */
	startAction(definition: ActionDefinition, options?: { sourceEventId?: string }): Action {
		this._assertActionMutationAllowed();
		this._validateActionDefinition(definition);
		const state = restoreEpistemicState(this.sessionManager.getBranch());
		this._applyActionDirective(
			{ type: "start", ...definition },
			this._resolveEpistemicSourceEventId(options?.sourceEventId),
			state,
		);
		return restoreEpistemicState(this.sessionManager.getBranch()).action!;
	}

	/** Finish the current episode after its frozen completion condition has been met. */
	completeAction(reason: string, options?: { sourceEventId?: string }): void {
		this._terminateAction("completed", reason, options?.sourceEventId);
	}

	/** Return bounded control to the epistemic loop when the frozen condition cannot be met. */
	markActionUnresolvable(reason: string, options?: { sourceEventId?: string }): void {
		this._terminateAction("unresolvable", reason, options?.sourceEventId);
	}

	/** Escalate a world result that challenges the containing Frame or Anchor. */
	escalateAction(challenge: "anchor" | "frame", reason: string, options?: { sourceEventId?: string }): void {
		this._terminateAction("escalated", reason, options?.sourceEventId, challenge);
	}

	private _terminateAction(
		transition: ActionTerminalTransition,
		reason: string,
		sourceEventId?: string,
		challenge?: "anchor" | "frame",
	): void {
		this._assertActionMutationAllowed();
		if (!reason.trim()) throw new Error("Action transition reason must not be empty.");
		const state = restoreEpistemicState(this.sessionManager.getBranch());
		if (!state.action) throw new Error("No Action episode is active.");
		this._appendActionTransition(
			state.action,
			transition,
			this._resolveEpistemicSourceEventId(sourceEventId),
			reason,
			challenge,
		);
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._activeRequestModel = undefined;
			this._activeProductionRequestRole = undefined;
			if (this._automaticActionRequest) {
				const branch = this.sessionManager.getBranch();
				const action = restoreEpistemicState(branch).action;
				const sourceEventId = branch.at(-1)?.id;
				if (action && sourceEventId && sourceEventId !== action.startEntryId) {
					this._appendActionTransition(
						action,
						"unresolvable",
						sourceEventId,
						"The production request settled after bounded recovery without meeting its completion condition.",
					);
				}
				this._automaticActionRequest = false;
			}
			this._pendingAnchorRevision = undefined;
			this._pendingFrameDirective = undefined;
			this._pendingActionDirective = undefined;
			this._pendingObservation = undefined;
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}
			const currentEpistemicState = restoreEpistemicState(this.sessionManager.getBranch());
			const terminatesCurrentAction = options?.action && options.action.type !== "start";
			if (currentEpistemicState.action && (options?.anchor || options?.frame) && !terminatesCurrentAction) {
				throw new Error(
					"Complete, escalate, or mark the current Action UNRESOLVABLE before changing its Anchor or Frame.",
				);
			}
			if (options?.anchor && !this._anchorEnabled) {
				throw new Error("Anchor is disabled for this session.");
			}
			if (options?.anchor && !options.anchor.statement.trim()) {
				throw new Error("Anchor statement must not be empty.");
			}
			if (options?.frame) {
				if (!this._frameEnabled) throw new Error("Frame is disabled for this session.");
				if (options.frame.type === "create") {
					this._validateFrameDefinition(options.frame);
					if (currentEpistemicState.frame) {
						throw new Error("A Frame is already active; revise or replace it explicitly.");
					}
					if (!currentEpistemicState.anchor && !options.anchor) {
						throw new Error("Create an Anchor before creating a Frame.");
					}
				} else {
					if (!currentEpistemicState.frame) {
						throw new Error(`Cannot ${options.frame.type} a Frame because no Frame is active.`);
					}
					if (options.frame.type === "revise" || options.frame.type === "replace") {
						this._validateFrameDefinition(options.frame);
					}
				}
				if ("reason" in options.frame && !options.frame.reason.trim()) {
					throw new Error("Frame transition reason must not be empty.");
				}
			}
			if (options?.observation) {
				if (!this._observationEnabled) throw new Error("Observations are disabled for this session.");
				this._validateObservationDefinition(options.observation, currentEpistemicState);
			}
			if (options?.action) {
				if (!this._actionEnabled) throw new Error("Action episodes are disabled for this session.");
				if (options.action.type === "start") {
					this._validateActionDefinition(options.action);
					if (currentEpistemicState.action) throw new Error("An Action episode is already active.");
					const frameWillRemain =
						options.frame?.type === "create" ||
						options.frame?.type === "revise" ||
						options.frame?.type === "replace" ||
						(!options.frame &&
							currentEpistemicState.frame !== undefined &&
							currentEpistemicState.frame.completedModelResponses < currentEpistemicState.frame.horizon);
					if (!frameWillRemain) throw new Error("Create or revise an admissible Frame before starting an Action.");
				} else {
					if (!currentEpistemicState.action) {
						throw new Error(`Cannot ${options.action.type} because no Action episode is active.`);
					}
					if (!options.action.reason.trim()) throw new Error("Action transition reason must not be empty.");
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (options?.anchor || options?.frame || options?.action || options?.observation) {
					throw new Error(
						"Epistemic state changes require an idle session so provenance can identify the new request.",
					);
				}
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		if (options?.anchor) {
			this._pendingAnchorRevision = options.anchor;
		}
		if (options?.frame) {
			this._pendingFrameDirective = options.frame;
		}
		if (options?.action) {
			this._pendingActionDirective = options.action;
		}
		if (options?.observation) {
			this._pendingObservation = options.observation;
		}
		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Adjust the compiler projection after provider usage or overflow feedback.
	 * Called after agent_end and before prompt submission.
	 *
	 * Overflow recovery retries once with a stricter projection. Threshold pressure
	 * constrains future projections. Neither path generates or persists a summary.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Ignore feedback older than the latest legacy compaction boundary. Its usage
		// describes a superseded provider request and must not resize the current projection.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Explicit overflow or a context-clamped length stop gets one projection retry.
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (sameModel && (isContextOverflow(assistantMessage, contextWindow) || recoverableLength)) {
			const willRetry = assistantMessage.stopReason !== "stop";
			if (!willRetry) return false;

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one projection-retry attempt. Try reducing the current request or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			const previousBudget = this._latestContextManifest?.budget.availableInputTokens ?? contextWindow;
			this._contextInputTokenLimit = Math.max(1, Math.floor(previousBudget * 0.75));
			// Remove the failed or truncated message from runtime state. It remains in raw session history,
			// while the compiler excludes it from the bounded retry projection.
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return true;
		}

		// Threshold feedback constrains future compiler projections. For errors or all-zero
		// usage, estimate from the last valid response without rewriting the transcript.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			const reservedOutputTokens = Math.min(
				settings.reserveTokens,
				this.model?.maxTokens ?? settings.reserveTokens,
				Math.floor(contextWindow * 0.25),
			);
			this._contextInputTokenLimit = Math.max(1, contextWindow - reservedOutputTokens);
		}
		return false;
	}

	/**
	 * Legacy auto-compaction implementation retained for comparative tests.
	 * Pie's model-request path does not call this method.
	 */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained as comparative Phase 0 evidence
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;

		try {
			if (!this.model) {
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// The overflow response was persisted on message_end before _checkCompaction() removed it
				// from agent state. Rebuilding state from the new compaction can restore that kept entry,
				// leaving an assistant as the final message. agent.continue() rejects that state, so remove
				// the retriable error or truncated-length response again before continuing the interrupted turn.
				if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")) {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: {
					...createAllToolDefinitions(this._cwd, {
						read: { autoResizeImages },
						bash: { commandPrefix: shellCommandPrefix, shellPath },
					}),
					...(this._frameEnabled
						? {
								view_frame_action_graph: createFrameActionGraphToolDefinition({
									getEntries: () => this.sessionManager.getBranch(),
								}),
							}
						: {}),
				};

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write", ...(this._frameEnabled ? ["view_frame_action_graph"] : [])];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
