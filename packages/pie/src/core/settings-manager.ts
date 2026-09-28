import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Transport } from "@earendil-works/pi-ai";
import type { TuiMode as RendererTuiMode, ScrollViewScrollbar, TerminalCapabilities } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { join } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import {
	FileSettingsStorage,
	InMemorySettingsStorage,
	type SettingsScope,
	type SettingsStorage,
} from "./settings-storage.ts";

export type { SettingsScope, SettingsStorage } from "./settings-storage.ts";
// Re-exported so existing importers (tests, src consumers) keep their import paths.
export { FileSettingsStorage, InMemorySettingsStorage } from "./settings-storage.ts";

export interface CompactionModelOverride {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

const DEFAULT_COMPACTION_TOKEN_SETTINGS: Required<CompactionModelOverride> = {
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	modelOverrides?: Record<string, CompactionModelOverride>; // exact "provider/modelId" keys
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
}

export type TuiMode = RendererTuiMode;
export type FullscreenExitOutput = "transcript" | "resume-hint";

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	hyperlinks?: boolean | "auto";
	images?: "kitty" | "iterm2" | "auto" | false;
	trueColor?: boolean | "auto";
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type MermaidRenderingMode = "off" | "final" | "streaming";

/** Cache-warming profile. "idle" also warms between agent runs. */
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;
export type CacheWarmingMode = (typeof CACHE_WARMING_MODES)[number];

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: MermaidRenderingMode; // default: "streaming"
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

/** Settings scoped to the belief-loop ("pie") subsystem. */
export interface PieSettings {
	/** Default model for pie sessions and the initial propose role. */
	defaultModel?: string;
	/** Default thinking level for pie sessions and roles without a specific override. */
	defaultThinkingLevel?: ThinkingLevel;
	/** Thinking level for the execution role. */
	executionThinkingLevel?: ThinkingLevel;
	/** Thinking level for fast-path execution. */
	fastPathThinkingLevel?: ThinkingLevel;
	/** Model for the belief loop's propose role. Defaults to `defaultModel`. */
	proposeModel?: string;
	/** Thinking level for the belief loop's propose role. Defaults to `defaultThinkingLevel`. */
	proposeThinkingLevel?: ThinkingLevel;
	/** Model for the belief loop's finalReport role. Defaults to `defaultModel`. */
	reportModel?: string;
	/** Thinking level for the belief loop's finalReport role. Defaults to `defaultThinkingLevel`. */
	reportThinkingLevel?: ThinkingLevel;
	/** Model for the belief loop's execution (probe) role; overrides the session model for that role only. */
	executionModel?: string;
	/**
	 * Model for adjudicating execution evidence and refining the belief state. Defaults to
	 * `defaultModel` so synthesis stays on the strong model when execution uses a cheaper one. */
	distillationModel?: string;
	/** Thinking level for the belief loop's distillation role. Defaults to "low". */
	distillationThinkingLevel?: ThinkingLevel;
	/** The language belief-set prompts must write in. Defaults to "English". */
	beliefLang?: string;
	/**
	 * Model for fast-path execution: a request routed to the fast path runs its execution on this
	 * model instead of `executionModel`/the session model. Unset means "use the session model". */
	fastPathModel?: string;
}

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	/** Settings for the belief-loop ("pie") subsystem. */
	pie?: PieSettings;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>; // per-model default thinking level overrides keyed by "provider/modelId"
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	showCacheMissNotices?: boolean; // default: false - show prompt-cache miss and compaction cost notices
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows); supports leading ~ expansion
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	defaultTools?: string[]; // Initial built-in tool selection
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	outputPad?: 0 | 1; // Horizontal padding for chat message output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	cacheWarming?: CacheWarmingMode; // default: "streaming"; global only because each refresh costs money
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	tuiMode?: TuiMode; // default: "regular"
	fullscreenExitOutput?: FullscreenExitOutput; // default: "transcript"; no effect in regular TUI mode
	fullscreenScrollbar?: ScrollViewScrollbar; // default: "auto"; no effect in regular TUI mode
	fullscreenCopyOnSelect?: boolean; // default: true; no effect in regular TUI mode
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;
type PieSettingsPaths = Partial<Record<SettingsScope, string>>;

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

