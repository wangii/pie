import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { restoreEpistemicState } from "../src/core/epistemic-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("Anchor persistence", () => {
	it("restores the append-only revision chain after reopening a session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pie-anchor-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir);
			const firstSourceId = manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "ship feature A" }],
				timestamp: 1,
			});
			const firstRevisionId = manager.appendAnchorRevision({
				anchorId: "anchor-1",
				revision: 1,
				statement: "ship feature A",
				previousRevisionId: null,
				sourceEventId: firstSourceId,
			});
			const secondSourceId = manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "ship feature B instead" }],
				timestamp: 2,
			});
			manager.appendAnchorRevision({
				anchorId: "anchor-1",
				revision: 2,
				statement: "ship feature B instead",
				previousRevisionId: firstRevisionId,
				sourceEventId: secondSourceId,
				revisionReason: "user changed the outcome",
			});
			manager.appendMessage(fauxAssistantMessage("done"));

			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			const reopened = SessionManager.open(sessionFile!);
			expect(restoreEpistemicState(reopened.getBranch()).anchor).toMatchObject({
				id: "anchor-1",
				revision: 2,
				statement: "ship feature B instead",
				previousRevisionId: firstRevisionId,
				sourceEventId: secondSourceId,
				revisionReason: "user changed the outcome",
			});
			expect(reopened.getEntries().filter((entry) => entry.type === "anchor_revision")).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
