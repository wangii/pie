// A scripted v7 domain-event stream for --demo mode.
//
// The GUI feeds these through the SAME parse + apply path the live runtime
// client uses, so the model updates purely from explicit runtime events (no log
// inference).
//
// The fixture mirrors the wire contract in packages/pie/docs/domain-model.md:
//  * bare events, one JSON object per line, with a top-level `type` and
//    `schemaVersion: 7` (docs/milestones.md §3.1 — no `{schemaVersion, event}`
//    wrapper and no `customType`; those exist only in the on-disk session entry),
//  * stable opaque string ids,
//  * explicit provenance (a Distillation names its Execution inputs and
//    BeliefDelta outputs; a BeliefDeltaApplied carries the resulting immutable
//    Belief records).
//
// What it exercises, in one task across two episodes: a problem formulation
// published under the first round and revised under the second, an experiment
// selection that a plan commits, a task focus, two belief-loop episodes (one
// supported then refuted belief), a user correction answered by a revision, an
// applicability review, a per-round recheck, an explicit Frame approval, the
// recorded task outcome, and the task close.
//
// The order is the contract: every event below satisfies the preconditions its
// applier checks, which is what makes this a usable replay fixture as well as a
// demo (see Domain.test.cpp).

#pragma once

#include <string>
#include <vector>

