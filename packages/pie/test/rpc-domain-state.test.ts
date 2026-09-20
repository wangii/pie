import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ToolCall,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * The RPC state surface has to carry the problem formulation, not just message counts.
 *
 * Live domain events already stream every formulation change, but a client that connects — or
 * reconnects — has no way to learn the *current* state without replaying the log it missed. That
 * is what `get_state`'s formulation field and the `get_domain_snapshot` command are for, so both
 * are pinned here against a real scripted turn that publishes a version.
 */

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, cacheRead: 0, cacheWrite: 0, total: 0, output: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const SET_FORMULATION: ToolCall = {
	type: "toolCall",
	id: "tool-call-1",
	name: "set_formulation",
	arguments: {
		interpretation: "I read this as a persistence question",
		focus: "the value that outlives the request",
		implication: "check retention before touching eviction",
		reason: "the first probe settled the rest",
	},
};

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(): ParsedOutputLine[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

let commandCounter = 0;

async function send(command: Record<string, unknown>): Promise<ParsedOutputLine> {
	const id = `cmd-${++commandCounter}`;
	rpcIo.lineHandler?.(JSON.stringify({ ...command, id }));
	return await vi.waitFor(() => {
		const response = parseOutputLines().find((record) => record.id === id && record.type === "response");
		expect(response).toBeDefined();
		return response!;
	});
}

/** Wait for an event to reach the client, which is what tells us the run got that far. */
async function waitForEvent(type: string): Promise<void> {
	await vi.waitFor(
		() => {
			expect(parseOutputLines().some((record) => record.type === type)).toBe(true);
		},
		{ timeout: 10000 },
	);
}

async function startRpcMode(): Promise<{ cleanup: () => Promise<void> }> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	let streamCalls = 0;

	const tempDir = join(tmpdir(), `pi-rpc-domain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Test model not found");

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			const stream = new MockAssistantStream();
			const firstTurn = streamCalls++ === 0;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistantMessage([]) });
				// The first turn states the agent's reading. Later turns stall mid-stream, so the
				// task stays open exactly where a reconnecting client would find it: an answer that
				// never arrives is not a state change, and cleanup aborts the run.
				if (firstTurn) {
					stream.push({ type: "done", reason: "stop", message: assistantMessage([SET_FORMULATION]) });
				}
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		cleanup: async () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

describe("RPC domain state", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("reports the current formulation and the replayed snapshot", async () => {
		const { cleanup } = await startRpcMode();
		try {
			void send({ type: "prompt", message: "is the cache persistent?" });
			await waitForEvent("ProblemFormulationRecorded");

			const state = await send({ type: "get_state" });
			expect(state.success).toBe(true);
			const formulation = (state.data as { formulation: Record<string, unknown> | null }).formulation;
			// The version is the point: a client that just connected has no other way to learn which
			// reading the agent is working under.
			expect(formulation).not.toBeNull();
			expect(formulation?.current).toMatchObject({
				ordinal: 1,
				origin: "propose",
				content: { interpretation: "I read this as a persistence question" },
			});
			// Nothing was deferred and no correction was submitted, so both answer honestly rather
			// than being omitted.
			expect(formulation?.deferral).toBeNull();
			expect(formulation?.corrections).toEqual([]);

			// The snapshot is the state the live events are applied to, so a client that reads it
			// and then subscribes sees one continuous history rather than two that can disagree.
			const snapshotResponse = await send({ type: "get_domain_snapshot" });
			expect(snapshotResponse.success).toBe(true);
			const snapshot = snapshotResponse.data as {
				tasks: Array<{ status: string; formulations: Array<{ ordinal: number }> }>;
				cursor?: { stage: string };
			};
			expect(snapshot.tasks).toHaveLength(1);
			expect(snapshot.tasks[0].status).toBe("active");
			expect(snapshot.tasks[0].formulations.map((version) => version.ordinal)).toEqual([1]);
			expect(snapshot.cursor?.stage).toBeDefined();
		} finally {
			await cleanup();
		}
	}, 30000);

	it("reports no formulation when no task is open", async () => {
		const { cleanup } = await startRpcMode();
		try {
			const state = await send({ type: "get_state" });
			expect(state.success).toBe(true);
			expect((state.data as { formulation: unknown }).formulation).toBeNull();

			const snapshotResponse = await send({ type: "get_domain_snapshot" });
			expect((snapshotResponse.data as { tasks: unknown[] }).tasks).toEqual([]);
		} finally {
			await cleanup();
		}
	}, 30000);
});
