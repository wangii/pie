/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	isStdoutBroken,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcDomainSnapshot,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

// ============================================================================
// Command handlers
// ============================================================================

/**
 * The live environment a command handler runs against.
 *
 * `session` is a getter rather than a value: `runRpcMode` rebinds its `session` binding
 * whenever a command creates, swaps or forks a session, and every command after that must
 * read the new one. A snapshot taken when the context was built would keep answering from
 * the session that was replaced.
 */
interface RpcCommandContext {
	/** The session currently bound to the runtime. */
	readonly session: AgentSessionRuntime["session"];
	readonly runtimeHost: AgentSessionRuntime;
	/** Re-bind after the runtime replaced the session; see `runRpcMode`. */
	readonly rebindSession: () => Promise<void>;
	/** Write one JSON line to stdout. */
	readonly output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void;
	readonly success: <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	) => RpcResponse;
	readonly error: (id: string | undefined, command: string, message: string) => RpcResponse;
}

/**
 * One handler per `RpcCommand` variant, with `command` narrowed to that variant.
 *
 * A handler that answers synchronously is deliberately *not* `async`: `handleCommand` returns
 * what it produced without an extra `await`, so such a command replies on the same microtask
 * turn as the `switch` arm it replaces did.
 */
type RpcCommandHandlers = {
	[K in RpcCommand["type"]]: (
		command: Extract<RpcCommand, { type: K }>,
		ctx: RpcCommandContext,
	) => RpcResponse | undefined | Promise<RpcResponse | undefined>;
};

/** Dispatch-side view of the table: `command.type` arrives off the wire as an arbitrary string. */
type AnyRpcCommandHandler = (
	command: RpcCommand,
	ctx: RpcCommandContext,
) => RpcResponse | undefined | Promise<RpcResponse | undefined>;

type DomainCommand = Extract<
	RpcCommand,
	{ type: "approve_frame" | "frame_correct" | "set_auto_approve_frame" | "get_state" | "get_domain_snapshot" }
>;

/**
 * The Frame/domain surface: reading the current formulation and the user's explicit acts on it.
 *
 * These five are synchronous reads of `session` state plus three user acts; none rebinds the session
 * or responds asynchronously, unlike the prompt preflight and the session-replacing commands. They
 * are handled here as one readable unit instead of interleaving with those entries in the table.
 */
const handleDomainCommand = (command: DomainCommand, ctx: RpcCommandContext): RpcResponse => {
	const id = command.id;

	switch (command.type) {
		case "approve_frame": {
			// The user's own act on the reading on the table. A refusal is returned as an error rather
			// than an approval: reporting "nothing was waiting" as consent is exactly the failure this
			// command exists to remove.
			const result = ctx.session.approveFormulation(command.versionId);
			if (result.outcome === "rejected") return ctx.error(id, "approve_frame", result.reason);
			return ctx.success(id, "approve_frame", {
				outcome: result.outcome,
				versionId: result.approval.versionId,
				// The turn was launched before this response was produced; whether it settles is reported
				// later by `get_state`'s formulation resume and the `formulation_resume_failed` event.
				continuation: result.continuation,
			});
		}

		case "frame_correct": {
			const correction = ctx.session.submitFormulationCorrection(command.message);
			if (!correction) {
				return ctx.error(id, "frame_correct", "no active task, or the correction was blank");
			}
			return ctx.success(id, "frame_correct", { correctionId: correction.id });
		}

		case "set_auto_approve_frame": {
			// Turning this on approves a reading that is already waiting (see `setAutoApproveFrame`),
			// so this command can have the same effect as `approve_frame` and stands under the same
			// rule: a refusal is an error, never a silent success. There is no refusal to report here
			// — a refused automatic approval leaves the reading waiting, and the client sees that in
			// the `get_state` that follows, which is why this returns no outcome of its own.
			ctx.session.setAutoApproveFrame(command.enabled);
			return ctx.success(id, "set_auto_approve_frame");
		}

		case "get_state": {
			const state: RpcSessionState = {
				model: ctx.session.model,
				thinkingLevel: ctx.session.thinkingLevel,
				isStreaming: ctx.session.isStreaming,
				isCompacting: ctx.session.isCompacting,
				steeringMode: ctx.session.steeringMode,
				followUpMode: ctx.session.followUpMode,
				sessionFile: ctx.session.sessionFile,
				sessionId: ctx.session.sessionId,
				sessionName: ctx.session.sessionName,
				autoCompactionEnabled: ctx.session.autoCompactionEnabled,
				autoApproveFrame: ctx.session.autoApproveFrame,
				messageCount: ctx.session.messages.length,
				pendingMessageCount: ctx.session.pendingMessageCount,
				formulation: ctx.session.getFormulationState() ?? null,
			};
			return ctx.success(id, "get_state", state);
		}

		case "get_domain_snapshot": {
			// Read straight off the runtime's replayed snapshot: a reconnecting client gets the
			// state the live events are already being applied to, not a parallel reconstruction.
			const snapshot = ctx.session.domainSnapshot;
			return ctx.success(id, "get_domain_snapshot", {
				sessionId: snapshot.id,
				activeBranchTasks: [...snapshot.activeBranchTasks],
				tasks: [...snapshot.tasks.values()],
				beliefs: [...snapshot.beliefs.values()],
				activeBeliefs: [...snapshot.activeBeliefs],
				cursor: snapshot.cursor,
			});
		}
	}
};

