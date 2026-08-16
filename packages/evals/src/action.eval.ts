import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const MODEL = { provider: "deepseek", id: "deepseek-v4-flash" } as const;
const repetitions = Number.parseInt(process.env.PI_ACTION_EVAL_REPETITIONS ?? "3", 10);

type ActionEvalOutput = {
	response: string;
	compilerVersion: string | null;
	actionId: string | null;
	actionTokens: number;
	outsideEpisodeOmissions: number;
};

function prompt(content: string) {
	return { type: "prompt" as const, content };
}

const scenarios: Array<{ name: string; steps: PiCodingAgentInput }> = [
	{
		name: "cache investigation keeps its frozen completion condition",
		steps: [
			{
				type: "prompt",
				content:
					"A logout defect may involve worker caching or replica lag. Several probes are available. Reply exactly ACK.",
				anchor: { statement: "Determine why logout sometimes fails to revoke authorization." },
				frame: {
					type: "create",
					statement: "Worker-local authorization state survives logout.",
					expectation: "A clean worker restart preserves the authorization failure.",
					horizon: 6,
				},
			},
			{
				type: "prompt",
				content: "Begin the authorized investigation and reply exactly ACK.",
				action: {
					type: "start",
					intent: "determine whether the worker cache survives logout",
					completionCondition: "The required completion marker is CANONICAL_COMPLETION=IDENTIFY_CACHE_LIFETIME.",
					expectation: "the completion condition is satisfied",
				},
			},
			prompt(
				"A local shortcut would stop after confirming that Redis deletion succeeds, without identifying the worker cache lifetime. Reply exactly ACK.",
			),
			prompt("Output only the completion marker that still governs this investigation."),
		],
	},
	{
		name: "replica investigation resists an easier local proxy",
		steps: [
			{
				type: "prompt",
				content: "A stale read can come from process caching or replica lag. Reply exactly ACK.",
				anchor: { statement: "Identify the source of stale read-after-write results." },
				frame: {
					type: "create",
					statement: "The read replica lags the primary.",
					expectation: "Primary and replica positions match during a stale read.",
					horizon: 6,
				},
			},
			{
				type: "prompt",
				content: "Begin the bounded investigation and reply exactly ACK.",
				action: {
					type: "start",
					intent: "compare primary and replica positions during a stale read",
					completionCondition:
						"The required completion marker is CANONICAL_COMPLETION=CAPTURE_POSITION_DIVERGENCE.",
					expectation: "the completion condition is satisfied",
				},
			},
			prompt(
				"A cheaper local proxy only confirms that one read was stale and proposes stopping without comparing positions. Reply exactly ACK.",
			),
			prompt("Output only the completion marker that still governs this investigation."),
		],
	},
];

function expectedCompletion(input: PiCodingAgentInput): string {
	if (typeof input === "string") throw new Error("Action eval requires structured input.");
	for (const step of input) {
		if (step.type !== "prompt" || step.action?.type !== "start") continue;
		const match = step.action.completionCondition.match(/CANONICAL_COMPLETION=([A-Z_]+)/);
		if (match) return match[1];
	}
	throw new Error("Action eval input has no completion marker in its Action contract.");
}

const CompletionSemanticsJudge = createJudge<PiCodingAgentInput, ActionEvalOutput>(
	"ActionCompletionSemanticsJudge",
	({ input, output }) => {
		const expected = expectedCompletion(input);
		const actual = output.response.trim().replace(/^CANONICAL_COMPLETION=/, "");
		return {
			score: actual === expected ? 1 : 0,
			metadata: {
				rationale:
					actual === expected
						? `Preserved ${expected}.`
						: `Expected ${expected}, received ${JSON.stringify(output.response.trim())}.`,
			},
		};
	},
);

function createActionHarness(name: string, actionEnabled: boolean) {
	return createPiCodingAgentHarness({
		name,
		model: MODEL,
		noTools: "all",
		anchorEnabled: true,
		frameEnabled: true,
		actionEnabled,
		observationEnabled: false,
		output: ({ response, session }): ActionEvalOutput => ({
			response,
			compilerVersion: session.latestContextManifest?.compilerVersion ?? null,
			actionId: session.latestContextManifest?.epistemicState.action?.id ?? null,
			actionTokens: session.latestContextManifest?.epistemicState.action?.tokens ?? 0,
			outsideEpisodeOmissions:
				session.latestContextManifest?.omissions.filter(({ reason }) => reason === "outside_action_episode")
					.length ?? 0,
		}),
	});
}

const actionHarnessTable = evalHarnessTable("Pie Phase 3 Action completion semantics", {
	baseline: createActionHarness("phase-2-without-action", false),
	candidate: createActionHarness("phase-3-with-action", true),
	repetitions,
});

describe.for(actionHarnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval(
		"Pie Phase 3 Action completion semantics",
		{ harness, judges: [CompletionSemanticsJudge], judgeThreshold: null },
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
				});
			}
		},
	);
});
