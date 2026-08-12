import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { restoreEpistemicState } from "../src/core/epistemic-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function initializeAnchor(manager: SessionManager): string {
	const sourceEventId = manager.appendMessage({ role: "user", content: "solve the task", timestamp: 1 });
	manager.appendAnchorRevision({
		anchorId: "anchor-1",
		revision: 1,
		statement: "solve the task",
		previousRevisionId: null,
		sourceEventId,
	});
	return sourceEventId;
}

describe("Frame persistence", () => {
	it("restores immutable versions and derives horizon progress from raw model responses", () => {
		const manager = SessionManager.inMemory();
		const sourceEventId = initializeAnchor(manager);
		const firstRevisionId = manager.appendFrameRevision({
			frameId: "frame-1",
			version: 1,
			statement: "the cache is stale",
			falsifier: "a cold read reproduces the value",
			horizon: 3,
			previousRevisionId: null,
			sourceEventId,
		});
		manager.appendMessage(fauxAssistantMessage("inspect cache"));
		const revisionSourceId = manager.appendMessage({ role: "user", content: "narrow the check", timestamp: 2 });
		manager.appendFrameRevision({
			frameId: "frame-1",
			version: 2,
			statement: "the worker cache is stale",
			falsifier: "a worker restart preserves the value",
			horizon: 2,
			previousRevisionId: firstRevisionId,
			sourceEventId: revisionSourceId,
			revisionReason: "scope narrowed",
		});
		manager.appendMessage(fauxAssistantMessage("restart worker"));

		expect(restoreEpistemicState(manager.getBranch()).frame).toMatchObject({
			id: "frame-1",
			version: 2,
			statement: "the worker cache is stale",
			falsifier: "a worker restart preserves the value",
			horizon: 2,
			completedModelResponses: 1,
			revisionReason: "scope narrowed",
		});
	});

	it("persists replacement as termination of one identity followed by another", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pie-frame-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir);
			const sourceEventId = initializeAnchor(manager);
			const revisionEntryId = manager.appendFrameRevision({
				frameId: "frame-old",
				version: 1,
				statement: "the cache is stale",
				falsifier: "cache bypass still fails",
				horizon: 2,
				previousRevisionId: null,
				sourceEventId,
			});
			manager.appendFrameTransition({
				frameId: "frame-old",
				version: 1,
				revisionEntryId,
				transition: "replaced",
				sourceEventId,
				reason: "database evidence redirects the investigation",
				replacementFrameId: "frame-new",
			});
			manager.appendFrameRevision({
				frameId: "frame-new",
				version: 1,
				statement: "the database replica lags",
				falsifier: "primary and replica positions match",
				horizon: 3,
				previousRevisionId: null,
				sourceEventId,
			});
			manager.appendMessage(fauxAssistantMessage("inspect replica"));

			const reopened = SessionManager.open(manager.getSessionFile()!);
			expect(restoreEpistemicState(reopened.getBranch()).frame).toMatchObject({
				id: "frame-new",
				version: 1,
				statement: "the database replica lags",
			});
			expect(reopened.getEntries().filter((entry) => entry.type === "frame_transition")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
