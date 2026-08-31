import { describe, expect, test } from "vitest";
import { type LoopState, selectRoleModelSpec } from "../src/core/belief-loop/belief-loop-controller.ts";

const models = {
	default: "openai-codex/gpt-5.6-sol",
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
	test("uses the strong default model for propose and final synthesis", () => {
		expect(selectRoleModelSpec("propose", state("propose"), models)).toBe(models.default);
		expect(selectRoleModelSpec("finalReport", state("finalReport"), models)).toBe(models.default);
	});

	test("selects execution and distillation models", () => {
		expect(selectRoleModelSpec("distill", state("distill"), models)).toBe(models.distillation);
		expect(selectRoleModelSpec("execution", state("execution"), models)).toBe(models.execution);
		expect(selectRoleModelSpec("execution", state("execution", true), models)).toBe(models.fastPath);
	});

	test("returns undefined when a role setting is absent", () => {
		expect(selectRoleModelSpec("propose", state("propose"), { ...models, default: undefined })).toBeUndefined();
		expect(selectRoleModelSpec("execution", state("execution"), { ...models, execution: undefined })).toBeUndefined();
		expect(selectRoleModelSpec("distill", state("distill"), { ...models, distillation: undefined })).toBeUndefined();
	});
});
