// Headless tests for the Phase 2 M1 graph projection and M3 layout engine.
// No window, no ImGui, no SDK. Run: ./pi_gui_graph_test  (non-zero on failure).

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"
#include "Model.h"

#include <cstdio>
#include <set>
#include <string>

using pie::gui::BeliefOperation;
using pie::gui::EdgeSemanticType;
using pie::gui::GraphTaskState;
using pie::gui::LoopFrameInfo;
using pie::gui::NativeGuiModel;
using pie::gui::NodeFamily;
using pie::gui::PieGraphLayout;
using pie::gui::projectGraphTask;
using pie::gui::computeGraphLayout;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

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

static void delta(NativeGuiModel& m, const char* frameId, const char* deltaId,
                  const char* op, const char* beliefId) {
    std::string rec = beliefRecord(beliefId, "statement of ", "code", "expectation");
    std::string line = "{\"type\":\"BeliefDeltaApplied\",\"taskId\":\"task-1\",\"frameId\":\"";
    line += frameId;
    line += "\",\"delta\":{\"id\":\"";
    line += deltaId;
    line += "\",\"frameId\":\"";
    line += frameId;
    line += "\",\"operation\":\"";
    line += op;
    line += "\",\"beliefId\":\"";
    line += beliefId;
    line += "\",\"evidenceBeliefIds\":[],\"resultingBeliefs\":[";
    line += rec;
    line += "]},\"activeBeliefs\":[\"";
    line += beliefId;
    line += "\"]}";
    m.applyLine(line);
}

