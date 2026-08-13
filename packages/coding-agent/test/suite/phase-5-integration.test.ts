import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const inspectTool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "Inspect worker state",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: "worker cache TTL is 30 seconds" }],
		details: {},
	}),
};

const epistemicOptions = {
	anchorEnabled: true,
	frameEnabled: true,
	actionEnabled: true,
	observationEnabled: true,
	tools: [inspectTool],
};

async function collectObservation(
	harness: Harness,
	branchName: string,
	options?: { initialize?: boolean },
): Promise<{ observationId: string; resultEntryId: string }> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("inspect", {}, { id: `call-${branchName}` }), { stopReason: "toolUse" }),
		fauxAssistantMessage(`evidence collected for ${branchName}`),
	]);
	await harness.session.prompt(`diagnose ${branchName}`, {
		...(options?.initialize ? { anchor: { statement: "logout must revoke authorization" } } : {}),
		frame: {
			type: "create",
			statement: `${branchName} state survives logout`,
			falsifier: `a clean restart contradicts ${branchName}`,
			horizon: 20,
		},
		action: {
			type: "start",
			intent: `inspect ${branchName} state`,
			completionCondition: `${branchName} lifetime is identified`,
		},
	});
	const action = harness.session.action!;
	const branch = harness.sessionManager.getBranch();
	const actionStartIndex = branch.findIndex((entry) => entry.id === action.startEntryId);
	const resultEntry = branch
		.slice(actionStartIndex + 1)
		.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
	if (!resultEntry) throw new Error(`Missing ${branchName} tool result.`);
	const observation = harness.session.materializeObservation({
		statement: `${branchName} durable evidence`,
		affects: "anchor_and_frame",
		sourceEventIds: [resultEntry.id],
	});
	harness.session.completeAction(`${branchName} evidence captured`, { sourceEventId: resultEntry.id });
	return { observationId: observation.id, resultEntryId: resultEntry.id };
}

