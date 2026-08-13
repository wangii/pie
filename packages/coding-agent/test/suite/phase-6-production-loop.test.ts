import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { PieProductionLoop, type PieProductionLoopState } from "../../src/core/pie-agent-loop.ts";
import { createHarness, getMessageText } from "./harness.ts";

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
	it("owns provider requests and tool continuation without invoking the stock loop", async () => {
		const harness = await createHarness({
			pieProductionLoop: true,
			tools: [echoTool],
		});
		try {
			const loop = harness.session.agent.loopRunner;
			expect(loop).toBeInstanceOf(PieProductionLoop);
			expect(loop.id).toBe("pie-production/v1");

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
			expect(states).toContainEqual({ event: "tool_execution_start", state: "executing_tools" });
			expect(states).toContainEqual({ event: "agent_end", state: "finished" });
			expect((loop as PieProductionLoop).state).toBe("idle");
			expect(harness.session.latestContextManifest?.compilerVersion).toBe("pie-phase-0/v1");
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
			expect(harness.session.agent.loopRunner.id).toBe("pie-production/v1");
		} finally {
			harness.cleanup();
		}
	});
});