/** Migrate old settings format to new format */
function migrateSettings(settings: Record<string, unknown>): Settings {
	// Migrate queueMode -> steeringMode
	if ("queueMode" in settings && !("steeringMode" in settings)) {
		settings.steeringMode = settings.queueMode;
		delete settings.queueMode;
	}

	// Migrate legacy websockets boolean -> transport enum
	if (!("transport" in settings) && typeof settings.websockets === "boolean") {
		settings.transport = settings.websockets ? "websocket" : "sse";
		delete settings.websockets;
	}

	// Migrate old skills object format to new array format
	if (
		"skills" in settings &&
		typeof settings.skills === "object" &&
		settings.skills !== null &&
		!Array.isArray(settings.skills)
	) {
		const skillsSettings = settings.skills as {
			enableSkillCommands?: boolean;
			customDirectories?: unknown;
		};
		if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
			settings.enableSkillCommands = skillsSettings.enableSkillCommands;
		}
		if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
			settings.skills = skillsSettings.customDirectories;
		} else {
			delete settings.skills;
		}
	}

	// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
	if (
		"retry" in settings &&
		typeof settings.retry === "object" &&
		settings.retry !== null &&
		!Array.isArray(settings.retry)
	) {
		const retrySettings = settings.retry as Record<string, unknown>;
		const providerSettings =
			typeof retrySettings.provider === "object" && retrySettings.provider !== null
				? (retrySettings.provider as Record<string, unknown>)
				: undefined;
		if (
			typeof retrySettings.maxDelayMs === "number" &&
			(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
		) {
			retrySettings.provider = {
				...(providerSettings ?? {}),
				maxRetryDelayMs: retrySettings.maxDelayMs,
			};
		}
		delete retrySettings.maxDelayMs;
	}

	return settings as Settings;
}

// ============================================================================
// State hosts
//
// SettingsManager is a thin facade over these two hosts: `values` owns the
// in-memory settings documents, `persistence` owns dirty tracking, the write
// queue and the errors surfaced to the caller. They are internal to this module;
// only the facade coordinates them.
// ============================================================================

/** The in-memory settings documents plus the project-trust flag that gates project writes. */
class SettingsValues {
	/** Global-scope document (settings.json in the agent dir). */
	global: Settings;
	/** Project-scope document (settings.json in the project config dir). */
	project: Settings;
	/** `global` deep-merged with `project`; recomputed by `recompute()`. */
	merged: Settings;
	projectTrusted: boolean;

	constructor(global: Settings, project: Settings, projectTrusted: boolean) {
		this.global = global;
		this.project = project;
		this.projectTrusted = projectTrusted;
		this.merged = deepMergeSettings(global, project);
	}

	/** Recompute `merged` after either document was replaced or mutated. */
	recompute(): void {
		this.merged = deepMergeSettings(this.global, this.project);
	}

	/** Refuse project writes while the project is untrusted. */
	assertProjectTrusted(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}
}

/** Fields of one scope modified during this session, plus the nested keys touched within them. */
interface ModifiedScope {
	fields: Set<keyof Settings>;
	nested: Map<keyof Settings, Set<string>>;
}

function createModifiedScope(): ModifiedScope {
	return { fields: new Set<keyof Settings>(), nested: new Map<keyof Settings, Set<string>>() };
}

function cloneNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
	const snapshot = new Map<keyof Settings, Set<string>>();
	for (const [key, value] of source.entries()) {
		snapshot.set(key, new Set(value));
	}
	return snapshot;
}

/**
 * Owns everything about persisting settings: the storage backend, per-scope dirty tracking, the
 * serialized write queue, and the errors reported to the caller. No settings values live here.
 */
class SettingsPersistence {
	readonly storage: SettingsStorage;
	/** Set when that scope's file could not be parsed; blocks further writes for it. */
	globalLoadError: Error | null;
	projectLoadError: Error | null;

	private readonly settingsPaths: SettingsPaths;
	private readonly pieSettingsPaths: PieSettingsPaths;
	private readonly modified: Record<SettingsScope, ModifiedScope> = {
		global: createModifiedScope(),
		project: createModifiedScope(),
	};
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	constructor(
		storage: SettingsStorage,
		settingsPaths: SettingsPaths,
		pieSettingsPaths: PieSettingsPaths,
		globalLoadError: Error | null,
		projectLoadError: Error | null,
		initialErrors: SettingsError[],
	) {
		this.storage = storage;
		this.settingsPaths = settingsPaths;
		this.pieSettingsPaths = pieSettingsPaths;
		this.globalLoadError = globalLoadError;
		this.projectLoadError = projectLoadError;
		this.errors = [...initialErrors];
	}

