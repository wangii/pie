import { describe, expect, test } from "vitest";
import { type LoopState, selectRoleThinkingLevel } from "../src/core/belief-loop/belief-loop-controller.ts";

const levels = {
	default: "minimal" as const,
	planner: "low" as const,
	execution: "medium" as const,
	fastPath: "high" as const,
	distillation: "xhigh" as const,
};

function state(role: LoopState["role"], fastPath = false): LoopState {
	if (role === "execution") {
		return { role, frameHorizon: 1, leaseReportNudged: false, ...(fastPath ? { fastPath: true } : {}) };
	}
	return { role };
}

describe("selectRoleThinkingLevel", () => {
	test("selects each configured role level", () => {
		expect(selectRoleThinkingLevel("propose", state("propose"), levels, "max")).toBe("minimal");
		expect(selectRoleThinkingLevel("planner", state("planner"), levels, "max")).toBe("low");
		expect(selectRoleThinkingLevel("execution", state("execution"), levels, "max")).toBe("medium");
		expect(selectRoleThinkingLevel("execution", state("execution", true), levels, "max")).toBe("high");
		expect(selectRoleThinkingLevel("distill", state("distill"), levels, "max")).toBe("xhigh");
		expect(selectRoleThinkingLevel("finalReport", state("finalReport"), levels, "max")).toBe("high");
	});

	test("falls back to the session level when a role setting is absent", () => {
		expect(selectRoleThinkingLevel("planner", state("planner"), { ...levels, planner: undefined }, "medium")).toBe(
			"medium",
		);
		expect(
			selectRoleThinkingLevel("execution", state("execution", true), { ...levels, fastPath: undefined }, "low"),
		).toBe("low");
	});
});
