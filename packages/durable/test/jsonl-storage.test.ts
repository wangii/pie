import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { err, FileError, type FileSystem, type Result } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { JsonlStorage } from "../src/storage/jsonl/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import type { DocumentCreate, Seq, Storage, StorageWrite, TaskRecord } from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";
import { registerStorageConformance } from "./storage-conformance.ts";

const context = BACKGROUND_CONTEXT;
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
const tempDirectories = new Set<string>();
const openStorages = new Set<JsonlStorage>();

afterEach(async () => {
	for (const storage of openStorages) await storage.close(context);
	openStorages.clear();
	for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
	tempDirectories.clear();
});

async function tempDirectory(prefix = "pi-durable-jsonl-"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	tempDirectories.add(directory);
	return directory;
}

async function openStorage(
	directory: string,
	fs: FileSystem = new NodeExecutionEnv({ cwd: directory }),
	options: { readonly fsync?: boolean } = {},
): Promise<JsonlStorage> {
	const storage = await JsonlStorage.open(directory, fs, context, options);
	openStorages.add(storage);
	return storage;
}

async function createStorage(): Promise<JsonlStorage> {
	return openStorage(await tempDirectory());
}

class ReopeningStorage implements Storage {
	private current: JsonlStorage;
	private readonly directory: string;
	private closed = false;

	constructor(current: JsonlStorage, directory: string) {
		this.current = current;
		this.directory = directory;
	}

	async commit(writes: readonly StorageWrite[], commitContext: Context): Promise<Seq> {
		if (this.closed) return this.current.commit(writes, commitContext);
		try {
			return await this.current.commit(writes, commitContext);
		} finally {
			await this.current.close(context);
			this.current = await JsonlStorage.open(this.directory, new NodeExecutionEnv({ cwd: this.directory }), context);
		}
	}

	mintId: Storage["mintId"] = () => this.current.mintId();
	conversation: Storage["conversation"] = (id, readContext) => this.current.conversation(id, readContext);
	scanConversations: Storage["scanConversations"] = (cursor, limit, readContext) =>
		this.current.scanConversations(cursor, limit, readContext);
	entry: Storage["entry"] = (id, readContext) => this.current.entry(id, readContext);
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (conversationId, at, readContext) =>
		this.current.findLatestHeadMarker(conversationId, at, readContext);
	scanEntries: Storage["scanEntries"] = (query, cursor, limit, readContext) =>
		this.current.scanEntries(query, cursor, limit, readContext);
	task: Storage["task"] = (id, readContext) => this.current.task(id, readContext);
	scanTasks: Storage["scanTasks"] = (query, cursor, limit, readContext) =>
		this.current.scanTasks(query, cursor, limit, readContext);
	submission: Storage["submission"] = (id, readContext) => this.current.submission(id, readContext);
	submissionByRequest: Storage["submissionByRequest"] = (conversationId, requestId, readContext) =>
		this.current.submissionByRequest(conversationId, requestId, readContext);
	findDocument: Storage["findDocument"] = (address, at, readContext) =>
		this.current.findDocument(address, at, readContext);
	document: Storage["document"] = (id, at, readContext) => this.current.document(id, at, readContext);
	scanDocuments: Storage["scanDocuments"] = (query, cursor, limit, readContext) =>
		this.current.scanDocuments(query, cursor, limit, readContext);

	async close(closeContext: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.current.close(closeContext);
	}
}

registerStorageConformance("Pico JsonlStorage conformance", createStorage);

registerStorageConformance("Pico JsonlStorage conformance across reopen", async () => {
	const directory = await tempDirectory("pi-durable-jsonl-conformance-");
	const current = await JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: directory }), context);
	const storage = new ReopeningStorage(current, directory);
	onTestFinished(() => storage.close(context));
	return storage;
});

function pendingTask(id: number, phase = "ready"): StoredTask {
	return {
		id,
		conversationId: ROOT_CONVERSATION_ID,
		kind: "test.task",
		version: 1,
		input: null,
		state: { status: "pending", checkpoint: { phase } },
		after: [],
		background: false,
		abortRequested: false,
	};
}