/**
 * Every command the RPC protocol accepts, keyed by `RpcCommand["type"]`.
 *
 * Each entry keeps the body of the `case` it replaced, reading the session and the response
 * helpers off `ctx` so that the whole table can live at module scope.
 */
const commandHandlers: RpcCommandHandlers = {
	// =================================================================
	// Prompting
	// =================================================================

	prompt: (command, ctx) => {
		const id = command.id;
		// Start prompt handling immediately, but emit the authoritative response only after
		// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
		let preflightSucceeded = false;
		void ctx.session
			.prompt(command.message, {
				images: command.images,
				streamingBehavior: command.streamingBehavior,
				source: "rpc",
				preflightResult: (disposition) => {
					preflightSucceeded = true;
					ctx.output(ctx.success(id, "prompt", { disposition }));
				},
			})
			.catch((e) => {
				if (!preflightSucceeded) {
					ctx.output(ctx.error(id, "prompt", e.message));
				}
			});
		return undefined;
	},

	steer: async (command, ctx) => {
		const id = command.id;
		const disposition = await ctx.session.steer(command.message, command.images);
		return ctx.success(id, "steer", { disposition });
	},

	follow_up: async (command, ctx) => {
		const id = command.id;
		const disposition = await ctx.session.followUp(command.message, command.images);
		return ctx.success(id, "follow_up", { disposition });
	},

	abort: async (command, ctx) => {
		const id = command.id;
		await ctx.session.abort();
		return ctx.success(id, "abort");
	},

	clear_queue: (command, ctx) => {
		const id = command.id;
		return ctx.success(id, "clear_queue", ctx.session.clearQueue());
	},

	new_session: async (command, ctx) => {
		const id = command.id;
		const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
		const result = await ctx.runtimeHost.newSession(options);
		if (!result.cancelled) {
			await ctx.rebindSession();
		}
		return ctx.success(id, "new_session", result);
	},

	// =================================================================
	// Frame / domain state
	// =================================================================

	// These five share one handler (see `handleDomainCommand`): reads of the current formulation
	// and the user's explicit acts on it. None of them rebinds the session or defers its response,
	// so they do not belong with the preflight and rebinding cases above.
	approve_frame: (command, ctx) => handleDomainCommand(command, ctx),
	frame_correct: (command, ctx) => handleDomainCommand(command, ctx),
	set_auto_approve_frame: (command, ctx) => handleDomainCommand(command, ctx),
	get_state: (command, ctx) => handleDomainCommand(command, ctx),
	get_domain_snapshot: (command, ctx) => handleDomainCommand(command, ctx),

	// =================================================================
	// Model
	// =================================================================

	set_model: (command, ctx) => {
		const id = command.id;
		const models = ctx.session.modelRuntime.getAvailableSnapshot();
		const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
		if (!model) {
			return ctx.error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
		}
		// Held out of an `async` body so the "model not found" answer above stays synchronous;
		// only the success path is waiting on the session.
		return ctx.session.setModel(model).then(() => ctx.success(id, "set_model", model));
	},

	cycle_model: async (command, ctx) => {
		const id = command.id;
		const result = await ctx.session.cycleModel();
		if (!result) {
			return ctx.success(id, "cycle_model", null);
		}
		return ctx.success(id, "cycle_model", result);
	},

	get_available_models: (command, ctx) => {
		const id = command.id;
		const models = ctx.session.modelRuntime.getAvailableSnapshot();
		return ctx.success(id, "get_available_models", { models });
	},

	// =================================================================
	// Thinking
	// =================================================================

	set_thinking_level: (command, ctx) => {
		const id = command.id;
		ctx.session.setThinkingLevel(command.level);
		return ctx.success(id, "set_thinking_level");
	},

	cycle_thinking_level: (command, ctx) => {
		const id = command.id;
		const level = ctx.session.cycleThinkingLevel();
		if (!level) {
			return ctx.success(id, "cycle_thinking_level", null);
		}
		return ctx.success(id, "cycle_thinking_level", { level });
	},

	get_available_thinking_levels: (command, ctx) => {
		const id = command.id;
		const levels = ctx.session.getAvailableThinkingLevels();
		return ctx.success(id, "get_available_thinking_levels", { levels });
	},

	// =================================================================
	// Queue Modes
	// =================================================================

	set_steering_mode: (command, ctx) => {
		const id = command.id;
		ctx.session.setSteeringMode(command.mode);
		return ctx.success(id, "set_steering_mode");
	},

	set_follow_up_mode: (command, ctx) => {
		const id = command.id;
		ctx.session.setFollowUpMode(command.mode);
		return ctx.success(id, "set_follow_up_mode");
	},

	// =================================================================
	// Compaction
	// =================================================================

	compact: async (command, ctx) => {
		const id = command.id;
		const result = await ctx.session.compact(command.customInstructions);
		return ctx.success(id, "compact", result);
	},

	set_auto_compaction: (command, ctx) => {
		const id = command.id;
		ctx.session.setAutoCompactionEnabled(command.enabled);
		return ctx.success(id, "set_auto_compaction");
	},

	// =================================================================
	// Retry
	// =================================================================

	set_auto_retry: (command, ctx) => {
		const id = command.id;
		ctx.session.setAutoRetryEnabled(command.enabled);
		return ctx.success(id, "set_auto_retry");
	},

	abort_retry: (command, ctx) => {
		const id = command.id;
		ctx.session.abortRetry();
		return ctx.success(id, "abort_retry");
	},

	// =================================================================
	// Bash
	// =================================================================

	bash: async (command, ctx) => {
		const id = command.id;
		const eventResult = await ctx.session.extensionRunner.emitUserBash({
			type: "user_bash",
			command: command.command,
			excludeFromContext: command.excludeFromContext ?? false,
			cwd: ctx.session.sessionManager.getCwd(),
		});

		if (eventResult?.result) {
			ctx.session.recordBashResult(command.command, eventResult.result, {
				excludeFromContext: command.excludeFromContext,
			});
			return ctx.success(id, "bash", eventResult.result);
		}

		const result = await ctx.session.executeBash(command.command, undefined, {
			excludeFromContext: command.excludeFromContext,
			id,
			operations: eventResult?.operations,
		});
		return ctx.success(id, "bash", result);
	},

	abort_bash: (command, ctx) => {
		const id = command.id;
		ctx.session.abortBash();
		return ctx.success(id, "abort_bash");
	},

	// =================================================================
	// Session
	// =================================================================

	get_session_stats: (command, ctx) => {
		const id = command.id;
		const stats = ctx.session.getSessionStats();
		return ctx.success(id, "get_session_stats", stats);
	},

	export_html: async (command, ctx) => {
		const id = command.id;
		const path = await ctx.session.exportToHtml(command.outputPath);
		return ctx.success(id, "export_html", { path });
	},

	switch_session: async (command, ctx) => {
		const id = command.id;
		const result = await ctx.runtimeHost.switchSession(command.sessionPath);
		if (!result.cancelled) {
			await ctx.rebindSession();
		}
		return ctx.success(id, "switch_session", result);
	},

	fork: async (command, ctx) => {
		const id = command.id;
		const result = await ctx.runtimeHost.fork(command.entryId);
		if (!result.cancelled) {
			await ctx.rebindSession();
		}
		return ctx.success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
	},

	// Not `async`: the no-leaf refusal is answered on this turn, as the old synchronous `switch`
	// arm did. Declaring the handler `async` would push that one error a microtask later.
	clone: (command, ctx) => {
		const id = command.id;
		const leafId = ctx.session.sessionManager.getLeafId();
		if (!leafId) {
			return ctx.error(id, "clone", "Cannot clone session: no current entry selected");
		}
		return ctx.runtimeHost.fork(leafId, { position: "at" }).then(async (result) => {
			if (!result.cancelled) {
				await ctx.rebindSession();
			}
			return ctx.success(id, "clone", { cancelled: result.cancelled });
		});
	},

	get_fork_messages: (command, ctx) => {
		const id = command.id;
		const messages = ctx.session.getUserMessagesForForking();
		return ctx.success(id, "get_fork_messages", { messages });
	},

	get_entries: (command, ctx) => {
		const id = command.id;
		const sessionManager = ctx.session.sessionManager;
		let entries = sessionManager.getEntries();
		if (command.since !== undefined) {
			const sinceIndex = entries.findIndex((e) => e.id === command.since);
			if (sinceIndex === -1) {
				return ctx.error(id, "get_entries", `Entry not found: ${command.since}`);
			}
			entries = entries.slice(sinceIndex + 1);
		}
		return ctx.success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
	},

	get_tree: (command, ctx) => {
		const id = command.id;
		const sessionManager = ctx.session.sessionManager;
		return ctx.success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
	},

	get_last_assistant_text: (command, ctx) => {
		const id = command.id;
		const text = ctx.session.getLastAssistantText();
		return ctx.success(id, "get_last_assistant_text", { text });
	},

	set_session_name: (command, ctx) => {
		const id = command.id;
		const name = command.name.trim();
		if (!name) {
			return ctx.error(id, "set_session_name", "Session name cannot be empty");
		}
		ctx.session.setSessionName(name);
		return ctx.success(id, "set_session_name");
	},

	// =================================================================
	// Messages
	// =================================================================

	get_messages: (command, ctx) => {
		const id = command.id;
		return ctx.success(id, "get_messages", { messages: ctx.session.messages });
	},

	// =================================================================
	// Commands (available for invocation via prompt)
	// =================================================================

	get_commands: (command, ctx) => {
		const id = command.id;
		const commands: RpcSlashCommand[] = [];

		for (const command of ctx.session.extensionRunner.getRegisteredCommands()) {
			commands.push({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			});
		}

		for (const template of ctx.session.promptTemplates) {
			commands.push({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			});
		}

		for (const skill of ctx.session.resourceLoader.getSkills().skills) {
			commands.push({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			});
		}

		return ctx.success(id, "get_commands", { commands });
	},
};

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Dialog surface: the three requests that wait for an answer from the host.
	 */
	const createDialogUIContext = (): Pick<ExtensionUIContext, "select" | "confirm" | "input"> => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),
	});

	/**
	 * Editor surface: text control, plus the composition hooks (autocomplete, custom editor
	 * component) that need TUI access and are therefore inert in RPC mode.
	 */
	const createEditorUIContext = (): Pick<
		ExtensionUIContext,
		| "setEditorText"
		| "getEditorText"
		| "pasteToEditor"
		| "editor"
		| "addAutocompleteProvider"
		| "setEditorComponent"
		| "getEditorComponent"
	> => ({
		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},
	});

	/**
	 * Fire-and-forget request surface: the host may render status text, widget lines and the
	 * terminal title, but nothing here waits for a response.
	 */
	const createStatusUIContext = (): Pick<ExtensionUIContext, "notify" | "setStatus" | "setWidget" | "setTitle"> => ({
		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},
	});

	/**
	 * Theme surface: extensions can read the current theme to style their own output, but
	 * RPC mode has no theme switching. The `theme` property itself stays on the composed
	 * context (see `createExtensionUIContext`) so it remains a getter.
	 */
	const createThemeUIContext = (): Pick<ExtensionUIContext, "getAllThemes" | "getTheme" | "setTheme"> => ({
		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},
	});

	/**
	 * The interactive-only surface. RPC mode has no TUI, so every member here is inert (or
	 * answers "nothing configured") instead of reaching the host.
	 */
	const createUnsupportedUIContext = (): Pick<
		ExtensionUIContext,
		| "onTerminalInput"
		| "setWorkingMessage"
		| "setWorkingVisible"
		| "setWorkingIndicator"
		| "setHiddenThinkingLabel"
		| "setFooter"
		| "setHeader"
		| "custom"
		| "getToolsExpanded"
		| "setToolsExpanded"
	> => ({
		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 *
	 * Compose the domain fragments above; `theme` is declared here rather than in
	 * `createThemeUIContext` because spreading a fragment copies values, which would turn
	 * the getter into a one-time snapshot.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		...createDialogUIContext(),
		...createEditorUIContext(),
		...createStatusUIContext(),
		...createThemeUIContext(),
		...createUnsupportedUIContext(),

		get theme() {
			return theme;
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			output(toJsonEvent(event));

			// Push footer telemetry (per-belief-loop-role model + cache hit rate,
			// per-role context usage, and session cost) to the native GUI.
			// getRoleStatus() resolves the model per the documented fallback chain and
			// latestCacheHitRate from the in-memory per-role snapshot;
			// getRoleContextUsage() is the per-role “current context length” (epistemic
			// vs execution projections); getSessionStats().cost is the accumulated
			// session cost. Emitted after every event so the footer/status stays current.
			const roleStatus = session.getRoleStatus();
			if (roleStatus) {
				const stats = session.getSessionStats();
				output({
					type: "session_status",
					roleStatus,
					roleUsage: session.getRoleContextUsage(),
					cost: stats.cost,
					tokens: {
						input: stats.tokens.input,
						output: stats.tokens.output,
						cacheRead: stats.tokens.cacheRead,
						cacheWrite: stats.tokens.cacheWrite,
					},
				});
			}

			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handlers live at module scope; this object is what attaches them to this loop's live
	// state. `session` must stay a getter — see `RpcCommandContext`.
	const ctx: RpcCommandContext = {
		get session() {
			return session;
		},
		runtimeHost,
		rebindSession: () => rebindSession(),
		output,
		success,
		error,
	};

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		// The table is keyed per variant, but `command` came off the wire and was never validated:
		// an unknown `type` has to answer the way the old `switch` default did. `hasOwn` keeps
		// names such as "toString" from resolving to an inherited member of the table object.
		const handler = Object.hasOwn(commandHandlers, command.type)
			? (commandHandlers as Partial<Record<string, AnyRpcCommandHandler>>)[command.type]
			: undefined;
		if (!handler) {
			const unknownCommand = command as { type: string };
			return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
		}

		// No `await`: a synchronous handler answers on this turn, an asynchronous one is adopted.
		return handler(command, ctx);
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
			// The consumer closed the pipe (e.g. `pi | head`): output was truncated, so
			// report it as a controlled failure rather than a silent success.
			if (isStdoutBroken()) {
				exitCode = 1;
			}
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
