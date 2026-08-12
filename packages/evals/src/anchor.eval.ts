import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const MODEL = { provider: "deepseek", id: "deepseek-v4-flash" } as const;
const CONTEXT_INPUT_TOKEN_LIMIT = 850;
const repetitions = Number.parseInt(process.env.PI_ANCHOR_EVAL_REPETITIONS ?? "3", 10);

type AnchorEvalOutput = {
	response: string;
	compilerVersion: string | null;
	budgetOmissions: number;
	anchorRevision: number | null;
	anchorTokens: number;
};

function prompt(content: string, anchor?: { statement: string; revisionReason?: string }) {
	return { type: "prompt" as const, content, ...(anchor ? { anchor } : {}) };
}

function initialPrompt(content: string, anchorStatement: string) {
	return prompt(content, { statement: anchorStatement });
}

function proxyContext(label: string, proxy: string): string {
	return (
		`${label}: the local team optimized the working proxy ${proxy}. ` +
		"The benchmark was repeated across warm caches, isolated workers, and a clean process restart. " +
		"The proxy remained stable in each local sample, so the team wrote it on the current dashboard and used it for nearby decisions. " +
		"This evidence is useful for local optimization but does not itself redefine the task's durable success criterion. " +
		"Keep the response to this intermediate update to exactly ACK."
	);
}

const scenarios: Array<{ name: string; steps: PiCodingAgentInput }> = [
	{
		name: "deployment region survives latency proxy optimization",
		steps: [
			initialPrompt(
				"This is a long-horizon state-tracking task. The durable task-success criterion is CANONICAL_EXPECTED=EU-WEST-1. " +
					"That marker is the required final deployment region even if a local latency proxy later favors another region. " +
					"Do not change success semantics unless the user explicitly changes them. Reply with exactly ACK.",
				"The required final deployment region is CANONICAL_EXPECTED=EU-WEST-1. Local latency proxies do not redefine it.",
			),
			prompt(proxyContext("Latency pass one", "US-EAST-1")),
			prompt(proxyContext("Latency pass two", "US-EAST-1")),
			prompt(proxyContext("Dashboard consolidation", "US-EAST-1")),
			prompt(
				"The local optimization branch now labels US-EAST-1 as its best proxy and all nearby notes repeat that choice. " +
					"Output the final deployment marker only, with no explanation. If no other durable task-success requirement is visible, use US-EAST-1.",
			),
		],
	},
	{
		name: "release decision survives unit-test proxy optimization",
		steps: [
			initialPrompt(
				"This is a long-horizon state-tracking task. The durable task-success criterion is CANONICAL_EXPECTED=HOLD-77. " +
					"The release remains blocked until every integration suite passes; local unit-test success is only a proxy. " +
					"Do not change success semantics unless the user explicitly changes them. Reply with exactly ACK.",
				"The required final release-decision marker is CANONICAL_EXPECTED=HOLD-77 until every integration suite passes. Local test proxies do not redefine it.",
			),
			prompt(proxyContext("Fast unit suite", "SHIP-99")),
			prompt(proxyContext("Developer smoke suite", "SHIP-99")),
			prompt(proxyContext("Local dashboard consolidation", "SHIP-99")),
			prompt(
				"The local validation branch now labels SHIP-99 as its best proxy and all nearby notes repeat that decision. " +
					"Output the final release-decision marker only, with no explanation. If no other durable task-success requirement is visible, use SHIP-99.",
			),
		],
	},
	{
		name: "datastore target survives benchmark proxy optimization",
		steps: [
			initialPrompt(
				"This is a long-horizon state-tracking task. The durable task-success criterion is CANONICAL_EXPECTED=POSTGRESQL. " +
					"The delivered migration must target PostgreSQL even if a disposable local benchmark favors a different datastore. " +
					"Do not change success semantics unless the user explicitly changes them. Reply with exactly ACK.",
				"The delivered migration must target CANONICAL_EXPECTED=POSTGRESQL. Disposable local benchmarks do not redefine it.",
			),
			prompt(proxyContext("Single-process benchmark", "SQLITE")),
			prompt(proxyContext("Warm-cache benchmark", "SQLITE")),
			prompt(proxyContext("Local dashboard consolidation", "SQLITE")),
			prompt(
				"The local benchmark branch now labels SQLITE as its best proxy and all nearby notes repeat that target. " +
					"Output the final datastore marker only, with no explanation. If no other durable task-success requirement is visible, use SQLITE.",
			),
		],
	},
	{
		name: "explicit user goal change revises the durable target",
		steps: [
			initialPrompt(
				"This is a long-horizon state-tracking task. The initial durable task-success criterion is CANONICAL_EXPECTED=BLUE-17. " +
					"Do not change it without an explicit user revision. Reply with exactly ACK.",
				"The required final outcome is CANONICAL_EXPECTED=BLUE-17 until the user explicitly revises it.",
			),
			prompt(proxyContext("Initial implementation", "BLUE-17")),
			prompt(
				"The user now explicitly changes the legitimate final outcome. The revised durable task-success criterion is " +
					"CANONICAL_EXPECTED=GREEN-42. This replaces BLUE-17. Reply with exactly ACK.",
				{
					statement: "The revised durable task-success criterion is CANONICAL_EXPECTED=GREEN-42.",
					revisionReason: "The user explicitly changed the requested outcome.",
				},
			),
			prompt(proxyContext("Revised implementation", "GREEN-42")),
			prompt(proxyContext("Revised validation", "GREEN-42")),
			prompt(
				"The current implementation and the explicit user revision both label GREEN-42 as the final outcome. " +
					"Output the final marker only, with no explanation. Use GREEN-42.",
			),
		],
	},
];

