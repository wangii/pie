import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BeliefLoopController } from "../src/core/belief-loop/belief-loop-controller.ts";
import { projectContextMessages } from "../src/core/belief-loop/message-projection.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/**
 * The execution role sees the current task only.
 *
 * Prior-task text — user requests, bash output, extension/custom messages, assistant prose and the
 * probe tool results themselves — passes `maskBeliefBookkeeping` unchanged, so the task boundary is
 * applied by index in the execution projection rather than by message role. These tests pin both
 * the projection rule (controller-driven) and its effect on the real prompt path (two tasks in one
 * session). The boundary applies to execution alone: propose and distill keep the retained history
 * they read the task through.
 */

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function userMessage(value: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text: value }], timestamp: 1 } as AgentMessage;
}

function createController(): { controller: BeliefLoopController; messages: AgentMessage[] } {
	const messages: AgentMessage[] = [];
	const host = {
		sessionManager: SessionManager.inMemory(process.cwd(), { id: "session-task-boundary" }),
		_emit: () => {},
		_fullActiveToolNames: ["read", "view_beliefs", "declare_belief", "conclude"],
		agent: { state: { messages } },
	} as unknown as AgentSession;
	return { controller: new BeliefLoopController(host), messages };
}

describe("task-boundary execution projection", () => {
	it("records the boundary in resetLoopForNewTask and keeps only the current task", () => {
		const { controller, messages } = createController();
		const probeResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "TASK-ONE-PROBE-OUTPUT" }],
			isError: false,
			timestamp: 1,
		} as AgentMessage;
		messages.push(userMessage("TASK-ONE-REQUEST"));
		messages.push(probeResult);
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: "TASK-ONE-ASSISTANT" }],
			timestamp: 1,
		} as AgentMessage);

		controller.resetLoopForNewTask();
		expect(controller.taskStartIndex).toBe(messages.length);

		messages.push(userMessage("TASK-TWO-REQUEST"));
		messages.push({
			role: "toolResult",
			toolCallId: "c2",
			toolName: "bash",
			content: [{ type: "text", text: "TASK-TWO-PROBE-OUTPUT" }],
			isError: false,
			timestamp: 2,
		} as AgentMessage);

		const projected = projectContextMessages(messages, "execution", messages.length, true, controller.taskStartIndex);
		const joined = projected.map(textOf).join("\n");
		expect(projected).toHaveLength(2);
		expect(joined).toContain("TASK-TWO-REQUEST");
		expect(joined).toContain("TASK-TWO-PROBE-OUTPUT");
		expect(joined).not.toContain("TASK-ONE-REQUEST");
		expect(joined).not.toContain("TASK-ONE-PROBE-OUTPUT");
		expect(joined).not.toContain("TASK-ONE-ASSISTANT");
	});

	it("keeps a system message that sits before the boundary", () => {
		const { controller, messages } = createController();
		messages.push({ role: "system", content: "SYSTEM-FRAMING", timestamp: 0 } as AgentMessage);
		messages.push(userMessage("TASK-ONE-REQUEST"));
		controller.resetLoopForNewTask();
		messages.push(userMessage("TASK-TWO-REQUEST"));

		const joined = projectContextMessages(messages, "execution", messages.length, true, controller.taskStartIndex)
			.map(textOf)
			.join("\n");
		expect(joined).toContain("SYSTEM-FRAMING");
		expect(joined).toContain("TASK-TWO-REQUEST");
		expect(joined).not.toContain("TASK-ONE-REQUEST");
	});

	it("leaves propose and distill with the retained history", () => {
		const { controller, messages } = createController();
		messages.push(userMessage("TASK-ONE-REQUEST"));
		controller.resetLoopForNewTask();
		messages.push(userMessage("TASK-TWO-REQUEST"));

		for (const role of ["propose", "distill"] as const) {
			const joined = projectContextMessages(messages, role, messages.length, true, controller.taskStartIndex)
				.map(textOf)
				.join("\n");
			expect(joined).toContain("TASK-ONE-REQUEST");
			expect(joined).toContain("TASK-TWO-REQUEST");
		}
	});
});