function terminalTask(id: number): StoredTask {
	return {
		id,
		conversationId: ROOT_CONVERSATION_ID,
		kind: "test.task",
		version: 1,
		input: null,
		state: { status: "terminal", outcome: { status: "completed", result: null } },
		after: [],
		background: false,
		abortRequested: false,
	};
}

async function createRoot(storage: Storage): Promise<void> {
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
}

function sessionDocument(id: number, kind = "test.document"): DocumentCreate {
	return { id, kind, scope: { kind: "session" } };
}

type Failure = {
	readonly operation: "append" | "flush";
	readonly call: number;
	readonly mode: "before" | "after" | "short";
};

class InstrumentedEnv extends NodeExecutionEnv {
	readonly operations: string[] = [];
	private failure: Failure | undefined;
	private appendCalls = 0;
	private flushCalls = 0;

	fail(failure: Failure): void {
		this.failure = failure;
		this.appendCalls = 0;
		this.flushCalls = 0;
		this.operations.length = 0;
	}

	clear(): void {
		this.failure = undefined;
		this.appendCalls = 0;
		this.flushCalls = 0;
		this.operations.length = 0;
	}

	override async appendFile(
		path: string,
		content: string | Uint8Array,
		appendContext: Context,
	): Promise<Result<void, FileError>> {
		this.appendCalls++;
		this.operations.push(`append:${basename(path)}`);
		const failure = this.failure;
		if (failure?.operation !== "append" || failure.call !== this.appendCalls) {
			return super.appendFile(path, content, appendContext);
		}
		if (failure.mode === "before") return err(new FileError("unknown", "injected append failure", path));
		if (failure.mode === "short") {
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
			const partial = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
			const written = await super.appendFile(path, partial, appendContext);
			if (!written.ok) return written;
			return err(new FileError("unknown", "injected short append", path));
		}
		const written = await super.appendFile(path, content, appendContext);
		if (!written.ok) return written;
		return err(new FileError("unknown", "injected post-append failure", path));
	}

	override async flushFile(path: string, flushContext: Context): Promise<Result<void, FileError>> {
		this.flushCalls++;
		this.operations.push(`flush:${basename(path)}`);
		const failure = this.failure;
		if (failure?.operation !== "flush" || failure.call !== this.flushCalls) {
			return super.flushFile(path, flushContext);
		}
		if (failure.mode === "after") {
			const flushed = await super.flushFile(path, flushContext);
			if (!flushed.ok) return flushed;
		}
		return err(new FileError("unknown", "injected flush failure", path));
	}
}

async function readLines(path: string): Promise<string[]> {
	const text = await readFile(path, "utf8");
	return text === "" ? [] : text.trimEnd().split("\n");
}

