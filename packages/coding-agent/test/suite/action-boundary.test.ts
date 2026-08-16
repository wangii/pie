import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

const initialFrame = {
	type: "create" as const,
	statement: "worker-local state survives logout",
	expectation: "a clean worker preserves the authorization failure",
	horizon: 4,
};

const action = {
	type: "start" as const,
	intent: "determine whether logout invalidates worker-local authorization state",
	completionCondition: "the worker cache lifetime is identified or cache survival is ruled out",
	expectation: "the worker cache lifetime is identified",
};

describe("Phase 3 Action provider boundary", () => {
	it("projects a frozen Action and only its episode-local execution window", async () => {
		const harness = await createHarness({
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
		});
		try {
			harness.setResponses([fauxAssistantMessage("establish frame"), fauxAssistantMessage("inspect cache")]);
			await harness.session.prompt("diagnose logout authorization", {
				anchor: { statement: "logout must revoke authorization" },
				frame: initialFrame,
			});
			await harness.session.prompt("begin the authorized investigation", { action });

			const contextTexts = harness.providerContexts[1]!.messages.map(getMessageText);
			expect(contextTexts.slice(0, 3)).toEqual([
				"[ANCHOR]\nlogout must revoke authorization",
				"[CURRENT FRAME]\nCommitment: worker-local state survives logout\n" +
					"Expectation: a clean worker preserves the authorization failure\n" +
					"Response lease: 1/4 completed; 3 model responses remain",
				"[CURRENT ACTION]\n" +
					"Intent: determine whether logout invalidates worker-local authorization state\n" +
					"Completion condition: the worker cache lifetime is identified or cache survival is ruled out\n" +
					"Contract: frozen for this episode. Tools and execution strategy may change; intent and completion condition may not. " +
					"If the condition cannot be met under the current Frame and constraints, return exactly UNRESOLVABLE.",
			]);
			expect(contextTexts.slice(3)).toEqual(["begin the authorized investigation"]);
			expect(harness.session.latestContextManifest).toMatchObject({
				compilerVersion: "pie-phase-3-action/v1",
				epistemicState: { action: { completedModelResponses: 0 } },
			});
			expect(
				harness.session.latestContextManifest?.omissions.filter(
					(omission) => omission.reason === "outside_action_episode",
				),
			).toHaveLength(2);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps tool calls, failures, and results paired inside the complete raw episode trace", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: String((params as { text: string }).text) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			tools: [echoTool],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", { text: "retry result" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("condition checked"),
			]);
			await harness.session.prompt("execute the bounded check", {
				anchor: { statement: "identify the defect" },
				frame: initialFrame,
				action,
			});

			expect(harness.providerContexts).toHaveLength(2);
			expect(harness.providerContexts[1]!.messages.map((message) => message.role)).toEqual([
				"user",
				"user",
				"user",
				"user",
				"assistant",
				"toolResult",
			]);
			const rawRoles = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message.role);
			expect(rawRoles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		} finally {
			harness.cleanup();
		}
	});

	it("treats an exact UNRESOLVABLE model result as bounded control transfer", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true, actionEnabled: true });
		try {
			harness.setResponses([fauxAssistantMessage("UNRESOLVABLE")]);
			await harness.session.prompt("investigate without the required runtime", {
				anchor: { statement: "identify the defect" },
				frame: initialFrame,
				action,
			});

			expect(harness.session.action).toBeUndefined();
			expect(harness.session.frame).toBeDefined();
			expect(harness.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({ type: "action_transition", transition: "unresolvable" }),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("returns an unfinished Action before its containing Frame expires", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true, actionEnabled: true });
		try {
			harness.setResponses([fauxAssistantMessage("attempted"), fauxAssistantMessage("reconsider")]);
			await harness.session.prompt("start bounded work", {
				anchor: { statement: "identify the defect" },
				frame: { ...initialFrame, horizon: 1 },
				action,
			});
			await harness.session.prompt("continue after reality pushback");

			expect(harness.session.action).toBeUndefined();
			expect(harness.session.frame).toBeUndefined();
			const transitions = harness.sessionManager.getBranch();
			const actionTransitionIndex = transitions.findIndex(
				(entry) => entry.type === "action_transition" && entry.transition === "unresolvable",
			);
			const frameTransitionIndex = transitions.findIndex(
				(entry) => entry.type === "frame_transition" && entry.transition === "expired",
			);
			expect(actionTransitionIndex).toBeGreaterThan(-1);
			expect(frameTransitionIndex).toBeGreaterThan(actionTransitionIndex);
		} finally {
			harness.cleanup();
		}
	});

	it("supports explicit escalation before changing the challenged Frame", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true, actionEnabled: true });
		try {
			harness.setResponses([fauxAssistantMessage("attempt"), fauxAssistantMessage("redirect")]);
			await harness.session.prompt("start", {
				anchor: { statement: "identify the defect" },
				frame: initialFrame,
				action,
			});
			await harness.session.prompt("the world result contradicts the frame", {
				action: { type: "escalate", challenge: "frame", reason: "worker restart preserved the failure" },
				frame: {
					type: "replace",
					statement: "the replica serves stale authorization state",
					expectation: "primary and replica positions match",
					horizon: 3,
					reason: "the Action escalated contradictory world evidence",
				},
			});

			expect(harness.session.action).toBeUndefined();
			expect(harness.session.frame?.statement).toBe("the replica serves stale authorization state");
			expect(harness.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({
					type: "action_transition",
					transition: "escalated",
					challenge: "frame",
				}),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves the Phase 2 compiler as the Action ablation", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true, actionEnabled: false });
		try {
			harness.setResponses([fauxAssistantMessage("baseline")]);
			await harness.session.prompt("baseline", {
				anchor: { statement: "finish baseline" },
				frame: initialFrame,
			});

			expect(harness.session.latestContextManifest?.compilerVersion).toBe("pie-phase-2-frame/v1");
			expect(harness.session.latestContextManifest?.epistemicState.action).toBeUndefined();
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "action_start")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