describe("task-boundary execution projection on the real prompt path", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const fastHarnessOptions = {
		models: [{ id: "default" }, { id: "fast" }, { id: "distill" }],
		settings: {
			defaultModel: "faux/default",
			pie: { fastPathModel: "faux/fast", distillationModel: "faux/distill" },
		},
	};

	function roleOf(value: string): "propose" | "execution" | "distill" | "finalReport" | "other" {
		if (value.includes("You are the propose role")) return "propose";
		if (value.includes("You are the execution role")) return "execution";
		if (value.includes("You are the distill role")) return "distill";
		if (value.includes("You synthesize an evidence-grounded answer")) return "finalReport";
		return "other";
	}

	it("the second task's execution request excludes the first task's request, probe text and answer", async () => {
		let inspectCount = 0;
		const inspectTool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Return an observation",
			parameters: Type.Object({}),
			execute: async () => {
				inspectCount += 1;
				return { content: [{ type: "text", text: `PROBE-OBSERVATION-${inspectCount}` }], details: undefined };
			},
		};
		const harness = await createHarness({ ...fastHarnessOptions, tools: [inspectTool] });
		harnesses.push(harness);

		const executionContexts: string[] = [];
		const proposeContexts: string[] = [];
		const route = () =>
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
		const formulation = () =>
			fauxAssistantMessage([
				fauxToolCall("set_formulation", {
					interpretation: "I currently read this as a question about which behavior actually holds",
					focus: "the observations the run produced",
					implication: "which conclusion the answer must report turns on what the run showed",
					reason: "reading after the run",
				}),
			]);

		// The provider consumes one response step per request, and the loop's turn count per role is
		// not fixed from the test's side, so a state-driven responder is supplied for every request.
		// It keys off the role instruction embedded in the request context, not the step index.
		let task: "one" | "two" = "one";
		let proposeCount = 0;
		let executionCount = 0;
		const respond = (context: { messages: unknown[] }) => {
			const seen = context.messages.map((message) => getMessageText(message)).join("\n");
			if (task === "one" && seen.includes("TASK-TWO-REQUEST")) {
				task = "two";
				proposeCount = 0;
				executionCount = 0;
			}
			const label = task === "two" ? "TASK-TWO" : "TASK-ONE";
			const role = roleOf(seen);
			if (role === "propose") {
				if (task === "two" && proposeCount === 0) proposeContexts.push(seen);
				proposeCount += 1;
				if (proposeCount === 1) return route();
				if (proposeCount === 2) return formulation();
				return fauxAssistantMessage([
					fauxToolCall("focus_beliefs", { beliefIds: [] }),
					fauxToolCall("conclude", { result: `${label}-ANSWER`, evidence: "observed" }),
				]);
			}
			if (role === "execution") {
				executionCount += 1;
				if (task === "two" && executionCount === 1) executionContexts.push(seen);
				if (executionCount === 1) return fauxAssistantMessage([fauxToolCall("inspect", {})]);
				return fauxAssistantMessage([
					fauxToolCall("report_outcome", { result: `${label}-ANSWER`, evidence: "observed" }),
				]);
			}
			if (role === "distill") return fauxAssistantMessage(`Summary: completed the ${label} request.`);
			if (role === "finalReport") return fauxAssistantMessage(`${label}-ANSWER`);
			return fauxAssistantMessage(`Summary: completed the ${label} request.`);
		};

		harness.setResponses(Array.from({ length: 60 }, () => respond));

		await harness.session.prompt("TASK-ONE-REQUEST");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		await harness.session.prompt("TASK-TWO-REQUEST");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();

		expect(executionContexts).toHaveLength(1);
		const execution = executionContexts[0]!;
		expect(execution).toContain("TASK-TWO-REQUEST");
		expect(execution).not.toContain("TASK-ONE-REQUEST");
		expect(execution).not.toContain("PROBE-OBSERVATION-1");
		expect(execution).not.toContain("TASK-ONE-ANSWER");

		// The boundary is execution-only: propose still reads the retained history it organizes the
		// current task through. If the scope is ever widened, this assertion is the guard that says so.
		expect(proposeContexts).toHaveLength(1);
		expect(proposeContexts[0]).toContain("TASK-ONE-REQUEST");
		expect(proposeContexts[0]).toContain("Applied routing");
		expect(proposeContexts[0]).toContain("TASK-TWO-REQUEST");
	}, 30000);
});
