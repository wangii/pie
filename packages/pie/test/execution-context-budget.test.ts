import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import { statusOf } from "../src/core/belief-set.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/**
 * The execution -> distill transition carries a hard budget: a trajectory that grows past half the
 * execution role model's context window is distilled before it grows further.
 *
 * The two runs below execute the same script and differ only in the model's context window, so the
 * limit is the only variable: a small window trips it, a large one does not.
 */

function roleOf(value: string): "propose" | "execution" | "distill" | "finalReport" | "other" {
	if (value.includes("You are the propose role")) return "propose";
	if (value.includes("You are the execution role")) return "execution";
	if (value.includes("You are the distill role")) return "distill";
	if (value.includes("You synthesize an evidence-grounded answer")) return "finalReport";
	return "other";
}

/** A probe result large enough that a small window is passed by it alone. */
const BIG_PROBE_RESULT = "PROBE-OBSERVATION ".repeat(2000);

describe("execution context budget", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(contextWindow: number): Promise<{ harness: Harness; userText: string; executions: number }> {
		const inspectTool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Return a large observation",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: BIG_PROBE_RESULT }], details: undefined }),
		};
		const harness = await createHarness({
			models: [{ id: "default", contextWindow }],
			settings: { compaction: { enabled: false } },
			tools: [inspectTool],
		});
		harnesses.push(harness);

		let proposeCount = 0;
		let executions = 0;
		const respond = (context: { messages: unknown[] }) => {
			const seen = context.messages.map((message) => getMessageText(message)).join("\n");
			const role = roleOf(seen);
			if (role === "propose") {
				proposeCount += 1;
				if (proposeCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall("declare_belief", {
							op: "propose",
							statement: "the cache survives logout",
							domain: "product",
							expectation: "a probe returns the cached value",
							evidenceRounds: 2,
						}),
						fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
						fauxToolCall("set_formulation", {
							interpretation: "I currently read this as a question about which behavior actually holds",
							focus: "the observations the selected beliefs predict",
							implication: "which conclusion the answer must report turns on what the probe shows",
							reason: "initial reading before the first probe",
						}),
					]);
				}
				if (proposeCount === 2) {
					return fauxAssistantMessage([
						fauxToolCall("review_applicability", {
							entries: [{ beliefId: "belief-1", decision: "carries-over", reason: "still the question" }],
						}),
						fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
						fauxToolCall("select_experiment", { intent: "which action to take", beliefIds: ["belief-1"] }),
					]);
				}
				return fauxAssistantMessage([
					fauxToolCall("recheck_formulation", { reason: "the round's evidence fits the current reading" }),
					fauxToolCall("conclude", { result: "delivered", evidence: "observed" }),
				]);
			}
			if (role === "execution") {
				executions += 1;
				if (executions <= 2) return fauxAssistantMessage([fauxToolCall("inspect", {})]);
				return fauxAssistantMessage("Observed:\n- a partial observation.");
			}
			if (role === "distill") {
				return fauxAssistantMessage([
					fauxToolCall("declare_belief", {
						op: "support",
						beliefId: "belief-1",
						evidence: "the observed value confirms the cache persists",
					}),
				]);
			}
			if (role === "finalReport") return fauxAssistantMessage("The cache persists.");
			return fauxAssistantMessage("Summary: completed the request.");
		};
		harness.setResponses(Array.from({ length: 40 }, () => respond));

		await harness.session.prompt("does the cache persist?");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();

		const userText = harness.session.messages
			.filter((message) => message.role === "user")
			.map((message) => getMessageText(message))
			.join("\n");
		return { harness, userText, executions };
	}

	test("distills early when the execution trajectory passes half the context window", async () => {
		const { harness, userText } = await run(2000);
		expect(userText).toContain("reached half the execution model's context window");
		expect(statusOf(harness.session.beliefs[0]!)).toBe("supported");
	}, 30000);

	test("leaves a trajectory under the budget running in execution", async () => {
		const { harness, userText } = await run(1_000_000);
		expect(userText).not.toContain("reached half the execution model's context window");
		expect(statusOf(harness.session.beliefs[0]!)).toBe("supported");
	}, 30000);

	/**
	 * Drive a fast-path execution with an unbounded stream of probe turns. The session model uses a
	 * huge window; only the fast path's own configured model window varies, so the threshold basis
	 * decides whether the run settles early.
	 */
	async function runFastPath(fastPathWindow: number): Promise<{ executions: number }> {
		const inspectTool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Return a large observation",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: BIG_PROBE_RESULT }], details: undefined }),
		};
		const harness = await createHarness({
			models: [
				{ id: "default", contextWindow: 1_000_000 },
				{ id: "fast", contextWindow: fastPathWindow },
			],
			settings: {
				compaction: { enabled: false },
				defaultModel: "faux/default",
				pie: { fastPathModel: "faux/fast" },
			},
			tools: [inspectTool],
		});
		harnesses.push(harness);

		let proposeCount = 0;
		let executions = 0;
		const respond = (context: { messages: unknown[] }) => {
			const seen = context.messages.map((message) => getMessageText(message)).join("\n");
			const role = roleOf(seen);
			if (role === "propose") {
				proposeCount += 1;
				if (proposeCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall("route_task", {
							decision: "fast-path",
							reason: "no unresolved uncertainty can change this action or its safety",
							suitabilityProbability: 0.9,
							successProbability: 0.9,
							estimatedSteps: 6,
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
				executions += 1;
				if (executions <= 20) return fauxAssistantMessage([fauxToolCall("inspect", {})]);
				return fauxAssistantMessage([
					fauxToolCall("report_outcome", { result: "delivered", evidence: "observed" }),
				]);
			}
			if (role === "distill") return fauxAssistantMessage("Summary: completed the request.");
			if (role === "finalReport") return fauxAssistantMessage("done");
			return fauxAssistantMessage("Summary: completed the request.");
		};
		harness.setResponses(Array.from({ length: 60 }, () => respond));

		await harness.session.prompt("please run the tool");
		harness.session.approveFormulation();
		await harness.session.waitForIdle();
		return { executions };
	}

	test("fast path settles early against its own model window, not the session model", async () => {
		const { executions } = await runFastPath(2000);
		expect(executions).toBeLessThanOrEqual(3);
	}, 30000);

	test("fast path under its model window is not settled early", async () => {
		const { executions } = await runFastPath(1_000_000);
		expect(executions).toBeGreaterThanOrEqual(8);
	}, 30000);
});
