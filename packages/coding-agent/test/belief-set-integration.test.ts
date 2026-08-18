import { describe, expect, test } from "vitest";
import { createHarness } from "./test-harness.ts";

describe("declare_belief integration", () => {
	test("declare_belief is on by default", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).toContain("declare_belief");
			expect(harness.session.getAllTools().map((t) => t.name)).toContain("declare_belief");
			expect(harness.session.systemPrompt).toContain("Record or update what you currently believe");
		} finally {
			harness.cleanup();
		}
	});

	test("enableBeliefSet: false disables declare_belief", async () => {
		const harness = await createHarness({ enableBeliefSet: false });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("declare_belief");
			expect(harness.session.getAllTools().map((t) => t.name)).not.toContain("declare_belief");
		} finally {
			harness.cleanup();
		}
	});

	test("declare_belief stays active when the CLI supplies a tool list without it", async () => {
		// The CLI passes `initialActiveToolNames = ["read", "bash", "edit", "write"]`
		// (its settings default); declare_belief must be added back in because the
		// belief set is on by default.
		const harness = await createHarness({ initialActiveToolNames: ["read", "bash", "edit", "write"] });
		try {
			expect(harness.session.getActiveToolNames()).toContain("declare_belief");
		} finally {
			harness.cleanup();
		}
	});
});
