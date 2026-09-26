import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BeliefLoopController } from "../src/core/belief-loop/belief-loop-controller.ts";
import { SessionManager } from "../src/core/session-manager.ts";

/**
 * Temporary probe for belief-69: what `blocksToolCall` decides for an execution-role call, and
 * whether that condition can only be satisfied when a name is absent from the applied surface.
 */

function makeController(
	rolesByName: Record<string, readonly string[] | undefined>,
	active: string[],
): BeliefLoopController {
	const host = {
		sessionManager: SessionManager.inMemory(process.cwd(), { id: "session-blocks" }),
		_emit: () => {},
		_fullActiveToolNames: active,
		getToolDefinition: (name: string) => {
			const roles = rolesByName[name];
			return roles === undefined ? undefined : { roles };
		},
		agent: { state: { messages: [], tools: [] } },
	} as unknown as AgentSession;
	return new BeliefLoopController(host);
}

describe("blocksToolCall authorization condition", () => {
	it("refuses a name absent from the execution surface and allows a present one", () => {
		const controller = makeController({ exec_tool: ["execution"], propose_only_tool: ["propose"] }, [
			"exec_tool",
			"propose_only_tool",
			"bash",
		]);
		controller.loopState = { role: "execution", episodeHorizon: 1, leaseReportNudged: false };
		expect(controller.blocksToolCall("exec_tool")).toBe(false);
		expect(controller.blocksToolCall("bash")).toBe(false);
		expect(controller.blocksToolCall("propose_only_tool")).toBe(true);
	});

	it("does not run the authorization check for a non-execution role", () => {
		const controller = makeController({ propose_only_tool: ["propose"] }, ["propose_only_tool", "bash"]);
		controller.loopState = { role: "propose" };
		expect(controller.blocksToolCall("bash")).toBe(false);
		expect(controller.blocksToolCall("propose_only_tool")).toBe(false);
	});
});
