import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { PieProductionLoop } from "../../src/core/pie-agent-loop.ts";
import { createHarness, getMessageText } from "./harness.ts";

function control(decision: Record<string, unknown>) {
	if (
		(decision.kind === "create_frame" || decision.kind === "revise_frame" || decision.kind === "replace_frame") &&
		!("actions" in decision)
	) {
		const { horizon: _legacyHorizon, ...withoutHorizon } = decision;
		return fauxAssistantMessage(JSON.stringify({ ...withoutHorizon, actions: [actionBudget(action)] }));
	}
	return fauxAssistantMessage(JSON.stringify(decision));
}

const inspectTool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "Return a deterministic world result",
	parameters: Type.Object({ value: Type.String() }),
	execute: async (_toolCallId, params) => ({
		content: [
			{
				type: "text",
				text: `observed:${typeof params === "object" && params !== null && "value" in params ? String(params.value) : ""}`,
			},
		],
		details: {},
	}),
};

const action = {
	intent: "Inspect cache lifetime and the restart boundary",
	completionCondition: "The cache lifetime and restart behavior are established by exact tool results",
	expectation: "A restart test result shows the failure persists across the cache lifetime boundary",
} as const;

const secondAction = {
	intent: "Inspect whether invalidation crosses the worker boundary",
	completionCondition: "An exact result establishes whether worker invalidation occurs",
	expectation: "An exact result shows invalidation crosses the worker boundary",
} as const;

const authorizeFirstAction = { kind: "authorize_action", actionContractId: "A1" } as const;
const authorizeSecondAction = { kind: "authorize_action", actionContractId: "A2" } as const;

function actionBudget(
	definition: { intent: string; completionCondition: string; expectation: string },
	expectedEvidenceRounds = 3,
) {
	return {
		...definition,
		expectedEvidenceRounds,
		budgetReason:
			expectedEvidenceRounds === 1
				? "One response can issue all independent known probes"
				: "Each later probe depends on the path or runtime result returned by the preceding probe",
	};
}

const frame = {
	kind: "create_frame",
	statement: "Repository behavior is controlled by the persisted cache boundary",
	expectation: "A restart test shows the failure persists after every cache instance is recreated",
	actions: [actionBudget(action), actionBudget(secondAction, 1)],
} as const;

function fullStackOptions() {
	return {
		pieProductionLoop: true,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled: true,
		tools: [inspectTool],
		frameHorizonRange: { min: 6, max: 32 },
	};
}