	/** Mark a field (and optionally a nested key) of `scope` as modified during this session. */
	markModified(scope: SettingsScope, field: keyof Settings, nestedKey?: string): void {
		const modified = this.modified[scope];
		modified.fields.add(field);
		if (nestedKey) {
			if (!modified.nested.has(field)) {
				modified.nested.set(field, new Set());
			}
			modified.nested.get(field)!.add(nestedKey);
		}
	}

	/** Forget `scope`'s dirty fields, after a successful write or a reload. */
	clearModified(scope: SettingsScope): void {
		const modified = this.modified[scope];
		modified.fields.clear();
		modified.nested.clear();
	}

	recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	recordPieError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.pieSettingsPaths[scope]));
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/**
	 * Snapshot `scope`'s dirty fields and queue a write of `snapshot` against the file's current
	 * contents. `beforeWrite` runs inside the queue, immediately before the write.
	 */
	commit(scope: SettingsScope, snapshot: Settings, beforeWrite?: () => void): void {
		const fields = new Set(this.modified[scope].fields);
		const nested = cloneNestedFields(this.modified[scope].nested);

		this.enqueueWrite(scope, () => {
			beforeWrite?.();
			this.persistScopedSettings(scope, snapshot, fields, nested);
		});
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModified(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}
}