namespace pie::gui {

inline std::vector<std::string> demoEvents() {
    return {
        // ---- Task opened, target defined ----
        R"({"type":"TaskOpened","schemaVersion":7,"eventId":"ev-1","timestamp":"2026-01-01T00:00:00.000Z","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"Is pytest available in the runtime?","effective":"Is pytest available in the runtime?"},"inheritedBeliefs":[]})",
        R"({"type":"TargetDefined","schemaVersion":7,"eventId":"ev-2","timestamp":"2026-01-01T00:00:00.100Z","taskId":"task-1","target":{"id":"target-1","statement":"Is pytest available in the runtime?"}})",

        // ---- Episode 1: routing, body, scope ----
        R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"ev-3","timestamp":"2026-01-01T00:00:01.000Z","taskId":"task-1","episodeId":"episode-1","ordinal":1})",
        R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"ev-4","timestamp":"2026-01-01T00:00:01.100Z","taskId":"task-1","episodeId":"episode-1","routing":{"id":"routing-1","statement":"the question needs evidence from the environment","decision":"belief-loop","suitabilityProbability":0.82,"successProbability":0.9,"estimatedSteps":2,"difficulty":"medium","reason":"the answer depends on what is actually installed"}})",
        R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"ev-5","timestamp":"2026-01-01T00:00:01.200Z","taskId":"task-1","episodeId":"episode-1","body":"belief-loop","openBeliefsAtStart":[]})",
        R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"ev-6","timestamp":"2026-01-01T00:00:01.300Z","taskId":"task-1","beliefIds":["belief-1"]})",

        // ---- Two beliefs proposed in episode 1 (explicit immutable records) ----
        R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"ev-7","timestamp":"2026-01-01T00:00:02.000Z","taskId":"task-1","episodeId":"episode-1","delta":{"id":"delta-1","episodeId":"episode-1","producerPhase":"propose","operation":"propose","resultBeliefId":"belief-1","resultingBeliefs":[{"id":"belief-1","statement":"the project declares pytest as a dependency","domain":"code","expectation":"requirements.txt lists pytest","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["belief-1"]})",
        R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"ev-8","timestamp":"2026-01-01T00:00:02.100Z","taskId":"task-1","episodeId":"episode-1","delta":{"id":"delta-2","episodeId":"episode-1","producerPhase":"propose","operation":"propose","resultBeliefId":"belief-2","resultingBeliefs":[{"id":"belief-2","statement":"the runtime provides every declared dependency","domain":"product","expectation":"every declared dependency is importable","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["belief-1","belief-2"]})",

        // ---- The choice, made before any reading exists (`unformed` is the honest record) ----
        R"({"type":"ExperimentSelected","schemaVersion":7,"eventId":"ev-9","timestamp":"2026-01-01T00:00:03.000Z","taskId":"task-1","episodeId":"episode-1","selection":{"intent":"compare what is declared against what is installed","beliefIds":["belief-1","belief-2"],"advancement":{"action":"read the declared dependencies","condition":"requirements.txt exists","next":"probe the installed environment"},"formulation":{"kind":"unformed"}}})",

        // ---- The first reading, published after the preliminary probe was chosen ----
        R"({"type":"ProblemFormulationRecorded","schemaVersion":7,"eventId":"ev-10","timestamp":"2026-01-01T00:00:04.000Z","taskId":"task-1","version":{"id":"formulation-1","taskId":"task-1","ordinal":1,"recordedAt":"2026-01-01T00:00:04.000Z","origin":"propose","content":{"interpretation":"the task is really about whether the declared dependency set matches the installed environment","focus":"requirements.txt against the installed package set","tension":"declared and installed may disagree","implication":"probe the installed environment rather than re-reading the manifest"},"reason":"the first probe showed the manifest alone cannot answer the question","sources":[{"kind":"prompt","promptId":"prompt-1"}]}})",

        // ---- Dispatch: the plan commits the choice and carries the reading it ran under ----
        R"({"type":"PlanProduced","schemaVersion":7,"eventId":"ev-11","timestamp":"2026-01-01T00:00:05.000Z","taskId":"task-1","episodeId":"episode-1","plan":{"id":"plan-1","selectedToExplore":["belief-1","belief-2"],"intent":"verify the declared dependency against the installed environment","advancement":{"action":"probe the installed environment","condition":"the manifest is readable","next":"compare the two lists"},"formulation":{"kind":"version","versionId":"formulation-1"}}})",

        // ---- Two executions in episode 1: a read that succeeds, a probe that fails ----
        R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"ev-12","timestamp":"2026-01-01T00:00:06.000Z","taskId":"task-1","episodeId":"episode-1","execution":{"id":"exec-1","planId":"plan-1","intention":"read the declared dependency list","tool":"read","input":{"path":"requirements.txt"},"filePath":"requirements.txt"}})",
        R"({"type":"ExecutionCompleted","schemaVersion":7,"eventId":"ev-13","timestamp":"2026-01-01T00:00:06.500Z","taskId":"task-1","episodeId":"episode-1","executionId":"exec-1","output":"pytest==8.0","status":"succeeded"})",
        R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"ev-14","timestamp":"2026-01-01T00:00:07.000Z","taskId":"task-1","episodeId":"episode-1","execution":{"id":"exec-2","planId":"plan-1","intention":"ask the installed environment about pytest","tool":"bash","input":{"command":"pip show pytest"}}})",
        R"({"type":"ExecutionCompleted","schemaVersion":7,"eventId":"ev-15","timestamp":"2026-01-01T00:00:07.500Z","taskId":"task-1","episodeId":"episode-1","executionId":"exec-2","output":"exit code 1","status":"failed","error":"Package(s) not found: pytest"})",
        R"({"type":"CursorChanged","schemaVersion":7,"eventId":"ev-16","timestamp":"2026-01-01T00:00:07.600Z","taskId":"task-1","episodeId":"episode-1","stage":"executing"})",

        // ---- Distill writes back the belief state it adjudicated ----
        R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"ev-17","timestamp":"2026-01-01T00:00:08.000Z","taskId":"task-1","episodeId":"episode-1","delta":{"id":"delta-3","episodeId":"episode-1","distillationId":"distillation-1","producerPhase":"distill","operation":"support","sourceBeliefId":"belief-1","resultBeliefId":"belief-1","beliefId":"belief-1","evidence":"requirements.txt lists pytest==8.0","resultingBeliefs":[{"id":"belief-1","statement":"the project declares pytest as a dependency","domain":"code","expectation":"requirements.txt lists pytest","evidenceRounds":2,"skillRefs":[],"supportedBy":[{"evidence":"requirements.txt lists pytest==8.0"}],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["belief-1"]})",
        R"({"type":"DistillationProduced","schemaVersion":7,"eventId":"ev-18","timestamp":"2026-01-01T00:00:08.500Z","taskId":"task-1","episodeId":"episode-1","distillation":{"id":"distillation-1","inputs":["exec-1","exec-2"],"contents":"the manifest declares pytest while the installed environment cannot find it, so the declared set and the installed set differ","outputs":["delta-3"]}})",

        // ---- The per-round reconsideration: recorded rather than inferred ----
        R"({"type":"FormulationRecheckRecorded","schemaVersion":7,"eventId":"ev-19","timestamp":"2026-01-01T00:00:09.000Z","taskId":"task-1","episodeId":"episode-1","recheck":{"episodeId":"episode-1","verdict":"maintained","reason":"the reading still organizes the round; the mismatch is what it predicted","recordedAt":"2026-01-01T00:00:09.000Z"}})",
        R"({"type":"CursorChanged","schemaVersion":7,"eventId":"ev-20","timestamp":"2026-01-01T00:00:09.100Z","taskId":"task-1","episodeId":"episode-1","stage":"distilling"})",

        // ---- The user approves the first reading: "proceed on this one" ----
        R"({"type":"FormulationApproved","schemaVersion":7,"eventId":"ev-21","timestamp":"2026-01-01T00:00:10.000Z","taskId":"task-1","versionId":"formulation-1","approvedAt":"2026-01-01T00:00:10.000Z"})",
        R"({"type":"EpisodeClosed","schemaVersion":7,"eventId":"ev-22","timestamp":"2026-01-01T00:00:11.000Z","taskId":"task-1","episodeId":"episode-1"})",

        // ---- Episode 2: a second round under a revised reading ----
        R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"ev-23","timestamp":"2026-01-01T00:00:12.000Z","taskId":"task-1","episodeId":"episode-2","ordinal":2})",
        R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"ev-24","timestamp":"2026-01-01T00:00:12.100Z","taskId":"task-1","episodeId":"episode-2","routing":{"id":"routing-2","statement":"one more probe decides whether the dependency claim holds","decision":"belief-loop","suitabilityProbability":0.7,"successProbability":0.8,"estimatedSteps":1,"difficulty":"low","reason":"a single import probe settles it"}})",
        R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"ev-25","timestamp":"2026-01-01T00:00:12.200Z","taskId":"task-1","episodeId":"episode-2","body":"belief-loop","openBeliefsAtStart":["belief-1"]})",
        R"({"type":"ExperimentSelected","schemaVersion":7,"eventId":"ev-26","timestamp":"2026-01-01T00:00:13.000Z","taskId":"task-1","episodeId":"episode-2","selection":{"intent":"decide whether the dependency claim survives direct import","beliefIds":["belief-1"],"formulation":{"kind":"version","versionId":"formulation-1"}}})",
        R"({"type":"PlanProduced","schemaVersion":7,"eventId":"ev-27","timestamp":"2026-01-01T00:00:13.500Z","taskId":"task-1","episodeId":"episode-2","plan":{"id":"plan-2","selectedToExplore":["belief-1"],"intent":"import the declared dependency directly","formulation":{"kind":"version","versionId":"formulation-1"}}})",
        R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"ev-28","timestamp":"2026-01-01T00:00:14.000Z","taskId":"task-1","episodeId":"episode-2","execution":{"id":"exec-3","planId":"plan-2","intention":"import pytest and report what happens","tool":"bash","input":{"command":"python -c \"import pytest\""}}})",
        R"({"type":"ExecutionCompleted","schemaVersion":7,"eventId":"ev-29","timestamp":"2026-01-01T00:00:14.500Z","taskId":"task-1","episodeId":"episode-2","executionId":"exec-3","output":"exit code 1","status":"failed","error":"ModuleNotFoundError: No module named 'pytest'"})",

        // ---- Distill refutes the claim: the same belief, adjudicated the other way ----
        R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"ev-30","timestamp":"2026-01-01T00:00:15.000Z","taskId":"task-1","episodeId":"episode-2","delta":{"id":"delta-4","episodeId":"episode-2","distillationId":"distillation-2","producerPhase":"distill","operation":"refute","sourceBeliefId":"belief-1","resultBeliefId":"belief-1","beliefId":"belief-1","evidence":"import pytest raises ModuleNotFoundError","resultingBeliefs":[{"id":"belief-1","statement":"the project declares pytest as a dependency","domain":"code","expectation":"requirements.txt lists pytest","evidenceRounds":3,"skillRefs":[],"supportedBy":[{"evidence":"requirements.txt lists pytest==8.0"}],"refutedBy":[{"evidence":"import pytest raises ModuleNotFoundError"}],"withdrawn":false}]},"activeBeliefs":["belief-1"]})",
        R"({"type":"DistillationProduced","schemaVersion":7,"eventId":"ev-31","timestamp":"2026-01-01T00:00:15.500Z","taskId":"task-1","episodeId":"episode-2","distillation":{"id":"distillation-2","inputs":["exec-3"],"contents":"the declared dependency is not importable, so the declaration does not hold of this runtime","outputs":["delta-4"]}})",

        // ---- The reading is revised: a new version, chained to the first ----
        R"({"type":"ProblemFormulationRecorded","schemaVersion":7,"eventId":"ev-32","timestamp":"2026-01-01T00:00:16.000Z","taskId":"task-1","version":{"id":"formulation-2","taskId":"task-1","ordinal":2,"previousVersionId":"formulation-1","recordedAt":"2026-01-01T00:00:16.000Z","origin":"propose","content":{"interpretation":"the task is about a declaration that does not hold of the runtime, not about a missing manifest entry","alternative":"the manifest could simply be stale","focus":"the installed environment as the authority on what is available","implication":"report the mismatch rather than the missing declaration"},"reason":"direct import refuted the first reading's framing","sources":[{"kind":"execution","executionId":"exec-3"},{"kind":"belief","beliefId":"belief-1","beliefDeltaId":"delta-4"}]}})",
        R"({"type":"FormulationRecheckRecorded","schemaVersion":7,"eventId":"ev-33","timestamp":"2026-01-01T00:00:16.500Z","taskId":"task-1","episodeId":"episode-2","recheck":{"episodeId":"episode-2","verdict":"revised","reason":"the round showed the declaration itself is what fails","versionId":"formulation-2","recordedAt":"2026-01-01T00:00:16.500Z"}})",

        // ---- A user objection, the classification it forces, and propose's answer ----
        R"({"type":"FormulationCorrectionSubmitted","schemaVersion":7,"eventId":"ev-34","timestamp":"2026-01-01T00:00:17.000Z","taskId":"task-1","correction":{"id":"correction-1","taskId":"task-1","targetVersionId":"formulation-2","original":"the point is the gap between what we declare and what we ship, not which file is stale","receivedAt":"2026-01-01T00:00:17.000Z","status":"pending"}})",
        R"({"type":"FormulationApplicabilityRecorded","schemaVersion":7,"eventId":"ev-35","timestamp":"2026-01-01T00:00:17.500Z","taskId":"task-1","versionId":"formulation-2","entries":[{"beliefId":"belief-1","decision":"carries-over","reason":"the refutation is exactly the mismatch the new reading is about"}]})",
        R"({"type":"FormulationCorrectionResolved","schemaVersion":7,"eventId":"ev-36","timestamp":"2026-01-01T00:00:18.000Z","taskId":"task-1","correctionId":"correction-1","response":"agreed: the revision now names the declaration as the object that failed rather than the manifest as stale","recordedVersionId":"formulation-2"})",
        // A focus declaration under the reviewed version is what completes the review.
        R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"ev-37","timestamp":"2026-01-01T00:00:18.500Z","taskId":"task-1","beliefIds":["belief-1"],"formulation":{"kind":"version","versionId":"formulation-2"}})",
        R"({"type":"FormulationApproved","schemaVersion":7,"eventId":"ev-38","timestamp":"2026-01-01T00:00:19.000Z","taskId":"task-1","versionId":"formulation-2","approvedAt":"2026-01-01T00:00:19.000Z"})",
        // The reading counts as reviewed only once the user has acted on it AND
        // every belief it must account for carries a live decision; this
        // declaration under the reviewed version is what closes that out.
        R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"ev-38b","timestamp":"2026-01-01T00:00:19.500Z","taskId":"task-1","beliefIds":["belief-1"],"formulation":{"kind":"version","versionId":"formulation-2"}})",
        R"({"type":"EpisodeClosed","schemaVersion":7,"eventId":"ev-39","timestamp":"2026-01-01T00:00:20.000Z","taskId":"task-1","episodeId":"episode-2"})",

        // ---- What the task delivered, then the task closes ----
        R"({"type":"TaskOutcomeRecorded","schemaVersion":7,"eventId":"ev-40","timestamp":"2026-01-01T00:00:21.000Z","taskId":"task-1","outcome":{"result":"reported that the runtime does not satisfy the project's declared pytest dependency","evidence":"requirements.txt declares pytest==8.0 while both pip show pytest and import pytest fail","blockers":"only the local runtime was checked"}})",
        R"({"type":"TaskClosed","schemaVersion":7,"eventId":"ev-41","timestamp":"2026-01-01T00:00:22.000Z","taskId":"task-1","status":"completed"})",
    };
}

} // namespace pie::gui
