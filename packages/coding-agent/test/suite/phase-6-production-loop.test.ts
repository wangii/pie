import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { PieProductionLoop, type PieProductionLoopState } from "../../src/core/pie-agent-loop.ts";
import { createHarness, getMessageText } from "./harness.ts";

function control(decision: Record<string, unknown>) {
	return fauxAssistantMessage(JSON.stringify(decision));
}

const productionFrame = {
	kind: "create_frame",
	statement: "Repository behavior is controlled by the current implementation boundary",
	falsifier: "An exact repository or runtime result shows a different boundary controls the behavior",
	horizon: 12,
} as const;

const productionAction = {
	kind: "authorize_action",
	intent: "Inspect the implementation boundary relevant to the request",
	completionCondition: "Exact repository or runtime results establish the relevant implementation behavior",
} as const;

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo one value",
	parameters: Type.Object({ value: Type.String() }),
	execute: async (_toolCallId, params) => ({
		content: [
			{
				type: "text",
				text: typeof params === "object" && params !== null && "value" in params ? String(params.value) : "",
			},
		],
		details: {},
	}),
};

describe("Phase 6 production loop ownership", () => {
	it("automatically drives the surviving epistemic stack for a production request", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
		});
		try {
			harness.setResponses([
				control(productionFrame),
				control(productionAction),
				fauxAssistantMessage("production request investigated"),
				control({ kind: "complete_action", reason: "The bounded investigation condition was met" }),
				control({ kind: "authorize_final", reason: "The first request is satisfied" }),
				fauxAssistantMessage("production request complete"),
				control({ kind: "kill_frame", reason: "The next request requires a distinct investigation" }),
				control({
					kind: "revise_anchor",
					statement: "now verify the follow-up behavior",
					reason: "The user supplied a distinct task",
				}),
				control({
					...productionFrame,
					statement: "Follow-up behavior is controlled by the verification boundary",
				}),
				control({
					...productionAction,
					intent: "Inspect the follow-up verification boundary",
				}),
				fauxAssistantMessage("follow-up investigated"),
				control({ kind: "complete_action", reason: "The follow-up condition was met" }),
				control({ kind: "authorize_final", reason: "The follow-up request is satisfied" }),
				fauxAssistantMessage("follow-up complete"),
			]);

			await harness.session.prompt("implement the requested fix");

			let diagnostics = harness.session.getEpistemicDiagnostics();
			expect(diagnostics.state.anchor?.statement).toBe("implement the requested fix");
			expect(diagnostics.state.frame?.statement).toBe(productionFrame.statement);
			expect(diagnostics.state.action).toBeUndefined();
			expect(diagnostics.state.observations).toEqual([]);
			expect(harness.providerContexts[2]!.messages.map(getMessageText)).toEqual(
				expect.arrayContaining([
					expect.stringContaining("[ANCHOR]"),
					expect.stringContaining("[CURRENT FRAME]"),
					expect.stringContaining("[CURRENT ACTION]"),
				]),
			);

			await harness.session.prompt("now verify the follow-up behavior");

			diagnostics = harness.session.getEpistemicDiagnostics();
			expect(diagnostics.state.anchor).toMatchObject({
				revision: 2,
				statement: "now verify the follow-up behavior",
			});
			expect(diagnostics.state.action).toBeUndefined();
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "completed" }),
				expect.objectContaining({ transition: "completed" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves explicit epistemic directives instead of applying production defaults", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("explicit state retained"),
				control({ kind: "complete_action", reason: "The explicit completion condition was met" }),
				control({ kind: "authorize_final", reason: "The explicit Anchor is satisfied" }),
				fauxAssistantMessage("explicit state retained"),
			]);

			await harness.session.prompt("raw request text", {
				anchor: { statement: "explicit success semantics" },
				frame: {
					type: "create",
					statement: "explicit investigation",
					falsifier: "explicit contradiction",
					horizon: 4,
				},
				action: {
					type: "start",
					intent: "explicit intent",
					completionCondition: "explicit completion",
				},
			});

			const diagnostics = harness.session.getEpistemicDiagnostics();
			expect(diagnostics.state.anchor?.statement).toBe("explicit success semantics");
			expect(diagnostics.state.frame?.statement).toBe("explicit investigation");
			expect(diagnostics.state.action).toBeUndefined();
			expect(harness.sessionManager.getBranch().find((entry) => entry.type === "action_start")).toMatchObject({
				intent: "explicit intent",
				completionCondition: "explicit completion",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("restores an interrupted persisted Action without replaying it or presenting it as completed", async () => {
		const first = await createHarness({
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
		});
		const manager = first.sessionManager;
		try {
			first.setResponses([fauxAssistantMessage("checkpoint")]);
			await first.session.prompt("persist an active episode", {
				anchor: { statement: "preserve restart state" },
				frame: {
					type: "create",
					statement: "restart should restore state",
					falsifier: "state is missing after restart",
					horizon: 4,
				},
				action: { type: "start", intent: "inspect restart", completionCondition: "state is restored" },
			});
		} finally {
			first.cleanup();
		}

		const resumed = await createHarness({
			sessionManager: manager,
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
		});
		try {
			const restored = resumed.session.getEpistemicDiagnostics();
			expect(restored.state.action).toMatchObject({ intent: "inspect restart" });
			expect(restored.state.lastAction?.transition).toBeUndefined();
			expect(resumed.providerContexts).toHaveLength(0);

			resumed.setResponses([
				control({ kind: "unresolvable_action", reason: "The new request supersedes this persisted episode" }),
				control({ kind: "report_inability", reason: "A new bounded investigation must be authorized separately" }),
				fauxAssistantMessage("new request requires a separate investigation"),
			]);
			await resumed.session.prompt("continue with a new bounded request");

			expect(resumed.providerContexts).toHaveLength(3);
			expect(manager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "unresolvable", reason: expect.stringContaining("supersedes") }),
			]);
		} finally {
			resumed.cleanup();
		}
	});

	it("returns interrupted automatic Actions as UNRESOLVABLE provenance", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
		});
		try {
			harness.setResponses([
				control(productionFrame),
				control(productionAction),
				fauxAssistantMessage("cancelled", { stopReason: "aborted" }),
			]);

			await harness.session.prompt("run until interrupted");

			expect(harness.session.action).toBeUndefined();
			expect(harness.sessionManager.getBranch().find((entry) => entry.type === "action_transition")).toMatchObject({
				type: "action_transition",
				transition: "unresolvable",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("preserves the frozen Action across bounded provider retry", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		try {
			harness.setResponses([
				control(productionFrame),
				control(productionAction),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("recovered"),
				control({ kind: "complete_action", reason: "Recovery established the frozen condition" }),
				control({ kind: "authorize_final", reason: "The request is satisfied after recovery" }),
				fauxAssistantMessage("recovered final answer"),
			]);

			await harness.session.prompt("recover without weakening the request");

			expect(harness.providerContexts).toHaveLength(7);
			expect(harness.session.action).toBeUndefined();
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_start")).toHaveLength(1);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "completed" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("returns UNRESOLVABLE after bounded provider recovery is exhausted", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		try {
			harness.setResponses([
				control(productionFrame),
				control(productionAction),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			]);

			await harness.session.prompt("fail in bounded time");

			expect(harness.providerContexts).toHaveLength(4);
			expect(harness.session.action).toBeUndefined();
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "unresolvable" }),
			]);
			expect(harness.session.isIdle).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("routes epistemic requests and Action-local continuations independently", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			models: [
				{ id: "session", reasoning: true, contextWindow: 8_000 },
				{ id: "controller", reasoning: true, contextWindow: 16_000 },
				{ id: "executor", reasoning: false, contextWindow: 32_000 },
			],
			tools: [echoTool],
			pieModelRouteIds: {
				epistemic: "controller",
				execution: "executor",
			},
		});
		try {
			harness.session.setThinkingLevel("high");
			harness.setResponses([
				control(productionFrame),
				control(productionAction),
				fauxAssistantMessage(fauxToolCall("echo", { value: "world-result" }, { id: "routed-call" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("routed completion"),
				control({ kind: "complete_action", reason: "The routed result met the condition" }),
				control({ kind: "authorize_final", reason: "The routed request is satisfied" }),
				fauxAssistantMessage("routed final answer"),
			]);

			await harness.session.prompt("route this request");

			expect(harness.providerModelIds).toEqual([
				"controller",
				"controller",
				"executor",
				"executor",
				"controller",
				"controller",
				"session",
			]);
			expect(harness.providerContexts).toHaveLength(7);
			expect(harness.session.latestContextManifest?.budget.contextWindow).toBe(8_000);
		} finally {
			harness.cleanup();
		}
	});

	it("owns provider requests and tool continuation without invoking the stock loop", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			tools: [echoTool],
		});
		try {
			const loop = harness.session.agent.loopRunner;
			expect(loop).toBeInstanceOf(PieProductionLoop);
			expect(loop.id).toBe("pie-production/v2");

			const states: Array<{ event: string; state: PieProductionLoopState }> = [];
			harness.session.subscribe((event) => {
				states.push({ event: event.type, state: (loop as PieProductionLoop).state });
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", { value: "world-result" }, { id: "phase-6-call" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("completed through Pie"),
			]);

			await harness.session.prompt("run the production loop");

			expect(harness.providerContexts).toHaveLength(2);
			expect(harness.providerContexts[0]!.messages.map(getMessageText)).toContain("run the production loop");
			expect(harness.providerContexts[1]!.messages.map(getMessageText)).toContain("world-result");
			expect(states).toContainEqual({ event: "tool_execution_start", state: "tool_execution" });
			expect(states).toContainEqual({ event: "agent_end", state: "completed" });
			expect((loop as PieProductionLoop).state).toBe("completed");
			expect(harness.session.latestContextManifest?.compilerVersion).toBe("pie-phase-0/v1");
		} finally {
			harness.cleanup();
		}
	});

	it("classifies operational failures without changing the frozen Action contract", async () => {
		const cases = [
			{
				name: "bash",
				args: { command: "missing-command" },
				message: "sh: missing-command: command not found\nCommand exited with code 127",
				expected: "invocation_failure",
			},
			{
				name: "bash",
				args: { command: "run-tests" },
				message: "tests failed\nCommand exited with code 1",
				expected: "completed_negative_result",
			},
			{
				name: "read",
				args: { path: "fixture.txt" },
				message: "Operation aborted",
				expected: "interrupted_execution",
			},
			{
				name: "write",
				args: { path: "fixture.txt", content: "changed" },
				message: "I/O failure after write may have completed",
				expected: "ambiguous_mutation",
			},
		] as const;

		for (const testCase of cases) {
			const tool: AgentTool = {
				name: testCase.name,
				label: testCase.name,
				description: "Fail predictably",
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async () => {
					throw new Error(testCase.message);
				},
			};
			const harness = await createHarness({
				pieProductionLoop: true,
				anchorEnabled: true,
				frameEnabled: true,
				actionEnabled: true,
				observationEnabled: true,
				tools: [tool],
			});
			try {
				harness.setResponses([
					control(productionFrame),
					control(productionAction),
					fauxAssistantMessage(fauxToolCall(testCase.name, testCase.args, { id: `call-${testCase.expected}` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("local repair complete"),
					control({ kind: "complete_action", reason: "The repaired execution established the condition" }),
					control({ kind: "authorize_final", reason: "The request is satisfied" }),
					fauxAssistantMessage("local repair final answer"),
				]);
				await harness.session.prompt(`exercise ${testCase.expected}`);

				expect(harness.eventsOfType("operational_error")).toContainEqual(
					expect.objectContaining({
						classification: testCase.expected,
						attempt: 1,
						maxAttempts: 3,
						frozenContract: true,
					}),
				);
				expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_start")).toHaveLength(1);
			} finally {
				harness.cleanup();
			}
		}
	});

	it("blocks blind ambiguous-mutation replay and returns UNRESOLVABLE when repair is exhausted", async () => {
		const writeTool: AgentTool = {
			name: "write",
			label: "write",
			description: "Ambiguous write fixture",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute: async () => {
				throw new Error("I/O failure after mutation may have completed");
			},
		};
		const harness = await createHarness({
			pieProductionLoop: true,
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			tools: [writeTool],
		});
		try {
			const call = { path: "state.txt", content: "changed" };
			harness.setResponses([
				control(productionFrame),
				control(productionAction),
				fauxAssistantMessage(fauxToolCall("write", call, { id: "write-1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("write", call, { id: "write-2" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("write", call, { id: "write-3" }), { stopReason: "toolUse" }),
				control({ kind: "report_inability", reason: "Operational repair was exhausted" }),
				fauxAssistantMessage("Unable to replay the ambiguous mutation safely."),
			]);

			await harness.session.prompt("perform a bounded mutation");

			const errors = harness.eventsOfType("operational_error");
			expect(errors.map((event) => event.classification)).toEqual([
				"ambiguous_mutation",
				"pre_execution_rejection",
				"pre_execution_rejection",
			]);
			expect(errors.at(-1)).toMatchObject({ attempt: 3, maxAttempts: 3 });
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({
					transition: "unresolvable",
					reason: expect.stringContaining("Operational repair exhausted after 3/3"),
				}),
			]);
			expect(harness.providerContexts).toHaveLength(7);
			expect((harness.session.agent.loopRunner as PieProductionLoop).state).toBe("completed");
			expect(harness.session.isIdle).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("drains a queued steering request before the next provider continuation", async () => {
		let releaseTool = (): void => {};
		const toolReleased = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test to release execution",
			parameters: Type.Object({}),
			execute: async () => {
				await toolReleased;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ pieProductionLoop: true, tools: [waitTool] });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}, { id: "wait-call" }), { stopReason: "toolUse" }),
				(context) => {
					const texts = context.messages.map(getMessageText);
					return fauxAssistantMessage(texts.includes("steer now") ? "steering received" : "steering missing");
				},
			]);
			const toolStarted = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "tool_execution_start") {
						unsubscribe();
						resolve();
					}
				});
			});

			const run = harness.session.prompt("start waiting");
			await toolStarted;
			await harness.session.prompt("steer now", { streamingBehavior: "steer" });
			releaseTool();
			await run;

			expect(harness.providerContexts).toHaveLength(2);
			expect(harness.providerContexts[1]!.messages.map(getMessageText)).toContain("steer now");
			expect(harness.session.getLastAssistantText()).toBe("steering received");
			expect(harness.session.agent.loopRunner.id).toBe("pie-production/v2");
		} finally {
			harness.cleanup();
		}
	});
});
