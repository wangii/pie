import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/**
 * The execution role's tool surface is authorized per tool by the tool's declared `roles`.
 *
 * A tool that declares roles without "execution" is dropped from the surface and refused at call
 * time; a tool that declares no roles follows the built-in default and stays available, which is
 * what keeps bare `AgentTool` overrides (which cannot carry a declaration) usable.
 */

const extensionFactories: ExtensionFactory[] = [
	(pi) => {
		pi.on("session_start", () => {
			pi.registerTool({
				name: "exec_tool",
				label: "Exec Tool",
				description: "Declared for the execution role",
				parameters: Type.Object({}),
				roles: ["execution"],
				execute: async () => ({ content: [{ type: "text" as const, text: "exec ok" }], details: {} }),
			});
			pi.registerTool({
				name: "propose_only_tool",
				label: "Propose Only",
				description: "Declared without the execution role",
				parameters: Type.Object({}),
				roles: ["propose"],
				execute: async () => ({ content: [{ type: "text" as const, text: "should not run" }], details: {} }),
			});
			pi.registerTool({
				name: "undeclared_tool",
				label: "Undeclared",
				description: "Carries no roles declaration",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "undeclared ok" }], details: {} }),
			});
		});
	},
];

function roleOf(value: string): "propose" | "execution" | "distill" | "finalReport" | "other" {
	if (value.includes("You are the propose role")) return "propose";
	if (value.includes("You are the execution role")) return "execution";
	if (value.includes("You are the distill role")) return "distill";
	if (value.includes("You synthesize an evidence-grounded answer")) return "finalReport";
	return "other";
}

describe("execution tool authorization by declared roles", () => {
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

	it("offers declared-execution and undeclared tools, drops a non-execution declaration, and refuses it at call time", async () => {
		const harness = await createHarness({ ...fastHarnessOptions, extensionFactories });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const executionToolNames: string[] = [];
		let proposeCount = 0;
		let executionCount = 0;
		const respond = (context: { messages: unknown[] }) => {
			const text = context.messages.map((message) => getMessageText(message)).join("\n");
			const role = roleOf(text);
			if (role === "propose") {
				proposeCount += 1;
				if (proposeCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall("route_task", {
							decision: "fast-path",
							reason: "no unresolved uncertainty can change this action or its safety",
							suitabilityProbability: 0.9,
							successProbability: 0.9,
							estimatedSteps: 1,
							difficulty: "low",
						}),
					]);
				}
				if (proposeCount === 2) {
					return fauxAssistantMessage([
						fauxToolCall("set_formulation", {
							interpretation: "I currently read this as a question about which behavior actually holds",
							focus: "the observations the run produced",
							implication: "which conclusion the answer must report turns on what the run showed",
							reason: "reading after the run",
						}),
					]);
				}
				return fauxAssistantMessage([
					fauxToolCall("focus_beliefs", { beliefIds: [] }),
					fauxToolCall("conclude", { result: "delivered", evidence: "observed" }),
				]);
			}
			if (role === "execution") {
				executionCount += 1;
				if (executionCount === 1) {
					executionToolNames.push(...harness.session.agent.state.tools.map((tool) => tool.name));
					return fauxAssistantMessage([fauxToolCall("propose_only_tool", {})]);
				}
				return fauxAssistantMessage([
					fauxToolCall("report_outcome", { result: "delivered", evidence: "observed" }),
				]);
			}
			if (role === "distill") return fauxAssistantMessage("Summary: completed the request.");
			if (role === "finalReport") return fauxAssistantMessage("done");
			return fauxAssistantMessage("Summary: completed the request.");
		};
		harness.setResponses(Array.from({ length: 40 }, () => respond));

		await harness.session.prompt("please run the tool");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();

		expect(executionToolNames).toContain("exec_tool");
		expect(executionToolNames).toContain("undeclared_tool");
		expect(executionToolNames).toContain("view_beliefs");
		expect(executionToolNames).toContain("report_outcome");
		expect(executionToolNames).not.toContain("propose_only_tool");
		expect(executionToolNames).not.toContain("declare_belief");

		const toolResults = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map(getMessageText);
		// The refusal is the agent's unknown-tool result: the tool was dropped from the surface, so
		// the call never reaches an executor. Either wording is a refusal; the point is it did not run.
		expect(toolResults.some((text) => text.includes("Tool propose_only_tool not found"))).toBe(true);
		expect(toolResults.some((text) => text.includes("should not run"))).toBe(false);
	}, 30000);
});
