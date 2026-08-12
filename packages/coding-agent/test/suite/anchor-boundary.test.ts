import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { restoreEpistemicState } from "../../src/core/epistemic-state.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("Phase 1 Anchor provider boundary", () => {
	it("creates an explicit task-success Anchor and always projects it", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: false });
		try {
			harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
			await harness.session.prompt("finish the original task", {
				anchor: { statement: "finish the original task" },
			});
			await harness.session.prompt("continue with the local fix");

			expect(harness.providerContexts).toHaveLength(2);
			expect(harness.providerContexts[0]!.messages.map(getMessageText)).toEqual([
				"[ANCHOR]\nfinish the original task",
				"finish the original task",
			]);
			expect(harness.providerContexts[1]!.messages.map(getMessageText)).toEqual([
				"[ANCHOR]\nfinish the original task",
				"finish the original task",
				"first answer",
				"continue with the local fix",
			]);

			const anchor = harness.session.anchor;
			expect(anchor).toMatchObject({ revision: 1, statement: "finish the original task" });
			expect(harness.session.latestContextManifest).toMatchObject({
				compilerVersion: "pie-phase-1-anchor/v1",
				epistemicState: {
					anchor: {
						id: anchor?.id,
						revision: 1,
						sourceEventId: anchor?.sourceEventId,
					},
				},
			});
		} finally {
			harness.cleanup();
		}
	});

	it("records explicit revisions without overwriting their provenance", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: false });
		try {
			harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("revised answer")]);
			await harness.session.prompt("ship feature A", { anchor: { statement: "ship feature A" } });
			const first = harness.session.anchor!;
			await harness.session.prompt("change the requested outcome", {
				anchor: {
					statement: "ship feature B instead",
					revisionReason: "user changed the requested outcome",
				},
			});
			const revised = harness.session.anchor!;
			const latestUserEvent = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.at(-1);

			expect(revised).toMatchObject({
				id: first.id,
				revision: 2,
				statement: "ship feature B instead",
				previousRevisionId: first.revisionEntryId,
				sourceEventId: latestUserEvent?.id,
				revisionReason: "user changed the requested outcome",
			});
			const revisions = harness.sessionManager.getBranch().filter((entry) => entry.type === "anchor_revision");
			expect(revisions).toHaveLength(2);
			expect(restoreEpistemicState(harness.sessionManager.getBranch()).anchor).toEqual(revised);
			expect(getMessageText(harness.providerContexts[1]!.messages[0])).toBe("[ANCHOR]\nship feature B instead");
		} finally {
			harness.cleanup();
		}
	});

	it("does not promote a full prompt when no explicit Anchor is supplied", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: false });
		try {
			harness.setResponses([fauxAssistantMessage("answer")]);
			await harness.session.prompt("request with a turn-local reply instruction");

			expect(harness.providerContexts[0]!.messages.map(getMessageText)).toEqual([
				"request with a turn-local reply instruction",
			]);
			expect(harness.session.anchor).toBeUndefined();
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "anchor_revision")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves the Phase 0 projection when Anchor is disabled for ablation", async () => {
		const harness = await createHarness({ anchorEnabled: false, frameEnabled: false });
		try {
			harness.setResponses([fauxAssistantMessage("answer")]);
			await harness.session.prompt("baseline request");

			expect(harness.providerContexts[0]!.messages.map(getMessageText)).toEqual(["baseline request"]);
			expect(harness.session.anchor).toBeUndefined();
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "anchor_revision")).toBe(false);
			expect(harness.session.latestContextManifest?.compilerVersion).toBe("pie-phase-0/v1");
		} finally {
			harness.cleanup();
		}
	});
});
