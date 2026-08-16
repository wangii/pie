import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const execFileAsync = promisify(execFile);
const MODEL = { provider: "deepseek", id: "deepseek-v4-flash" } as const;
const repetitions = Number.parseInt(process.env.PI_PHASE_5_EVAL_REPETITIONS ?? "3", 10);

type PhaseFiveOutput = {
	response: string;
	compilerVersion: string | null;
	anchorActive: boolean;
	frameActive: boolean;
	actionActive: boolean;
	selectedObservations: number;
	observationSourceCount: number;
	provenanceValid: boolean;
	workspacePassed: boolean;
	persistedRestartCount: number;
	rawEventCount: number;
	activeBranchEventCount: number;
	outsideEpisodeOmissions: number;
	modelTurns: number;
	toolCalls: number;
};

const commonPackage = JSON.stringify(
	{
		name: "phase-5-coding-fixture",
		private: true,
		version: "1.0.0",
		scripts: { test: "node tests/test.js" },
	},
	null,
	2,
);

const codingScenarios: Array<{
	name: string;
	files: Record<string, string>;
	task: string;
	anchor: string;
	frame: string;
	expectation: string;
	longSession?: boolean;
}> = [
	{
		name: "preserves numeric zero while filtering absent identifiers",
		files: {
			"package.json": commonPackage,
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
		task: "Fix the regression: numeric identifier 0 is valid, while only null and undefined are absent. Inspect the implementation, edit it, and run npm test.",
		anchor: "normalizeIds must preserve every valid numeric identifier, including 0, and pass the regression test.",
		frame: "The truthiness filter incorrectly conflates numeric zero with an absent identifier.",
		expectation: "The regression still fails after filtering only null and undefined.",
	},
	{
		name: "lets explicit request headers override defaults",
		files: {
			"package.json": commonPackage,
			"src/subject.js": `function mergeHeaders(defaults, overrides) {
  return { ...overrides, ...defaults };
}

module.exports = { mergeHeaders };
`,
			"tests/test.js": `const assert = require("node:assert/strict");
const { mergeHeaders } = require("../src/subject.js");
assert.deepEqual(
  mergeHeaders({ authorization: "default", accept: "json" }, { authorization: "request" }),
  { authorization: "request", accept: "json" },
);
console.log("PASS");
`,
		},
		task: "Fix header precedence so explicit request overrides win while untouched defaults remain. Inspect the implementation, edit it, and run npm test.",
		anchor:
			"Explicit request headers must override defaults without dropping unrelated defaults, and the regression test must pass.",
		frame: "The object spread order restores defaults after applying explicit request overrides.",
		expectation: "The authorization override still loses after reversing the merge precedence.",
	},
	{
		name: "handles the expiration boundary through a long restarted session",
		files: {
			"package.json": commonPackage,
			"src/subject.js": `function isExpired(now, expiresAt) {
  return now > expiresAt;
}

module.exports = { isExpired };
`,
			"tests/test.js": `const assert = require("node:assert/strict");
const { isExpired } = require("../src/subject.js");
assert.equal(isExpired(100, 100), true, "equal timestamps are expired");
assert.equal(isExpired(99, 100), false);
console.log("PASS");
`,
		},
		task: "Fix expiration semantics: a token is expired when now is equal to or later than expiresAt. Inspect the implementation, edit it, and run npm test.",
		anchor: "Expiration must be inclusive at expiresAt and the boundary regression test must pass.",
		frame: "The strict greater-than comparison leaves tokens valid at their exact expiration timestamp.",
		expectation: "The equal-timestamp regression still fails after making the boundary inclusive.",
		longSession: true,
	},
];

function codingSteps(scenario: (typeof codingScenarios)[number]): PiCodingAgentInput {
	const maintenanceTurns = scenario.longSession
		? Array.from({ length: 6 }, (_, index) => ({
				type: "prompt" as const,
				content:
					`Maintenance checkpoint ${index + 1}: no user goal changed. ` +
					"Keep the original success criterion and reply exactly ACK.",
			}))
		: [];
	return [
		{ type: "seed", files: scenario.files },
		{
			type: "prompt",
			content: `${scenario.task} Reply exactly ACK only after the test passes.`,
			anchor: { statement: scenario.anchor },
			frame: {
				type: "create",
				statement: scenario.frame,
				expectation: scenario.expectation,
				horizon: 50,
			},
			action: {
				type: "start",
				intent: "repair the localized regression and execute its test",
				completionCondition: "the implementation is corrected and npm test passes",
				expectation: "the completion condition is satisfied",
			},
		},
		{
			type: "observe_latest_action_results",
			statement:
				"The implementation was exercised by the Action's exact tool results; the regression result now determines Anchor satisfaction.",
			affects: "anchor",
		},
		{ type: "complete_current_action", reason: "the implementation was changed and the regression was executed" },
		{ type: "restart" },
		...maintenanceTurns,
		...(scenario.longSession ? ([{ type: "restart" as const }] satisfies PiCodingAgentInput) : []),
		{
			type: "prompt",
			content:
				"Verify the completed coding task from durable state. Run npm test again with tools. If it succeeds, end the response with a line containing only PASS; otherwise continue fixing until it does.",
			action: {
				type: "start",
				intent: "verify the durable coding outcome after session restoration",
				completionCondition: "npm test passes and the final response line is PASS",
				expectation: "the completion condition is satisfied",
			},
		},
		{ type: "complete_current_action", reason: "the restored session produced a passing verification result" },
	];
}

const scenarios: Array<{ name: string; steps: PiCodingAgentInput; coding: boolean; longSession: boolean }> = [
	{
		name: "contradictory evidence survives process restart",
		coding: false,
		longSession: false,
		steps: [
			{
				type: "seed",
				files: {
					"evidence.txt":
						"Probe: clean worker restart\nResult: authorization failure persists after restart\nConclusion: worker-local cache is not sufficient\n",
				},
			},
			{
				type: "prompt",
				content:
					"You must call the read tool on evidence.txt before replying. After the tool result arrives, reply exactly ACK.",
				anchor: { statement: "Determine why logout sometimes fails to revoke authorization." },
				frame: {
					type: "create",
					statement:
						"Worker-local authorization state survives logout. Without durable contradictory evidence, DECISION=KEEP_FRAME.",
					expectation: "A clean worker restart preserves the authorization failure.",
					horizon: 8,
				},
				action: {
					type: "start",
					intent: "run the clean-worker expectation probe",
					completionCondition: "the post-restart authorization result is captured",
					expectation: "the completion condition is satisfied",
				},
			},
			{
				type: "observe_latest_action_results",
				statement:
					"A clean worker restart preserved the authorization failure, so the current Frame's declared expectation occurred. Durable adjudication is DECISION=REJECT_FRAME.",
				affects: "frame",
			},
			{ type: "complete_current_action", reason: "the restart result was captured" },
			{ type: "remove", paths: ["evidence.txt"] },
			{ type: "restart" },
			{
				type: "prompt",
				content:
					"Adjudicate the current Frame from durable Observation evidence. Output only the value after its DECISION= marker: KEEP_FRAME or REJECT_FRAME.",
				action: {
					type: "start",
					intent: "adjudicate whether the current Frame remains admissible",
					completionCondition: "output exactly KEEP_FRAME or REJECT_FRAME from durable current context",
					expectation: "the completion condition is satisfied",
				},
			},
			{ type: "adjudicate_current_frame" },
		],
	},
	...codingScenarios.map((scenario) => ({
		name: scenario.name,
		steps: codingSteps(scenario),
		coding: true,
		longSession: scenario.longSession ?? false,
	})),
];

function isCodingInput(input: PiCodingAgentInput): boolean {
	return (
		typeof input !== "string" &&
		input.some((step) => step.type === "seed" && Object.hasOwn(step.files, "tests/test.js"))
	);
}

function finalResponseLine(response: string): string {
	return (
		response
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? ""
	);
}

const IntegratedStabilityJudge = createJudge<PiCodingAgentInput, PhaseFiveOutput>(
	"PhaseFiveIntegratedStabilityJudge",
	({ input, output }) => {
		const coding = isCodingInput(input);
		const expectedResponse = coding ? "PASS" : "REJECT_FRAME";
		const expectedFrameActive = coding;
		const passed =
			finalResponseLine(output.response) === expectedResponse &&
			output.workspacePassed &&
			output.provenanceValid &&
			output.anchorActive &&
			output.frameActive === expectedFrameActive &&
			!output.actionActive &&
			output.selectedObservations > 0 &&
			output.observationSourceCount > 0;
		return {
			score: passed ? 1 : 0,
			metadata: {
				rationale: passed
					? `The full integrated flow retained provenance and produced ${expectedResponse}.`
					: `Expected a valid integrated ${expectedResponse} outcome, received ${JSON.stringify(output)}.`,
				modelTurns: output.modelTurns,
				toolCalls: output.toolCalls,
			},
		};
	},
);

async function verifyWorkspace(cwd: string): Promise<boolean> {
	if (!existsSync(`${cwd}/tests/test.js`)) return true;
	try {
		await execFileAsync(process.execPath, ["tests/test.js"], { cwd, timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

function createIntegratedHarness(name: string, performPersistedRestarts: boolean) {
	return createPiCodingAgentHarness({
		name,
		model: MODEL,
		transformSystemPrompt: (systemPrompt) =>
			`${systemPrompt}\n\nYou are running in an isolated evaluation workspace. Stay inside it. Use tools for requested coding work and follow exact reply-token instructions.`,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled: true,
		contextInputTokenLimit: 8_000,
		performPersistedRestarts,
		output: async ({ response, session, cwd, persistedRestartCount }): Promise<PhaseFiveOutput> => {
			const manifest = session.latestContextManifest;
			const selected = manifest?.epistemicState.observations?.selected ?? [];
			const diagnostics = session.getEpistemicDiagnostics();
			const provenanceValid = session.observations.every((observation) =>
				observation.sourceEventIds.every((sourceEventId) => {
					const source = session.sessionManager.getEntry(sourceEventId);
					return (
						source?.type === "message" &&
						(source.message.role === "toolResult" || source.message.role === "bashExecution")
					);
				}),
			);
			return {
				response,
				compilerVersion: manifest?.compilerVersion ?? null,
				anchorActive: session.anchor !== undefined,
				frameActive: session.frame !== undefined,
				actionActive: session.action !== undefined,
				selectedObservations: selected.length,
				observationSourceCount: selected.reduce((sum, observation) => sum + observation.sourceEventIds.length, 0),
				provenanceValid,
				workspacePassed: await verifyWorkspace(cwd),
				persistedRestartCount,
				rawEventCount: diagnostics.provenance.rawEventCount,
				activeBranchEventCount: diagnostics.provenance.activeBranchEventCount,
				outsideEpisodeOmissions:
					manifest?.omissions.filter(({ reason }) => reason === "outside_action_episode").length ?? 0,
				modelTurns: session.getSessionStats().assistantMessages,
				toolCalls: session.getSessionStats().toolCalls,
			};
		},
	});
}

const phaseFiveHarnessTable = evalHarnessTable("Pie Phase 5 integrated stability", {
	baseline: createIntegratedHarness("phase-4-continuous-full-stack", false),
	candidate: createIntegratedHarness("phase-5-persisted-restart-full-stack", true),
	repetitions,
});

describe.for(phaseFiveHarnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval(
		"Pie Phase 5 integrated stability",
		{ harness, judges: [IntegratedStabilityJudge], judgeThreshold: null },
		(it) => {
			for (const scenario of scenarios) {
				it(scenario.name, async ({ run }) => {
					const result = await run(scenario.steps);
					expect(result.output.compilerVersion).toBe("pie-phase-4-observation/v1");
					expect(result.output.anchorActive).toBe(true);
					expect(result.output.actionActive).toBe(false);
					expect(result.output.selectedObservations).toBeGreaterThan(0);
					expect(result.output.observationSourceCount).toBeGreaterThan(0);
					expect(result.output.provenanceValid).toBe(true);
					expect(result.output.toolCalls).toBeGreaterThan(0);
					expect(result.output.outsideEpisodeOmissions).toBeGreaterThan(0);
					expect(result.output.activeBranchEventCount).toBe(result.output.rawEventCount);
					expect(result.output.persistedRestartCount).toBe(
						harness.name === "phase-5-persisted-restart-full-stack" ? (scenario.longSession ? 2 : 1) : 0,
					);
					if (scenario.coding) {
						expect(result.output.workspacePassed).toBe(true);
						expect(finalResponseLine(result.output.response)).toBe("PASS");
					}
					if (scenario.longSession) expect(result.output.rawEventCount).toBeGreaterThan(30);
				});
			}
		},
	);
});
