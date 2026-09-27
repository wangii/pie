import { describe, expect, test } from "vitest";
import {
	type LoopState,
	selectRoleModelSpec,
	shouldDegradeRoleModel,
} from "../src/core/belief-loop/belief-loop-controller.ts";

const models = {
	propose: "openai-codex/gpt-5.6-sol",
	report: "openai-codex/gpt-5.6-terra",
	execution: "deepseek/deepseek-v4-flash-vision-exp",
	fastPath: "deepseek/deepseek-v4-flash-vision-exp",
	distillation: "openai-codex/gpt-5.6-terra",
};

function state(role: LoopState["role"], fastPath = false): LoopState {
	if (role === "execution") {
		return { role, episodeHorizon: 1, leaseReportNudged: false, ...(fastPath ? { fastPath: true } : {}) };
	}
	return { role };
}

describe("selectRoleModelSpec", () => {
	test("uses the dedicated propose and finalReport models", () => {
		expect(selectRoleModelSpec("propose", state("propose"), models)).toBe(models.propose);
		expect(selectRoleModelSpec("finalReport", state("finalReport"), models)).toBe(models.report);
	});

	test("propose and finalReport select independently", () => {
		expect(selectRoleModelSpec("propose", state("propose"), { ...models, propose: undefined })).toBeUndefined();
		expect(selectRoleModelSpec("finalReport", state("finalReport"), models)).toBe(models.report);
	});

	test("selects execution and distillation models", () => {
		expect(selectRoleModelSpec("distill", state("distill"), models)).toBe(models.distillation);
		expect(selectRoleModelSpec("execution", state("execution"), models)).toBe(models.execution);
		expect(selectRoleModelSpec("execution", state("execution", true), models)).toBe(models.fastPath);
	});

	test("returns undefined when a role setting is absent", () => {
		expect(selectRoleModelSpec("execution", state("execution"), { ...models, execution: undefined })).toBeUndefined();
		expect(selectRoleModelSpec("distill", state("distill"), { ...models, distillation: undefined })).toBeUndefined();
	});
});

describe("shouldDegradeRoleModel", () => {
	test("degrades when the role runs on a model other than the default", () => {
		expect(shouldDegradeRoleModel("openai-codex/gpt-5.6-sol", "deepseek/deepseek-v4-flash")).toBe(true);
	});

	test("does not degrade when the role already uses the default", () => {
		expect(shouldDegradeRoleModel("openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-sol")).toBe(false);
	});

	test("does not degrade without a default model to fall back to", () => {
		expect(shouldDegradeRoleModel("openai-codex/gpt-5.6-sol", undefined)).toBe(false);
		expect(shouldDegradeRoleModel(undefined, "openai-codex/gpt-5.6-sol")).toBe(false);
	});
});
