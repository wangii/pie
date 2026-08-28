// A scripted domain-event stream for --demo mode. The GUI feeds these through
// the SAME applyLine() interface the real runtime client uses, so the model
// updates purely from explicit runtime events (no log inference).
//
// The fixture mirrors the wire contract in packages/pie/docs/domain-model.md:
// stable string ids (task-/frame-/belief-/plan-/execution-/distillation-), the
// versioned domain event vocabulary, and explicit provenance (Distillation
// names its Execution inputs and BeliefDelta outputs; BeliefDeltaApplied names
// the resulting immutable Belief records).
//
// One task, one belief-loop frame: two proposed beliefs, a plan selecting them,
// two executions (one failing), a distillation, and the task closed.

#pragma once

#include <string>
#include <vector>

namespace pie::gui {

inline std::vector<std::string> demoEvents() {
    return {
        // ---- Task / target / frame ----
        R"({"type":"TaskOpened","schemaVersion":1,"eventId":"ev-1","timestamp":"t0","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"Is pytest available in the runtime?","effective":"Is pytest available in the runtime?"},"inheritedBeliefs":[]})",
        R"({"type":"TargetDefined","schemaVersion":1,"eventId":"ev-2","timestamp":"t0","taskId":"task-1","target":{"id":"target-1","statement":"Is pytest available in the runtime?"}})",
        R"({"type":"FrameOpened","schemaVersion":1,"eventId":"ev-3","timestamp":"t0","taskId":"task-1","frameId":"frame-1","ordinal":1})",
        R"({"type":"RoutingDecided","schemaVersion":1,"eventId":"ev-4","timestamp":"t0","taskId":"task-1","frameId":"frame-1","routing":{"id":"routing-1","statement":"investigation is required","decision":"belief-loop","suitabilityProbability":0.3,"successProbability":0.9,"estimatedSteps":2,"difficulty":"medium","supportingBeliefs":[],"handoffFromFramingBeliefs":[],"reason":"requires evidence"}})",
        R"({"type":"FrameBodySelected","schemaVersion":1,"eventId":"ev-5","timestamp":"t0","taskId":"task-1","frameId":"frame-1","body":"belief-loop","openBeliefsAtStart":[]})",

        // ---- Two proposed beliefs (explicit immutable records) ----
        R"({"type":"BeliefDeltaApplied","schemaVersion":1,"eventId":"ev-6","timestamp":"t0","taskId":"task-1","frameId":"frame-1","delta":{"id":"delta-1","frameId":"frame-1","operation":"propose","beliefId":"belief-1","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"belief-1","statement":"project uses pytest","domain":"code","expectation":"pytest is importable","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["belief-1"]})",
        R"({"type":"BeliefDeltaApplied","schemaVersion":1,"eventId":"ev-7","timestamp":"t0","taskId":"task-1","frameId":"frame-1","delta":{"id":"delta-2","frameId":"frame-1","operation":"propose","beliefId":"belief-2","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"belief-2","statement":"runtime environment provides the declared dependencies","domain":"framing","expectation":"every declared dependency is importable","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["belief-1","belief-2"]})",

        // ---- Plan selects both beliefs ----
        R"({"type":"PlanProduced","schemaVersion":1,"eventId":"ev-8","timestamp":"t1","taskId":"task-1","frameId":"frame-1","plan":{"id":"plan-1","selectedToExplore":["belief-1","belief-2"],"intent":"verify the declared dependency against the runtime"}})",

        // ---- Two executions (read succeeds, bash fails) ----
        R"({"type":"ExecutionStarted","schemaVersion":1,"eventId":"ev-9","timestamp":"t1","taskId":"task-1","frameId":"frame-1","execution":{"id":"exec-1","planId":"plan-1","intention":"Run read","tool":"read","input":{"path":"requirements.txt"},"filePath":"requirements.txt"}})",
        R"({"type":"ExecutionCompleted","schemaVersion":1,"eventId":"ev-10","timestamp":"t1","taskId":"task-1","frameId":"frame-1","executionId":"exec-1","output":"pytest==8.0","status":"succeeded"})",
        R"({"type":"ExecutionStarted","schemaVersion":1,"eventId":"ev-11","timestamp":"t1","taskId":"task-1","frameId":"frame-1","execution":{"id":"exec-2","planId":"plan-1","intention":"Run bash","tool":"bash","input":{"command":"pip show pytest"}}})",
        R"({"type":"ExecutionCompleted","schemaVersion":1,"eventId":"ev-12","timestamp":"t1","taskId":"task-1","frameId":"frame-1","executionId":"exec-2","output":"exit code 1","status":"failed","error":"Package(s) not found: pytest"})",
        R"({"type":"CursorChanged","schemaVersion":1,"eventId":"ev-13","timestamp":"t1","taskId":"task-1","frameId":"frame-1","stage":"executing"})",

        // ---- Distillation names its inputs and belief-delta outputs ----
        R"({"type":"DistillationProduced","schemaVersion":1,"eventId":"ev-14","timestamp":"t1","taskId":"task-1","frameId":"frame-1","distillation":{"id":"distillation-1","inputs":["exec-1","exec-2"],"contents":"declared dependency and actual runtime environment differ","outputs":["delta-1","delta-2"]}})",
        R"({"type":"CursorChanged","schemaVersion":1,"eventId":"ev-15","timestamp":"t1","taskId":"task-1","frameId":"frame-1","stage":"distilling"})",

        // ---- Frame and task close ----
        R"({"type":"FrameClosed","schemaVersion":1,"eventId":"ev-16","timestamp":"t2","taskId":"task-1","frameId":"frame-1"})",
        R"({"type":"TaskClosed","schemaVersion":1,"eventId":"ev-17","timestamp":"t2","taskId":"task-1","status":"completed"})",
    };
}

} // namespace pie::gui
