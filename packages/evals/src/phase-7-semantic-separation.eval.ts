import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const execFileAsync = promisify(execFile);
const MODEL = { provider: "deepseek", id: "deepseek-v4-flash" } as const;
const repetitions = Number.parseInt(process.env.PI_PHASE_7_EVAL_REPETITIONS ?? "1", 10);

type PhaseSevenOutput = {
	response: string;
	workspacePassed: boolean;
	frameStatements: string[];
	frameTransitions: string[];
	actionIntents: string[];
	actionTransitions: string[];
	actionsPerFrame: Record<string, number>;
	modelResponsesPerAction: number[];
	toolCalls: number;
	modelResponses: number;
};

type Scenario = {
	name: string;
	files: Record<string, string>;
	task: string;
	baselineFrame: { statement: string; falsifier: string };
	baselineAction: { intent: string; completionCondition: string };
	expectMultipleActions: boolean;
	expectFrameTermination: boolean;
};

const packageJson = JSON.stringify(
	{
		name: "phase-7-fixture",
		private: true,
		version: "1.0.0",
		scripts: { test: "node tests/test.js" },
	},
	null,
	2,
);

const scenarios: Scenario[] = [
	{
		name: "one Frame authorizes diagnosis then repair",
		files: {
			"package.json": packageJson,
			"src/subject.js": `function normalizeIds(values) {
  return values.filter(Boolean);
}
module.exports = { normalizeIds };
`,
			"tests/test.js": `const assert = require("node:assert/strict");
const { normalizeIds } = require("../src/subject.js");
assert.deepEqual(normalizeIds([0, 1, null, undefined, 2]), [0, 1, 2]);
console.log("PASS");
`,
		},
		task:
			"Fix the identifier regression and run npm test. Numeric zero is valid; only null and undefined are absent. " +
			"Use bounded investigation episodes. The first Action completion condition is only: establish the exact defect from read-only repository evidence; it must not edit files or run the post-edit verification. After explicitly completing that Action, authorize a second Action under the same still-admissible Frame whose completion condition is: apply the repair and verify it with npm test. End the final answer with a line containing only PASS.",
		baselineFrame: {
			statement: "Complete the current user request without weakening its success semantics",
			falsifier: "A world result shows the whole request cannot be completed",
		},
		baselineAction: {
			intent: "Fix the identifier regression and verify the complete user request",
			completionCondition: "The implementation is fixed, npm test passes, and a final answer is produced",
		},
		expectMultipleActions: true,
		expectFrameTermination: false,
	},
	{
		name: "attractive cache Frame becomes inadmissible",
		files: {
			"package.json": packageJson,
			"reports/initial.txt":
				"Attractive initial report: worker-local cache survives logout. Required falsifier: run scripts/restart-probe.sh.\n",
			"scripts/restart-probe.sh": "#!/bin/sh\necho 'RESULT: failure persists after a clean worker restart'\n",
			"src/subject.js": `function authorizationSource(primaryPosition, replicaPosition) {
  return primaryPosition === replicaPosition ? "fresh" : "stale-replica";
}
module.exports = { authorizationSource };
`,
			"tests/test.js": `const assert = require("node:assert/strict");
const { authorizationSource } = require("../src/subject.js");
assert.equal(authorizationSource(1003, 1001), "stale-replica");
console.log("PASS");
`,
		},
		task:
			"Diagnose the authorization failure. The attractive initial report in reports/initial.txt favors worker-local cache. " +
			"Inspect it and run its required restart probe before relying on that commitment. If the concrete falsifier occurs, " +
			"explicitly terminate that Frame, reconsider in the same run, inspect the implementation and test, and run npm test. " +
			"End the final answer with a line containing only PASS.",
		baselineFrame: {
			statement: "Worker-local cache survives logout and explains the authorization failure",
			falsifier: "A clean worker restart preserves the authorization failure",
		},
		baselineAction: {
			intent: "Complete the entire diagnosis, probe, implementation inspection, and verification request",
			completionCondition: "The whole request is diagnosed, npm test passes, and a final answer is produced",
		},
		expectMultipleActions: false,
		expectFrameTermination: true,
	},
];

function steps(scenario: Scenario, baseline: boolean): PiCodingAgentInput {
	return [
		{ type: "seed", files: scenario.files },
		{
			type: "prompt",
			content: scenario.task,
			...(baseline
				? {
						anchor: { statement: scenario.task },
						frame: {
							type: "create" as const,
							...scenario.baselineFrame,
							horizon: 24,
						},
						action: { type: "start" as const, ...scenario.baselineAction },
					}
				: {}),
		},
	];
}

function finalLine(response: string): string {
	return (
		response
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? ""
	);
}

