import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { contentText } from "@earendil-works/pi-ai";
import {
	type ActionDirective,
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type FrameDirective,
	ModelRuntime,
	type ObservationDefinition,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	type Harness,
	type HarnessContext,
	type JsonValue,
	normalizeRecord,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
} from "vitest-evals/harness";
import { PI_SESSION_SNAPSHOT_ARTIFACT } from "./vitest-evals/artifacts.ts";

export type PiCodingAgentInput =
	| string
	| Array<
			| {
					type: "prompt";
					content: string;
					anchor?: { statement: string; revisionReason?: string };
					frame?: FrameDirective;
					action?: ActionDirective;
					observation?: ObservationDefinition;
			  }
			| { type: "reload" }
			| { type: "restart" }
			| { type: "seed"; files: Record<string, string> }
			| { type: "remove"; paths: string[] }
			| {
					type: "observe_latest_action_results";
					statement: string;
					affects: ObservationDefinition["affects"];
			  }
			| { type: "complete_current_action"; reason: string }
			| { type: "adjudicate_current_frame" }
	  >;

type PiCodingAgentModelSelection = {
	provider: string;
	id: string;
};

type PiCodingAgentHarnessOptions = {
	name?: string;
	model?: PiCodingAgentModelSelection;
	noTools?: CreateAgentSessionOptions["noTools"];
	transformSystemPrompt?: (defaultPrompt: string) => string;
	anchorEnabled?: boolean;
	frameEnabled?: boolean;
	actionEnabled?: boolean;
	observationEnabled?: boolean;
	contextInputTokenLimit?: number;
	/** Run restart steps by reopening the persisted session. False provides a matched uninterrupted control. */
	performPersistedRestarts?: boolean;
	/** Harness-local ablation transform; comparison grouping still uses the original matched input. */
	transformInput?: (input: PiCodingAgentInput) => PiCodingAgentInput;
};

type PiCodingAgentHarnessWithOutput<TOutput extends JsonValue> = PiCodingAgentHarnessOptions & {
	output: (args: {
		response: string;
		session: AgentSession;
		cwd: string;
		input: PiCodingAgentInput;
		persistedRestartCount: number;
	}) => TOutput | Promise<TOutput>;
};

export function resolveModelSelection(
	explicitModel: PiCodingAgentModelSelection | undefined,
	environment: { PI_PROVIDER?: string; PI_MODEL?: string } = process.env,
): PiCodingAgentModelSelection {
	const provider = (explicitModel?.provider ?? environment.PI_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.PI_MODEL)?.trim();
	if (!provider || !id) {
		throw new Error("Select a harness model explicitly or set both PI_PROVIDER and PI_MODEL as defaults.");
	}
	return { provider, id };
}

function toTranscriptEvents(messages: AgentSession["messages"]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: contentText(message.content) });
		} else if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type === "toolCall") {
					events.push({
						type: "tool_call",
						id: part.id,
						name: part.name,
						arguments: normalizeRecord(part.arguments),
					});
				}
			}
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content: message.content.every((part) => part.type === "text") ? text : toJsonValue(message.content),
				...(message.isError ? { error: { message: text || "Tool failed" } } : {}),
			});
		}
	}
	return events;
}

async function promptAgent(
	session: AgentSession,
	input: string,
	signal: AbortSignal | undefined,
	anchor?: { statement: string; revisionReason?: string },
	frame?: FrameDirective,
	action?: ActionDirective,
	observation?: ObservationDefinition,
): Promise<string> {
	signal?.throwIfAborted();
	const previousMessageCount = session.messages.length;
	await session.prompt(input, { anchor, frame, action, observation });
	const assistant = session.messages
		.slice(previousMessageCount)
		.reverse()
		.find((message) => message.role === "assistant");
	if (!assistant) throw new Error("Agent run completed without an assistant message.");
	if (assistant.stopReason !== "stop") {
		throw new Error(
			assistant.errorMessage ?? `Agent run ended with unexpected stop reason: ${assistant.stopReason}.`,
		);
	}
	const output = session.getLastAssistantText();
	if (!output) throw new Error("Agent run produced no assistant text.");
	return output;
}

