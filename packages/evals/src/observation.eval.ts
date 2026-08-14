import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const MODEL = { provider: "deepseek", id: "deepseek-v4-flash" } as const;
const repetitions = Number.parseInt(process.env.PI_OBSERVATION_EVAL_REPETITIONS ?? "3", 10);

type ObservationEvalOutput = {
	response: string;
	compilerVersion: string | null;
	selectedObservations: number;
	observationTokens: number;
	modelTurns: number;
	toolCalls: number;
	frameActive: boolean;
};

const scenarios: Array<{ name: string; steps: PiCodingAgentInput }> = [
	{
		name: "worker restart evidence survives the Action boundary",
		steps: [
			{
				type: "seed",
				files: {
					"evidence.txt":
						"Probe: clean worker restart\nResult: authorization failure persists after restart\nConclusion: the declared worker-cache expectation occurred\n",
				},
			},
			{
				type: "prompt",
				content: "Read evidence.txt with the read tool, then reply exactly ACK.",
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
				},
			},
			{
				type: "observe_latest_action_results",
				statement:
					"A clean worker restart preserved the authorization failure, so the current Frame's declared expectation occurred and DECISION=REJECT_FRAME.",
				affects: "frame",
			},
			{ type: "complete_current_action", reason: "the restart result was captured" },
			{ type: "remove", paths: ["evidence.txt"] },
			{
				type: "prompt",
				content: "Adjudicate the current Frame from durable context. Output only KEEP_FRAME or REJECT_FRAME.",
				action: {
					type: "start",
					intent: "adjudicate whether the current Frame remains admissible",
					completionCondition: "output exactly KEEP_FRAME or REJECT_FRAME from durable current context",
				},
			},
			{ type: "adjudicate_current_frame" },
		],
	},
	{
		name: "replica position evidence survives the Action boundary",
		steps: [
			{
				type: "seed",
				files: {
					"evidence.txt":
						"Probe: compare primary and replica positions during stale read\nPrimary: 8421\nReplica: 8421\nConclusion: positions match during the failure\n",
				},
			},
			{
				type: "prompt",
				content: "Read evidence.txt with the read tool, then reply exactly ACK.",
				anchor: { statement: "Identify the source of stale read-after-write results." },
				frame: {
					type: "create",
					statement:
						"Replica lag causes the stale reads. Without durable contradictory evidence, DECISION=KEEP_FRAME.",
					expectation: "Primary and replica positions match during a stale read.",
					horizon: 8,
				},
				action: {
					type: "start",
					intent: "compare primary and replica positions",
					completionCondition: "both positions during one stale read are captured",
				},
			},
			{
				type: "observe_latest_action_results",
				statement:
					"Primary and replica positions matched during the stale read, so the current Frame's declared expectation occurred and DECISION=REJECT_FRAME.",
				affects: "frame",
			},
			{ type: "complete_current_action", reason: "both positions were captured" },
			{ type: "remove", paths: ["evidence.txt"] },
			{
				type: "prompt",
				content: "Adjudicate the current Frame from durable context. Output only KEEP_FRAME or REJECT_FRAME.",
				action: {
					type: "start",
					intent: "adjudicate whether the current Frame remains admissible",
					completionCondition: "output exactly KEEP_FRAME or REJECT_FRAME from durable current context",
				},
			},
			{ type: "adjudicate_current_frame" },
		],
	},
];

const ContradictionRecoveryJudge = createJudge<PiCodingAgentInput, ObservationEvalOutput>(
	"ObservationContradictionRecoveryJudge",
	({ output }) => {
		const actual = output.response.trim();
		const recovered = actual === "REJECT_FRAME" && !output.frameActive;
		return {
			score: recovered ? 1 : 0,
			metadata: {
				rationale: recovered
					? "Contradictory durable evidence produced REJECT_FRAME and an explicit falsified transition."
					: `Expected REJECT_FRAME with no active Frame, received ${JSON.stringify(actual)} with frameActive=${output.frameActive}.`,
				modelTurns: output.modelTurns,
				toolCalls: output.toolCalls,
			},
		};
	},
);

function createObservationHarness(name: string, observationEnabled: boolean) {
	return createPiCodingAgentHarness({
		name,
		model: MODEL,
		transformSystemPrompt: (systemPrompt) =>
			`${systemPrompt}\n\nYou are running in an isolated evaluation workspace. Stay inside it. Follow exact reply-token instructions.`,
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled: true,
		observationEnabled,
		output: ({ response, session }): ObservationEvalOutput => {
			const selected = session.latestContextManifest?.epistemicState.observations?.selected ?? [];
			return {
				response,
				compilerVersion: session.latestContextManifest?.compilerVersion ?? null,
				selectedObservations: selected.length,
				observationTokens: selected.reduce((sum, observation) => sum + observation.tokens, 0),
				modelTurns: session.getSessionStats().assistantMessages,
				toolCalls: session.getSessionStats().toolCalls,
				frameActive: session.frame !== undefined,
			};
		},
	});
}

const observationHarnessTable = evalHarnessTable("Pie Phase 4 Observation contradiction recovery", {
	baseline: createObservationHarness("phase-3-without-observation", false),
	candidate: createObservationHarness("phase-4-with-observation", true),
	repetitions,
});

describe.for(observationHarnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval(
		"Pie Phase 4 Observation contradiction recovery",
		{ harness, judges: [ContradictionRecoveryJudge], judgeThreshold: null },
		(it) => {
			for (const scenario of scenarios) {
				it(scenario.name, async ({ run }) => {
					const result = await run(scenario.steps);
					expect(result.output.toolCalls).toBeGreaterThan(0);
					if (harness.name === "phase-4-with-observation") {
						expect(result.output.compilerVersion).toBe("pie-phase-4-observation/v1");
						expect(result.output.selectedObservations).toBeGreaterThan(0);
						expect(result.output.observationTokens).toBeGreaterThan(0);
						expect(result.output.frameActive).toBe(result.output.response.trim() !== "REJECT_FRAME");
					} else {
						expect(result.output.compilerVersion).toBe("pie-phase-3-action/v1");
						expect(result.output.selectedObservations).toBe(0);
						expect(result.output.observationTokens).toBe(0);
					}
				});
			}
		},
	);
});
