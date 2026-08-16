import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { restoreEpistemicState } from "../src/core/epistemic-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function initializeFrame(manager: SessionManager): { sourceEventId: string; frameRevisionEntryId: string } {
	const sourceEventId = manager.appendMessage({ role: "user", content: "diagnose the defect", timestamp: 1 });
	manager.appendAnchorRevision({
		anchorId: "anchor-1",
		revision: 1,
		statement: "diagnose the defect",
		previousRevisionId: null,
		sourceEventId,
	});
	const frameRevisionEntryId = manager.appendFrameRevision({
		frameId: "frame-1",
		version: 1,
		statement: "worker state is stale",
		expectation: "a clean worker reproduces the stale state",
		horizon: 4,
		previousRevisionId: null,
		sourceEventId,
	});
	return { sourceEventId, frameRevisionEntryId };
}

describe("Action episode persistence", () => {
	it("restores a frozen contract and derives progress from its complete raw trace", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pie-action-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir);
			const { sourceEventId, frameRevisionEntryId } = initializeFrame(manager);
			const startEntryId = manager.appendActionStart({
				actionId: "action-1",
				intent: "determine whether the worker cache survives logout",
				completionCondition: "a cache lifetime is identified or cache survival is ruled out",
				expectation: "a cache lifetime is identified",
				frameRevisionEntryId,
				sourceEventId,
			});
			manager.appendMessage(fauxAssistantMessage("inspect cache"));

			const reopened = SessionManager.open(manager.getSessionFile()!);
			expect(restoreEpistemicState(reopened.getBranch()).action).toMatchObject({
				id: "action-1",
				intent: "determine whether the worker cache survives logout",
				completionCondition: "a cache lifetime is identified or cache survival is ruled out",
				startEntryId,
				frameRevisionEntryId,
				completedModelResponses: 1,
			});
			expect(reopened.getEntries().filter((entry) => entry.type === "action_start")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("terminates an episode explicitly without mutating its contract", () => {
		const manager = SessionManager.inMemory();
		const { sourceEventId, frameRevisionEntryId } = initializeFrame(manager);
		const startEntryId = manager.appendActionStart({
			actionId: "action-1",
			intent: "reproduce the failure",
			completionCondition: "a deterministic reproducer exists",
			expectation: "a deterministic reproducer exists",
			frameRevisionEntryId,
			sourceEventId,
		});
		const resultEventId = manager.appendMessage(fauxAssistantMessage("the environment cannot reproduce it"));
		manager.appendActionTransition({
			actionId: "action-1",
			startEntryId,
			transition: "unresolvable",
			sourceEventId: resultEventId,
			reason: "the required runtime is unavailable",
		});

		expect(restoreEpistemicState(manager.getBranch()).action).toBeUndefined();
		expect(manager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "action_transition",
				actionId: "action-1",
				startEntryId,
				transition: "unresolvable",
			}),
		);
	});

	it("prevents Anchor or Frame mutation while an Action contract is active", () => {
		const manager = SessionManager.inMemory();
		const { sourceEventId, frameRevisionEntryId } = initializeFrame(manager);
		manager.appendActionStart({
			actionId: "action-1",
			intent: "inspect the cache",
			completionCondition: "cache ownership is identified",
			expectation: "cache ownership is identified",
			frameRevisionEntryId,
			sourceEventId,
		});

		expect(() =>
			manager.appendFrameRevision({
				frameId: "frame-1",
				version: 2,
				statement: "the replica is stale",
				expectation: "replica positions match",
				horizon: 2,
				previousRevisionId: frameRevisionEntryId,
				sourceEventId,
			}),
		).toThrow("Frame cannot change while an Action episode is active");
	});
});
