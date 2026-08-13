import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resolvePieModelRoutes } from "../src/core/pie-models.ts";

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_000,
		maxTokens: 2_000,
	};
}

async function createRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	runtime.registerProvider("route-provider", {
		baseUrl: "https://example.test/v1",
		apiKey: "route-key",
		api: "openai-completions",
		models: [testModel("controller"), testModel("executor")],
	});
	return runtime;
}

describe("resolvePieModelRoutes", () => {
	it("keeps the default role graph on the dynamic session model", async () => {
		const routes = resolvePieModelRoutes({}, await createRuntime());

		expect(routes).toEqual({
			epistemic: undefined,
			execution: undefined,
			observation: undefined,
			verification: undefined,
			finalAnswer: undefined,
		});
	});

	it("resolves explicit models and transitive inheritance", async () => {
		const routes = resolvePieModelRoutes(
			{
				epistemic: "route-provider/controller",
				execution: "route-provider/executor",
				observation: "inherit:epistemic",
				verification: "inherit:observation",
				finalAnswer: "inherit:execution",
			},
			await createRuntime(),
		);

		expect(routes.epistemic?.id).toBe("controller");
		expect(routes.execution?.id).toBe("executor");
		expect(routes.observation).toBe(routes.epistemic);
		expect(routes.verification).toBe(routes.epistemic);
		expect(routes.finalAnswer).toBe(routes.execution);
	});

	it("rejects malformed, unknown, and cyclic references", async () => {
		const runtime = await createRuntime();

		expect(() => resolvePieModelRoutes({ execution: "executor" }, runtime)).toThrow(
			'Invalid Pie model reference "executor" for role "execution"',
		);
		expect(() => resolvePieModelRoutes({ execution: "route-provider/missing" }, runtime)).toThrow(
			"Unknown Pie execution model: route-provider/missing",
		);
		expect(() => resolvePieModelRoutes({ execution: "inherit:missing" }, runtime)).toThrow(
			'Invalid Pie model inheritance target "missing" for role "execution"',
		);
		expect(() =>
			resolvePieModelRoutes({ epistemic: "inherit:execution", execution: "inherit:epistemic" }, runtime),
		).toThrow('Pie model role inheritance contains a cycle at "epistemic"');
	});
});