describe("Phase 7 production control flow", () => {
	it("creates a semantic Frame and authorizes a bounded Action before execution", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeFirstAction),
				fauxAssistantMessage("inspection result is ready"),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "Exact cache lifetime evidence was collected from the restart test",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("The persisted cache boundary controls the behavior."),
			]);

			await harness.session.prompt("diagnose the restart failure");

			const branch = harness.sessionManager.getBranch();
			const createdFrame = branch.find((entry) => entry.type === "frame_revision");
			const startedAction = branch.find((entry) => entry.type === "action_start");
			expect(createdFrame).toMatchObject({
				statement: frame.statement,
				expectation: frame.expectation,
				horizon: 12,
			});
			expect(createdFrame?.type === "frame_revision" ? createdFrame.statement : undefined).not.toBe(
				"diagnose the restart failure",
			);
			expect(startedAction).toMatchObject({
				intent: action.intent,
				completionCondition: action.completionCondition,
			});
			expect(branch.filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({ transition: "completed" }),
			]);
			expect(harness.session.getLastAssistantText()).toBe("The persisted cache boundary controls the behavior.");
			expect(harness.session.agent.loopRunner).toBeInstanceOf(PieProductionLoop);
			expect(harness.providerContexts).toHaveLength(6);
			expect(harness.providerContexts.every((context) => context.messages.length > 0)).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects natural-task Frame and Action degeneration before execution", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement:
						"Investigate the frame/action degeneration regression: trace state transitions, locate the root cause, and deliver a diagnosis with a fix.",
					expectation:
						"No concrete degeneration site or root cause can be located after inspecting the transition paths.",
					horizon: 16,
				}),
				control({
					kind: "create_frame",
					statement: "Action lifetime is controlled only by the containing Frame response lease",
					expectation: "A distinct Action response budget returns control before the Frame lease expires",
					actions: [
						actionBudget({
							intent: "Trace the Frame and Action transition paths end to end",
							completionCondition:
								"A concrete diagnosis with code references and a proposed fix, or a confirmed absence, is delivered",
							expectation: "The trace result shows the Frame and Action transition paths in source",
						}),
					],
				}),
				control({
					kind: "create_frame",
					statement: "Action lifetime is controlled only by the containing Frame response lease",
					expectation: "A distinct Action response budget returns control before the Frame lease expires",
					actions: [
						actionBudget({
							intent: "Inspect where Action lifetime is bounded relative to the Frame lease",
							completionCondition:
								"Exact source locations establish whether Action has an independent response boundary",
							expectation:
								"Exact source locations show the Action response boundary relative to the Frame lease",
						}),
					],
				}),
				control(authorizeFirstAction),
				fauxAssistantMessage("The bounded source locations are established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The exact Action lifetime boundary was established in the source",
					},
				}),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("The Action boundary was verified."),
			]);

			await harness.session.prompt(
				"Investigate the frame/action degeneration regression: trace state transitions, locate the root cause, and deliver a diagnosis with a fix.",
			);

			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "frame_revision")).toEqual([
				expect.objectContaining({
					statement: "Action lifetime is controlled only by the containing Frame response lease",
				}),
			]);
			expect(branch.filter((entry) => entry.type === "action_start")).toEqual([
				expect.objectContaining({
					intent: "Inspect where Action lifetime is bounded relative to the Frame lease",
				}),
			]);
			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Frame statement must assert one provisional world relation",
			);
			expect(harness.providerContexts[2]!.systemPrompt).toContain(
				"previous decision was rejected: Action must authorize one finite episode",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes non-ASCII Anchor text before semantic Frame validation", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "调查工具说明如何适配认识循环和执行循环并给出具体修改",
					expectation: "没有发现工具说明与两个循环之间的具体差异",
					horizon: 12,
				}),
				control({
					kind: "create_frame",
					statement: "工具调用结果的意义而非工具名称决定其所属循环",
					expectation: "同一工具的所有结果都被运行时固定归入同一个循环",
					horizon: 12,
				}),
				control(authorizeFirstAction),
				fauxAssistantMessage("bounded result"),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The bounded result was established in the runtime configuration",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("调查工具说明如何适配认识循环和执行循环并给出具体修改");

			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_revision")).toEqual([
				expect.objectContaining({ statement: "工具调用结果的意义而非工具名称决定其所属循环" }),
			]);
			expect(harness.providerContexts[1]!.systemPrompt).toContain("previous decision was rejected");
		} finally {
			harness.cleanup();
		}
	});

	it("requires a contradictory expectation and preserves explicit adjudication under a derived Frame lease", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "The restart probe produces a cache-invalidating result",
					expectation: "Running the restart probe produces the cache-invalidating result",
					horizon: 1,
				}),
				control({
					kind: "create_frame",
					statement:
						"The concrete expectation prescribed by the report will occur when its restart probe runs, contradicting worker-local cache persistence",
					expectation: "The authorization failure persists after a clean worker restart",
					horizon: 1,
				}),
				control({
					kind: "create_frame",
					statement: "Worker-local cache persistence explains the authorization failure",
					expectation: "The authorization failure persists after a clean worker restart",
					horizon: 1,
				}),
				control({
					kind: "falsify_frame",
					reason: "The clean-restart result directly contradicts worker-local cache persistence",
				}),
				control({ kind: "report_inability", reason: "Boundary adjudication was verified" }),
				fauxAssistantMessage("The explicit falsification was preserved."),
			]);

			await harness.session.prompt("adjudicate the restart evidence at the lease boundary");

			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "frame_revision")).toHaveLength(1);
			expect(branch.filter((entry) => entry.type === "frame_transition")).toEqual([
				expect.objectContaining({ transition: "falsified" }),
			]);
			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Frame expectation must name the concrete observable result you predict confirms",
			);
			expect(harness.providerContexts[2]!.systemPrompt).toContain(
				"previous decision was rejected: Frame statement must assert one provisional world relation",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("does not let an ordinary stop complete the active Action", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeFirstAction),
				fauxAssistantMessage("This looks finished, but no exact result establishes the condition."),
				control({ kind: "continue_action", reason: "The completion condition is not established" }),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "cache" }, { id: "inspect-cache" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The exact result is now available."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The exact tool result establishes the cache behavior condition",
					},
				}),
				control({ kind: "authorize_final", reason: "Anchor satisfaction is established" }),
				fauxAssistantMessage("Verified from the exact result."),
			]);

			await harness.session.prompt("verify cache behavior");

			const branch = harness.sessionManager.getBranch();
			const transitions = branch.filter((entry) => entry.type === "action_transition");
			expect(transitions).toHaveLength(1);
			expect(transitions[0]).toMatchObject({ transition: "completed" });
			const premature = branch.find(
				(entry) => entry.type === "action_transition" && entry.reason.includes("looks finished"),
			);
			expect(premature).toBeUndefined();
			expect(harness.providerContexts[4]!.messages.map(getMessageText)).toContain(
				"This looks finished, but no exact result establishes the condition.",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("projects the current Action as exclusive execution scope", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeFirstAction),
				(context) => {
					const instruction = context.messages
						.map(getMessageText)
						.find((text) => text.includes("exclusive scope"));
					return fauxAssistantMessage(
						instruction ? "stopped at the current condition" : "scope instruction missing",
					);
				},
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The exact current condition was established in the active episode",
					},
				}),
				control({ kind: "authorize_final", reason: "Scope projection was verified" }),
				fauxAssistantMessage("Scope verified."),
			]);

			await harness.session.prompt("verify exclusive Action scope");

			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_start")).toHaveLength(1);
			expect(harness.session.getLastAssistantText()).toBe("Scope verified.");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps one frozen Action across multiple responses and tool calls", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeFirstAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "first" }, { id: "inspect-first" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "second" }, { id: "inspect-second" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Both boundaries are established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "Both exact results satisfy the frozen cache boundary condition",
					},
				}),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("Both boundaries were verified."),
			]);

			await harness.session.prompt("inspect both boundaries");

			const branch = harness.sessionManager.getBranch();
			const starts = branch.filter((entry) => entry.type === "action_start");
			expect(starts).toHaveLength(1);
			expect(starts[0]).toMatchObject({
				intent: action.intent,
				completionCondition: action.completionCondition,
			});
			expect(branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(
				2,
			);
			expect(branch.filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({
					transition: "completed",
					startEntryId: starts[0]!.id,
				}),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("allows one Frame to authorize sequential Actions without revision", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeFirstAction),
				fauxAssistantMessage("First result established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The first bounded cache condition was met by the exact result",
					},
				}),
				control(authorizeSecondAction),
				fauxAssistantMessage("Second result established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The second bounded cache condition was met by the exact result",
					},
				}),
				control({ kind: "authorize_final", reason: "Both required facts establish the Anchor" }),
				fauxAssistantMessage("Both investigations completed."),
			]);

			await harness.session.prompt("diagnose both cache boundaries");

			const branch = harness.sessionManager.getBranch();
			const frames = branch.filter((entry) => entry.type === "frame_revision");
			const actions = branch.filter((entry) => entry.type === "action_start");
			expect(frames).toHaveLength(1);
			expect(actions).toHaveLength(2);
			expect(new Set(actions.map((entry) => entry.frameRevisionEntryId))).toEqual(new Set([frames[0]!.id]));
			expect(branch.filter((entry) => entry.type === "action_transition")).toHaveLength(2);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a conditional meta-Frame that turns its probe into support", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement:
						"The report accurately identifies worker-local cache as the cause only if its restart probe reproduces the failure",
					expectation: "Running the restart probe does not reproduce the authorization failure",
					horizon: 16,
				}),
				control(frame),
				control({ kind: "report_inability", reason: "Conditional Frame rejection was verified" }),
				fauxAssistantMessage("The conditional Frame was rejected."),
			]);

			await harness.session.prompt("verify that the restart probe remains a expectation");

			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_revision")).toEqual([
				expect.objectContaining({ statement: frame.statement }),
			]);
			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Frame statement must assert one provisional world relation",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves explicit Action completion within the derived Frame lease", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(authorizeFirstAction),
				fauxAssistantMessage("The exact bounded result is established."),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The bounded result is established at the lease boundary in the active episode",
					},
				}),
				control({ kind: "authorize_final", reason: "The completed Action establishes the Anchor" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("complete exactly at the Frame lease boundary");

			const branch = harness.sessionManager.getBranch();
			const actionCompletionIndex = branch.findIndex(
				(entry) => entry.type === "action_transition" && entry.transition === "completed",
			);
			const frameExpiryIndex = branch.findIndex(
				(entry) => entry.type === "frame_transition" && entry.transition === "expired",
			);
			expect(actionCompletionIndex).toBeGreaterThan(-1);
			expect(frameExpiryIndex).toBe(-1);
			expect(harness.providerContexts[5]!.systemPrompt).toContain(
				"Epistemic control established Anchor satisfaction and authorized the final answer",
			);
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});

	it("returns control before one Action can consume the containing Frame lease", async () => {
		const harness = await createHarness({
			...fullStackOptions(),
			actionResponseLimit: 4,
		});
		try {
			harness.setResponses([
				control({
					...frame,
					actions: [actionBudget(action, 2), actionBudget(secondAction, 1)],
				}),
				control(authorizeFirstAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "first" }, { id: "inspect-budget-first" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "second" }, { id: "inspect-budget-second" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The episode result remains incomplete."),
				control({ kind: "continue_action", reason: "Try to keep the same episode alive" }),
				control(authorizeSecondAction),
				fauxAssistantMessage("remaining boundary established"),
				control({
					kind: "complete_action",
					predictionError: {
						sign: "confirmed",
						detail: "The remaining bounded result was established by the exact evidence",
					},
				}),
				control({ kind: "authorize_final", reason: "Both bounded results establish the Anchor" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("inspect cache behavior without one task-sized Action");

			const branch = harness.sessionManager.getBranch();
			const frameEntry = branch.find((entry) => entry.type === "frame_revision");
			const starts = branch.filter((entry) => entry.type === "action_start");
			const transitions = branch.filter((entry) => entry.type === "action_transition");
			expect(starts).toHaveLength(2);
			expect(new Set(starts.map((entry) => entry.frameRevisionEntryId))).toEqual(
				new Set([frameEntry?.type === "frame_revision" ? frameEntry.id : undefined]),
			);
			expect(transitions).toEqual([
				expect.objectContaining({
					transition: "unresolvable",
					reason: expect.stringContaining("2-round serial evidence budget"),
				}),
				expect.objectContaining({ transition: "completed" }),
			]);
			expect(branch.filter((entry) => entry.type === "frame_transition")).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("returns control when the accepted evidence-round estimate is exhausted", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({ ...frame, actions: [actionBudget(action, 1)] }),
				control(authorizeFirstAction),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "inconclusive" }, { id: "lease-round" }), {
					stopReason: "toolUse",
				}),
				control({ kind: "continue_action", reason: "Try to extend the exhausted estimate" }),
				control({ kind: "report_inability", reason: "The bounded evidence round was inconclusive" }),
				fauxAssistantMessage("Unable to establish the result within the evidence-round budget."),
			]);

			await harness.session.prompt("diagnose within a bounded lease");

			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "action_transition")).toEqual([
				expect.objectContaining({
					transition: "unresolvable",
					reason: expect.stringContaining("1-round serial evidence budget"),
				}),
			]);
			expect(branch.filter((entry) => entry.type === "frame_transition")).toHaveLength(0);
			// A budget-exhaustion unresolvable still materializes the epistemic unit —
			// a refuted prediction error — so the controller is not left to verify raw
			// evidence itself.
			const refutedObservation = harness.session.observations.find(
				(observation) => observation.predictionErrorSign === "refuted",
			);
			expect(refutedObservation).toBeDefined();
			expect(refutedObservation?.statement).toContain("refuted");
			expect(harness.session.getLastAssistantText()).toContain("evidence-round budget");
		} finally {
			harness.cleanup();
		}
	});

	it("authorizes different first Actions for competing Frames under the same Anchor", async () => {
		const run = async (candidateFrame: Record<string, unknown>) => {
			const harness = await createHarness(fullStackOptions());
			try {
				harness.setResponses([
					control(candidateFrame),
					control(authorizeFirstAction),
					fauxAssistantMessage("bounded result"),
					control({
						kind: "complete_action",
						predictionError: {
							sign: "confirmed",
							detail: "The candidate result was established by the exact source evidence",
						},
					}),
					control({ kind: "authorize_final", reason: "The shared Anchor is satisfied" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("diagnose the shared authorization failure");
				return harness.sessionManager.getBranch().find((entry) => entry.type === "action_start")?.intent;
			} finally {
				harness.cleanup();
			}
		};
		const cacheAction = await run(frame);
		const databaseCandidate = {
			intent: "Compare primary and replica authorization reads",
			completionCondition: "Exact read results establish whether replica divergence exists",
			expectation: "The replica read result shows an authorization value diverging from primary",
		};
		const databaseAction = await run({
			kind: "create_frame",
			statement: "Authorization failure is controlled by stale database replica reads",
			expectation: "A primary-database trace shows the same stale authorization value",
			actions: [actionBudget(databaseCandidate)],
		});

		expect(cacheAction).toBe(action.intent);
		expect(databaseAction).toBe("Compare primary and replica authorization reads");
		expect(databaseAction).not.toBe(cacheAction);
	});

	it("keeps completed, UNRESOLVABLE, and escalated Action outcomes distinct", async () => {
		for (const outcome of [
			{ kind: "complete_action", transition: "completed", sign: "confirmed" },
			{ kind: "unresolvable_action", transition: "unresolvable", sign: "refuted" },
			{ kind: "escalate_action", transition: "escalated", challenge: "frame", sign: "refuted" },
		] as const) {
			const harness = await createHarness(fullStackOptions());
			try {
				harness.setResponses([
					control(frame),
					control(authorizeFirstAction),
					fauxAssistantMessage("The bounded episode reached a controller boundary."),
					control({
						kind: outcome.kind,
						predictionError: {
							sign: outcome.sign,
							detail: `Controller selected ${outcome.transition} for the active episode`,
						},
						...(outcome.kind === "escalate_action" ? { challenge: outcome.challenge } : {}),
					}),
					control({ kind: "report_inability", reason: "Outcome distinction verified" }),
					fauxAssistantMessage("The bounded outcome was recorded."),
				]);

				await harness.session.prompt(`exercise ${outcome.transition}`);

				expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "action_transition")).toEqual([
					expect.objectContaining({
						transition: outcome.transition,
						...(outcome.kind === "escalate_action" ? { challenge: "frame" } : {}),
					}),
				]);
			} finally {
				harness.cleanup();
			}
		}
	});

	it("does not let a terminated Frame authorize another Action", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				fauxAssistantMessage(
					'Controller decision:\n{"operation":"falsify_frame","reason":"An exact restart result contradicted the commitment"}',
				),
				control(authorizeFirstAction),
				control({ kind: "report_inability", reason: "No admissible Frame remains" }),
				fauxAssistantMessage("A replacement Frame is required before further execution."),
			]);

			await harness.session.prompt("reject a falsified investigation");

			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "frame_transition")).toEqual([
				expect.objectContaining({ transition: "falsified" }),
			]);
			expect(branch.filter((entry) => entry.type === "action_start")).toHaveLength(0);
			expect(harness.providerContexts[3]!.systemPrompt).toContain(
				"previous decision was rejected: Create an admissible Frame before authorizing an Action",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("converges to a bounded inability report when malformed Frame decisions exhaust repair attempts", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "repair malformed control",
					expectation: "cannot complete the request",
					horizon: 9,
				}),
				fauxAssistantMessage("not json"),
				control({ kind: "create_frame", statement: "repair malformed control", expectation: "wrong", horizon: 9 }),
				fauxAssistantMessage("A bounded inability report."),
			]);

			await harness.session.prompt("repair malformed control");
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("A bounded inability report.");
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_revision")).toHaveLength(0);
			expect(harness.providerContexts[1]!.systemPrompt).toContain("previous decision was rejected");
			expect(harness.providerContexts).toHaveLength(4);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a terminal authorization that omits its reason", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({ kind: "authorize_final" }),
				control({ kind: "authorize_final", reason: "The Anchor is satisfied" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("reject a reasonless authorization");

			expect(harness.providerContexts[1]!.systemPrompt).toContain(
				"previous decision was rejected: Control decision authorize_final requires a non-empty reason.",
			);
			expect(harness.session.getLastAssistantText()).toBe("done");
		} finally {
			harness.cleanup();
		}
	});
});
