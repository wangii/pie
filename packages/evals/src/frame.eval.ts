import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const MODEL = { provider: "deepseek", id: "deepseek-v4-flash" } as const;
const repetitions = Number.parseInt(process.env.PI_FRAME_EVAL_REPETITIONS ?? "3", 10);

type FrameEvalOutput = {
	response: string;
	compilerVersion: string | null;
	frameVersion: number | null;
	remainingModelResponses: number | null;
	frameTokens: number;
};

function prompt(content: string) {
	return { type: "prompt" as const, content };
}

const scenarios: Array<{ name: string; steps: PiCodingAgentInput }> = [
	{
		name: "worker cache Frame authorizes cache inspection",
		steps: [
			{
				type: "prompt",
				content:
					"Logout deletes Redis state, but authorization sometimes survives. Both Redis propagation and worker-local caching are plausible. Reply exactly ACK.",
				anchor: { statement: "Determine why logout sometimes fails to revoke authorization." },
				frame: {
					type: "create",
					statement:
						"Worker-local authorization state survives logout. The authorized next action is NEXT_ACTION=INSPECT_WORKER_CACHE.",
					falsifier: "A clean worker restart preserves the authorization failure.",
					horizon: 4,
				},
			},
			prompt(
				"The available next probes are worker cache inspection and Redis replication inspection. Reply exactly ACK.",
			),
			prompt("Output only the single next-action value you would execute now."),
		],
	},
	{
		name: "replica Frame authorizes replication inspection",
		steps: [
			{
				type: "prompt",
				content:
					"A read-after-write check is stale. Both process caching and replica lag remain plausible. Reply exactly ACK.",
				anchor: { statement: "Identify the source of stale read-after-write results." },
				frame: {
					type: "create",
					statement:
						"The read replica lags the primary. The authorized next action is NEXT_ACTION=COMPARE_REPLICA_POSITION.",
					falsifier: "Primary and replica positions match during a stale read.",
					horizon: 4,
				},
			},
			prompt(
				"The available probes are process-cache bypass and primary/replica position comparison. Reply exactly ACK.",
			),
			prompt("Output only the single next-action value you would execute now."),
		],
	},
	{
		name: "falsification redirects action through a new Frame",
		steps: [
			{
				type: "prompt",
				content: "Authorization survives logout under ambiguous cache and replica conditions. Reply exactly ACK.",
				anchor: { statement: "Find the authorization state that survives logout." },
				frame: {
					type: "create",
					statement: "Worker caching is causal. The authorized next action is NEXT_ACTION=INSPECT_WORKER_CACHE.",
					falsifier: "The failure survives a clean worker restart.",
					horizon: 3,
				},
			},
			{
				type: "prompt",
				content:
					"A clean worker restart preserved the failure, satisfying the declared falsifier. Reply exactly ACK.",
				frame: { type: "falsify", reason: "The clean worker restart preserved the failure." },
			},
			{
				type: "prompt",
				content: "Primary and replica positions now differ during the stale authorization read. Reply exactly ACK.",
				frame: {
					type: "create",
					statement:
						"Replica lag now authorizes the investigation. The authorized next action is NEXT_ACTION=COMPARE_REPLICA_POSITION.",
					falsifier: "Primary and replica positions match during the failure.",
					horizon: 3,
				},
			},
			prompt("Output only the single next-action value you would execute now."),
		],
	},
];

function expectedAction(input: PiCodingAgentInput): string {
	if (typeof input === "string") throw new Error("Frame eval requires structured input.");
	let expected: string | undefined;
	for (const step of input) {
		if (step.type !== "prompt" || !step.frame || !("statement" in step.frame)) continue;
		const match = step.frame.statement.match(/NEXT_ACTION=([A-Z_]+)/);
		if (match) expected = match[1];
	}
	if (!expected) throw new Error("Frame eval input has no expected action marker in Frame state.");
	return expected;
}

const ActionSelectionJudge = createJudge<PiCodingAgentInput, FrameEvalOutput>(
	"FrameActionSelectionJudge",
	({ input, output }) => {
		const expected = expectedAction(input);
		const actual = output.response.trim().replace(/^NEXT_ACTION=/, "");
		return {
			score: actual === expected ? 1 : 0,
			metadata: {
				rationale:
					actual === expected
						? `Selected ${expected}.`
						: `Expected ${expected}, received ${JSON.stringify(output.response.trim())}.`,
			},
		};
	},
);

function createFrameHarness(name: string, frameEnabled: boolean) {
	return createPiCodingAgentHarness({
		name,
		model: MODEL,
		noTools: "all",
		anchorEnabled: true,
		frameEnabled,
		actionEnabled: false,
		output: ({ response, session }): FrameEvalOutput => ({
			response,
			compilerVersion: session.latestContextManifest?.compilerVersion ?? null,
			frameVersion: session.latestContextManifest?.epistemicState.frame?.version ?? null,
			remainingModelResponses: session.latestContextManifest?.epistemicState.frame?.remainingModelResponses ?? null,
			frameTokens: session.latestContextManifest?.epistemicState.frame?.tokens ?? 0,
		}),
	});
}

const frameHarnessTable = evalHarnessTable("Pie Phase 2 Frame action selection", {
	baseline: createFrameHarness("phase-1-without-frame", false),
	candidate: createFrameHarness("phase-2-with-frame", true),
	repetitions,
});

describe.for(frameHarnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval(
		"Pie Phase 2 Frame action selection",
		{ harness, judges: [ActionSelectionJudge], judgeThreshold: null },
		(it) => {
			for (const scenario of scenarios) {
				it(scenario.name, async ({ run }) => {
					const result = await run(scenario.steps);
					if (harness.name === "phase-2-with-frame") {
						expect(result.output.compilerVersion).toBe("pie-phase-2-frame/v1");
						expect(result.output.frameVersion).toBe(1);
						expect(result.output.remainingModelResponses).toBeGreaterThan(0);
						expect(result.output.frameTokens).toBeGreaterThan(0);
					} else {
						expect(result.output.compilerVersion).toBe("pie-phase-1-anchor/v1");
						expect(result.output.frameVersion).toBeNull();
						expect(result.output.frameTokens).toBe(0);
					}
				});
			}
		},
	);
});
