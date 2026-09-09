import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// Pie runs the default (propose) role with only belief tools, so `wait` is blocked unless
// the session routes to fast-path execution first. Inject a `route_task(fast-path)` response
// so the slow tool actually runs and its background notify can fire.
const routeTaskToFastPath = () =>
	fauxAssistantMessage([
		fauxToolCall("route_task", {
			decision: "fast-path",
			reason: "no unresolved uncertainty can change this action or its safety",
			suitabilityProbability: 0.9,
			successProbability: 0.9,
			estimatedSteps: 1,
			difficulty: "low",
		}),
	]);

const fastHarnessOptions = {
	models: [{ id: "default" }, { id: "fast" }, { id: "distill" }],
	settings: {
		defaultModel: "faux/default",
		pie: { fastPathModel: "faux/fast", distillationModel: "faux/distill" },
	},
};

// AgentMessage is a union of LLM messages and custom messages; only assistant messages
// carry a `content` array. Narrow to the assistant member so `content` access is type-safe
// (BashExecutionMessage has no `content`).
type AssistantContentMessage = Extract<AgentMessage, { role: "assistant"; content: Array<{ type: string }> }>;

function isAssistantMessage(message: AgentMessage): message is AssistantContentMessage {
	return message.role === "assistant";
}

interface WaitToolCall {
	type: "toolCall";
	id: string;
	name: string;
}

// The `wait` tool call that this scenario injects. Returns its id once resolved, or throws
// so tests fail loudly rather than asserting on an undefined id.
function findWaitToolCallId(messages: AgentMessage[]): string {
	const assistantMessages = messages.filter(isAssistantMessage);
	for (const message of assistantMessages) {
		const block = message.content.find((part) => part.type === "toolCall" && part.name === "wait") as
			| WaitToolCall
			| undefined;
		if (block) {
			return block.id;
		}
	}
	throw new Error("Expected an assistant turn that calls the wait tool");
}

describe("#8537 custom messages injected during tool execution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends the message after the turn's tool results instead of between call and result", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				// A background task (e.g. a subagent reply) notifies the session while the
				// tool is still running.
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ ...fastHarnessOptions, tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			routeTaskToFastPath(),
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("Summary: complete."),
		]);

		await harness.session.prompt("hi");

		const customMsg = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "subagent-reply",
		);
		expect(customMsg).toBeDefined();
		const customIndex = harness.session.messages.indexOf(customMsg!);

		const waitCallId = findWaitToolCallId(harness.session.messages);
		const callIndex = harness.session.messages.findIndex(
			(message) =>
				isAssistantMessage(message) &&
				message.content.some((block) => block.type === "toolCall" && block.name === "wait"),
		);
		expect(callIndex).toBeGreaterThan(-1);

		const waitResultIndex = harness.session.messages.findIndex(
			(message) => message.role === "toolResult" && (message as { toolCallId?: string }).toolCallId === waitCallId,
		);
		expect(waitResultIndex).toBeGreaterThan(callIndex);

		// The custom message must not land between the tool call and its result.
		expect(customIndex).toBeGreaterThan(waitResultIndex);
	});

	it("keeps session entries and message events in the same order as agent state", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ ...fastHarnessOptions, tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			routeTaskToFastPath(),
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("Summary: complete."),
		]);

		await harness.session.prompt("hi");

		// Identify the `wait` tool call id, then assert the `subagent-reply` custom appears
		// after its tool result in session entries and message events — and that all three
		// views (agent state, entries, events) agree on the turn's role sequence. The
		// trailing `fast_path_distillation` summary custom must not be mistaken for the
		// target, so it is matched by customType.
		const waitCallId = findWaitToolCallId(harness.session.messages);

		const entryIndexFor = (predicate: (entry: SessionEntry) => boolean): number => {
			let idx = 0;
			for (const entry of harness.sessionManager.getBranch()) {
				if (predicate(entry)) return idx;
				idx++;
			}
			return -1;
		};

		const entryWaitResult = entryIndexFor(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message as { toolCallId?: string }).toolCallId === waitCallId,
		);
		const entryCustom = entryIndexFor(
			(entry) => entry.type === "custom_message" && entry.customType === "subagent-reply",
		);
		expect(entryWaitResult).toBeGreaterThan(-1);
		expect(entryCustom).toBeGreaterThan(-1);
		expect(entryCustom).toBeGreaterThan(entryWaitResult);

		const eventIndexFor = (predicate: (event: AgentSessionEvent) => boolean): number => {
			let idx = 0;
			for (const event of harness.events) {
				if (predicate(event)) return idx;
				idx++;
			}
			return -1;
		};

		const startWaitResult = eventIndexFor(
			(event) =>
				event.type === "message_start" &&
				event.message.role === "toolResult" &&
				(event.message as { toolCallId?: string }).toolCallId === waitCallId,
		);
		const startCustom = eventIndexFor(
			(event) =>
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "subagent-reply",
		);
		expect(startWaitResult).toBeGreaterThan(-1);
		expect(startCustom).toBeGreaterThan(-1);
		expect(startCustom).toBeGreaterThan(startWaitResult);

		const stateRoles = harness.session.messages.map((message) => message.role);
		const entryRoles = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" ? [entry.message.role] : entry.type === "custom_message" ? ["custom"] : [],
			);
		const eventRoles = harness.events.flatMap((event) =>
			event.type === "message_start" ? [event.message.role] : [],
		);
		expect(entryRoles).toEqual(stateRoles);
		expect(eventRoles).toEqual(stateRoles);
	});

	it("produces an llm history where every tool result follows its tool call", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ ...fastHarnessOptions, tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			routeTaskToFastPath(),
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("second turn"),
		]);

		await harness.session.prompt("hi");
		await harness.session.prompt("and now?");

		const llmMessages = convertToLlm(harness.session.messages);
		const openToolCallIds = new Set<string>();
		for (const message of llmMessages) {
			if (message.role === "assistant") {
				openToolCallIds.clear();
				for (const block of message.content) {
					if (block.type === "toolCall") openToolCallIds.add(block.id);
				}
				continue;
			}
			if (message.role === "toolResult") {
				expect(openToolCallIds.has(message.toolCallId)).toBe(true);
				openToolCallIds.delete(message.toolCallId);
				continue;
			}
			openToolCallIds.clear();
		}
	});
});
