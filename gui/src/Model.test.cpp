// Headless unit tests for NativeGuiModel. No window, no ImGui, no SDK.
// Run: ./pi_gui_model_test   (returns non-zero on failure).
//
// Exercises the versioned domain-event vocabulary (packages/pie/docs/
// domain-model.md) through both applyLine (demo/headless) and applyRpcLine
// (live), plus the RPC telemetry (in-message stream, footer, file list).

#include "Model.h"
#include "graph/GraphModel.h"

#include <cstdio>
#include <string>

using pie::gui::FrameStage;
using pie::gui::NativeGuiModel;

static int failures = 0;

static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// A minimal immutable belief record (the shape carried inside
// BeliefDeltaApplied.delta.resultingBeliefs).
static std::string beliefRecord(const char* id, const char* statement, const char* domain,
                                const char* expectation) {
    std::string s = "{\"id\":\"";
    s += id;
    s += "\",\"statement\":\"";
    s += statement;
    s += "\",\"domain\":\"";
    s += domain;
    s += "\",\"expectation\":\"";
    s += expectation;
    s += "\",\"evidenceRounds\":1,\"skillRefs\":[],\"supportedBy\":[],\"refutedBy\":[],\"withdrawn\":false}";
    return s;
}

// Feed a full belief-loop task through the demo/headless path.
static void feedDemoTask(NativeGuiModel& m) {
    m.applyLine(R"({"type":"TaskOpened","taskId":"task-1","initialPrompt":{"id":"p-1","original":"x","effective":"x"},"inheritedBeliefs":[]})");
    m.applyLine(R"({"type":"TargetDefined","taskId":"task-1","target":{"id":"t-1","statement":"Is pytest available?"}})");
    m.applyLine(R"({"type":"FrameOpened","taskId":"task-1","frameId":"frame-1","ordinal":1})");
    m.applyLine(R"({"type":"RoutingDecided","taskId":"task-1","frameId":"frame-1","routing":{"id":"r-1","statement":"s","decision":"belief-loop","suitabilityProbability":0.3,"successProbability":0.9,"estimatedSteps":2,"difficulty":"medium","supportingBeliefs":[],"handoffFromFramingBeliefs":[],"reason":"needs evidence"}})");
    m.applyLine(R"({"type":"FrameBodySelected","taskId":"task-1","frameId":"frame-1","body":"belief-loop","openBeliefsAtStart":[]})");

    std::string d1 = "{\"type\":\"BeliefDeltaApplied\",\"taskId\":\"task-1\",\"frameId\":\"frame-1\",\"delta\":{\"id\":\"delta-1\",\"frameId\":\"frame-1\",\"operation\":\"propose\",\"beliefId\":\"belief-1\",\"evidenceBeliefIds\":[],\"resultingBeliefs\":[" + beliefRecord("belief-1", "project uses pytest", "code", "pytest is importable") + "]},\"activeBeliefs\":[\"belief-1\"]}";
    m.applyLine(d1);
    std::string d2 = "{\"type\":\"BeliefDeltaApplied\",\"taskId\":\"task-1\",\"frameId\":\"frame-1\",\"delta\":{\"id\":\"delta-2\",\"frameId\":\"frame-1\",\"operation\":\"propose\",\"beliefId\":\"belief-2\",\"evidenceBeliefIds\":[],\"resultingBeliefs\":[" + beliefRecord("belief-2", "runtime lacks pytest", "product", "pip show pytest fails") + "]},\"activeBeliefs\":[\"belief-1\",\"belief-2\"]}";
    m.applyLine(d2);

    m.applyLine(R"({"type":"PlanProduced","taskId":"task-1","frameId":"frame-1","plan":{"id":"plan-1","selectedToExplore":["belief-1","belief-2"],"intent":"verify dependency"}})");
    m.applyLine(R"({"type":"ExecutionStarted","taskId":"task-1","frameId":"frame-1","execution":{"id":"exec-1","planId":"plan-1","intention":"Run read","tool":"read","input":{"path":"requirements.txt"},"filePath":"requirements.txt"}})");
    m.applyLine(R"({"type":"ExecutionCompleted","taskId":"task-1","frameId":"frame-1","executionId":"exec-1","output":"pytest==8.0","status":"succeeded"})");
    m.applyLine(R"({"type":"ExecutionStarted","taskId":"task-1","frameId":"frame-1","execution":{"id":"exec-2","planId":"plan-1","intention":"Run bash","tool":"bash","input":{"command":"pip show pytest"}}})");
    m.applyLine(R"({"type":"ExecutionCompleted","taskId":"task-1","frameId":"frame-1","executionId":"exec-2","output":"exit 1","status":"failed","error":"not found"})");
    m.applyLine(R"({"type":"CursorChanged","taskId":"task-1","frameId":"frame-1","stage":"executing"})");
    m.applyLine(R"({"type":"DistillationProduced","taskId":"task-1","frameId":"frame-1","distillation":{"id":"distill-1","inputs":["exec-1","exec-2"],"contents":"declared vs runtime differ","outputs":["delta-1","delta-2"]}})");
    m.applyLine(R"({"type":"FrameClosed","taskId":"task-1","frameId":"frame-1"})");
    m.applyLine(R"({"type":"TaskClosed","taskId":"task-1","status":"completed"})");
}

