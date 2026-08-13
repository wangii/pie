import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const MODEL = { provider: "deepseek", id: "deepseek-v4-flash" } as const;
const repetitions = Number.parseInt(process.env.PI_ACTION_TOOLS_EVAL_REPETITIONS ?? "3", 10);

type ActionToolsEvalOutput = {
	response: string;
	compilerVersion: string | null;
	actionId: string | null;
	actionTokens: number;
	outsideEpisodeOmissions: number;
	modelTurns: number;
	toolCalls: number;
};

function prompt(content: string) {
	return { type: "prompt" as const, content };
}

/** Worker-cache fixture: a deterministic logout defect plus a misleading restart claim. */
const cacheFixture = {
	"package.json": JSON.stringify(
		{
			name: "worker-auth-fixture",
			private: true,
			version: "1.0.0",
			scripts: { test: "node tests/failure.test.js" },
		},
		null,
		2,
	),
	"state/session.json": '{"revoked":false}',
	"src/logout.js": `// Worker-local authorization cache with a fixed TTL.
// Loaded entries expire after CACHE_TTL_MS; a clean process restart also clears the cache.
const fs = require("node:fs");
const path = require("node:path");

const CACHE_TTL_MS = 5 * 60 * 1000;
const workerCache = new Map();

function stateFile() {
  return path.join(__dirname, "..", "state", "session.json");
}

function loadAuth(userId) {
  if (!workerCache.has(userId)) {
    workerCache.set(userId, { token: "stale-token", loadedAt: Date.now() });
  }
  const entry = workerCache.get(userId);
  if (Date.now() - entry.loadedAt > CACHE_TTL_MS) workerCache.delete(userId);
  return workerCache.get(userId);
}

function isAuthorized(userId) {
  const persisted = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  if (persisted.revoked !== true) return true;
  // Once revoked, only a live non-revoked cache entry may keep authorization.
  return loadAuth(userId) !== undefined;
}

function revokeAuth(userId) {
  const persisted = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  persisted.revoked = true;
  fs.writeFileSync(stateFile(), JSON.stringify(persisted));
  workerCache.delete(userId);
}

module.exports = { isAuthorized, loadAuth, revokeAuth, workerCache };
`,
	"tests/failure.test.js": `const assert = require("node:assert");
const { isAuthorized, revokeAuth } = require("../src/logout.js");

const userId = "u-42";
assert.strictEqual(isAuthorized(userId), true, "session should start authorized");
revokeAuth(userId);
assert.strictEqual(isAuthorized(userId), false, "cached authorization survived logout");
`,
	"scripts/restart.sh": `#!/bin/sh
# Orchestrator-triggered worker restart. It resets persisted session state.
mkdir -p state
printf '{"revoked":false}' > state/session.json
echo "restart completed: worker-local authorization state cleared"
`,
};

/** Replica fixture: a lagging replica whose divergence only appears on comparison. */
const replicaFixture = {
	"cluster/README.md": `# Cluster
Reads are served by the replica. Writes go to the primary.
The replica replays the primary write log with a small delay.`,
	"cluster/primary.log": `position 1001 write u-42
position 1002 write u-43
position 1003 write u-42`,
	"cluster/replica.log": `position 1001 write u-42`,
	"scripts/check-position.sh": `#!/bin/sh
# Cheap local proxy: report the replica's current position.
tail -n 1 cluster/replica.log
`,
	"scripts/compare-positions.sh": `#!/bin/sh
# Compare the last primary position with the last replica position.
primary=$(tail -n 1 cluster/primary.log | cut -d' ' -f1)
replica=$(tail -n 1 cluster/replica.log | cut -d' ' -f1)
if [ "$primary" = "$replica" ]; then
  echo "positions match: $primary"
else
  echo "positions diverge: primary $primary, replica $replica"
fi
`,
};

/** Deploy fixture: a transient lock that only an external orchestrator can release. */
const deployFixture = {
	"README.md": `# Deploy environment
- The worker runs behind an external orchestrator process.
- state/lock.pid records the transient deploy lock; it is held by the orchestrator.
- Only the external orchestrator can release the lock; local commands cannot.`,
	"state/lock.pid": "4242",
	"scripts/restart.sh": `#!/bin/sh
# Attempt a clean worker restart.
if [ -f state/lock.pid ]; then
  echo "restart failed: transient lock held by pid $(cat state/lock.pid)"
  echo "release is handled by the external orchestrator, not by local commands"
  exit 1
fi
echo "restart completed"
`,
};