// Build a model with two belief-loop frames mirroring the domain vocabulary.
static NativeGuiModel buildModel() {
    NativeGuiModel model;
    model.applyLine(R"({"type":"TaskOpened","taskId":"task-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
    model.applyLine(R"({"type":"TargetDefined","taskId":"task-1","target":{"id":"t","statement":"verify pytest"}})");

    // Frame 1: propose belief-1, belief-2; plan; two executions; distill.
    model.applyLine(R"({"type":"FrameOpened","taskId":"task-1","frameId":"frame-1","ordinal":1})");
    model.applyLine(R"({"type":"FrameBodySelected","taskId":"task-1","frameId":"frame-1","body":"belief-loop","openBeliefsAtStart":[]})");
    delta(model, "frame-1", "delta-1", "propose", "belief-1");
    delta(model, "frame-1", "delta-2", "propose", "belief-2");
    model.applyLine(R"({"type":"PlanProduced","taskId":"task-1","frameId":"frame-1","plan":{"id":"plan-1","selectedToExplore":["belief-1","belief-2"],"intent":"verify dependency"}})");
    model.applyLine(R"({"type":"ExecutionStarted","taskId":"task-1","frameId":"frame-1","execution":{"id":"exec-1","planId":"plan-1","intention":"read","tool":"read","input":{"path":"requirements.txt"}}})");
    model.applyLine(R"({"type":"ExecutionCompleted","taskId":"task-1","frameId":"frame-1","executionId":"exec-1","output":"pytest==8.0","status":"succeeded"})");
    model.applyLine(R"({"type":"ExecutionStarted","taskId":"task-1","frameId":"frame-1","execution":{"id":"exec-2","planId":"plan-1","intention":"bash","tool":"bash","input":{"command":"pip show pytest"}}})");
    model.applyLine(R"({"type":"ExecutionCompleted","taskId":"task-1","frameId":"frame-1","executionId":"exec-2","output":"exit 1","status":"failed","error":"not found"})");
    model.applyLine(R"({"type":"DistillationProduced","taskId":"task-1","frameId":"frame-1","distillation":{"id":"distill-1","inputs":["exec-1","exec-2"],"contents":"declared vs runtime differ","outputs":["delta-1","delta-2"]}})");
    model.applyLine(R"({"type":"FrameClosed","taskId":"task-1","frameId":"frame-1"})");

    // Frame 2: propose belief-3; plan; one execution; distill; close.
    model.applyLine(R"({"type":"FrameOpened","taskId":"task-1","frameId":"frame-2","ordinal":2})");
    model.applyLine(R"({"type":"FrameBodySelected","taskId":"task-1","frameId":"frame-2","body":"belief-loop","openBeliefsAtStart":[]})");
    delta(model, "frame-2", "delta-3", "propose", "belief-3");
    model.applyLine(R"({"type":"PlanProduced","taskId":"task-1","frameId":"frame-2","plan":{"id":"plan-2","selectedToExplore":["belief-3"],"intent":"check env"}})");
    model.applyLine(R"({"type":"ExecutionStarted","taskId":"task-1","frameId":"frame-2","execution":{"id":"exec-3","planId":"plan-2","intention":"bash","tool":"bash","input":{"command":"ls"}}})");
    model.applyLine(R"({"type":"ExecutionCompleted","taskId":"task-1","frameId":"frame-2","executionId":"exec-3","output":"a b c","status":"succeeded"})");
    model.applyLine(R"({"type":"DistillationProduced","taskId":"task-1","frameId":"frame-2","distillation":{"id":"distill-2","inputs":["exec-3"],"contents":"ok","outputs":["delta-3"]}})");
    model.applyLine(R"({"type":"FrameClosed","taskId":"task-1","frameId":"frame-2"})");

    return model;
}

int main() {
    NativeGuiModel model = buildModel();
    GraphTaskState state = projectGraphTask(model);

    // --- M1: node families ---
    int proposeNodes1 = 0, proposeNodes2 = 0;
    int beliefCount = 0, planCount = 0, execCount1 = 0, distillCount = 0;
    bool beliefsGlobal = true;
    for (const auto& n : state.nodes) {
        switch (n.family) {
            case NodeFamily::Belief:
                ++beliefCount;
                if (n.frameId.has_value()) beliefsGlobal = false;
                break;
            case NodeFamily::Plan: ++planCount; break;
            case NodeFamily::Execution:
                if (n.frameId && *n.frameId == "frame-1") ++execCount1;
                break;
            case NodeFamily::Distill: ++distillCount; break;
            case NodeFamily::Propose:
                if (n.frameId && *n.frameId == "frame-1") ++proposeNodes1;
                if (n.frameId && *n.frameId == "frame-2") ++proposeNodes2;
                break;
        }
    }
    check(beliefCount == 3, "three global belief nodes");
    check(beliefsGlobal, "beliefs are global (no owning frame)");
    check(planCount == 2, "two plan nodes");
    check(execCount1 == 2, "two execution nodes for frame 1");
    check(distillCount == 2, "two distill nodes");
    check(proposeNodes1 == 2, "two Propose nodes for frame 1 (two deltas)");
    check(proposeNodes2 == 1, "one Propose node for frame 2 (one delta)");

    // --- M1: typed, directed edges with valid endpoints ---
    bool allTyped = !state.edges.empty();
    int createEdges = 0;
    for (const auto& e : state.edges) {
        const bool known = e.type == EdgeSemanticType::BeliefToPlan ||
                           e.type == EdgeSemanticType::PlanToExecution ||
                           e.type == EdgeSemanticType::ExecutionToDistill ||
                           e.type == EdgeSemanticType::DistillToPropose ||
                           e.type == EdgeSemanticType::ProposeToBelief;
        if (!known) allTyped = false;
        if (!e.source.valid() || !e.target.valid()) allTyped = false;
        if (e.type == EdgeSemanticType::ProposeToBelief && e.beliefOperation &&
            *e.beliefOperation == BeliefOperation::Create) ++createEdges;
    }
    check(allTyped, "all edges typed and valid");
    check(createEdges == 3, "three Propose->Belief create edges (propose ops)");

    // --- M1: frame containers ---
    check(state.frames.size() == 2, "two frame containers");

    // --- M3: layout determinism ---
    PieGraphLayout layout = computeGraphLayout(state);
    PieGraphLayout layout2 = computeGraphLayout(state);
    bool deterministic = layout.nodeRects.size() == layout2.nodeRects.size();
    for (const auto& [k, r] : layout.nodeRects) {
        auto it = layout2.nodeRects.find(k);
        if (it == layout2.nodeRects.end() ||
            it->second.x != r.x || it->second.y != r.y ||
            it->second.w != r.w || it->second.h != r.h) deterministic = false;
    }
    check(deterministic, "layout is deterministic");

    auto findRect = [&](const std::string& id) -> const pie::gui::GraphRect* {
        auto it = layout.nodeRects.find(id);
        return it == layout.nodeRects.end() ? nullptr : &it->second;
    };
    const auto* b1 = findRect("belief-1");
    const auto* p1 = findRect("plan-1");
    const auto* e1 = findRect("exec-1");
    const auto* d1 = findRect("distill-1");
    const auto* pr1 = findRect("delta-1");
    check(b1 && p1 && e1 && d1 && pr1, "core nodes placed");

    bool allValid = true;
    bool noOverlap = true;
    for (const auto& [k, r] : layout.nodeRects) {
        if (r.w <= 0.0f || r.h <= 0.0f) allValid = false;
        for (const auto& [k2, r2] : layout.nodeRects) {
            if (k == k2) continue;
            if (r.x < r2.x + r2.w && r.x + r.w > r2.x && r.y < r2.y + r2.h && r.y + r.h > r2.y)
                noOverlap = false;
        }
    }
    check(allValid, "every node rect has positive size");
    check(noOverlap, "node rects do not overlap");

    check(layout.frameRects.count("frame-1") && layout.frameRects.count("frame-2"),
          "both frames have a container");
    check(layout.planRegionRects.count("frame-1") && layout.distillRegionRects.count("frame-1") &&
          layout.executionRegionRects.count("frame-1"),
          "frame 1 exposes Plan/Distillation/Execution regions");

    check(layout.canvasWidth > 0 && layout.canvasHeight > 0, "canvas size is positive");

    if (failures == 0) std::printf("PASS\n");
    std::printf("graph test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