async function runPiCodingAgent<TOutput extends JsonValue>(
	input: PiCodingAgentInput,
	signal: AbortSignal | undefined,
	setArtifact: HarnessContext["setArtifact"],
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput>,
): Promise<SimpleHarnessResult<string | TOutput>> {
	const startedAt = performance.now();
	signal?.throwIfAborted();
	const selection = resolveModelSelection(options.model);
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel(selection.provider, selection.id);
	if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.id}`);

	const root = await mkdtemp(join(tmpdir(), "pi-eval-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	let transformedSystemPrompt: string | undefined;
	let sessionManager: SessionManager | undefined;
	let session: AgentSession | undefined;
	let outcome: { success: true; result: SimpleHarnessResult<string | TOutput> } | { success: false; error: unknown };
	try {
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			...(options.transformSystemPrompt
				? { resourceLoaderOptions: { systemPromptOverride: () => transformedSystemPrompt } }
				: {}),
		});
		signal?.throwIfAborted();
		sessionManager = SessionManager.create(cwd, join(root, "sessions"));
		setArtifact("runId", sessionManager.getSessionId());
		const createEvalSession = async (manager: SessionManager): Promise<AgentSession> =>
			(
				await createAgentSessionFromServices({
					services,
					sessionManager: manager,
					model,
					thinkingLevel: "off",
					noTools: options.noTools,
					anchorEnabled: options.anchorEnabled,
					frameEnabled: options.frameEnabled,
					actionEnabled: options.actionEnabled,
					observationEnabled: options.observationEnabled,
					contextInputTokenLimit: options.contextInputTokenLimit,
				})
			).session;
		session = await createEvalSession(sessionManager);

		let evalSession = session;
		if (options.transformSystemPrompt) {
			transformedSystemPrompt = options.transformSystemPrompt(evalSession.systemPrompt);
			if (!transformedSystemPrompt.trim()) throw new Error("Transformed eval system prompt must not be empty.");
			await evalSession.reload();
		}
		let abortPromise: Promise<void> | undefined;
		const abort = () => {
			abortPromise ??= evalSession.abort();
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			signal?.throwIfAborted();
			if (evalSession.extensionRunner.getExtensionPaths().length !== 0) {
				throw new Error("Expected an isolated eval session to start without extensions.");
			}
			const effectiveInput = options.transformInput?.(input) ?? input;
			const steps =
				typeof effectiveInput === "string"
					? [{ type: "prompt" as const, content: effectiveInput }]
					: effectiveInput;
			let response: string | undefined;
			let persistedRestartCount = 0;
			for (const step of steps) {
				if (step.type === "prompt") {
					response = await promptAgent(
						evalSession,
						step.content,
						signal,
						options.anchorEnabled === false ? undefined : step.anchor,
						options.frameEnabled === false ? undefined : step.frame,
						options.actionEnabled === false ? undefined : step.action,
						options.observationEnabled === false ? undefined : step.observation,
					);
				} else if (step.type === "restart") {
					if (options.performPersistedRestarts === false) continue;
					const sessionPath = sessionManager.getSessionFile();
					if (!sessionPath) throw new Error("Eval restart requires a persisted session.");
					evalSession.dispose();
					sessionManager = SessionManager.open(sessionPath);
					persistedRestartCount++;
					evalSession = await createEvalSession(sessionManager);
					session = evalSession;
				} else if (step.type === "seed") {
					for (const [relativePath, content] of Object.entries(step.files)) {
						const target = join(cwd, relativePath);
						await mkdir(dirname(target), { recursive: true });
						await writeFile(target, content, "utf8");
					}
				} else if (step.type === "remove") {
					for (const relativePath of step.paths) {
						await unlink(join(cwd, relativePath));
					}
				} else if (step.type === "observe_latest_action_results") {
					if (options.observationEnabled === false) continue;
					const branch = sessionManager.getBranch();
					let actionStartIndex = -1;
					for (let index = branch.length - 1; index >= 0; index--) {
						if (branch[index]?.type === "action_start") {
							actionStartIndex = index;
							break;
						}
					}
					const sourceEventIds = branch
						.slice(actionStartIndex + 1)
						.filter(
							(entry) =>
								entry.type === "message" &&
								(entry.message.role === "toolResult" || entry.message.role === "bashExecution"),
						)
						.map((entry) => entry.id);
					if (sourceEventIds.length === 0) {
						throw new Error("Observation eval step requires an execution result in the current Action episode.");
					}
					evalSession.materializeObservation({
						statement: step.statement,
						affects: step.affects,
						sourceEventIds,
					});
				} else if (step.type === "complete_current_action") {
					const branch = sessionManager.getBranch();
					let actionStartIndex = -1;
					for (let index = branch.length - 1; index >= 0; index--) {
						if (branch[index]?.type === "action_start") {
							actionStartIndex = index;
							break;
						}
					}
					const sourceEventId = branch
						.slice(actionStartIndex + 1)
						.reverse()
						.find(
							(entry) =>
								entry.type === "message" &&
								(entry.message.role === "toolResult" || entry.message.role === "bashExecution"),
						)?.id;
					if (!sourceEventId) throw new Error("Action completion requires an execution result event.");
					evalSession.completeAction(step.reason, { sourceEventId });
				} else if (step.type === "adjudicate_current_frame") {
					if (response === undefined) throw new Error("Frame adjudication requires a preceding model response.");
					const decision = response
						.trim()
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
						.at(-1);
					const sourceEventId = sessionManager
						.getBranch()
						.slice()
						.reverse()
						.find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
					if (!sourceEventId) throw new Error("Frame adjudication requires an assistant result event.");
					if (evalSession.action) {
						evalSession.completeAction("the Frame adjudication decision was produced", { sourceEventId });
					}
					if (decision === "REJECT_FRAME") {
						evalSession.terminateFrame("falsified", {
							reason: "the adjudication Action found that the declared falsifier occurred",
							sourceEventId,
						});
					}
				} else {
					await evalSession.reload();
				}
			}
			if (response === undefined) throw new Error("Pi eval input must include at least one prompt step.");
			const output =
				"output" in options
					? await options.output({
							response,
							session: evalSession,
							cwd,
							input: effectiveInput,
							persistedRestartCount,
						})
					: response;
			const stats = evalSession.getSessionStats();
			const hasPricing = [model.cost, ...(model.cost.tiers ?? [])].some(
				({ input, output, cacheRead, cacheWrite }) => input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0,
			);
			outcome = {
				success: true,
				result: {
					output,
					events: toTranscriptEvents(evalSession.messages),
					usage: {
						provider: model.provider,
						model: model.id,
						inputTokens: stats.tokens.input,
						outputTokens: stats.tokens.output,
						totalTokens: stats.tokens.total,
						toolCalls: stats.toolCalls,
						metadata: {
							cacheReadTokens: stats.tokens.cacheRead,
							cacheWriteTokens: stats.tokens.cacheWrite,
							...(hasPricing ? { estimatedCostUsd: stats.cost } : {}),
						},
					},
				},
			};
		} finally {
			signal?.removeEventListener("abort", abort);
			if (abortPromise) await abortPromise;
		}
	} catch (error) {
		outcome = { success: false, error };
	}

	const cleanupErrors: unknown[] = [];
	if (sessionManager) {
		try {
			const sessionPath = sessionManager.getSessionFile();
			if (sessionPath && existsSync(sessionPath)) {
				setArtifact(PI_SESSION_SNAPSHOT_ARTIFACT, await readFile(sessionPath, "utf8"));
			}
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		session?.dispose();
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await rm(root, { recursive: true, force: true });
	} catch (error) {
		cleanupErrors.push(error);
	}

	if (!outcome.success) {
		if (cleanupErrors.length === 0) throw outcome.error;
		throw new AggregateError([outcome.error, ...cleanupErrors], "Agent run failed and cleanup also failed.");
	}
	if (cleanupErrors.length === 1) throw cleanupErrors[0];
	if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Agent cleanup failed.");
	return {
		...outcome.result,
		timings: { totalMs: performance.now() - startedAt },
	};
}

export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	options: PiCodingAgentHarnessWithOutput<TOutput>,
): Harness<PiCodingAgentInput, TOutput>;
export function createPiCodingAgentHarness(options?: PiCodingAgentHarnessOptions): Harness<PiCodingAgentInput, string>;
export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput> = {},
) {
	return createHarness<PiCodingAgentInput, string | TOutput>({
		name: options.name ?? "pi-coding-agent",
		run: ({ input, signal, setArtifact }) => runPiCodingAgent(input, signal, setArtifact, options),
	});
}