const SemanticSeparationJudge = createJudge<PiCodingAgentInput, PhaseSevenOutput>(
	"PhaseSevenSemanticSeparationJudge",
	({ output }) => {
		const passed = finalLine(output.response) === "PASS" && output.workspacePassed;
		return {
			score: passed ? 1 : 0,
			metadata: {
				rationale: passed
					? "The production flow completed the real tool task with explicit control."
					: `Expected passing workspace and final PASS, received ${JSON.stringify(output)}.`,
				modelResponses: output.modelResponses,
				toolCalls: output.toolCalls,
			},
		};
	},
);

function createSemanticHarness(name: string, baseline: boolean) {
	return createPiCodingAgentHarness({
		name,
		transformInput: baseline
			? (input) => {
					if (typeof input === "string") return input;
					const scenario = scenarios.find((candidate) =>
						input.some((step) => step.type === "prompt" && step.content === candidate.task),
					);
					return scenario ? steps(scenario, true) : input;
				}
			: undefined,
		model: MODEL,
		transformSystemPrompt: (systemPrompt) =>
			`${systemPrompt}\n\nThis is an isolated evaluation workspace. Stay inside it. Use real tools for every requested repository check. Follow Pie's JSON control protocol exactly during epistemic requests.`,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled: true,
		contextInputTokenLimit: 12_000,
		output: async ({ response, session, cwd }): Promise<PhaseSevenOutput> => {
			const branch = session.sessionManager.getBranch();
			const actionStarts = branch.filter((entry) => entry.type === "action_start");
			const actionTransitions = branch.filter((entry) => entry.type === "action_transition");
			const positions = new Map(branch.map((entry, index) => [entry.id, index] as const));
			const actionsPerFrame: Record<string, number> = {};
			for (const action of actionStarts) {
				actionsPerFrame[action.frameRevisionEntryId] = (actionsPerFrame[action.frameRevisionEntryId] ?? 0) + 1;
			}
			const modelResponsesPerAction = actionStarts.map((action) => {
				const start = positions.get(action.id) ?? -1;
				const transition = actionTransitions.find((entry) => entry.startEntryId === action.id);
				const end = transition ? (positions.get(transition.id) ?? branch.length) : branch.length;
				return branch
					.slice(start + 1, end + 1)
					.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
			});
			let workspacePassed = false;
			try {
				await execFileAsync(process.execPath, ["tests/test.js"], { cwd, timeout: 10_000 });
				workspacePassed = true;
			} catch {
				workspacePassed = false;
			}
			const stats = session.getSessionStats();
			return {
				response,
				workspacePassed,
				frameStatements: branch.filter((entry) => entry.type === "frame_revision").map((entry) => entry.statement),
				frameTransitions: branch
					.filter((entry) => entry.type === "frame_transition")
					.map((entry) => entry.transition),
				actionIntents: actionStarts.map((entry) => entry.intent),
				actionTransitions: actionTransitions.map((entry) => entry.transition),
				actionsPerFrame,
				modelResponsesPerAction,
				toolCalls: stats.toolCalls,
				modelResponses: stats.assistantMessages,
			};
		},
	});
}

const harnessTable = evalHarnessTable("Pie Phase 7 semantic separation", {
	baseline: createSemanticHarness("phase-6-task-sized-production", true),
	candidate: createSemanticHarness("phase-7-separated-production", false),
	repetitions,
});

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval(
		"Pie Phase 7 semantic separation",
		{ harness, judges: [SemanticSeparationJudge], judgeThreshold: null },
		(it) => {
			for (const scenario of scenarios) {
				it(scenario.name, async ({ run }) => {
					const baseline = harness.name === "phase-6-task-sized-production";
					const result = await run(steps(scenario, false));
					expect(result.output.workspacePassed).toBe(true);
					expect(finalLine(result.output.response)).toBe("PASS");
					expect(result.output.toolCalls).toBeGreaterThan(0);
					expect(result.output.actionTransitions.length).toBeGreaterThan(0);
					if (!baseline) {
						expect(result.output.frameStatements).not.toContain(scenario.task);
						expect(result.output.actionIntents).not.toContain(scenario.task);
						expect(result.output.modelResponsesPerAction.every((count) => count > 0)).toBe(true);
						if (scenario.expectMultipleActions) {
							expect(Math.max(...Object.values(result.output.actionsPerFrame))).toBeGreaterThanOrEqual(2);
						}
						if (scenario.expectFrameTermination) {
							expect(result.output.frameTransitions).toEqual(
								expect.arrayContaining([expect.stringMatching(/falsified|died|replaced/)]),
							);
						}
					} else {
						expect(result.output.actionIntents).toContain(scenario.baselineAction.intent);
					}
				});
			}
		},
	);
});
