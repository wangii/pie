import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { statusOf } from "../../src/core/belief-set.ts";
import { BELIEF_SURFACE_TOOLS, ROLE_SPECS } from "../../src/core/role-specs.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * M3: the formulation decision belongs to propose, and the loop must not route around it.
 *
 * These tests drive the real loop with scripted turns, so they pin the behavior a model actually
 * experiences: when the decision is demanded, what happens to an experiment chosen before it, and
 * which version a dispatch is recorded against.
 */
describe("formulation decision", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const reading = (interpretation: string) =>
		fauxToolCall("set_formulation", {
			interpretation,
			focus: "the observations the tested beliefs predict",
			implication: "which conclusion the answer reports turns on what the probe shows",
			reason: "stated the current reading",
		});

	const conclude = () => fauxToolCall("conclude", { result: "delivered", evidence: "observed" });

	const firstProbe = [
		fauxToolCall("declare_belief", {
			op: "propose",
			statement: "the cache survives logout",
			domain: "product",
			expectation: "a post-logout read keeps the value",
			evidenceRounds: 1,
		}),
		fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
		fauxToolCall("select_experiment", { intent: "what the answer must report", beliefIds: ["belief-1"] }),
	];

	const support = fauxToolCall("declare_belief", {
		op: "support",
		beliefId: "belief-1",
		evidence: "the post-logout read kept the value",
	});

	const userText = (harness: Harness) =>
		harness.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.join("\n");

	it("lets the first probe run before any reading, then requires the decision", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			// No formulation yet: choosing a preliminary probe before stating a reading is allowed.
			fauxAssistantMessage(firstProbe),
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([support]),
			// Concluding now would answer the task without the agent ever saying what it made of it,
			// so the call is refused and propose is sent back for the decision.
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([reading("persistence across logout is the question"), conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const plans = harness.eventsOfType("PlanProduced");
		const selectionPlan = plans.find((event) => event.plan.selectedToExplore.length > 0);
		// The first experiment was chosen before any reading existed, and its plan says so.
		expect(selectionPlan?.plan.formulation).toEqual({ kind: "unformed" });

		const versions = harness.eventsOfType("ProblemFormulationRecorded");
		expect(versions).toHaveLength(1);
		expect(versions[0].version.content.interpretation).toBe("persistence across logout is the question");
		expect(versions[0].version.ordinal).toBe(1);
		expect(versions[0].version.origin).toBe("propose");

		// The refused conclusion is what makes the decision mandatory rather than optional.
		expect(userText(harness)).toContain("have not yet said how you understand it");

		// Everything planned after the reading names it, so a decision is traceable to the
		// understanding that governed it.
		for (const event of plans.filter((plan) => plan !== selectionPlan)) {
			expect(event.plan.formulation).toEqual({ kind: "version", versionId: versions[0].version.id });
		}
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"the cache survives logout",
		);
	});

	it("diverts a distill conclusion instead of letting the terminal path skip the decision", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(firstProbe),
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			// Distill concludes directly, which normally hands straight to finalReport.
			fauxAssistantMessage([support, conclude()]),
			fauxAssistantMessage([reading("persistence is settled, the question is its lifetime")]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The reading exists, and it was required *before* the task could finish: the distilled
		// conclusion cannot be the last word on a task that never stated its reading.
		const versions = harness.eventsOfType("ProblemFormulationRecorded");
		expect(versions).toHaveLength(1);
		expect(userText(harness)).toContain("have not yet said how you understand it");
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"the cache survives logout",
		);
	});

	it("voids an experiment selected before a version is published, and re-binds the new one", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			// The selection is made first, then the reading is published in the same turn. Tools run
			// in call order, so the publication voids the selection that preceded it.
			fauxAssistantMessage([
				fauxToolCall("declare_belief", {
					op: "propose",
					statement: "the cache survives logout",
					domain: "product",
					expectation: "a post-logout read keeps the value",
					evidenceRounds: 1,
				}),
				fauxToolCall("focus_beliefs", { beliefIds: ["belief-1"] }),
				fauxToolCall("select_experiment", { intent: "what the answer must report", beliefIds: ["belief-1"] }),
				reading("persistence across logout is the question"),
			]),
			// Sent back to choose again under the version that now exists.
			fauxAssistantMessage([
				fauxToolCall("select_experiment", { intent: "what the answer must report", beliefIds: ["belief-1"] }),
			]),
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			fauxAssistantMessage([support]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const versions = harness.eventsOfType("ProblemFormulationRecorded");
		expect(versions).toHaveLength(1);
		// The voided selection is visible as "nothing is selected", which is what forces the re-choice.
		expect(userText(harness)).toContain("No experiment is selected");

		// Exactly one experiment ever ran, and its plan records the version it was chosen under.
		const selectionPlans = harness
			.eventsOfType("PlanProduced")
			.filter((event) => event.plan.selectedToExplore.length > 0);
		expect(selectionPlans).toHaveLength(1);
		expect(selectionPlans[0].plan.formulation).toEqual({ kind: "version", versionId: versions[0].version.id });
	});

	it("settles a probed belief before the decision handoff can re-open the episode", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(firstProbe),
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			// Distill concludes without adjudicating the belief it just probed. Concluding normally
			// hands straight to finalReport; the owed formulation decision diverts back to propose
			// instead — and that handoff opens the next episode, which clears the dispatched set. If
			// the debt were not settled here, the belief would stop blocking conclusion the moment
			// the loop handed back, and the task could finish having never adjudicated it.
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([support]),
			fauxAssistantMessage([reading("persistence across logout is the question")]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout"),
		]);

		await harness.session.prompt("is the cache persistent?");

		// The probe's evidence was adjudicated rather than abandoned at the handoff.
		expect(userText(harness)).toContain("remain unadjudicated");
		expect(harness.session.beliefs.map(statusOf)).toEqual(["supported"]);
		expect(harness.eventsOfType("ProblemFormulationRecorded")).toHaveLength(1);
	});

	it("does not let a revision touch the focus slice or the belief records", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([...firstProbe, reading("persistence across logout is the question")]),
			fauxAssistantMessage("Observed:\n- the post-logout read kept the value."),
			// A revision during the round, which must leave scope and truth alone.
			fauxAssistantMessage([support, reading("persistence is settled, the question is its lifetime")]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage([conclude()]),
			fauxAssistantMessage("the cache survives logout for its TTL"),
		]);

		await harness.session.prompt("is the cache persistent?");

		const versions = harness.eventsOfType("ProblemFormulationRecorded");
		expect(versions.map((event) => event.version.ordinal)).toEqual([1, 2]);
		expect(versions[1].version.previousVersionId).toBe(versions[0].version.id);

		// Scope and truth are separate objects: revising the reading re-declares neither.
		expect(harness.eventsOfType("FocusDeclared")).toHaveLength(1);
		expect(harness.session.beliefs.map(statusOf)).toEqual(["supported"]);

		// The current reading is what the next role actually reads, and it is labeled as the agent's
		// own provisional position rather than as a finding.
		const prompt = harness.session.agent.state.systemPrompt;
		expect(prompt).toContain("<current_formulation>");
		expect(prompt).toContain("persistence is settled, the question is its lifetime");
		expect(prompt).toContain("never support for a belief");
	});

	it("publishes from the propose surface only", () => {
		// Publishing is propose's alone: neither the role that gathers evidence nor the one that
		// adjudicates it can state the agent's reading, so no other role can route around the
		// decision by making it themselves.
		const formulationTools = ["set_formulation", "defer_formulation"];
		for (const tool of formulationTools) {
			expect(BELIEF_SURFACE_TOOLS).toContain(tool);
			for (const role of ["distill", "execution", "finalReport"] as const) {
				const tools = ROLE_SPECS[role].tools;
				const names =
					typeof tools === "function" ? tools({ fullActiveToolNames: [...BELIEF_SURFACE_TOOLS] }) : tools;
				expect(names).not.toContain(tool);
			}
			expect(ROLE_SPECS.propose.tools).toContain(tool);
		}
	});
});
