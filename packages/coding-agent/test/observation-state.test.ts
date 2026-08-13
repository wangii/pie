import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { restoreEpistemicState } from "../src/core/epistemic-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function initializeAction(manager: SessionManager): {
	anchorRevisionEntryId: string;
	frameRevisionEntryId: string;
	actionStartEntryId: string;
} {
	const sourceEventId = manager.appendMessage({ role: "user", content: "diagnose logout", timestamp: 1 });
	const anchorRevisionEntryId = manager.appendAnchorRevision({
		anchorId: "anchor-1",
		revision: 1,
		statement: "logout revokes authorization",
		previousRevisionId: null,
		sourceEventId,
	});
	const frameRevisionEntryId = manager.appendFrameRevision({
		frameId: "frame-1",
		version: 1,
		statement: "worker-local cache survives logout",
		falsifier: "a worker restart preserves the authorization failure",
		horizon: 4,
		previousRevisionId: null,
		sourceEventId,
	});
	const actionStartEntryId = manager.appendActionStart({
		actionId: "action-1",
		intent: "measure worker cache lifetime",
		completionCondition: "the cache lifetime is identified",
		frameRevisionEntryId,
		sourceEventId,
	});
	return { anchorRevisionEntryId, frameRevisionEntryId, actionStartEntryId };
}

function appendToolResult(manager: SessionManager, text: string, isError = false): string {
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "inspect",
		content: [{ type: "text", text }],
		details: {},
		isError,
		timestamp: Date.now(),
	};
	return manager.appendMessage(result);
}

describe("Observation persistence", () => {
	it("restores immutable evidence with exact raw provenance independently of its Frame", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pie-observation-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir);
			const { anchorRevisionEntryId, frameRevisionEntryId, actionStartEntryId } = initializeAction(manager);
			manager.appendMessage(fauxAssistantMessage("inspect worker cache"));
			const resultEventId = appendToolResult(manager, "worker cache TTL is 30 seconds");
			const observationEntryId = manager.appendObservation({
				observationId: "observation-1",
				statement: "worker-local authorization cache survives logout for 30 seconds",
				sourceEventIds: [resultEventId],
				anchorId: "anchor-1",
				anchorRevisionEntryId,
				frameId: "frame-1",
				frameRevisionEntryId,
			});
			manager.appendActionTransition({
				actionId: "action-1",
				startEntryId: actionStartEntryId,
				transition: "completed",
				sourceEventId: resultEventId,
				reason: "cache lifetime identified",
			});
			manager.appendFrameTransition({
				frameId: "frame-1",
				version: 1,
				revisionEntryId: frameRevisionEntryId,
				transition: "died",
				sourceEventId: resultEventId,
				reason: "investigation completed",
			});

			const reopened = SessionManager.open(manager.getSessionFile()!);
			expect(restoreEpistemicState(reopened.getBranch()).observations).toEqual([
				expect.objectContaining({
					id: "observation-1",
					entryId: observationEntryId,
					statement: "worker-local authorization cache survives logout for 30 seconds",
					sourceEventIds: [resultEventId],
					frameRevisionEntryId,
				}),
			]);
			expect(restoreEpistemicState(reopened.getBranch()).frame).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not promote routine execution errors unless materialization is explicit", () => {
		const manager = SessionManager.inMemory();
		initializeAction(manager);
		appendToolResult(manager, "unknown option", true);

		expect(restoreEpistemicState(manager.getBranch()).observations).toBeUndefined();
		expect(manager.getEntries().some((entry) => entry.type === "observation")).toBe(false);
	});

	it("rejects provenance outside the active Action execution trace", () => {
		const manager = SessionManager.inMemory();
		const oldResultEventId = appendToolResult(manager, "historical result");
		const { frameRevisionEntryId } = initializeAction(manager);

		expect(() =>
			manager.appendObservation({
				observationId: "observation-1",
				statement: "historical evidence",
				sourceEventIds: [oldResultEventId],
				frameId: "frame-1",
				frameRevisionEntryId,
			}),
		).toThrow("must be an exact execution result after the current Action started");
	});
});
