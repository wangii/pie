// Headless unit tests for NativeGuiModel. No window, no ImGui, no SDK.
// Run: ./pi_gui_model_test   (returns non-zero on failure).

#include "Model.h"

#include <cstdio>

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

int main() {
    NativeGuiModel model;

    // A complete epistemic transaction for frame 128 (pytest runtime mismatch).
    model.applyLine(R"({"type":"FrameOpened","id":128,"summary":"runtime pytest mismatch","opened_at":"t0"})");
    model.applyLine(R"({"type":"BeliefsSelected","frameId":128,"beliefs":[42,47]})");
    model.applyLine(R"({"type":"PlanProduced","frameId":128,"label":"P-128","question":"Is pytest actually available?","intent":"verify dependency against runtime"})");
    model.applyLine(R"({"type":"ExecutionStarted","frameId":128})");
    model.applyLine(R"({"type":"ToolCalled","frameId":128,"id":"E-88","tool":"read","command":"requirements.txt","status":"ok"})");
    model.applyLine(R"({"type":"ToolReturned","frameId":128,"id":"E-88","result":"pytest==8.0","warning":""})");
    model.applyLine(R"({"type":"ToolCalled","frameId":128,"id":"E-89","tool":"bash","command":"pip show pytest","status":"running"})");
    model.applyLine(R"({"type":"ToolReturned","frameId":128,"id":"E-89","result":"exit code 1","warning":"Package(s) not found: pytest","status":"failed"})");
    model.applyLine(R"({"type":"ExecutionCompleted","frameId":128})");
    model.applyLine(R"({"type":"DistillationStarted","frameId":128})");
    model.applyLine(R"({"type":"DistillationProduced","frameId":128,"label":"D-42","inputIds":["E-88","E-89"],"unexplained":"B42 predicts pytest but runtime lacks it","interpretation":"declared vs runtime differ"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":128,"op":"~","belief":"B42","detail":"confidence 0.62 -> 0.31","lhs":"project","relation":"uses","rhs":"pytest"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":128,"op":"+","belief":"B53","detail":"new","lhs":"runtime_environment","relation":"lacks","rhs":"pytest"})");
    model.applyLine(R"({"type":"CursorChanged","frameId":128,"stage":"EXECUTING","item":"E-89"})");
    model.applyLine(R"({"type":"BeliefUpdated","beliefId":42,"confidence":0.31,"status":"open","sourceFrame":128,"lhs":"project","relation":"uses","rhs":"pytest"})");
    model.applyLine(R"({"type":"BeliefUpdated","beliefId":53,"confidence":0.9,"status":"open","sourceFrame":128,"lhs":"runtime_environment","relation":"lacks","rhs":"pytest"})");

    // --- Frame structure ---
    const auto* f = model.frameById(128);
    check(f != nullptr, "frame 128 exists");
    check(f && f->plan.label == "P-128", "plan label");
    check(f && f->plan.intent == "verify dependency against runtime", "plan intent");
    check(f && f->selectedBeliefs.size() == 2, "two selected beliefs");
    check(f && f->trajectory.size() == 2, "two tool calls");
    check(f && f->trajectory[1].status == "failed", "tool status from ToolReturned");
    check(f && f->trajectory[1].warning == "Package(s) not found: pytest", "tool warning");
    check(f && f->distillation.label == "D-42", "distillation label");
    check(f && f->distillation.inputIds.size() == 2, "distillation inputs");
    check(f && f->proposals.size() == 2, "two proposals");
    check(f && f->proposals[0].op == '~', "proposal 0 is modify");
    check(f && f->proposals[1].op == '+', "proposal 1 is create");

    // --- Cursor comes only from the explicit CursorChanged event ---
    check(model.cursor().frameId == 128, "cursor frame");
    check(model.cursor().stage == FrameStage::EXECUTING, "cursor stage from event");
    check(model.cursor().item == "E-89", "cursor item from event");
    check(model.activeFrame() != nullptr, "active frame present");

    // --- Belief registry + selected-in-frame ---
    check(model.beliefs().size() == 2, "two beliefs registered");
    check(model.isSelectedInCurrentFrame(pie::gui::BeliefId{42}), "belief 42 selected");
    check(model.isSelectedInCurrentFrame(pie::gui::BeliefId{47}), "belief 47 selected");
    check(!model.isSelectedInCurrentFrame(pie::gui::BeliefId{53}), "belief 53 not selected in frame 128");

    // --- Close the frame; it becomes immutable historical state ---
    model.applyLine(R"({"type":"FrameClosed","frameId":128,"status":"CLOSED"})");
    const auto* closed = model.frameById(128);
    check(closed && closed->closed, "frame closed");
    check(closed && closed->history == pie::gui::LoopFrame::History::Revised, "history marked revised");
    check(model.activeFrame() == nullptr, "no active frame after close");

    // --- A later frame must NOT mutate the closed frame ---
    model.applyLine(R"({"type":"FrameOpened","id":132,"summary":"re-audit","opened_at":"t1"})");
    model.applyLine(R"({"type":"CursorChanged","frameId":132,"stage":"PLANNING","item":"P-132"})");
    model.applyLine(R"({"type":"ToolCalled","frameId":132,"id":"E-200","tool":"read","command":"x","status":"ok"})");
    const auto* f132 = model.frameById(132);
    check(f132 && f132->trajectory.size() == 1, "frame 132 own trajectory");
    check(closed && closed->trajectory.size() == 2, "closed frame 128 trajectory unchanged");
    check(closed && !closed->failed, "closed 128 not failed");
    check(model.cursor().frameId == 132, "cursor moved to 132");

    // --- Non-event / garbage lines are ignored; state unchanged ---
    int before = static_cast<int>(model.frames().size());
    model.applyLine("not json");
    model.applyLine("");
    model.applyLine(R"({"type":"RandomThing","foo":1})");
    check(static_cast<int>(model.frames().size()) == before, "garbage ignored");

    // --- P1 frame search: frameMatchesQuery (case-insensitive substring) ---
    const auto* f128 = model.frameById(128);
    check(f128 && pie::gui::frameMatchesQuery(*f128, ""), "empty query matches all");
    check(f128 && pie::gui::frameMatchesQuery(*f128, "PYTEST"), "case-insensitive match on result");
    check(f128 && pie::gui::frameMatchesQuery(*f128, "128"), "match on frame id");
    check(f128 && pie::gui::frameMatchesQuery(*f128, "dependency against runtime"), "match on plan intent");
    check(f128 && pie::gui::frameMatchesQuery(*f128, "runtime_environment"), "match on proposal lhs");
    check(f128 && !pie::gui::frameMatchesQuery(*f128, "zzzzz"), "non-matching query rejected");
    const auto* f132s = model.frameById(132);
    check(f132s && pie::gui::frameMatchesQuery(*f132s, "re-audit"), "match on summary");
    check(f132s && pie::gui::frameMatchesQuery(*f132s, "132"), "match on frame id 132");
    check(f132s && !pie::gui::frameMatchesQuery(*f132s, "pytest"), "frame 132 does not match pytest");

    // --- RPC event adapter (live mode): build frame/summary/trajectory, do    ---
    // --- not fabricate Belief/Proposal/Distillation.                          ---
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"response","id":"p1","command":"prompt","success":true})") == pie::gui::RpcApplyResult::Ignored, "response ack ignored");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "agent_start opens frame");
        check(rpc.frames().size() == 1, "one frame after agent_start");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"explain current frame"}],"timestamp":0}})") == pie::gui::RpcApplyResult::Applied, "user message appended to summary");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"tool_execution_start","toolCallId":"call_E88","toolName":"read","args":{"path":"x"}})") == pie::gui::RpcApplyResult::Applied, "tool_execution_start adds trajectory");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"tool_execution_end","toolCallId":"call_E88","toolName":"read","result":{"text":"ok"},"isError":false})") == pie::gui::RpcApplyResult::Applied, "tool_execution_end sets result");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"turn_end"})") == pie::gui::RpcApplyResult::Applied, "turn_end closes frame");

        const auto* fr = rpc.frameById(1000);
        check(fr != nullptr, "rpc frame 1000 exists");
        check(fr && fr->summary.find("explain current frame") != std::string::npos, "frame summary has user text");
        check(fr && fr->trajectory.size() == 1, "frame has one trajectory entry");
        check(fr && fr->trajectory[0].tool == "read", "trajectory tool captured");
        check(fr && fr->trajectory[0].status == "ok", "trajectory status ok");
        check(fr && fr->trajectory[0].result.find("text") != std::string::npos, "trajectory result captured");
        check(fr && fr->closed, "rpc frame closed after turn_end");
        check(rpc.beliefs().empty(), "no beliefs fabricated");
        check(fr && fr->proposals.empty(), "no proposals fabricated");
        check(fr && fr->distillation.label.empty(), "no distillation fabricated");
        check(pie::gui::applyRpcLine(rpc, "not json") == pie::gui::RpcApplyResult::Error, "malformed line returns Error");
        check(pie::gui::applyRpcLine(rpc, "{\"foo\":1}") == pie::gui::RpcApplyResult::Error, "missing type returns Error");
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