describe("Phase 5 integrated epistemic flow", () => {
	it("restores the full state and raw provenance across legacy summaries and a process restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "pie-phase-5-"));
		let firstHarness: Harness | undefined;
		let resumedHarness: Harness | undefined;
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			firstHarness = await createHarness({ ...epistemicOptions, sessionManager: manager });
			const evidence = await collectObservation(firstHarness, "worker-local", { initialize: true });
			firstHarness.session.startAction({
				intent: "adjudicate the durable worker evidence",
				completionCondition: "the evidence is reconsidered",
			});

			const firstKeptEntryId = manager.getBranch()[0]!.id;
			const compactionId = manager.appendCompaction("legacy compaction narrative", firstKeptEntryId, 4000);
			const abandonedEventId = manager.appendMessage({
				role: "user",
				content: "abandoned branch noise",
				timestamp: Date.now(),
			});
			manager.branchWithSummary(compactionId, "legacy branch narrative");
			const sessionFile = manager.getSessionFile()!;
			const rawEventCountBeforeRestart = manager.getEntries().length;
			firstHarness.cleanup();
			firstHarness = undefined;

			const reopened = SessionManager.open(sessionFile);
			resumedHarness = await createHarness({ ...epistemicOptions, sessionManager: reopened });
			resumedHarness.setResponses([fauxAssistantMessage("restored")]);
			await resumedHarness.session.prompt("continue from durable state");

			expect(resumedHarness.providerContexts).toHaveLength(1);
			const providerTexts = resumedHarness.providerContexts[0]!.messages.map(getMessageText);
			expect(providerTexts).toContain("[ANCHOR]\nlogout must revoke authorization");
			expect(providerTexts).toContainEqual(expect.stringContaining("[CURRENT FRAME]"));
			expect(providerTexts).toContainEqual(expect.stringContaining(`[OBSERVATION ${evidence.observationId}]`));
			expect(providerTexts).toContainEqual(expect.stringContaining("[CURRENT ACTION]"));
			expect(providerTexts).not.toContain("legacy compaction narrative");
			expect(providerTexts).not.toContain("legacy branch narrative");
			expect(providerTexts).not.toContain("abandoned branch noise");

			const manifest = resumedHarness.session.latestContextManifest;
			expect(manifest?.compilerVersion).toBe("pie-phase-4-observation/v1");
			expect(manifest?.omissions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ eventType: "compaction", reason: "historical_summary" }),
					expect.objectContaining({ eventType: "branch_summary", reason: "historical_summary" }),
				]),
			);
			expect(manifest?.epistemicState.observations?.selected[0]).toMatchObject({
				id: evidence.observationId,
				sourceEventIds: [evidence.resultEntryId],
			});

			const diagnostics = resumedHarness.session.getEpistemicDiagnostics();
			expect(diagnostics).toMatchObject({
				enabled: { anchor: true, frame: true, action: true, observation: true },
				state: {
					anchor: { statement: "logout must revoke authorization" },
					frame: { statement: "worker-local state survives logout" },
					action: { completionCondition: "the evidence is reconsidered" },
					observations: [{ id: evidence.observationId, sourceEventIds: [evidence.resultEntryId] }],
				},
				context: {
					compilerVersion: "pie-phase-4-observation/v1",
					omissionsByReason: { historical_summary: 2 },
				},
			});
			expect(diagnostics.provenance.rawEventCount).toBe(rawEventCountBeforeRestart + 2);
			expect(diagnostics.provenance.rawEventCount).toBeGreaterThan(diagnostics.provenance.activeBranchEventCount);
			expect(reopened.getEntry(evidence.resultEntryId)).toBeDefined();
			expect(reopened.getEntry(abandonedEventId)).toBeDefined();
		} finally {
			firstHarness?.cleanup();
			resumedHarness?.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("isolates divergent epistemic state while repeatedly selecting sibling branches across restarts", async () => {
		const root = mkdtempSync(join(tmpdir(), "pie-phase-5-branches-"));
		let harness: Harness | undefined;
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			harness = await createHarness({ ...epistemicOptions, sessionManager: manager });
			const branchA = await collectObservation(harness, "branch-a", { initialize: true });
			const anchorEntryId = harness.session.anchor!.revisionEntryId;
			const branchALeafId = manager.getLeafId()!;

			manager.branch(anchorEntryId);
			const branchB = await collectObservation(harness, "branch-b");
			const branchBLeafId = manager.getLeafId()!;

			manager.branch(branchALeafId);
			harness.setResponses([fauxAssistantMessage("branch a selected")]);
			await harness.session.prompt("continue branch a");
			const sessionFile = manager.getSessionFile()!;
			harness.cleanup();
			harness = undefined;

			let reopened = SessionManager.open(sessionFile);
			harness = await createHarness({ ...epistemicOptions, sessionManager: reopened });
			expect(harness.session.frame?.statement).toBe("branch-a state survives logout");
			expect(harness.session.observations.map(({ id }) => id)).toEqual([branchA.observationId]);
			expect(reopened.getEntry(branchB.resultEntryId)).toBeDefined();

			reopened.branch(branchBLeafId);
			harness.setResponses([fauxAssistantMessage("branch b selected")]);
			await harness.session.prompt("continue branch b");
			harness.cleanup();
			harness = undefined;

			reopened = SessionManager.open(sessionFile);
			harness = await createHarness({ ...epistemicOptions, sessionManager: reopened });
			expect(harness.session.frame?.statement).toBe("branch-b state survives logout");
			expect(harness.session.observations.map(({ id }) => id)).toEqual([branchB.observationId]);
			expect(reopened.getEntry(branchA.resultEntryId)).toBeDefined();
			expect(reopened.getEntries().length).toBeGreaterThan(reopened.getBranch().length);
		} finally {
			harness?.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("migrates a legacy compacted session without promoting narrative summaries or inventing epistemic state", async () => {
		const root = mkdtempSync(join(tmpdir(), "pie-phase-5-legacy-"));
		let harness: Harness | undefined;
		try {
			const sessionFile = join(root, "legacy.jsonl");
			const oldAssistant = fauxAssistantMessage("legacy raw answer");
			const entries = [
				{ type: "session", version: 2, id: "legacy-session", timestamp: new Date(1).toISOString(), cwd: root },
				{
					type: "message",
					id: "legacy-user",
					parentId: null,
					timestamp: new Date(2).toISOString(),
					message: { role: "user", content: "legacy raw request", timestamp: 2 },
				},
				{
					type: "message",
					id: "legacy-assistant",
					parentId: "legacy-user",
					timestamp: new Date(3).toISOString(),
					message: oldAssistant,
				},
				{
					type: "compaction",
					id: "legacy-compaction",
					parentId: "legacy-assistant",
					timestamp: new Date(4).toISOString(),
					summary: "legacy narrative summary",
					firstKeptEntryId: "legacy-user",
					tokensBefore: 1000,
				},
			];
			writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			const manager = SessionManager.open(sessionFile);
			expect(manager.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
			harness = await createHarness({ ...epistemicOptions, sessionManager: manager });
			harness.setResponses([fauxAssistantMessage("continued")]);
			await harness.session.prompt("continue the legacy session");

			expect(harness.providerContexts[0]!.messages.map(getMessageText)).toEqual([
				"legacy raw request",
				"legacy raw answer",
				"continue the legacy session",
			]);
			expect(harness.session.anchor).toBeUndefined();
			expect(harness.session.frame).toBeUndefined();
			expect(harness.session.action).toBeUndefined();
			expect(harness.session.observations).toEqual([]);
			expect(manager.getEntry("legacy-compaction")).toBeDefined();
			expect(harness.session.latestContextManifest?.omissions).toContainEqual({
				eventId: "legacy-compaction",
				eventType: "compaction",
				reason: "historical_summary",
			});
		} finally {
			harness?.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps long repeated episodes bounded, resumable, and traceable under projection pressure", async () => {
		const root = mkdtempSync(join(tmpdir(), "pie-phase-5-long-"));
		let harness: Harness | undefined;
		let manager = SessionManager.create(root, join(root, "sessions"));
		let execution = 0;
		const stressTool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Return one deterministic world result",
			parameters: Type.Object({ episode: Type.Number() }),
			execute: async () => ({
				content: [{ type: "text", text: `world-result-${++execution}` }],
				details: {},
			}),
		};
		const options = {
			anchorEnabled: true,
			frameEnabled: true,
			actionEnabled: true,
			observationEnabled: true,
			contextInputTokenLimit: 700,
			tools: [stressTool],
		};
		try {
			harness = await createHarness({ ...options, sessionManager: manager });
			for (let episode = 1; episode <= 18; episode++) {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("probe", { episode }, { id: `call-${episode}` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(`episode-${episode}-complete`),
				]);
				await harness.session.prompt(`run bounded episode ${episode}`, {
					...(episode === 1
						? {
								anchor: { statement: "preserve every material world result" },
								frame: {
									type: "create" as const,
									statement: "the repeated probe remains informative",
									falsifier: "a probe result contradicts the repeated pattern",
									horizon: 80,
								},
							}
						: {}),
					action: {
						type: "start",
						intent: `collect world result ${episode}`,
						completionCondition: `world result ${episode} is captured`,
					},
				});
				const action = harness.session.action!;
				const branch = manager.getBranch();
				const startIndex = branch.findIndex((entry) => entry.id === action.startEntryId);
				const result = branch
					.slice(startIndex + 1)
					.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
				if (!result) throw new Error(`Episode ${episode} has no result provenance.`);
				harness.session.materializeObservation({
					statement: `durable observation ${episode}: world-result-${episode}`,
					affects: "anchor_and_frame",
					sourceEventIds: [result.id],
				});
				harness.session.completeAction(`episode ${episode} completed`, { sourceEventId: result.id });

				if (episode % 4 === 0 && episode < 18) {
					const sessionFile = manager.getSessionFile()!;
					harness.cleanup();
					harness = undefined;
					manager = SessionManager.open(sessionFile);
					harness = await createHarness({ ...options, sessionManager: manager });
					expect(harness.session.observations).toHaveLength(episode);
				}
			}

			const diagnostics = harness.session.getEpistemicDiagnostics();
			expect(diagnostics.state.anchor?.statement).toBe("preserve every material world result");
			expect(diagnostics.state.frame?.statement).toBe("the repeated probe remains informative");
			expect(diagnostics.state.action).toBeUndefined();
			expect(diagnostics.state.observations).toHaveLength(18);
			expect(diagnostics.provenance.rawEventCount).toBeGreaterThan(120);
			expect(diagnostics.context?.outputMessageTokens).toBeLessThanOrEqual(
				diagnostics.context?.availableInputTokens ?? 0,
			);
			expect(harness.session.latestContextManifest?.epistemicState.observations?.omitted).not.toHaveLength(0);
			expect(
				manager.getEntries().some((entry) => entry.type === "compaction" || entry.type === "branch_summary"),
			).toBe(false);
			for (const observation of harness.session.observations) {
				for (const sourceEventId of observation.sourceEventIds) {
					expect(manager.getEntry(sourceEventId)).toMatchObject({
						type: "message",
						message: { role: "toolResult" },
					});
				}
			}
		} finally {
			harness?.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
