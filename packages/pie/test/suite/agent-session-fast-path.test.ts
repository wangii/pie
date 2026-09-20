import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession fast path", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const routeResponse = (decision: "fast-path" | "belief-loop") =>
		fauxAssistantMessage([
			fauxToolCall("route_task", {
				decision,
				reason:
					decision === "fast-path"
						? "no unresolved uncertainty can change this action or its safety"
						: "material uncertainty could change the action",
				suitabilityProbability: decision === "fast-path" ? 0.9 : 0.2,
				successProbability: decision === "fast-path" ? 0.9 : 0.6,
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

	/**
	 * The formulation propose owes once a round has completed. Both handoff paths — a failed fast
	 * path and the first belief-loop round — return to propose, and propose cannot conclude or
	 * choose another experiment until it has said what it makes of the task.
	 */
	const formulation = () =>
		fauxToolCall("set_formulation", {
			interpretation: "I currently read this as a question about which behavior actually holds",
			focus: "the observations the run produced",
			implication: "which conclusion the answer must report turns on what the run showed",
			reason: "reading after the first round",
		});

	it("stores routing as control metadata and lets fast execution own the terminal response", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);
		harness.setResponses([
			routeResponse("fast-path"),
			fauxAssistantMessage([
				fauxToolCall("report_outcome", { result: "echoed hello", evidence: "the echo tool returned ok" }),
			]),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Summary: completed the request."),
		]);

		await harness.session.prompt("please echo hello");

		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(1);
		expect(harness.session.beliefs).toHaveLength(0);
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"Done.",
		);
		const summary = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "fast_path_distillation",
		);
		expect(summary).toBeDefined();
		expect((summary as { details?: { outcome?: string } }).details?.outcome).toBe("success");
	});

	it("hands a failed fast path back to propose without replaying its consumed route", async () => {
		const boomTool: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "Always fails",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("boom");
			},
		};
		const harness = await createHarness({ ...fastHarnessOptions, tools: [boomTool] });
		harnesses.push(harness);
		harness.setResponses([
			routeResponse("fast-path"),
			fauxAssistantMessage([fauxToolCall("boom", {})]),
			fauxAssistantMessage("I failed."),
			fauxAssistantMessage("Summary: failed at boom."),
			fauxAssistantMessage([formulation(), fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("belief loop took over"),
		]);

		await harness.session.prompt("run boom");

		const summaries = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "fast_path_distillation",
		);
		expect(summaries).toHaveLength(1);
		expect((summaries[0] as { details?: { outcome?: string } }).details?.outcome).toBe("failure");
		expect(harness.eventsOfType("RoutingDecided")).toHaveLength(1);
	});

	it("preserves prior-turn successful actions in a failed fast-path handoff", async () => {
		const inspectTool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Return a code observation",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "the generated file is derived from the template" }],
				details: undefined,
			}),
		};
		const boomTool: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "Always fails",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("boom");
			},
		};
		const harness = await createHarness({ ...fastHarnessOptions, tools: [inspectTool, boomTool] });
		harnesses.push(harness);
		harness.setResponses([
			routeResponse("fast-path"),
			// First turn: a successful probe the failing final turn never restates.
			fauxAssistantMessage([fauxToolCall("inspect", {})]),
			// Next turn: the tool that fails, in the same fast-path fragment and before the
			// settlement turn (a plain-text turn would stop the fast path).
			fauxAssistantMessage([fauxToolCall("boom", {})]),
			fauxAssistantMessage("I failed."),
			// The summarizer's prose omits the prior successful probe; the deterministic
			// operation record appended to the handoff must still surface it.
			fauxAssistantMessage("Summary: complete the task in the belief loop."),
			fauxAssistantMessage([formulation(), fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("belief loop took over"),
		]);

		await harness.session.prompt("run a probe then boom");

		const summaries = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "fast_path_distillation",
		);
		expect(summaries).toHaveLength(1);
		expect((summaries[0] as { details?: { outcome?: string } }).details?.outcome).toBe("failure");
		const summaryText = getMessageText(summaries[0]);
		expect(summaryText).toContain("Completed operations:");
		expect(summaryText).toContain("tool inspect");
		expect(summaryText).toContain("tool boom");
	});

	it("keeps belief-loop execution for material uncertainty", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);
		harness.setResponses([
			routeResponse("belief-loop"),
			fauxAssistantMessage([
				formulation(),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a post-logout probe keeps the value",
					evidenceRounds: 1,
				}),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				fauxToolCall("select_experiment", {
					intent: "whether the cache is persistent",
					beliefIds: ["belief-1"],
				}),
			]),
			fauxAssistantMessage("Observed:\n- the post-logout value persisted."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the post-logout value persisted as predicted",
				}),
			]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		expect(
			harness.session.messages.find(
				(message) => message.role === "custom" && message.customType === "fast_path_distillation",
			),
		).toBeUndefined();
		expect(harness.session.beliefs[0]?.supportedBy).toHaveLength(1);
	});

	it("blocks fast path while an unresolved belief could affect execution", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("route_task", {
					decision: "fast-path",
					reason: "the operation looks simple",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
				}),
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the target file is generated",
					domain: "code",
					expectation: "the repository marks the file as generated",
					evidenceRounds: 1,
				}),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
			]),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", { op: "retract", beliefId: "belief-1" }),
				fauxToolCall("route_task", {
					decision: "fast-path",
					reason: "evidence outside this run established that the generated file is not the target",
					suitabilityProbability: 0.9,
					successProbability: 0.9,
					estimatedSteps: 1,
					difficulty: "low",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("report_outcome", { result: "edited the target file", evidence: "the write returned ok" }),
			]),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Summary: completed after excluding the irrelevant target."),
		]);

		await harness.session.prompt("edit the target file");

		expect(harness.session.messages.some((message) => getMessageText(message).includes("Fast path is blocked"))).toBe(
			true,
		);
		expect(
			harness.session.messages.find(
				(message) => message.role === "custom" && message.customType === "fast_path_distillation",
			),
		).toBeDefined();
	});

	it("does not mark a fast path successful when the submitted outcome carries a blocker", async () => {
		const harness = await createHarness(fastHarnessOptions);
		harnesses.push(harness);
		harness.setResponses([
			routeResponse("fast-path"),
			fauxAssistantMessage([
				fauxToolCall("report_outcome", {
					result: "changed one of the two call sites",
					evidence: "the first call site's test passed",
					blockers: "the second call site is still untested",
				}),
			]),
			fauxAssistantMessage("Partially done."),
			fauxAssistantMessage("Summary: one call site changed, the other not verified."),
			fauxAssistantMessage([formulation(), fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage([fauxToolCall("conclude", { result: "delivered", evidence: "observed" })]),
			fauxAssistantMessage("belief loop took over"),
		]);

		await harness.session.prompt("change both call sites");

		const summaries = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "fast_path_distillation",
		);
		expect(summaries).toHaveLength(1);
		expect((summaries[0] as { details?: { outcome?: string } }).details?.outcome).toBe("failure");
	});
});
