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

    // --- Belief-loop phase events (live mode): populate selected beliefs, plan, ---
    // --- distillation, and stage on the active frame. Stage is driven by
    // --- CursorChanged (not by Execution* / Distillation* events, which the
    // --- runtime never emits); DistillationProduced consumes only label and
    // --- interpretation (inputIds/unexplained never come from the runtime).
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "agent_start opens frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"BeliefsSelected","frameId":1000,"beliefs":[42,47]})") == pie::gui::RpcApplyResult::Applied, "beliefs_selected applied");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"BeliefUpdated","beliefId":42,"status":"proposed","statement":"project uses pytest"})") == pie::gui::RpcApplyResult::Applied, "belief_updated applied");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"PlanProduced","frameId":1000,"label":"P-128","question":"Is pytest available?","intent":"verify dependency"})") == pie::gui::RpcApplyResult::Applied, "plan_produced applied");
        // Stage is driven by CursorChanged, not synthesized from a phase event.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"CursorChanged","frameId":1000,"stage":"EXECUTING","item":"E-88"})") == pie::gui::RpcApplyResult::Applied, "cursor_changed sets stage");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"DistillationProduced","frameId":1000,"label":"D-42","interpretation":"mismatch"})") == pie::gui::RpcApplyResult::Applied, "distillation_produced applied");

        const auto* fr = rpc.frameById(1000);
        check(fr != nullptr, "rpc frame 1000 exists");
        check(fr && fr->selectedBeliefs.size() == 2, "two selected beliefs");
        check(fr && fr->selectedBeliefs[0].value == 42, "first selected belief id 42");
        check(fr && fr->plan.valid() && fr->plan.label == "P-128", "plan label set");
        check(fr && fr->plan.intent == "verify dependency", "plan intent set");
        check(fr && fr->stage == pie::gui::FrameStage::EXECUTING, "stage driven by CursorChanged");
        check(fr && fr->distillation.valid() && fr->distillation.label == "D-42", "distillation label");
        check(fr && fr->distillation.interpretation == "mismatch", "distillation interpretation");
        check(fr && fr->distillation.inputIds.empty(), "distillation inputIds empty (runtime never sends)");

        check(rpc.beliefs().size() == 1, "one belief registered");
        check(rpc.beliefs()[0].id.value == 42, "registered belief id 42");
        check(rpc.beliefs()[0].statement == "project uses pytest", "registered belief statement");
        check(rpc.beliefs()[0].status == "proposed", "registered belief status");
    }

    // --- Regression: the runtime frame id (taskId, 1-based) is authoritative. ---
    // --- The adapter opens a synthetic placeholder (1000); first real frame id  ---
    // --- must rebind it so later phase events land on the same frame, instead of ---
    // --- the panes dropping events after a frame id mismatch.                   ---
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "regression: agent_start opens placeholder");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"CursorChanged","frameId":1,"stage":"PLANNING"})") == pie::gui::RpcApplyResult::Applied, "regression: cursor_changed binds runtime frame id");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"BeliefsSelected","frameId":1,"beliefs":[42,47]})") == pie::gui::RpcApplyResult::Applied, "regression: beliefs_selected on runtime frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"PlanProduced","frameId":1,"label":"P-1","question":"q","intent":"intent"})") == pie::gui::RpcApplyResult::Applied, "regression: plan on runtime frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"CursorChanged","frameId":1,"stage":"EXECUTING","item":"E-1"})") == pie::gui::RpcApplyResult::Applied, "regression: cursor stage");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"DistillationProduced","frameId":1,"label":"D-1","interpretation":"distilled"})") == pie::gui::RpcApplyResult::Applied, "regression: distillation on runtime frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"ProposalCreated","frameId":1,"op":"+","belief":"B3","lhs":"","relation":"","rhs":"","detail":"proposal"})") == pie::gui::RpcApplyResult::Applied, "regression: proposal on runtime frame");

        check(rpc.cursor().frameId == 1, "regression: cursor bound to runtime frame id");
        const auto* f1 = rpc.frameById(1);
        check(f1 != nullptr, "regression: frame 1 exists after rebind");
        check(f1 && f1->selectedBeliefs.size() == 2, "regression: selected beliefs on runtime frame");
        check(f1 && f1->plan.valid() && f1->plan.label == "P-1", "regression: plan on runtime frame");
        check(f1 && f1->stage == pie::gui::FrameStage::EXECUTING, "regression: stage on runtime frame");
        check(f1 && f1->distillation.valid() && f1->distillation.label == "D-1", "regression: distillation label");
        check(f1 && f1->distillation.inputIds.empty(), "regression: distillation inputIds empty (runtime never sends)");
        check(f1 && f1->distillation.interpretation == "distilled", "regression: distillation interpretation");
        check(f1 && f1->proposals.size() == 1, "regression: proposal on runtime frame");
        check(rpc.frameById(1000) == nullptr, "regression: synthetic placeholder 1000 no longer exists");
    }

    // --- Regression: tool_execution_start after the runtime frame rebind lands ---
    // --- on the rebound frame (taskId, 1-based), not the synthetic placeholder. ---
    // --- Covers the live sequence agent_start -> CursorChanged(frameId:1) -> ---
    // --- tool_execution_start, which the earlier tests only exercise apart. ---
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "rebind+tool: agent_start opens placeholder");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"CursorChanged","frameId":1,"stage":"EXECUTING","item":"E-1"})") == pie::gui::RpcApplyResult::Applied, "rebind+tool: cursor rebound to runtime frame id");
        check(rpc.cursor().frameId == 1, "rebind+tool: cursor on runtime frame id");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"tool_execution_start","toolCallId":"call_E1","toolName":"bash","args":{"command":"ls"}})") == pie::gui::RpcApplyResult::Applied, "rebind+tool: tool_execution_start applied");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"tool_execution_end","toolCallId":"call_E1","toolName":"bash","result":{"output":"x"},"isError":false})") == pie::gui::RpcApplyResult::Applied, "rebind+tool: tool_execution_end applied");

        const auto* f1 = rpc.frameById(1);
        check(f1 != nullptr, "rebind+tool: frame 1 exists after rebind");
        check(f1 && f1->trajectory.size() == 1, "rebind+tool: one trajectory entry on rebound frame");
        check(f1 && f1->trajectory[0].tool == "bash", "rebind+tool: trajectory tool captured");
        check(f1 && f1->trajectory[0].command.find("ls") != std::string::npos, "rebind+tool: trajectory command captured");
        check(f1 && f1->trajectory[0].status == "ok", "rebind+tool: trajectory status ok");
        check(rpc.frameById(1000) == nullptr, "rebind+tool: synthetic placeholder 1000 gone");
    }

    // --- Regression: BeliefCreated registers a new belief immediately, and a
    // --- later BeliefUpdated for the same id updates it in place (no duplicate).
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "belief_created: agent_start opens frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"BeliefCreated","beliefId":42,"statement":"project uses pytest","domain":"code","expectation":"pytest is importable","evidenceRounds":1})") == pie::gui::RpcApplyResult::Applied, "belief_created applied");
        check(rpc.beliefs().size() == 1, "belief registered immediately on BeliefCreated");
        check(rpc.beliefs()[0].id.value == 42, "belief id 42 registered");
        check(rpc.beliefs()[0].statement == "project uses pytest", "belief statement set");
        check(rpc.beliefs()[0].status == "proposed", "new belief status proposed");
        // Same id later updated (support) must update the same entry, not add a dup.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"BeliefUpdated","beliefId":42,"status":"supported","previousStatus":"proposed","statement":"project uses pytest"})") == pie::gui::RpcApplyResult::Applied, "belief_updated applied");
        check(rpc.beliefs().size() == 1, "no duplicate after BeliefUpdated");
        check(rpc.beliefs()[0].status == "supported", "same entry status updated in place");
        check(rpc.beliefs()[0].statement == "project uses pytest", "same entry statement retained");
    }

    // --- Live RPC ProposalCreated: agent_start then ProposalCreated lands on the
    // --- active frame's proposals (bind to cursor frame, not the event's frameId). ---
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "agent_start opens frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"ProposalCreated","frameId":1,"op":"+","belief":"B3","lhs":"","relation":"","rhs":"","detail":"fast path routed"})") == pie::gui::RpcApplyResult::Applied, "proposal_created applied");

        const auto* fr = rpc.frameById(rpc.cursor().frameId);
        check(fr != nullptr, "rpc frame exists");
        check(fr && fr->proposals.size() == 1, "one proposal recorded");
        check(fr && fr->proposals[0].op == '+', "proposal op is +");
        check(fr && fr->proposals[0].belief == "B3", "proposal belief label");
    }

    // --- Live in-message stream (⌘T pane): message_start seeds, message_update ---
    // --- appends text deltas, message_end finalizes.                            ---
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"seed "}]}})") == pie::gui::RpcApplyResult::Applied, "message_start seeds in-message");
        check(rpc.inMessage() == "seed ", "in-message initialized from message_start");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello"}})") == pie::gui::RpcApplyResult::Applied, "text_delta appends");
        check(rpc.inMessage() == "seed hello", "in-message appended with delta");
        // Thinking deltas are appended too, so the ⌘T pane shows reasoning incrementally.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"..."}})") == pie::gui::RpcApplyResult::Applied, "thinking_delta appends");
        check(rpc.inMessage() == "seed hello...", "in-message appended with thinking delta");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "message_end finalizes");
        check(rpc.inMessage() == "seed hello...", "in-message retained after message_end");
    }

    // --- fast_path_distillation custom message projects content into the ---
    // --- incoming-message area, not the distillation lane. ---
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "fast_path: agent_start opens frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_start","message":{"role":"custom","customType":"fast_path_distillation","content":[{"type":"text","text":"dep confirmed"}]}})") == pie::gui::RpcApplyResult::Applied, "fast_path: message_start applied");
        check(rpc.inMessage() == "dep confirmed", "fast_path: content projected into incoming-message area");
        const auto* f = rpc.frameById(rpc.cursor().frameId);
        check(f != nullptr, "fast_path: frame exists");
        check(f && !f->distillation.valid(), "fast_path: no DistillationOutput fabricated");
        check(f && f->distillation.label.empty(), "fast_path: distillation label empty");
        // A following message_end must not clobber the projected content.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "fast_path: message_end applied");
        check(rpc.inMessage() == "dep confirmed", "fast_path: in-message retained after message_end");
    }

    // --- finalReport auto-reopen: CursorChanged(CLOSED) (the loop entering the ---
    // --- terminal finalReport role) marks the model pending, and the following ---
    // --- message_end requests the render loop reopen the user instruction pane. ---
    // --- Before the CLOSED cursor, a plain message_end must NOT request a reopen. ---
    {
        pie::gui::NativeGuiModel rpc;
        // No CLOSED cursor yet: ordinary mid-loop message_end does not request reopen.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "auto-open: agent_start opens frame");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "auto-open: message_end without CLOSED cursor");
        check(!rpc.consumeAutoOpenInstruction(), "no reopen requested before finalReport");
        // The loop advances to the terminal finalReport role -> CursorChanged(CLOSED).
        check(pie::gui::applyRpcLine(rpc, R"({"type":"CursorChanged","frameId":1,"stage":"CLOSED"})") == pie::gui::RpcApplyResult::Applied, "auto-open: cursor CLOSED marks pending");
        check(rpc.finalReportPending(), "pending set by CursorChanged(CLOSED)");
        check(!rpc.consumeAutoOpenInstruction(), "reopen not yet requested before message_end");
        // The finalReport role streams its conclusion and the message ends.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"final conclusion"}]}})") == pie::gui::RpcApplyResult::Applied, "auto-open: finalReport message_start");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "auto-open: finalReport message_end");
        check(rpc.inMessage() == "final conclusion", "final answer text retained");
        check(rpc.consumeAutoOpenInstruction(), "reopen requested after finalReport message_end");
        check(!rpc.consumeAutoOpenInstruction(), "reopen request consumed once");
        // A later unrelated message_end does not re-trigger.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_end"})") == pie::gui::RpcApplyResult::Applied, "auto-open: later message_end");
        check(!rpc.consumeAutoOpenInstruction(), "no reopen after pending cleared");
    }

    // --- thinking_start marks the live message as thinking; thinking_end / ---
    // --- text_start clear it. The ⌘T pane renders the accumulated inMessage_ ---
    // --- (including thinking deltas) even during reasoning; it only shows the ---
    // --- "thinking" placeholder when the buffer is still empty. ---
    {
        pie::gui::NativeGuiModel rpc;
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"thinking_start","contentIndex":0}})") == pie::gui::RpcApplyResult::Applied, "thinking_start applies");
        check(rpc.inMessageThinking(), "in-message is thinking after thinking_start");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"thinking_end","contentIndex":0}})") == pie::gui::RpcApplyResult::Applied, "thinking_end applies");
        check(!rpc.inMessageThinking(), "in-message no longer thinking after thinking_end");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_start","contentIndex":0}})") == pie::gui::RpcApplyResult::Applied, "text_start applies");
        check(!rpc.inMessageThinking(), "text_start keeps in-message not thinking");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"thinking_start","contentIndex":0}})") == pie::gui::RpcApplyResult::Applied, "second thinking_start applies");
        check(rpc.inMessageThinking(), "in-message thinking again after second thinking_start");
    }

    // --- Regression: JSON string escapes in message content must decode, not    ---
    // --- lose the backslash. A newline in JSON is the two-char sequence \n; the ---
    // --- decoder previously dropped the backslash and emitted 'n', so a model    ---
    // --- reply containing \n\n became the literal "nn". Verify the fixed decoder  ---
    // --- turns \n\n into two real newlines, and that plain text, quotes,          ---
    // --- backslashes, tabs and Unicode escapes still round-trip.                 ---
    {
        pie::gui::NativeGuiModel rpc;
        // Streaming text delta carries the JSON-escaped newline sequence. In a
        // raw string the backslashes are literal, so "\n" here is the two-char
        // JSON escape sequence (backslash + 'n'), which must decode to one real
        // newline -- not to the single letter 'n' as the old decoder did.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":""}]}})") == pie::gui::RpcApplyResult::Applied, "nlit: message_start seeds");
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"line1\n\nline2"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with escaped newline applied");
        check(rpc.inMessage() == "line1\n\nline2", "nlit: escaped newline decodes to two real newlines (not 'nn')");

        // Plain text and a literal backslash are preserved (JSON "\\" -> one backslash).
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"path: C:\\Users\\me\\x"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with escaped backslash applied");
        check(rpc.inMessage() == "line1\n\nline2path: C:\\Users\\me\\x", "nlit: escaped backslash decodes to one backslash");

        // Escaped quote and tab decode to their literal characters.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"say \"hi\" \tthen go"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with escaped quote/tab applied");
        check(rpc.inMessage() == "line1\n\nline2path: C:\\Users\\me\\xsay \"hi\" \tthen go", "nlit: escaped quote and tab decode correctly");

        // BMP Unicode escape decodes to UTF-8.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"caf\u00e9"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with unicode escape applied");
        check(rpc.inMessage().find("caf\xc3\xa9") != std::string::npos, "nlit: unicode escape decodes to UTF-8 e-acute");

        // UTF-16 surrogate pair: \uD83D\uDE00 is U+1F600 (grinning face), which
        // must become a single 4-byte UTF-8 sequence F0 9F 98 80, not two loose
        // 3-byte surrogate encodings (invalid UTF-8).
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"emoji:\uD83D\uDE00"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with surrogate pair applied");
        check(rpc.inMessage().find("emoji:\xf0\x9f\x98\x80") != std::string::npos, "nlit: surrogate pair combined into U+1F600 UTF-8 (F0 9F 98 80)");

        // An isolated high surrogate has no low partner: it must be preserved as
        // its original escape, never emitted as invalid UTF-8 (a lone 3-byte seq).
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"lone:\uD83D"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with isolated high surrogate applied");
        check(rpc.inMessage().find("lone:\\uD83D") != std::string::npos, "nlit: isolated high surrogate preserved as escape");

        // An isolated low surrogate is likewise preserved, not emitted as UTF-8.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"low-only:\uDE00"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with isolated low surrogate applied");
        check(rpc.inMessage().find("low-only:\\uDE00") != std::string::npos, "nlit: isolated low surrogate preserved as escape");

        // A high surrogate followed by a non-low code unit must not be combined;
        // the lone escape is preserved and the next escape decodes normally.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"bad:\uD83D\u0041"}})") == pie::gui::RpcApplyResult::Applied, "nlit: text_delta with high surrogate + non-low applied");
        check(rpc.inMessage().find("bad:\\uD83DA") != std::string::npos, "nlit: high surrogate retained when next escape is not a low surrogate");

        // message_start content array: the assistant's reply text decodes escapes
        // before seeding the in-message and folding into the frame summary.
        pie::gui::NativeGuiModel rpc2;
        check(pie::gui::applyRpcLine(rpc2, R"({"type":"agent_start"})") == pie::gui::RpcApplyResult::Applied, "nlit: agent_start opens frame");
        check(pie::gui::applyRpcLine(rpc2, R"({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"head\n\nbody"}]}})") == pie::gui::RpcApplyResult::Applied, "nlit: message_start with escaped newline applied");
        check(rpc2.inMessage() == "head\n\nbody", "nlit: message_start content decodes escaped newline to two newlines");
        check(rpc2.frameById(1000) && rpc2.frameById(1000)->summary.find("head") != std::string::npos, "nlit: decoded text folds into frame summary");

        // Structured content (plain token, no escapes) is not mangled.
        pie::gui::NativeGuiModel rpc3;
        check(pie::gui::applyRpcLine(rpc3, R"({"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"the quick brown fox"}]}})") == pie::gui::RpcApplyResult::Applied, "nlit: plain content applied");
        check(pie::gui::applyRpcLine(rpc3, R"({"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"..."}]}})") == pie::gui::RpcApplyResult::Applied, "nlit: second plain content applied");
    }

    // ---------------------------------------------------------------------
    // Bottom footer telemetry: session_status event -> Footer on the model.
    // ---------------------------------------------------------------------
    {
        pie::gui::NativeGuiModel rpc;
        const char* statusLine =
            R"({"type":"session_status","roleStatus":{"epistemic":{"model":{"provider":"anthropic","id":"claude-sonnet-4-5"},"latestCacheHitRate":42.7},"planner":{"model":{"provider":"google","id":"gemini-2.5-pro"},"latestCacheHitRate":55.0},"distillation":{"model":{"provider":"openai","id":"o3"},"latestCacheHitRate":0.0},"execution":{"model":{"provider":"anthropic","id":"claude-sonnet-4-5"},"latestCacheHitRate":38.2}},"cost":0.1234})";
        check(pie::gui::applyRpcLine(rpc, statusLine) == pie::gui::RpcApplyResult::Applied,
              "session_status applied");
        const pie::gui::Footer& f = rpc.footer();
        check(f.hasData, "session_status sets hasData");
        check(f.epistemic.model == "claude-sonnet-4-5", "epistemic model id");
        check(f.epistemic.cacheHitRate == 42.7f, "epistemic cache hit rate");
        check(f.planner.model == "gemini-2.5-pro", "planner model id");
        check(f.planner.cacheHitRate == 55.0f, "planner cache hit rate");
        check(f.distillation.model == "o3", "distillation model id");
        check(f.distillation.cacheHitRate == 0.0f, "distillation cache hit rate (0 is valid)");
        check(f.execution.model == "claude-sonnet-4-5", "execution model id");
        check(f.execution.cacheHitRate == 38.2f, "execution cache hit rate");
        check(f.sessionCost == 0.1234, "session cost parsed");

        // Missing phase / empty model fields fall back to placeholders.
        pie::gui::NativeGuiModel rpc2;
        const char* sparseLine =
            R"({"type":"session_status","roleStatus":{"epistemic":{"model":{}},"planner":{"model":{"provider":"p","id":"m"}}},"cost":0})";
        check(pie::gui::applyRpcLine(rpc2, sparseLine) == pie::gui::RpcApplyResult::Applied,
              "sparse session_status applied");
        const pie::gui::Footer& f2 = rpc2.footer();
        check(f2.hasData, "sparse sets hasData");
        check(f2.epistemic.model.empty(), "empty model -> empty provider/id");
        check(f2.epistemic.cacheHitRate < 0.0f, "absent cache hit rate -> negative placeholder");
        check(f2.planner.model == "m", "planner model still parsed");
        check(f2.sessionCost == 0.0, "absent cost -> 0");
    }

    // ---------------------------------------------------------------------
    // Per-role context length: session_status roleUsage -> roleContext on the model.
    // ---------------------------------------------------------------------
    {
        pie::gui::NativeGuiModel rpc;
        const char* usageLine =
            R"({"type":"session_status","roleStatus":{},"roleUsage":{"epistemic":{"tokens":4321,"contextWindow":200000,"percent":2.16},"execution":{"tokens":51234,"contextWindow":200000,"percent":25.62}},"cost":0})";
        check(pie::gui::applyRpcLine(rpc, usageLine) == pie::gui::RpcApplyResult::Applied,
              "session_status roleUsage applied");
        const pie::gui::RoleContextUsagePair& rc = rpc.roleContext();
        check(rc.hasData, "roleUsage sets hasData");
        check(rc.epistemic.tokens == 4321, "epistemic tokens parsed");
        check(rc.epistemic.contextWindow == 200000, "epistemic context window");
        check(rc.execution.tokens == 51234, "execution tokens parsed");
        check(rc.execution.percent == 25.62, "execution percent parsed");
        check(rc.epistemic.valid() && rc.execution.valid(), "both roles valid");

        // A roleUsage with null tokens (unknown) leaves the negative placeholder.
        pie::gui::NativeGuiModel rpc2;
        const char* nullLine =
            R"({"type":"session_status","roleStatus":{},"roleUsage":{"epistemic":{"tokens":null,"contextWindow":200000,"percent":null},"execution":{"tokens":51234,"contextWindow":200000,"percent":25.62}},"cost":0})";
        check(pie::gui::applyRpcLine(rpc2, nullLine) == pie::gui::RpcApplyResult::Applied,
              "null-token roleUsage applied");
        const pie::gui::RoleContextUsagePair& rc2 = rpc2.roleContext();
        check(rc2.hasData, "null-token sets hasData");
        check(!rc2.epistemic.valid() && rc2.epistemic.tokens < 0, "null epistemic tokens -> placeholder");
        check(rc2.execution.valid(), "execution still valid");

        // A later session_status without roleUsage must clear (not retain) the
        // previously cached role context, so the status bar shows no stale value.
        check(pie::gui::applyRpcLine(rpc, R"({"type":"session_status","roleStatus":{},"cost":0})") ==
                  pie::gui::RpcApplyResult::Applied,
              "absence: roleUsage-less session_status applied");
        check(!rpc.roleContext().hasData, "absence: roleUsage cleared after missing roleUsage");
        // Reset also clears the cached role context (seed with a fresh, valid pair
        // rather than the reference aliasing the model's own field).
        pie::gui::RoleContextUsagePair seeded;
        seeded.epistemic.tokens = 100;
        seeded.execution.tokens = 200;
        seeded.hasData = true;
        rpc.setRoleContext(seeded);
        check(rpc.roleContext().hasData, "seeded roleContext before reset");
        rpc.reset();
        check(!rpc.roleContext().hasData, "reset clears roleContext");
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