export class SettingsManager {
	private readonly values: SettingsValues;
	private readonly persistence: SettingsPersistence;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
		pieSettingsPaths: PieSettingsPaths = {},
	) {
		this.values = new SettingsValues(initialGlobal, initialProject, projectTrusted);
		this.persistence = new SettingsPersistence(
			storage,
			settingsPaths,
			pieSettingsPaths,
			globalLoadError,
			projectLoadError,
			initialErrors,
		);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(
			storage,
			options,
			{
				global: join(resolvedAgentDir, "settings.json"),
				project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
			},
			{
				global: join(resolvedAgentDir, "settings-pie.json"),
				project: join(resolvedCwd, CONFIG_DIR_NAME, "settings-pie.json"),
			},
		);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
		pieSettingsPaths: PieSettingsPaths = {},
	): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (globalLoad.pieError) {
			initialErrors.push(toSettingsError("global", globalLoad.pieError, pieSettingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}
		if (projectLoad.pieError) {
			initialErrors.push(toSettingsError("project", projectLoad.pieError, pieSettingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
			pieSettingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; pieError: Error | null } {
		if (scope === "project" && !projectTrusted) {
			return { settings: {}, pieError: null };
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		const settings = content
			? migrateSettings(JSON.parse(stripBom(content)) as Record<string, unknown>)
			: ({} as Settings);

		let pieError: Error | null = null;
		if (storage.readPieSettings) {
			// Pie settings live in a separate file; ignore any `pie` key inside settings.json.
			const settingsRecord = settings as Record<string, unknown>;
			delete settingsRecord.pie;
			try {
				const pieContent = storage.readPieSettings(scope);
				if (pieContent) {
					settingsRecord.pie = JSON.parse(stripBom(pieContent));
				}
			} catch (error) {
				pieError = error instanceof Error ? error : new Error(String(error));
			}
		}

		return { settings, pieError };
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null; pieError: Error | null } {
		try {
			const { settings, pieError } = SettingsManager.loadFromStorage(storage, scope, projectTrusted);
			return { settings, error: null, pieError };
		} catch (error) {
			return { settings: {}, error: error as Error, pieError: null };
		}
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.values.global);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.values.project);
	}

	isProjectTrusted(): boolean {
		return this.values.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.values.projectTrusted === trusted) {
			return;
		}

		this.values.projectTrusted = trusted;
		this.persistence.clearModified("project");

		if (!trusted) {
			this.values.project = {};
			this.persistence.projectLoadError = null;
			this.values.recompute();
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.persistence.storage, "project", trusted);
		this.values.project = projectLoad.settings;
		this.persistence.projectLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.persistence.recordError("project", projectLoad.error);
		}
		if (projectLoad.pieError) {
			this.persistence.recordPieError("project", projectLoad.pieError);
		}
		this.values.recompute();
	}

	async reload(): Promise<void> {
		await this.persistence.flush();
		const globalLoad = SettingsManager.tryLoadFromStorage(this.persistence.storage, "global");
		if (!globalLoad.error) {
			this.values.global = globalLoad.settings;
			this.persistence.globalLoadError = null;
		} else {
			this.persistence.globalLoadError = globalLoad.error;
			this.persistence.recordError("global", globalLoad.error);
		}
		if (globalLoad.pieError) {
			this.persistence.recordPieError("global", globalLoad.pieError);
		}

		this.persistence.clearModified("global");
		this.persistence.clearModified("project");

		const projectLoad = SettingsManager.tryLoadFromStorage(
			this.persistence.storage,
			"project",
			this.values.projectTrusted,
		);
		if (!projectLoad.error) {
			this.values.project = projectLoad.settings;
			this.persistence.projectLoadError = null;
		} else {
			this.persistence.projectLoadError = projectLoad.error;
			this.persistence.recordError("project", projectLoad.error);
		}
		if (projectLoad.pieError) {
			this.persistence.recordPieError("project", projectLoad.pieError);
		}

		this.values.recompute();
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.values.merged = deepMergeSettings(this.values.merged, overrides);
	}

	private save(): void {
		this.values.recompute();

		if (this.persistence.globalLoadError) {
			return;
		}

		this.persistence.commit("global", structuredClone(this.values.global));
	}

	private saveProjectSettings(settings: Settings): void {
		this.values.assertProjectTrusted();
		this.values.project = structuredClone(settings);
		this.values.recompute();

		if (this.persistence.projectLoadError) {
			return;
		}

		// The queue re-checks trust at flush time, before the write runs.
		this.persistence.commit("project", structuredClone(this.values.project), () =>
			this.values.assertProjectTrusted(),
		);
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.values.assertProjectTrusted();
		const projectSettings = structuredClone(this.values.project);
		update(projectSettings);
		this.persistence.markModified("project", field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.persistence.flush();
	}

	drainErrors(): SettingsError[] {
		return this.persistence.drainErrors();
	}

	getLastChangelogVersion(): string | undefined {
		return this.values.merged.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.values.global.lastChangelogVersion = version;
		this.persistence.markModified("global", "lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.values.merged.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.values.merged.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.values.merged.pie?.defaultModel ?? this.values.merged.defaultModel;
	}

	getProposeModel(): string | undefined {
		return this.values.merged.pie?.proposeModel ?? this.getDefaultModel();
	}

	getReportModel(): string | undefined {
		return this.values.merged.pie?.reportModel ?? this.getDefaultModel();
	}

	getExecutionModel(): string | undefined {
		return this.values.merged.pie?.executionModel;
	}

	getFastPathModel(): string | undefined {
		return this.values.merged.pie?.fastPathModel;
	}

	getDistillationModel(): string | undefined {
		return this.values.merged.pie?.distillationModel ?? this.values.merged.defaultModel;
	}

	getDistillationThinkingLevel(): ThinkingLevel {
		return this.values.merged.pie?.distillationThinkingLevel ?? "low";
	}

	getExecutionThinkingLevel(): ThinkingLevel | undefined {
		return this.values.merged.pie?.executionThinkingLevel ?? this.getDefaultThinkingLevel();
	}

	getFastPathThinkingLevel(): ThinkingLevel | undefined {
		return this.values.merged.pie?.fastPathThinkingLevel ?? this.getDefaultThinkingLevel();
	}

	getBeliefLang(): string {
		return this.values.merged.pie?.beliefLang ?? "English";
	}

	setDefaultProvider(provider: string): void {
		this.values.global.defaultProvider = provider;
		this.persistence.markModified("global", "defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.values.global.defaultModel = modelId;
		this.persistence.markModified("global", "defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.values.global.defaultProvider = provider;
		this.values.global.defaultModel = modelId;
		this.persistence.markModified("global", "defaultProvider");
		this.persistence.markModified("global", "defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.values.merged.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.values.global.steeringMode = mode;
		this.persistence.markModified("global", "steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.values.merged.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.values.global.followUpMode = mode;
		this.persistence.markModified("global", "followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.values.merged.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.values.global.theme = theme;
		this.persistence.markModified("global", "theme");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.values.merged.pie?.defaultThinkingLevel ?? this.values.merged.defaultThinkingLevel;
	}

	getProposeThinkingLevel(): ThinkingLevel | undefined {
		return this.values.merged.pie?.proposeThinkingLevel ?? this.getDefaultThinkingLevel();
	}

	getReportThinkingLevel(): ThinkingLevel | undefined {
		return this.values.merged.pie?.reportThinkingLevel ?? this.getDefaultThinkingLevel();
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.values.global.defaultThinkingLevel = level;
		this.persistence.markModified("global", "defaultThinkingLevel");
		this.save();
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.values.merged.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.values.merged.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		if (!this.values.global.modelThinkingLevels) {
			this.values.global.modelThinkingLevels = {};
		}
		this.values.global.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.persistence.markModified("global", "modelThinkingLevels");
		this.save();
	}

	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.values.global.modelThinkingLevels) return;
		delete this.values.global.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.values.global.modelThinkingLevels).length === 0) {
			delete this.values.global.modelThinkingLevels;
		}
		this.persistence.markModified("global", "modelThinkingLevels");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.values.merged.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.values.global.transport = transport;
		this.persistence.markModified("global", "transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.values.merged.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.values.global.compaction) {
			this.values.global.compaction = {};
		}
		this.values.global.compaction.enabled = enabled;
		this.persistence.markModified("global", "compaction", "enabled");
		this.save();
	}

	private getCompactionTokenSetting(
		field: keyof CompactionModelOverride,
		model?: Pick<Model<string>, "provider" | "id">,
	): number {
		const compaction = this.values.merged.compaction;
		const ordinary = compaction?.[field];
		if (ordinary !== undefined && (typeof ordinary !== "number" || !Number.isSafeInteger(ordinary) || ordinary < 0)) {
			throw new Error(
				`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
			);
		}

		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		const entry = modelKey !== undefined ? compaction?.modelOverrides?.[modelKey] : undefined;
		if (entry !== undefined && !isMergeableObject(entry)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
			);
		}
		const override = entry?.[field];
		if (override !== undefined && (typeof override !== "number" || !Number.isSafeInteger(override) || override < 0)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
			);
		}
		return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
	}

	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("reserveTokens", model);
	}

	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("keepRecentTokens", model);
	}

	/** Resolve each token setting through model override, ordinary setting, then built-in default. */
	getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(model),
			keepRecentTokens: this.getCompactionKeepRecentTokens(model),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.values.merged.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.values.merged.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.values.merged.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.values.merged.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.values.global.retry) {
			this.values.global.retry = {};
		}
		this.values.global.retry.enabled = enabled;
		this.persistence.markModified("global", "retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.values.merged.retry?.maxRetries ?? 3,
			baseDelayMs: this.values.merged.retry?.baseDelayMs ?? 2000,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return (
			parseTimeoutSetting(this.values.merged.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS
		);
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.values.global.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.persistence.markModified("global", "httpIdleTimeoutMs");
		this.save();
	}

	/** Read from global settings only because warming costs money. */
	getCacheWarmingMode(): CacheWarmingMode {
		const mode = this.values.global.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";
	}

	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.values.global.cacheWarming = mode;
		this.persistence.markModified("global", "cacheWarming");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.values.merged.retry?.provider?.timeoutMs,
			maxRetries: this.values.merged.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.values.merged.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.values.merged.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.values.merged.hideThinkingBlock ?? false;
	}

	getShowCacheMissNotices(): boolean {
		return this.values.merged.showCacheMissNotices ?? false;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.values.merged.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.values.global.hideThinkingBlock = hide;
		this.persistence.markModified("global", "hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.values.global.showCacheMissNotices = show;
		this.persistence.markModified("global", "showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.values.merged.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.values.global.shellPath = path;
		this.persistence.markModified("global", "shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.values.merged.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.values.global.quietStartup = quiet;
		this.persistence.markModified("global", "quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.values.global.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.values.global.defaultProjectTrust = defaultProjectTrust;
		this.persistence.markModified("global", "defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.values.merged.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.values.global.shellCommandPrefix = prefix;
		this.persistence.markModified("global", "shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.values.merged.npmCommand ? [...this.values.merged.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.values.global.npmCommand = command ? [...command] : undefined;
		this.persistence.markModified("global", "npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.values.merged.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.values.global.collapseChangelog = collapse;
		this.persistence.markModified("global", "collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.values.merged.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.values.global.enableInstallTelemetry = enabled;
		this.persistence.markModified("global", "enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.values.merged.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.values.merged.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.values.global.enableAnalytics = enabled;
		this.persistence.markModified("global", "enableAnalytics");
		if (enabled && !this.values.global.trackingId) {
			this.values.global.trackingId = randomUUID();
			this.persistence.markModified("global", "trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.values.merged.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.values.global.packages = packages;
		this.persistence.markModified("global", "packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.values.merged.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.values.global.extensions = paths;
		this.persistence.markModified("global", "extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.values.merged.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.values.global.skills = paths;
		this.persistence.markModified("global", "skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.values.merged.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.values.global.prompts = paths;
		this.persistence.markModified("global", "prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.values.merged.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.values.global.themes = paths;
		this.persistence.markModified("global", "themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.values.merged.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.values.global.enableSkillCommands = enabled;
		this.persistence.markModified("global", "enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.values.merged.thinkingBudgets;
	}

	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		const terminal = this.values.merged.terminal;
		const images = terminal?.images;
		return {
			...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
			...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
			...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
		};
	}

	getShowImages(): boolean {
		return this.values.merged.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.values.global.terminal) {
			this.values.global.terminal = {};
		}
		this.values.global.terminal.showImages = show;
		this.persistence.markModified("global", "terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.values.merged.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.values.global.terminal) {
			this.values.global.terminal = {};
		}
		this.values.global.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.persistence.markModified("global", "terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.values.merged.terminal?.clearOnShrink !== undefined) {
			return this.values.merged.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.values.global.terminal) {
			this.values.global.terminal = {};
		}
		this.values.global.terminal.clearOnShrink = enabled;
		this.persistence.markModified("global", "terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.values.merged.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.values.global.terminal) {
			this.values.global.terminal = {};
		}
		this.values.global.terminal.showTerminalProgress = enabled;
		this.persistence.markModified("global", "terminal", "showTerminalProgress");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.values.merged.tuiMode === "fullscreen" ? "fullscreen" : "regular";
	}

	setTuiMode(mode: TuiMode): void {
		this.values.global.tuiMode = mode;
		this.persistence.markModified("global", "tuiMode");
		this.save();
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.values.merged.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.values.global.fullscreenExitOutput = output;
		this.persistence.markModified("global", "fullscreenExitOutput");
		this.save();
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.values.merged.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.values.global.fullscreenScrollbar = mode;
		this.persistence.markModified("global", "fullscreenScrollbar");
		this.save();
	}

	getFullscreenCopyOnSelect(): boolean {
		return this.values.merged.fullscreenCopyOnSelect ?? true;
	}

	setFullscreenCopyOnSelect(enabled: boolean): void {
		this.values.global.fullscreenCopyOnSelect = enabled;
		this.persistence.markModified("global", "fullscreenCopyOnSelect");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.values.merged.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.values.global.images) {
			this.values.global.images = {};
		}
		this.values.global.images.autoResize = enabled;
		this.persistence.markModified("global", "images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.values.merged.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.values.global.images) {
			this.values.global.images = {};
		}
		this.values.global.images.blockImages = blocked;
		this.persistence.markModified("global", "images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.values.merged.enabledModels;
	}

	getDefaultTools(): string[] | undefined {
		const tools = this.values.merged.defaultTools;
		return tools ? [...tools] : undefined;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.values.global.enabledModels = patterns;
		this.persistence.markModified("global", "enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.values.merged.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.values.global.doubleEscapeAction = action;
		this.persistence.markModified("global", "doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.values.merged.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.values.global.treeFilterMode = mode;
		this.persistence.markModified("global", "treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.values.merged.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.values.global.showHardwareCursor = enabled;
		this.persistence.markModified("global", "showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.values.merged.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.values.global.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.persistence.markModified("global", "editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.values.merged.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.values.global.outputPad = padding;
		this.persistence.markModified("global", "outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.values.merged.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.values.global.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.persistence.markModified("global", "autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.values.merged.markdown?.codeBlockIndent ?? "  ";
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.values.merged.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.values.global.markdown ??= {};
		this.values.global.markdown.mermaid = mode;
		this.persistence.markModified("global", "markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.values.merged.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.values.global.warnings = { ...warnings };
		this.persistence.markModified("global", "warnings");
		this.save();
	}
}