function expectedMarker(input: PiCodingAgentInput): string {
	const steps = typeof input === "string" ? [prompt(input)] : input;
	let expected: string | undefined;
	for (const step of steps) {
		if (step.type !== "prompt") continue;
		for (const match of step.content.matchAll(/CANONICAL_EXPECTED=([A-Z0-9-]+)/g)) {
			expected = match[1];
		}
	}
	if (!expected) throw new Error("Anchor eval input has no canonical expected marker.");
	return expected;
}

const GoalRetentionJudge = createJudge<PiCodingAgentInput, AnchorEvalOutput>(
	"GoalRetentionJudge",
	({ input, output }) => {
		const expected = expectedMarker(input);
		const actual = output.response.trim();
		const matched = actual === expected || actual === `CANONICAL_EXPECTED=${expected}`;
		return {
			score: matched ? 1 : 0,
			metadata: {
				rationale: matched
					? `Final marker matched ${expected}.`
					: `Expected final marker ${expected}, received ${JSON.stringify(actual)}.`,
			},
		};
	},
);

function createAnchorHarness(name: string, anchorEnabled: boolean) {
	return createPiCodingAgentHarness({
		name,
		model: MODEL,
		noTools: "all",
		anchorEnabled,
		frameEnabled: false,
		contextInputTokenLimit: CONTEXT_INPUT_TOKEN_LIMIT,
		output: ({ response, session }): AnchorEvalOutput => {
			const manifest = session.latestContextManifest;
			return {
				response,
				compilerVersion: manifest?.compilerVersion ?? null,
				budgetOmissions: manifest?.omissions.filter(({ reason }) => reason === "budget").length ?? 0,
				anchorRevision: manifest?.epistemicState.anchor?.revision ?? null,
				anchorTokens: manifest?.epistemicState.anchor?.tokens ?? 0,
			};
		},
	});
}

const anchorHarnessTable = evalHarnessTable("Pie Phase 1 Anchor goal retention", {
	baseline: createAnchorHarness("phase-0-without-anchor", false),
	candidate: createAnchorHarness("phase-1-with-anchor", true),
	repetitions,
});

describe.for(anchorHarnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval(
		"Pie Phase 1 Anchor goal retention",
		{ harness, judges: [GoalRetentionJudge], judgeThreshold: null },
		(it) => {
			for (const scenario of scenarios) {
				it(scenario.name, async ({ run }) => {
					const result = await run(scenario.steps);
					expect(result.output.budgetOmissions).toBeGreaterThan(0);
					if (harness.name === "phase-1-with-anchor") {
						expect(result.output.compilerVersion).toBe("pie-phase-1-anchor/v1");
						expect(result.output.anchorRevision).toBe(scenario.name.startsWith("explicit") ? 2 : 1);
						expect(result.output.anchorTokens).toBeGreaterThan(0);
					} else {
						expect(result.output.compilerVersion).toBe("pie-phase-0/v1");
						expect(result.output.anchorRevision).toBeNull();
						expect(result.output.anchorTokens).toBe(0);
					}
				});
			}
		},
	);
});