int main() {
    // ---------------------------------------------------------------------
    // Domain-event ingestion (applyLine / demo path)
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedDemoTask(model);

        const auto* task = model.taskById("task-1");
        check(task != nullptr, "task exists");
        check(task && task->status == "completed", "task completed");
        check(task && task->targetStatement == "Is pytest available?", "task target statement");

        const auto* f = model.frameById("frame-1");
        check(f != nullptr, "frame exists");
        check(f && f->closed, "frame closed");
        check(f && f->bodyKind == "belief-loop", "frame body is belief-loop");
        check(f && f->routingDecision == "belief-loop", "routing decision recorded");
        check(f && f->plan.valid(), "plan valid");
        check(f && f->plan.selectedToExplore.size() == 2, "plan selects two beliefs");
        check(f && f->plan.intent == "verify dependency", "plan intent");
        check(f && f->trajectory.size() == 2, "two executions");
        check(f && f->trajectory[0].status == "ok", "execution 0 ok (from succeeded)");
        check(f && f->trajectory[1].status == "failed", "execution 1 failed");
        check(f && f->trajectory[1].warning == "not found", "execution 1 error");
        check(f && f->distillation.valid(), "distillation valid");
        check(f && f->distillation.inputs.size() == 2, "distillation inputs");
        check(f && f->distillation.outputs.size() == 2, "distillation outputs");
        check(f && f->beliefDeltas.size() == 2, "two belief deltas");

        // Belief registry: two beliefs, correct statement/status/provenance.
        check(model.beliefs().size() == 2, "two beliefs registered");
        const auto* b1 = model.belief("belief-1");
        check(b1 && b1->statement == "project uses pytest", "belief 1 statement");
        check(b1 && b1->status == "proposed", "belief 1 status proposed");
        check(b1 && b1->createdInFrame == "frame-1", "belief 1 provenance explicit");
        check(!b1->label.empty(), "belief 1 has a display label");

        // Task closed clears the active task and cursor.
        check(model.activeTask() == nullptr, "no active task after close");
        check(!model.cursor().valid(), "cursor invalid after close");
    }

    // ---------------------------------------------------------------------
    // Non-event / garbage lines are ignored; state unchanged.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        model.applyLine(R"({"type":"TaskOpened","taskId":"task-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        int before = static_cast<int>(model.frames().size());
        model.applyLine("not json");
        model.applyLine("");
        model.applyLine(R"({"type":"RandomThing","foo":1})");
        check(static_cast<int>(model.frames().size()) == before, "garbage ignored");
    }

    // ---------------------------------------------------------------------
    // Frame search (P1): case-insensitive substring over display fields.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedDemoTask(model);
        const auto* f = model.frameById("frame-1");
        check(f && pie::gui::frameMatchesQuery(*f, ""), "empty query matches all");
        check(f && pie::gui::frameMatchesQuery(*f, "PYTEST"), "case-insensitive match on result");
        check(f && pie::gui::frameMatchesQuery(*f, "verify dependency"), "match on plan intent");
        check(f && !pie::gui::frameMatchesQuery(*f, "zzzzz"), "non-matching query rejected");
    }

    // ---------------------------------------------------------------------
    // RPC adapter: control ack + turn boundaries are ignored (no frame).
    // ---------------------------------------------------------------------
    {
        NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"response","id":"p1","command":"prompt","success":true})") == pie::gui::RpcApplyResult::Ignored, "response ack ignored");
        check(rpc.inMessage().empty() && !rpc.inMessageError(), "successful response leaves prompt message unchanged");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"response","id":"p2","command":"prompt","success":false,"error":"request failed"})") == pie::gui::RpcApplyResult::Ignored, "failed response is ignored as control event");
        check(rpc.inMessage() == "request failed" && rpc.inMessageError(), "failed response surfaces error message");
        rpc.beginInMessage("next reply");
        check(!rpc.inMessageError(), "new message clears error state");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Ignored, "agent_start does not open a frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"turn_start"})") == pie::gui::RpcApplyResult::Ignored, "turn_start does not open a frame");
        check(rpc.frames().empty(), "no frame after turn boundaries");
        check(pie::gui::applyRpcLine(rpc, "not json") == pie::gui::RpcApplyResult::Error, "malformed line returns Error");
        check(pie::gui::applyRpcLine(rpc, "{\"foo\":1}") == pie::gui::RpcApplyResult::Error, "missing type returns Error");
    }

    // ---------------------------------------------------------------------
    // RPC adapter: domain events drive the same model (live path).
    // ---------------------------------------------------------------------
    {
        NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"TaskOpened","taskId":"task-9","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})") == pie::gui::RpcApplyResult::Applied, "TaskOpened applied");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"TargetDefined","taskId":"task-9","target":{"id":"t","statement":"prove it"}})") == pie::gui::RpcApplyResult::Applied, "TargetDefined applied");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"FrameOpened","taskId":"task-9","frameId":"frame-9","ordinal":1})") == pie::gui::RpcApplyResult::Applied, "FrameOpened applied");
        check(rpc.activeFrame() != nullptr, "active frame present after FrameOpened");
        check(rpc.cursor().frameId == "frame-9", "cursor bound to frame id");
        check(rpc.cursor().stage == pie::gui::FrameStage::ROUTING, "cursor starts at routing");

        check(pie::gui::applyRpcLine(rpc, R"({"type":"CursorChanged","taskId":"task-9","frameId":"frame-9","stage":"planning"})") == pie::gui::RpcApplyResult::Applied, "CursorChanged applied");
        check(rpc.cursor().stage == pie::gui::FrameStage::PLANNING, "cursor stage planning");
    }

    // ---------------------------------------------------------------------
    // RPC adapter: in-message stream (message_start/update/end).
    // ---------------------------------------------------------------------
    {
        NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"seed "}]}})") == pie::gui::RpcApplyResult::Applied, "message_start seeds in-message");
        check(rpc.inMessage() == "seed ", "in-message initialized");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello"}})") == pie::gui::RpcApplyResult::Applied, "text_delta appends");
        check(rpc.inMessage() == "seed hello", "in-message appended");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"..."}})") == pie::gui::RpcApplyResult::Applied, "thinking_delta appends");
        check(rpc.inMessage() == "seed hello...", "in-message appended with thinking");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "message_end finalizes");
    }

    // ---------------------------------------------------------------------
    // RPC adapter: tool_execution_start feeds the session file list only.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel lm;
        lm.setSession("/a/b");
        check(pie::gui::applyRpcLine(lm, R"({"type":"tool_execution_start","toolCallId":"c1","toolName":"read","args":{"path":"src/x.cpp"}})") == pie::gui::RpcApplyResult::Applied, "tool_execution_start applied");
        check(pie::gui::applyRpcLine(lm, R"({"type":"tool_execution_start","toolCallId":"c2","toolName":"edit","args":{"file_path":"/a/b/src/y.cpp"}})") == pie::gui::RpcApplyResult::Applied, "tool_execution_start file_path applied");
        const auto& fl = lm.fileList();
        check(fl.size() == 2, "live file list size 2");
        check(fl[0].op == "read" && fl[0].path == "src/x.cpp", "live read path from args.path");
        check(fl[1].op == "edit" && fl[1].path == "src/y.cpp", "live edit path from args.file_path");
    }

    // ---------------------------------------------------------------------
    // finalReport auto-reopen: FrameClosed marks pending; the next message_end
    // requests reopen; a following FrameOpened clears the pending signal.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"TaskOpened","taskId":"task-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})") == pie::gui::RpcApplyResult::Applied, "auto-open: task opens");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"FrameOpened","taskId":"task-1","frameId":"frame-1","ordinal":1})") == pie::gui::RpcApplyResult::Applied, "auto-open: frame opens");
        check(!rpc.finalReportPending(), "no pending before frame close");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "auto-open: message_end before close");
        check(!rpc.consumeAutoOpenPrompt(), "no reopen requested before close");

        check(pie::gui::applyRpcLine(rpc, R"({"type":"FrameClosed","taskId":"task-1","frameId":"frame-1"})") == pie::gui::RpcApplyResult::Applied, "auto-open: frame closes");
        check(rpc.finalReportPending(), "pending set by frame close");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"final conclusion"}]}})") == pie::gui::RpcApplyResult::Applied, "auto-open: conclusion message_start");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "auto-open: conclusion message_end");
        check(rpc.inMessage() == "final conclusion", "final answer retained");
        check(rpc.consumeAutoOpenPrompt(), "reopen requested after conclusion");
        check(!rpc.consumeAutoOpenPrompt(), "reopen consumed once");

        // A mid-loop frame close is cleared by the following FrameOpened.
        NativeGuiModel rpc2;
        pie::gui::applyRpcLine(rpc2, R"({"type":"TaskOpened","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        pie::gui::applyRpcLine(rpc2, R"({"type":"FrameOpened","taskId":"t","frameId":"f1","ordinal":1})");
        pie::gui::applyRpcLine(rpc2, R"({"type":"FrameClosed","taskId":"t","frameId":"f1"})");
        check(rpc2.finalReportPending(), "mid-loop close marks pending");
        pie::gui::applyRpcLine(rpc2, R"({"type":"FrameOpened","taskId":"t","frameId":"f2","ordinal":2})");
        check(!rpc2.finalReportPending(), "FrameOpened clears the pending signal");
    }

    // ---------------------------------------------------------------------
    // Graph projection: two belief deltas -> two Propose nodes; typed edges.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedDemoTask(model);
        pie::gui::GraphTaskState st = pie::gui::projectGraphTask(model);

        int beliefs = 0, plans = 0, execs = 0, dists = 0, proposes = 0;
        for (const auto& n : st.nodes) {
            if (n.family == pie::gui::NodeFamily::Belief) ++beliefs;
            else if (n.family == pie::gui::NodeFamily::Plan) ++plans;
            else if (n.family == pie::gui::NodeFamily::Execution) ++execs;
            else if (n.family == pie::gui::NodeFamily::Distill) ++dists;
            else if (n.family == pie::gui::NodeFamily::Propose) ++proposes;
        }
        check(beliefs == 2, "two global belief nodes");
        check(plans == 1, "one plan node");
        check(execs == 2, "two execution nodes");
        check(dists == 1, "one distill node");
        check(proposes == 2, "two propose nodes (one per belief delta)");

        bool allTyped = !st.edges.empty();
        for (const auto& e : st.edges) {
            if (!e.source.valid() || !e.target.valid()) allTyped = false;
        }
        check(allTyped, "all edges have valid endpoints");

        // Belief nodes are global (no owning frame).
        bool beliefsGlobal = true;
        for (const auto& n : st.nodes) {
            if (n.family == pie::gui::NodeFamily::Belief && n.frameId.has_value()) beliefsGlobal = false;
        }
        check(beliefsGlobal, "beliefs are global (no owning frame)");
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