const scenarios: Array<{ name: string; steps: PiCodingAgentInput }> = [
	{
		name: "restart investigation keeps its frozen completion condition",
		steps: [
			{
				type: "seed",
				files: cacheFixture,
			},
			{
				type: "prompt",
				content:
					"A logout defect may involve worker-local caching. The workspace has a small Node service, a failing test, a state file, and a restart script. Reply exactly ACK.",
				anchor: { statement: "Determine why logout sometimes fails to revoke authorization." },
				frame: {
					type: "create",
					statement: "Worker-local authorization state survives logout.",
					falsifier: "A clean worker restart preserves the authorization failure.",
					horizon: 40,
				},
			},
			{
				type: "prompt",
				content: "Begin the authorized investigation and reply exactly ACK.",
				action: {
					type: "start",
					intent: "determine whether the worker cache survives logout",
					completionCondition: "The required completion marker is CANONICAL_COMPLETION=IDENTIFY_CACHE_LIFETIME.",
				},
			},
			prompt(
				"Run the failing test, inspect src/logout.js, and run scripts/restart.sh. An orchestrator report claims the restart clears the failure; verify that claim against the actual test run. Keep investigating until you can state the worker cache lifetime. Reply exactly ACK when done investigating.",
			),
			prompt("Output only the completion marker that still governs this investigation."),
		],
	},
	{
		name: "two-episode session keeps the frozen completion condition",
		steps: [
			{
				type: "seed",
				files: { ...cacheFixture, ...replicaFixture },
			},
			{
				type: "prompt",
				content:
					"Stale read-after-write symptoms may involve worker caching or replica lag. Two investigations are authorized. Reply exactly ACK.",
				anchor: { statement: "Identify the source of stale read-after-write results." },
				frame: {
					type: "create",
					statement: "The read replica lags the primary.",
					falsifier: "Primary and replica positions match during a stale read.",
					horizon: 40,
				},
			},
			{
				type: "prompt",
				content: "Begin the cache investigation and reply exactly ACK.",
				action: {
					type: "start",
					intent: "determine whether the worker cache survives logout",
					completionCondition: "The required completion marker is CANONICAL_COMPLETION=IDENTIFY_CACHE_LIFETIME.",
				},
			},
			prompt(
				"Run the failing test, inspect src/logout.js, and run scripts/restart.sh to test whether a restart clears the failure. Reply exactly ACK when done investigating.",
			),
			{
				type: "prompt",
				content: "The cache investigation is complete. Reply exactly ACK.",
				action: { type: "complete", reason: "Worker cache lifetime identified." },
			},
			{
				type: "prompt",
				content:
					"Begin the replica investigation and reply exactly ACK. This investigation is satisfiable in this workspace.",
				action: {
					type: "start",
					intent: "compare primary and replica positions during a stale read",
					completionCondition:
						"The required completion marker is CANONICAL_COMPLETION=CAPTURE_POSITION_DIVERGENCE.",
				},
			},
			prompt(
				"Run scripts/check-position.sh and scripts/compare-positions.sh to capture the position relationship. Reply exactly ACK when done investigating.",
			),
			prompt("Output only the completion marker that still governs this investigation."),
		],
	},
	{
		name: "unsatisfiable action returns control in bounded time",
		steps: [
			{
				type: "seed",
				files: deployFixture,
			},
			{
				type: "prompt",
				content:
					"A deploy restart is failing because of a transient lock. The workspace documents the environment and provides a restart script. Reply exactly ACK.",
				anchor: { statement: "Determine why the worker restart fails to clear the transient lock." },
				frame: {
					type: "create",
					statement: "The transient deploy lock blocks restart until the orchestrator releases it.",
					falsifier: "A local restart attempt clears the lock.",
					horizon: 20,
				},
			},
			{
				type: "prompt",
				content: "Begin the bounded investigation and reply exactly ACK.",
				action: {
					type: "start",
					intent: "confirm whether a worker restart clears the transient lock",
					completionCondition: "The required completion marker is CANONICAL_COMPLETION=CLEARED_AFTER_RESTART.",
				},
			},
			prompt(
				"Use tools to try to satisfy the completion condition. Each restart attempt fails identically with the same lock-held error, and the environment states that only the external orchestrator can release the lock. If the completion condition cannot be met under the current frame and constraints, reply with exactly one line containing only: UNRESOLVABLE. Do not add any other text.",
			),
		],
	},
];

