import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { PieProductionLoop } from "../../src/core/pie-agent-loop.ts";
import { createHarness, getMessageText } from "./harness.ts";

function control(decision: Record<string, unknown>) {
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

const frame = {
	kind: "create_frame",
	statement: "Repository behavior is controlled by the persisted cache boundary",
	falsifier: "A restart test shows the failure persists after every cache instance is recreated",
	horizon: 20,
} as const;

const action = {
	kind: "authorize_action",
	intent: "Inspect cache lifetime and the restart boundary",
	completionCondition: "The cache lifetime and restart behavior are established by exact tool results",
} as const;

function fullStackOptions() {
	return {
		pieProductionLoop: true,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled: true,
		tools: [inspectTool],
		frameHorizonRange: { min: 3, max: 20 },
	};
}

describe("Phase 7 production control flow", () => {
	it("creates a semantic Frame and authorizes a bounded Action before execution", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(action),
				fauxAssistantMessage("inspection result is ready"),
				control({ kind: "complete_action", reason: "Exact cache lifetime evidence was collected" }),
				control({ kind: "authorize_final", reason: "The requested diagnosis is established" }),
				fauxAssistantMessage("The persisted cache boundary controls the behavior."),
			]);

			await harness.session.prompt("diagnose the restart failure");

			const branch = harness.sessionManager.getBranch();
			const createdFrame = branch.find((entry) => entry.type === "frame_revision");
			const startedAction = branch.find((entry) => entry.type === "action_start");
			expect(createdFrame).toMatchObject({
				statement: frame.statement,
				falsifier: frame.falsifier,
				horizon: 20,
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

	it("does not let an ordinary stop complete the active Action", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control(frame),
				control(action),
				fauxAssistantMessage("This looks finished, but no exact result establishes the condition."),
				control({ kind: "continue_action", reason: "The completion condition is not established" }),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "cache" }, { id: "inspect-cache" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The exact result is now available."),
				control({ kind: "complete_action", reason: "The exact tool result establishes the condition" }),
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
				control(action),
				(context) => {
					const instruction = context.messages
						.map(getMessageText)
						.find((text) => text.includes("exclusive scope"));
					return fauxAssistantMessage(
						instruction ? "stopped at the current condition" : "scope instruction missing",
					);
				},
				control({ kind: "complete_action", reason: "The exact current condition was established" }),
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
				control(action),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "first" }, { id: "inspect-first" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("inspect", { value: "second" }, { id: "inspect-second" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Both boundaries are established."),
				control({ kind: "complete_action", reason: "Both exact results satisfy the frozen condition" }),
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
				control(action),
				fauxAssistantMessage("First result established."),
				control({ kind: "complete_action", reason: "First bounded condition met" }),
				control({
					kind: "authorize_action",
					intent: "Inspect whether invalidation crosses the worker boundary",
					completionCondition: "An exact result establishes whether worker invalidation occurs",
				}),
				fauxAssistantMessage("Second result established."),
				control({ kind: "complete_action", reason: "Second bounded condition met" }),
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

	it("expires the response lease after terminating the active Action and reconsiders in the same run", async () => {
		const harness = await createHarness({
			...fullStackOptions(),
			frameHorizonRange: { min: 3, max: 3 },
		});
		try {
			harness.setResponses([
				control({ ...frame, horizon: 99 }),
				control(action),
				fauxAssistantMessage("No terminal evidence yet."),
				control({ kind: "continue_action", reason: "More evidence is required" }),
				control({
					kind: "create_frame",
					statement: "Runtime invalidation is controlled by worker-local state",
					falsifier: "A worker trace shows authorization reads only the shared session store",
					horizon: 3,
				}),
				control({ kind: "report_inability", reason: "The original lease expired before evidence was established" }),
				fauxAssistantMessage("Unable to establish the result before mandatory reconsideration."),
			]);

			await harness.session.prompt("diagnose within a bounded lease");

			const branch = harness.sessionManager.getBranch();
			const actionTransitionIndex = branch.findIndex(
				(entry) => entry.type === "action_transition" && entry.transition === "unresolvable",
			);
			const frameExpiryIndex = branch.findIndex(
				(entry) => entry.type === "frame_transition" && entry.transition === "expired",
			);
			expect(actionTransitionIndex).toBeGreaterThan(-1);
			expect(frameExpiryIndex).toBeGreaterThan(actionTransitionIndex);
			expect(branch.filter((entry) => entry.type === "frame_revision")[0]).toMatchObject({ horizon: 3 });
			expect(harness.providerContexts).toHaveLength(7);
			expect(harness.session.getLastAssistantText()).toContain("mandatory reconsideration");
		} finally {
			harness.cleanup();
		}
	});

	it("authorizes different first Actions for competing Frames under the same Anchor", async () => {
		const run = async (candidateFrame: Record<string, unknown>, candidateAction: Record<string, unknown>) => {
			const harness = await createHarness(fullStackOptions());
			try {
				harness.setResponses([
					control(candidateFrame),
					control(candidateAction),
					fauxAssistantMessage("bounded result"),
					control({ kind: "complete_action", reason: "The candidate result was established" }),
					control({ kind: "authorize_final", reason: "The shared Anchor is satisfied" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("diagnose the shared authorization failure");
				return harness.sessionManager.getBranch().find((entry) => entry.type === "action_start")?.intent;
			} finally {
				harness.cleanup();
			}
		};
		const cacheAction = await run(frame, action);
		const databaseAction = await run(
			{
				kind: "create_frame",
				statement: "Authorization failure is controlled by stale database replica reads",
				falsifier: "A primary-database trace shows the same stale authorization value",
				horizon: 20,
			},
			{
				kind: "authorize_action",
				intent: "Compare primary and replica authorization reads",
				completionCondition: "Exact read results establish whether replica divergence exists",
			},
		);

		expect(cacheAction).toBe(action.intent);
		expect(databaseAction).toBe("Compare primary and replica authorization reads");
		expect(databaseAction).not.toBe(cacheAction);
	});

	it("keeps completed, UNRESOLVABLE, and escalated Action outcomes distinct", async () => {
		for (const outcome of [
			{ kind: "complete_action", transition: "completed" },
			{ kind: "unresolvable_action", transition: "unresolvable" },
			{ kind: "escalate_action", transition: "escalated", challenge: "frame" },
		] as const) {
			const harness = await createHarness(fullStackOptions());
			try {
				harness.setResponses([
					control(frame),
					control(action),
					fauxAssistantMessage("The bounded episode reached a controller boundary."),
					control({
						kind: outcome.kind,
						reason: `Controller selected ${outcome.transition}`,
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
				control(action),
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
			expect(harness.providerContexts[3]!.messages.map(getMessageText)).toEqual(
				expect.arrayContaining([
					expect.stringContaining("adjudicate only that exact frozen intent and completion condition"),
				]),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("repairs malformed Frame decisions in bounded time without a generic fallback", async () => {
		const harness = await createHarness(fullStackOptions());
		try {
			harness.setResponses([
				control({
					kind: "create_frame",
					statement: "repair malformed control",
					falsifier: "cannot complete the request",
					horizon: 9,
				}),
				fauxAssistantMessage("not json"),
				control({ kind: "create_frame", statement: "repair malformed control", falsifier: "wrong", horizon: 9 }),
			]);

			await harness.session.prompt("repair malformed control");
			expect(harness.session.state.errorMessage).toContain("failed validation after 3 bounded attempts");
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_revision")).toHaveLength(0);
			expect(harness.providerContexts[1]!.systemPrompt).toContain("previous decision was rejected");
			expect(harness.providerContexts).toHaveLength(3);
		} finally {
			harness.cleanup();
		}
	});
});
