import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { restoreEpistemicState } from "../../src/core/epistemic-state.ts";
import { createHarness, getMessageText } from "./harness.ts";

const initialFrame = {
	type: "create" as const,
	statement: "worker-local state survives logout",
	expectation: "a worker restart preserves the authorization failure",
	horizon: 3,
};

describe("Phase 2 Frame provider boundary", () => {
	it("projects the current admissible Frame after the Anchor", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true });
		try {
			harness.setResponses([fauxAssistantMessage("inspect the worker cache")]);
			await harness.session.prompt("diagnose logout authorization", {
				anchor: { statement: "logout must revoke authorization" },
				frame: initialFrame,
			});

			expect(harness.providerContexts[0]!.messages.map(getMessageText)).toEqual([
				"[ANCHOR]\nlogout must revoke authorization",
				"[CURRENT FRAME]\nCommitment: worker-local state survives logout\n" +
					"Expectation: a worker restart preserves the authorization failure\n" +
					"Response lease: 0/3 completed; 3 model responses remain",
				"diagnose logout authorization",
			]);
			expect(harness.session.frame).toMatchObject({ version: 1, completedModelResponses: 1 });
			expect(harness.session.latestContextManifest).toMatchObject({
				compilerVersion: "pie-phase-2-frame/v1",
				epistemicState: { frame: { version: 1, remainingModelResponses: 3 } },
			});
		} finally {
			harness.cleanup();
		}
	});

	it("makes revision and replacement distinct append-only transitions", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true });
		try {
			harness.setResponses([
				fauxAssistantMessage("first"),
				fauxAssistantMessage("revised"),
				fauxAssistantMessage("replacement"),
			]);
			await harness.session.prompt("start", {
				anchor: { statement: "find the authorization defect" },
				frame: initialFrame,
			});
			const first = harness.session.frame!;
			await harness.session.prompt("narrow the commitment", {
				frame: {
					type: "revise",
					statement: "the middleware cache survives logout",
					expectation: "middleware bypass still reproduces the failure",
					horizon: 2,
					revisionReason: "cache ownership was localized",
				},
			});
			const revised = harness.session.frame!;
			await harness.session.prompt("redirect the investigation", {
				frame: {
					type: "replace",
					statement: "the replica serves stale session state",
					expectation: "primary and replica positions match",
					horizon: 4,
					reason: "cache bypass contradicted the old commitment",
				},
			});
			const replacement = harness.session.frame!;

			expect(revised).toMatchObject({
				id: first.id,
				version: 2,
				previousRevisionId: first.revisionEntryId,
				revisionReason: "cache ownership was localized",
			});
			expect(replacement).toMatchObject({ version: 1, statement: "the replica serves stale session state" });
			expect(replacement.id).not.toBe(first.id);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "frame_transition")).toEqual([
				expect.objectContaining({
					frameId: first.id,
					version: 2,
					transition: "replaced",
					replacementFrameId: replacement.id,
				}),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("removes a falsified Frame from model context without rewriting its identity", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true });
		try {
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("redirect")]);
			await harness.session.prompt("start", {
				anchor: { statement: "find the defect" },
				frame: initialFrame,
			});
			const frame = harness.session.frame!;
			await harness.session.prompt("worker restart preserved the failure", {
				frame: { type: "falsify", reason: "the declared expectation occurred" },
			});

			expect(harness.session.frame).toBeUndefined();
			expect(harness.providerContexts[1]!.messages.map(getMessageText)).not.toContain(
				expect.stringContaining("[CURRENT FRAME]"),
			);
			expect(harness.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({ frameId: frame.id, transition: "falsified" }),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("records deliberate Frame death as a terminal transition", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true });
		try {
			harness.setResponses([fauxAssistantMessage("first")]);
			await harness.session.prompt("start", {
				anchor: { statement: "find the defect" },
				frame: initialFrame,
			});
			const frame = harness.session.frame!;
			harness.session.terminateFrame("died", { reason: "the investigation is no longer useful" });

			expect(harness.session.frame).toBeUndefined();
			expect(harness.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({ frameId: frame.id, transition: "died" }),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("expires a Frame before the request after its finite response horizon", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: true });
		try {
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("reconsidered")]);
			await harness.session.prompt("start", {
				anchor: { statement: "find the defect" },
				frame: { ...initialFrame, horizon: 1 },
			});
			const expired = harness.session.frame!;
			await harness.session.prompt("continue after the timeout");

			expect(harness.session.frame).toBeUndefined();
			expect(
				harness.providerContexts[1]!.messages.map(getMessageText).some((text) =>
					text.startsWith("[CURRENT FRAME]"),
				),
			).toBe(false);
			const transition = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "frame_transition" && entry.transition === "expired");
			expect(transition).toMatchObject({ frameId: expired.id, version: 1, transition: "expired" });
			expect(restoreEpistemicState(harness.sessionManager.getBranch()).frame).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("preserves the Phase 1 compiler as the Frame ablation", async () => {
		const harness = await createHarness({ anchorEnabled: true, frameEnabled: false });
		try {
			harness.setResponses([fauxAssistantMessage("answer")]);
			await harness.session.prompt("baseline", { anchor: { statement: "finish baseline" } });

			expect(harness.session.latestContextManifest?.compilerVersion).toBe("pie-phase-1-anchor/v1");
			expect(harness.session.latestContextManifest?.epistemicState.frame).toBeUndefined();
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "frame_revision")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
