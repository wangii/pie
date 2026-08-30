import { describe, expect, test } from "vitest";
import { type LoopState, selectRoleModelSpec } from "../src/core/belief-loop/belief-loop-controller.ts";

const models = {
	default: "openai-codex/gpt-5.6-sol",
	planner: "openai-codex/gpt-5.6-sol",
	execution: "deepseek/deepseek-v4-flash-vision-exp",
	fastPath: "deepseek/deepseek-v4-flash-vision-exp",
	distillation: "openai-codex/gpt-5.6-terra",
};

function state(role: LoopState["role"], fastPath = false): LoopState {
	if (role === "execution") {
		return { role, frameHorizon: 1, leaseReportNudged: false, ...(fastPath ? { fastPath: true } : {}) };
	}
	return { role };
}

describe("selectRoleModelSpec", () => {
	test("all propose turns follow the default model", () => {
		expect(selectRoleModelSpec("propose", state("propose"), models)).toBe(models.default);
	});

	test("selects each configured role model", () => {
		expect(selectRoleModelSpec("planner", state("planner"), models)).toBe(models.planner);
		expect(selectRoleModelSpec("distill", state("distill"), models)).toBe(models.distillation);
		expect(selectRoleModelSpec("execution", state("execution"), models)).toBe(models.execution);
		expect(selectRoleModelSpec("execution", state("execution", true), models)).toBe(models.fastPath);
		expect(selectRoleModelSpec("finalReport", state("finalReport"), models)).toBe(models.fastPath);
	});

	test("returns undefined when the role setting is absent, so callers fall back", () => {
		expect(selectRoleModelSpec("propose", state("propose"), { ...models, default: undefined })).toBeUndefined();
		expect(selectRoleModelSpec("planner", state("planner"), { ...models, planner: undefined })).toBeUndefined();
		expect(selectRoleModelSpec("execution", state("execution"), { ...models, execution: undefined })).toBeUndefined();
		expect(selectRoleModelSpec("distill", state("distill"), { ...models, distillation: undefined })).toBeUndefined();
		expect(
			selectRoleModelSpec("finalReport", state("execution"), { ...models, fastPath: undefined }),
		).toBeUndefined();
	});
});
