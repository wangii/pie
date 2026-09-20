import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusOf } from "../../src/core/belief-set.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * M4: a user correction stops the round at the tool boundary and hands the next decision to propose.
 *
 * The two things that are easy to get wrong, and that these tests pin, are the *boundary* — calls
 * already in flight must come back while the ones behind them must not start — and the *debt*: an
 * interrupted round still owes distillation for the evidence it gathered, so the correction may not
 * quietly become a way to conclude without adjudicating.
 */
describe("correction handoff", () => {
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

	const routeFast = () =>
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

	const reading = () =>
		fauxToolCall("set_formulation", {
			interpretation: "I currently read this as a question about which target the work names",
			focus: "the target the user's correction points at",
			implication: "which conclusion the answer must report turns on the corrected target",
			reason: "reading after the correction",
		});

	const conclude = () =>
		fauxToolCall("conclude", { result: "delivered the echoed text", evidence: "the echo tool returned ok" });

	const userText = (harness: Harness) =>
		harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");

	/** A probe that blocks until the test releases it, so the correction provably lands mid-round. */
	function gatedProbe(name: string, text: string, gate: Promise<void>): AgentTool {
		return {
			name,
			label: name,
			description: `Probe ${name}`,
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				await gate;
				return { content: [{ type: "text", text }], details: undefined };
			},
		};
	}

	function immediateProbe(name: string, text: string): AgentTool {
		return {
			name,
			label: name,
			description: `Probe ${name}`,
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => ({ content: [{ type: "text", text }], details: undefined }),
		};
	}

	it("lets the started call finish and stops the ones behind it in the same batch", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			...fastHarnessOptions,
			tools: [
				gatedProbe("first_probe", "the first probe found the target", gate),
				immediateProbe("second_probe", "the second probe ran"),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			routeFast(),
			fauxAssistantMessage([fauxToolCall("first_probe", {}), fauxToolCall("second_probe", {})]),
		]);

		const run = harness.session.prompt("probe both targets");
		await vi.waitFor(() => {
			expect(harness.events.some((event) => event.type === "ExecutionStarted")).toBe(true);
		});
		const correction = harness.session.submitFormulationCorrection("you are probing the wrong target");
		release();
		harness.appendResponses([
			fauxAssistantMessage([
				reading(),
				fauxToolCall("answer_correction", {
					correctionId: correction!.id,
					response: "kept the reading; the correction names a different target",
				}),
				conclude(),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("delivered the echoed text"),
		]);
		await run;

		// The call already in flight came back with its real result.
		expect(harness.session.messages.map(getMessageText).join("\n")).toContain("the first probe found the target");
		// The one behind it never ran: it was blocked with a reason naming the correction, which is
		// also what keeps the transcript valid — every call in the message has a result.
		const blocked = harness.eventsOfType("ExecutionStarted").length;
		expect(blocked).toBe(1);
		expect(harness.session.messages.map(getMessageText).join("\n")).not.toContain("the second probe ran");
		expect(userText(harness)).toContain("Blocked: the user corrected the task's reading");
	});

	it("keeps an interrupted round's adjudication debt, and gives the next experiment its own round", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			models: fastHarnessOptions.models,
			settings: fastHarnessOptions.settings,
			tools: [gatedProbe("first_probe", "the probe observed the post-logout read", gate)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a post-logout read keeps the value",
					evidenceRounds: 1,
				}),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				fauxToolCall("select_experiment", { intent: "whether the cache survives logout", beliefIds: ["belief-1"] }),
			]),
			fauxAssistantMessage([fauxToolCall("first_probe", {})]),
		]);

		const run = harness.session.prompt("is the cache persistent?");
		await vi.waitFor(() => {
			expect(harness.events.some((event) => event.type === "ExecutionStarted")).toBe(true);
		});
		const correction = harness.session.submitFormulationCorrection("the question is about the re-arm path");
		release();
		harness.appendResponses([
			// Propose answers, states its reading, drops the belief out of scope, and tries to close
			// the task on the evidence the interrupted round gathered. It may not: nobody has
			// adjudicated that evidence, and scope is not truth — clearing the focus would otherwise
			// be a way to conclude past a belief that was actually probed.
			fauxAssistantMessage([
				fauxToolCall("set_formulation", {
					interpretation: "I currently read this as a question about the re-arm path",
					focus: "where the guard is re-armed",
					implication: "which conclusion the answer reports turns on the re-arm path",
					reason: "the correction moved the reading to the re-arm path",
					citations: [{ kind: "correction", correctionId: correction!.id }],
				}),
				fauxToolCall("answer_correction", {
					correctionId: correction!.id,
					response: "revised the reading to the re-arm path; the evidence still needs adjudicating",
				}),
				fauxToolCall("focus_beliefs", { beliefIds: [] }),
				fauxToolCall("conclude", { result: "delivered", evidence: "the probe observed the read" }),
			]),
			// Sent back to choose again, this time under the corrected reading.
			fauxAssistantMessage([
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				fauxToolCall("select_experiment", { intent: "whether the cache survives logout", beliefIds: ["belief-1"] }),
			]),
			fauxAssistantMessage("Observed:\n- the probe observed the post-logout read."),
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "support",
					beliefId: "belief-1",
					evidence: "the probe observed the post-logout read",
				}),
			]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);
		await run;

		// The conclusion was refused because the interrupted round's belief was never adjudicated.
		expect(userText(harness)).toContain("remain unadjudicated");
		// And the debt was settled in the end, by distill, on evidence that came back.
		expect(harness.session.beliefs.map(statusOf)).toEqual(["supported"]);

		// The interrupted round kept its plan, and the experiment chosen after the correction got a
		// round of its own rather than silently reusing the plan it had already spent.
		const task = [...harness.session.domainSnapshot.tasks.values()][0];
		const dispatched = (task?.episodes ?? [])
			.filter((episode) => episode.body.kind === "belief-loop")
			.map((episode) => (episode.body.kind === "belief-loop" ? episode.body.plan?.selectedToExplore : undefined))
			.filter((selected): selected is readonly string[] => selected !== undefined && selected.length > 0);
		expect(dispatched).toHaveLength(2);
		expect(dispatched.every((selected) => selected.includes("belief-1"))).toBe(true);
	}, 30000);
});