describe("Pico JsonlStorage publication and recovery", () => {
	it("opens through the Node adapter", async () => {
		const storage = await openNodeJsonlStorage(await tempDirectory(), context);
		openStorages.add(storage);
		await createRoot(storage);
		expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
	});

	it("persists live tasks and document revisions in sidecars with one marker for every commit", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const taskId = await storage.mintId();
		const documentId = await storage.mintId();
		await storage.commit([{ type: "task", value: pendingTask(taskId) }], context);
		await storage.commit(
			[
				{
					type: "document.create",
					record: sessionDocument(documentId),
					content: { kind: "base", version: 1, value: { count: 0 } },
				},
			],
			context,
		);
		await storage.commit(
			[{ type: "document.change", id: documentId, content: { kind: "delta", version: 1, ops: [] } }],
			context,
		);
		await storage.commit(
			[
				{
					type: "document.change",
					id: documentId,
					content: { kind: "base", version: 1, value: { count: 1 } },
				},
			],
			context,
		);
		await storage.commit([{ type: "document.retire", id: documentId }], context);
		await storage.commit([{ type: "task", value: terminalTask(taskId) }], context);

		expect(await readLines(join(directory, "main.jsonl"))).toHaveLength(7);
		expect(await readLines(join(directory, `task-${taskId}.jsonl`))).toHaveLength(1);
		expect(await readLines(join(directory, `doc-${documentId}.jsonl`))).toHaveLength(3);
		const markerTypes = (await readLines(join(directory, "main.jsonl"))).map(
			(line) => (JSON.parse(line) as { readonly type: string }).type,
		);
		expect(markerTypes).toEqual(["commit", "commit", "commit", "commit", "commit", "commit", "commit"]);
	});

	it("orders multiple live-task replacements in one sidecar by commit ordinal", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const taskId = await storage.mintId();
		await storage.commit(
			[
				{ type: "task", value: pendingTask(taskId, "first") },
				{ type: "task", value: pendingTask(taskId, "second") },
			],
			context,
		);
		expect(await readLines(join(directory, `task-${taskId}.jsonl`))).toHaveLength(2);

		const reopened = await openStorage(directory);
		expect(await reopened.task(taskId, context)).toEqual(pendingTask(taskId, "second"));
	});

	it("removes a complete-plus-torn unconfirmed multi-record sidecar append", async () => {
		const directory = await tempDirectory();
		const env = new InstrumentedEnv({ cwd: directory });
		const storage = await openStorage(directory, env);
		await createRoot(storage);
		const taskId = await storage.mintId();
		env.fail({ operation: "append", call: 1, mode: "short" });
		await expect(
			storage.commit(
				[
					{ type: "task", value: pendingTask(taskId, "first") },
					{ type: "task", value: pendingTask(taskId, `second-${"x".repeat(512)}`) },
				],
				context,
			),
		).rejects.toThrow("poisoned");
		const partial = await readFile(join(directory, `task-${taskId}.jsonl`));
		expect(partial.at(-1)).not.toBe(0x0a);
		expect([...partial].filter((byte) => byte === 0x0a)).toHaveLength(1);

		const reopened = await openStorage(directory);
		expect(await reopened.task(taskId, context)).toBeUndefined();
		expect((await stat(join(directory, `task-${taskId}.jsonl`))).size).toBe(0);
	});

	it("serializes the complete candidate before I/O and leaves preparation failures usable", async () => {
		const directory = await tempDirectory();
		const env = new InstrumentedEnv({ cwd: directory });
		const storage = await openStorage(directory, env);
		await createRoot(storage);
		env.clear();
		const id = await storage.mintId();
		await expect(
			storage.commit(
				[
					{
						type: "entry",
						value: {
							id,
							conversationId: ROOT_CONVERSATION_ID,
							kind: "bad",
							data: 1n as unknown as JsonValue,
						},
					},
				],
				context,
			),
		).rejects.toThrow();
		expect(env.operations).toEqual([]);
		expect(await storage.entry(id, context)).toBeUndefined();
		expect(
			await storage.commit(
				[{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "good" } }],
				context,
			),
		).toBe(2);
	});

	for (const failure of [
		{ operation: "append", call: 1, mode: "before" },
		{ operation: "append", call: 1, mode: "after" },
		{ operation: "append", call: 1, mode: "short" },
		{ operation: "append", call: 2, mode: "before" },
		{ operation: "append", call: 2, mode: "after" },
		{ operation: "append", call: 3, mode: "before" },
		{ operation: "append", call: 3, mode: "short" },
		{ operation: "append", call: 3, mode: "after" },
	] as const satisfies readonly Failure[]) {
		it(`poisons after ${failure.mode} failure at append ${failure.call} and recovers only confirmed state`, async () => {
			const directory = await tempDirectory();
			const env = new InstrumentedEnv({ cwd: directory });
			const storage = await openStorage(directory, env);
			await createRoot(storage);
			const firstId = await storage.mintId();
			const secondId = await storage.mintId();
			env.fail(failure);
			await expect(
				storage.commit(
					[
						{
							type: "document.create",
							record: sessionDocument(firstId, "first"),
							content: { kind: "base", version: 1, value: { text: "α" } },
						},
						{
							type: "document.create",
							record: sessionDocument(secondId, "second"),
							content: { kind: "base", version: 1, value: { text: "β" } },
						},
					],
					context,
				),
			).rejects.toThrow("poisoned");
			await expect(storage.document(firstId, "current", context)).rejects.toThrow("poisoned");

			const reopened = await openStorage(directory);
			const markerSurvived = failure.call === 3 && failure.mode === "after";
			expect(await reopened.document(firstId, "current", context)).toEqual(
				markerSurvived ? expect.objectContaining({ value: { text: "α" } }) : undefined,
			);
			expect(await reopened.document(secondId, "current", context)).toEqual(
				markerSurvived ? expect.objectContaining({ value: { text: "β" } }) : undefined,
			);
		});
	}

	for (const failure of [
		{ operation: "flush", call: 1, mode: "before" },
		{ operation: "flush", call: 1, mode: "after" },
		{ operation: "flush", call: 2, mode: "before" },
		{ operation: "flush", call: 2, mode: "after" },
	] as const satisfies readonly Failure[]) {
		it(`poisons after ${failure.mode} failure at flush ${failure.call} and never writes a marker`, async () => {
			const directory = await tempDirectory();
			const env = new InstrumentedEnv({ cwd: directory });
			const storage = await openStorage(directory, env, { fsync: true });
			await createRoot(storage);
			const firstId = await storage.mintId();
			const secondId = await storage.mintId();
			env.fail(failure);
			await expect(
				storage.commit(
					[
						{
							type: "document.create",
							record: sessionDocument(firstId, "flush.first"),
							content: { kind: "base", version: 1, value: {} },
						},
						{
							type: "document.create",
							record: sessionDocument(secondId, "flush.second"),
							content: { kind: "base", version: 1, value: {} },
						},
					],
					context,
				),
			).rejects.toThrow("poisoned");
			const reopened = await openStorage(directory);
			expect(await reopened.document(firstId, "current", context)).toBeUndefined();
			expect(await reopened.document(secondId, "current", context)).toBeUndefined();
		});
	}

	it("orders appends and optional flushes exactly and never flushes main.jsonl", async () => {
		for (const fsync of [false, true]) {
			const directory = await tempDirectory();
			const env = new InstrumentedEnv({ cwd: directory });
			const storage = await openStorage(directory, env, { fsync });
			await createRoot(storage);
			const firstId = await storage.mintId();
			const secondId = await storage.mintId();
			env.clear();
			await storage.commit(
				[
					{
						type: "document.create",
						record: sessionDocument(secondId, "second"),
						content: { kind: "base", version: 1, value: {} },
					},
					{
						type: "document.create",
						record: sessionDocument(firstId, "first"),
						content: { kind: "base", version: 1, value: {} },
					},
				],
				context,
			);
			const expected = [
				`append:doc-${secondId}.jsonl`,
				`append:doc-${firstId}.jsonl`,
				...(fsync ? [`flush:doc-${secondId}.jsonl`, `flush:doc-${firstId}.jsonl`] : []),
				"append:main.jsonl",
			];
			expect(env.operations).toEqual(expected);

			env.clear();
			await storage.commit(
				[
					{
						type: "entry",
						value: {
							id: await storage.mintId(),
							conversationId: ROOT_CONVERSATION_ID,
							kind: "main-only",
						},
					},
				],
				context,
			);
			expect(env.operations).toEqual(["append:main.jsonl"]);
		}
	});

	it("truncates torn UTF-8 tails at exact byte offsets and reuses the unconfirmed sequence", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const documentId = await storage.mintId();
		await storage.commit(
			[
				{
					type: "document.create",
					record: sessionDocument(documentId),
					content: { kind: "base", version: 1, value: { text: "kept" } },
				},
			],
			context,
		);
		const sidecarPath = join(directory, `doc-${documentId}.jsonl`);
		const mainPath = join(directory, "main.jsonl");
		const sidecarSize = (await stat(sidecarPath)).size;
		const mainSize = (await stat(mainPath)).size;
		const torn = new TextEncoder().encode('{"text":"€');
		await writeFile(sidecarPath, torn.subarray(0, torn.length - 1), { flag: "a" });
		await writeFile(mainPath, torn.subarray(0, torn.length - 1), { flag: "a" });

		const reopened = await openStorage(directory);
		expect((await stat(sidecarPath)).size).toBe(sidecarSize);
		expect((await stat(mainPath)).size).toBe(mainSize);
		expect(
			await reopened.commit(
				[{ type: "document.change", id: documentId, content: { kind: "delta", version: 1, ops: [] } }],
				context,
			),
		).toBe(3);
	});

	it("removes complete unconfirmed sidecar tails without resurrecting terminal tasks", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const taskId = await storage.mintId();
		await storage.commit([{ type: "task", value: pendingTask(taskId) }], context);
		await storage.commit([{ type: "task", value: terminalTask(taskId) }], context);
		const sidecarPath = join(directory, `task-${taskId}.jsonl`);
		const confirmedSize = (await stat(sidecarPath)).size;
		await writeFile(
			sidecarPath,
			`${JSON.stringify({
				format: 1,
				type: "record",
				seq: 4,
				ordinal: 0,
				payload: { type: "task", value: pendingTask(taskId, "stale") },
			})}\n`,
			{ flag: "a" },
		);

		const reopened = await openStorage(directory);
		expect((await stat(sidecarPath)).size).toBe(confirmedSize);
		expect(await reopened.task(taskId, context)).toEqual(terminalTask(taskId));
		expect(await reopened.commit([], context)).toBe(4);
	});

	it("fails open when confirmed sidecar data is missing", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const documentId = await storage.mintId();
		await storage.commit(
			[
				{
					type: "document.create",
					record: sessionDocument(documentId),
					content: { kind: "base", version: 1, value: {} },
				},
			],
			context,
		);
		await writeFile(join(directory, `doc-${documentId}.jsonl`), "");
		await expect(JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: directory }), context)).rejects.toThrow(
			"Missing confirmed sidecar record",
		);
	});

	it("rejects a confirmed record after an unconfirmed sidecar record", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const documentId = await storage.mintId();
		await storage.commit(
			[
				{
					type: "document.create",
					record: sessionDocument(documentId),
					content: { kind: "base", version: 1, value: { count: 0 } },
				},
			],
			context,
		);
		await storage.commit(
			[
				{
					type: "document.change",
					id: documentId,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], 1]] },
				},
			],
			context,
		);
		const path = join(directory, `doc-${documentId}.jsonl`);
		const [first, second] = await readLines(path);
		const unconfirmed = JSON.stringify({
			format: 1,
			type: "record",
			seq: 2,
			ordinal: 999,
			payload: { type: "document", id: documentId, content: { kind: "delta", version: 1, ops: [] } },
		});
		await writeFile(path, `${first}\n${unconfirmed}\n${second}\n`);
		await expect(JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: directory }), context)).rejects.toThrow(
			"Confirmed record follows an unconfirmed tail",
		);
	});

	it("rejects non-increasing main commit sequences", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const path = join(directory, "main.jsonl");
		await writeFile(path, await readFile(path), { flag: "a" });

		await expect(JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: directory }), context)).rejects.toThrow(
			"Commit sequence does not strictly increase",
		);
	});

	it("rejects structurally invalid confirmed document content", async () => {
		const directory = await tempDirectory();
		const storage = await openStorage(directory);
		await createRoot(storage);
		const documentId = await storage.mintId();
		await storage.commit(
			[
				{
					type: "document.create",
					record: sessionDocument(documentId),
					content: { kind: "base", version: 1, value: {} },
				},
			],
			context,
		);
		const path = join(directory, `doc-${documentId}.jsonl`);
		const record = JSON.parse((await readFile(path, "utf8")).trim()) as {
			payload: { content: Record<string, unknown> };
		};
		delete record.payload.content.value;
		await writeFile(path, `${JSON.stringify(record)}\n`);

		await expect(JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: directory }), context)).rejects.toThrow(
			"Invalid document content",
		);
	});

	it("rejects malformed complete main and sidecar lines", async () => {
		const mainDirectory = await tempDirectory();
		const mainStorage = await openStorage(mainDirectory);
		await createRoot(mainStorage);
		await writeFile(join(mainDirectory, "main.jsonl"), "{bad}\n", { flag: "a" });
		await expect(
			JsonlStorage.open(mainDirectory, new NodeExecutionEnv({ cwd: mainDirectory }), context),
		).rejects.toThrow("Malformed complete main.jsonl");

		const sidecarDirectory = await tempDirectory();
		const sidecarStorage = await openStorage(sidecarDirectory);
		await createRoot(sidecarStorage);
		await writeFile(join(sidecarDirectory, "doc-99.jsonl"), "{bad}\n");
		await expect(
			JsonlStorage.open(sidecarDirectory, new NodeExecutionEnv({ cwd: sidecarDirectory }), context),
		).rejects.toThrow("Malformed complete doc-99.jsonl");
	});
});
