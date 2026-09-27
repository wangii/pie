import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * The failure fallback: a role running on a non-default model that fails falls back to
 * `defaultModel` and resends the turn. The faux provider writes the requested model id into
 * each response, so the sequence of requested models is observable at the session level.
 */
describe("model failure degradation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("resends the failed turn on defaultModel after a non-retryable failure", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-flaky" }, { id: "faux-default" }],
			settings: {
				defaultModel: "faux/faux-default",
				pie: { proposeModel: "faux/faux-flaky" },
			},
		});
		harnesses.push(harness);
		const requestedModels: string[] = [];
		const failing: FauxResponseFactory = (_context, _options, _state, model) => {
			requestedModels.push(model.id);
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Provider is not configured: faux",
			});
		};
		const succeeding: FauxResponseFactory = (_context, _options, _state, model) => {
			requestedModels.push(model.id);
			return fauxAssistantMessage("done");
		};
		harness.setResponses([failing, succeeding, succeeding, succeeding, succeeding]);

		await harness.session.prompt("do the thing");

		expect(requestedModels[0]).toBe("faux-flaky");
		expect(requestedModels.slice(1)).toContain("faux-default");
	});

	it("falls back to defaultModel at the pre-run credential check and completes the request on it", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-good" }],
			settings: { defaultModel: "faux/faux-good" },
		});
		harnesses.push(harness);
		const good = harness.getModel("faux-good")!;
		// A current model whose provider has no registered credentials. The preflight must
		// replace it with `defaultModel` before the run instead of throwing.
		harness.session.state.model = { ...good, provider: "ghost", id: "ghost-bad" };
		const requestedModels: string[] = [];
		const succeeding: FauxResponseFactory = (_context, _options, _state, model) => {
			requestedModels.push(model.id);
			return fauxAssistantMessage("done");
		};
		harness.setResponses([succeeding, succeeding, succeeding, succeeding, succeeding]);

		await harness.session.prompt("do the thing");

		expect(requestedModels[0]).toBe("faux-good");
	});
});
