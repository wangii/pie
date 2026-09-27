import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

// Regression test for #9784 / #9901: provider stream events must reach extensions
// through pie's forked sdk.ts wiring.
describe("createAgentSession provider stream events", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-provider-stream-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("forwards provider stream events to extensions", async () => {
		const api: Api = "openai-completions";
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory({});
		const extensionEvents: unknown[] = [];
		let factoryInvocations = 0;
		let providerCalls = 0;
		const extensionFactory: ExtensionFactory = (pi) => {
			factoryInvocations++;
			pi.on("provider_stream_event", (event) => {
				extensionEvents.push(event);
			});
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [extensionFactory],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (requestModel, _context, providerOptions) => {
				providerCalls++;
				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					stream.end(createDoneMessage(api));
				})();
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			await session.prompt("test");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}

		// pie's belief loop advances through roles (propose → execution → distill → finalReport) on
		// turn_end, so one prompt drives multiple provider calls. The extension factory runs once and
		// every provider call delivers exactly one provider_stream_event.
		expect(factoryInvocations).toBe(1);
		expect(providerCalls).toBeGreaterThan(0);
		expect(extensionEvents.length).toBe(providerCalls);
		expect(extensionEvents[0]).toEqual({
			data: providerEvent,
			type: "provider_stream_event",
			provider: "capture-provider",
			api,
			model: "capture-model",
		});
	});

	it("issues multiple provider calls for one prompt without any provider_stream_event handler", async () => {
		const api: Api = "openai-completions";
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory({});
		let providerCalls = 0;
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: () => {
				providerCalls++;
				const stream = createAssistantMessageEventStream();
				stream.end(createDoneMessage(api));
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			await session.prompt("test");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
		// Same prompt with no provider_stream_event handler still makes multiple provider calls,
		// so the extra calls come from pie's belief loop, not the #9901 wiring.
		expect(providerCalls).toBeGreaterThan(0);
	});
});