/** Marker from the most recent Action contract, or a sentinel for the unsatisfiable scenario. */
function expectedCompletion(input: PiCodingAgentInput): string {
	if (typeof input === "string") throw new Error("Action tools eval requires structured input.");
	let marker: string | undefined;
	for (const step of input) {
		if (step.type !== "prompt" || step.action?.type !== "start") continue;
		const match = step.action.completionCondition.match(/CANONICAL_COMPLETION=([A-Z_]+)/);
		if (match) marker = match[1];
	}
	if (!marker) throw new Error("Action tools eval input has no completion marker in its Action contract.");
	return marker;
}

const ActionToolsCompletionJudge = createJudge<PiCodingAgentInput, ActionToolsEvalOutput>(
	"ActionToolsCompletionJudge",
	({ input, output }) => {
		const marker = expectedCompletion(input);
		// The unsatisfiable scenario's contract cannot be met; control must return as UNRESOLVABLE.
		const target = marker === "CLEARED_AFTER_RESTART" ? "UNRESOLVABLE" : marker;
		const trimmed = output.response.trim();
		// UNRESOLVABLE is a runtime contract token (the session closes the Action on exact
		// trimmed equality), so it must match exactly. Completion markers are text
		// identification; the model may wrap them in prose or a code fence.
		const matches =
			target === "UNRESOLVABLE"
				? trimmed === target
				: trimmed === target || trimmed.includes(`CANONICAL_COMPLETION=${target}`);
		return {
			score: matches ? 1 : 0,
			metadata: {
				rationale: matches ? `Returned ${target}.` : `Expected ${target}, received ${JSON.stringify(trimmed)}.`,
				modelTurns: output.modelTurns,
				toolCalls: output.toolCalls,
			},
		};
	},
);

function createActionHarness(name: string, actionEnabled: boolean) {
	return createPiCodingAgentHarness({
		name,
		model: MODEL,
		transformSystemPrompt: (systemPrompt) =>
			`${systemPrompt}

You are running in an isolated evaluation workspace at the current directory. All investigation must stay inside this directory. Never read, list, search, or write files outside it (in particular, never inspect the agent harness, eval sources, or package sources on this machine). When a task instructs you to reply with a specific token, reply with exactly that token and nothing else.`,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled,
		output: ({ response, session }): ActionToolsEvalOutput => ({
			response,
			compilerVersion: session.latestContextManifest?.compilerVersion ?? null,
			actionId: session.latestContextManifest?.epistemicState.action?.id ?? null,
			actionTokens: session.latestContextManifest?.epistemicState.action?.tokens ?? 0,
			outsideEpisodeOmissions:
				session.latestContextManifest?.omissions.filter(({ reason }) => reason === "outside_action_episode")
					.length ?? 0,
			modelTurns: session.getSessionStats().assistantMessages,
			toolCalls: session.getSessionStats().toolCalls,
		}),
	});
}

const actionToolsHarnessTable = evalHarnessTable("Pie Phase 3 Action tools ablation", {
	baseline: createActionHarness("phase-2-without-action", false),
	candidate: createActionHarness("phase-3-with-action", true),
	repetitions,
});

describe.for(actionToolsHarnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval(
		"Pie Phase 3 Action tools ablation",
		{ harness, judges: [ActionToolsCompletionJudge], judgeThreshold: null },
		(it) => {
			for (const scenario of scenarios) {
				it(scenario.name, async ({ run }) => {
					const result = await run(scenario.steps);
					if (harness.name === "phase-3-with-action") {
						expect(result.output.compilerVersion).toBe("pie-phase-3-action/v1");
						expect(result.output.actionId).not.toBeNull();
						expect(result.output.actionTokens).toBeGreaterThan(0);
						expect(result.output.outsideEpisodeOmissions).toBeGreaterThan(0);
					} else {
						expect(result.output.compilerVersion).toBe("pie-phase-2-frame/v1");
						expect(result.output.actionId).toBeNull();
						expect(result.output.actionTokens).toBe(0);
					}
					if (scenario.name.includes("unsatisfiable")) {
						expect(result.output.modelTurns).toBeLessThanOrEqual(15);
						expect(result.output.toolCalls).toBeLessThanOrEqual(15);
					} else if (harness.name === "phase-3-with-action") {
						expect(result.output.toolCalls).toBeGreaterThan(0);
					}
				});
			}
		},
	);
});
