// Headless tests for the Phase 2 M1 graph projection and M3 layout engine.
// No window, no ImGui, no SDK. Run: ./pi_gui_graph_test  (non-zero on failure).

#include "graph/GraphLive.h"
#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"
#include "Model.h"

#include <cstdio>
#include <set>
#include <string>

using pie::gui::BeliefOperation;
using pie::gui::EdgeSemanticType;
using pie::gui::GraphLiveState;
using pie::gui::GraphTaskState;
using pie::gui::LoopFrameInfo;
using pie::gui::NativeGuiModel;
using pie::gui::NodeFamily;
using pie::gui::PieGraphLayout;
using pie::gui::projectGraphTask;
using pie::gui::computeGraphLayout;
using pie::gui::stabilizeLiveLayout;
using pie::gui::beliefNodeTitle;
using pie::gui::edgeIsCreate;
using pie::gui::GraphNode;
using pie::gui::NodeId;
using pie::gui::GraphRect;
using pie::gui::GraphEdge;

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

// Belief create is a Propose step: a BeliefDeltaApplied with operation
// "propose" must project as one Propose node plus a Propose->Belief edge whose
// beliefOperation is Create, and the layout must place both positively.
static void testBeliefCreateIsPropose() {
    NativeGuiModel m;
    m.applyLine(R"({"type":"TaskOpened","taskId":"t-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
    m.applyLine(R"({"type":"FrameOpened","taskId":"t-1","frameId":"f1","ordinal":1})");
    m.applyLine(R"({"type":"BeliefDeltaApplied","taskId":"t-1","frameId":"f1","delta":{"id":"d1","frameId":"f1","operation":"propose","beliefId":"B1","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"B1","statement":"x","domain":"code","expectation":"","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["B1"]})");
    m.applyLine(R"({"type":"DistillationProduced","taskId":"t-1","frameId":"f1","distillation":{"id":"D1","inputs":[],"contents":"c","outputs":["d1"]}})");

    GraphTaskState s = projectGraphTask(m);
    int proposeCount = 0, createEdges = 0, distillToPropose = 0, beliefCount = 0;
    for (const GraphNode& n : s.nodes) {
        if (n.family == NodeFamily::Propose) {
            ++proposeCount;
            check(n.displayType == "propose", "create Propose node displayType is 'propose'");
            check(n.frameId && *n.frameId == "f1::next", "distill Propose node belongs to the pending next frame");
        }
        if (n.family == NodeFamily::Belief) {
            ++beliefCount;
            check(n.displayType == "proposed", "created belief status projected as 'proposed'");
        }
    }
    for (const GraphEdge& e : s.edges) {
        if (e.type == EdgeSemanticType::ProposeToBelief && e.beliefOperation &&
            *e.beliefOperation == BeliefOperation::Create) ++createEdges;
        if (e.type == EdgeSemanticType::DistillToPropose) ++distillToPropose;
    }
    check(proposeCount == 1, "belief create yields exactly one Propose node");
    check(createEdges == 1, "belief create yields one Propose->Belief create edge");
    check(distillToPropose == 1, "belief create yields one Distill->Propose edge");
    check(beliefCount == 1, "belief create yields exactly one belief node");
    check(s.frames.size() == 2 && s.frames.back().id == "f1::next",
          "distill output creates a pending next frame container");

    PieGraphLayout layout = computeGraphLayout(s);
    const GraphRect* pr = nullptr;
    for (const auto& [k, r] : layout.nodeRects) if (k == "d1") { pr = &r; break; }
    if (pr) check(pr->w > 0.0f && pr->h > 0.0f, "create Propose node has a positive-size layout rect");
    else check(false, "create Propose node is laid out");
}

// Belief-creation deltas that reach the model before their frame opens, or that
// omit beliefId but still project a resulting belief, must still yield a
// Propose node (and a Propose->Belief create edge) once the frame is known.
static void testBeliefCreateMissingFrameAndLink() {
    // Out-of-order: the delta arrives before FrameOpened but names its frame.
    {
        NativeGuiModel m;
        m.applyLine(R"({"type":"TaskOpened","taskId":"t-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        m.applyLine(R"({"type":"BeliefDeltaApplied","taskId":"t-1","frameId":"f1","delta":{"id":"d1","frameId":"f1","operation":"propose","beliefId":"B1","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"B1","statement":"x","domain":"code","expectation":"","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["B1"]})");
        m.applyLine(R"({"type":"FrameOpened","taskId":"t-1","frameId":"f1","ordinal":1})");
        GraphTaskState s = projectGraphTask(m);
        int propose = 0;
        for (const GraphNode& n : s.nodes) if (n.family == NodeFamily::Propose) ++propose;
        check(propose == 1, "out-of-order belief create still yields one Propose node");
    }
    // Empty beliefId but the resultingBeliefs create a belief.
    {
        NativeGuiModel m;
        m.applyLine(R"({"type":"TaskOpened","taskId":"t-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        m.applyLine(R"({"type":"FrameOpened","taskId":"t-1","frameId":"f1","ordinal":1})");
        m.applyLine(R"({"type":"BeliefDeltaApplied","taskId":"t-1","frameId":"f1","delta":{"id":"d1","frameId":"f1","operation":"propose","beliefId":"","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"B1","statement":"x","domain":"code","expectation":"","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["B1"]})");
        GraphTaskState s = projectGraphTask(m);
        int propose = 0, createEdges = 0;
        for (const GraphNode& n : s.nodes) if (n.family == NodeFamily::Propose) ++propose;
        for (const GraphEdge& e : s.edges)
            if (e.type == EdgeSemanticType::ProposeToBelief && e.beliefOperation &&
                *e.beliefOperation == BeliefOperation::Create && e.target.valid()) ++createEdges;
        check(propose == 1, "empty-beliefId belief create still yields one Propose node");
        check(createEdges == 1, "empty-beliefId belief create links Propose->Belief (create)");
    }
    // Replay of the same delta id must not duplicate the Propose node.
    {
        NativeGuiModel m;
        m.applyLine(R"({"type":"TaskOpened","taskId":"t-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        m.applyLine(R"({"type":"FrameOpened","taskId":"t-1","frameId":"f1","ordinal":1})");
        const char* deltaLine = R"({"type":"BeliefDeltaApplied","taskId":"t-1","frameId":"f1","delta":{"id":"d1","frameId":"f1","operation":"propose","beliefId":"B1","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"B1","statement":"x","domain":"code","expectation":"","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["B1"]})";
        m.applyLine(deltaLine);
        m.applyLine(deltaLine);  // replay
        GraphTaskState s = projectGraphTask(m);
        int propose = 0;
        for (const GraphNode& n : s.nodes) if (n.family == NodeFamily::Propose) ++propose;
        check(propose == 1, "replayed belief-delta id yields a single Propose node");
    }
    // Repeated FrameOpened must not clobber a backfilled delta.
    {
        NativeGuiModel m;
        m.applyLine(R"({"type":"TaskOpened","taskId":"t-1","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        m.applyLine(R"({"type":"BeliefDeltaApplied","taskId":"t-1","frameId":"f1","delta":{"id":"d1","frameId":"f1","operation":"propose","beliefId":"B1","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"B1","statement":"x","domain":"code","expectation":"","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["B1"]})");
        m.applyLine(R"({"type":"FrameOpened","taskId":"t-1","frameId":"f1","ordinal":1})");
        m.applyLine(R"({"type":"FrameOpened","taskId":"t-1","frameId":"f1","ordinal":1})");  // duplicate
        GraphTaskState s = projectGraphTask(m);
        int propose = 0;
        for (const GraphNode& n : s.nodes) if (n.family == NodeFamily::Propose) ++propose;
        check(propose == 1, "repeated FrameOpened preserves the backfilled Propose node");
    }
}

int main() {
    NativeGuiModel model = buildModel();
    GraphTaskState state = projectGraphTask(model);

    // --- M1: node families ---
    int proposeNodes1 = 0, proposeNodes2 = 0, pendingProposeNodes = 0;
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
                if (n.frameId && *n.frameId == "frame-2::next") ++pendingProposeNodes;
                break;
        }
    }
    check(beliefCount == 3, "three global belief nodes");
    check(beliefsGlobal, "beliefs are global (no owning frame)");
    check(planCount == 2, "two plan nodes");
    check(execCount1 == 2, "two execution nodes for frame 1");
    check(distillCount == 2, "two distill nodes");
    // A distillation-produced propose belongs to the NEXT episode: frame-1's
    // distill outputs delta-1/delta-2, which now render in frame-2's lane;
    // frame-2's distill output delta-3 targets the pending successor row.
    check(proposeNodes1 == 0, "frame 1 owns no Propose node (its distill's proposes move to frame 2)");
    check(proposeNodes2 == 2, "frame 2 owns the prior frame's distill Propose nodes");
    check(pendingProposeNodes == 1, "frame 2's distill output targets the pending next frame");
    check(state.frames.size() == 3 && state.frames.back().id == "frame-2::next",
          "the pending next frame is exposed as a graph container");

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
    check(state.frames.size() == 3, "two materialized plus one pending frame container");

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

    testBeliefCreateIsPropose();
    testBeliefCreateMissingFrameAndLink();

    // A pending successor uses the same row as the real successor once it is
    // opened; the proposal changes only its frame id, not its node id.
    {
        NativeGuiModel m;
        m.applyLine(R"({"type":"TaskOpened","taskId":"t-2","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        m.applyLine(R"({"type":"FrameOpened","taskId":"t-2","frameId":"f1","ordinal":1})");
        m.applyLine(R"({"type":"BeliefDeltaApplied","taskId":"t-2","frameId":"f1","delta":{"id":"d1","frameId":"f1","operation":"propose","beliefId":"B1","evidenceBeliefIds":[],"resultingBeliefs":[{"id":"B1","statement":"x","domain":"code","expectation":"","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["B1"]})");

        // Before DistillationProduced supplies provenance, the proposal is
        // provisionally in f1 and receives an initial live-layout position.
        GraphLiveState live;
        GraphTaskState provisional = projectGraphTask(m);
        PieGraphLayout provisionalLayout = stabilizeLiveLayout(
            provisional, computeGraphLayout(provisional), live);
        const GraphNode* provisionalNode = nullptr;
        for (const GraphNode& n : provisional.nodes)
            if (n.family == NodeFamily::Propose) provisionalNode = &n;
        check(provisionalNode && provisionalNode->frameId && *provisionalNode->frameId == "f1",
              "proposal is provisional in the producing frame before distillation provenance");
        // The Belief its Propose produces is anchored to the producing frame too,
        // and holds a stable position in that row.
        const GraphNode* provisionalBelief = nullptr;
        for (const GraphNode& n : provisional.nodes)
            if (n.family == NodeFamily::Belief && n.id.value == "B1") provisionalBelief = &n;
        check(provisionalBelief && provisionalBelief->createdInFrame &&
                  *provisionalBelief->createdInFrame == "f1",
              "belief is provisionally anchored to the producing frame");

        m.applyLine(R"({"type":"DistillationProduced","taskId":"t-2","frameId":"f1","distillation":{"id":"D1","inputs":[],"contents":"c","outputs":["d1"]}})");
        GraphTaskState pending = projectGraphTask(m);
        PieGraphLayout pendingFresh = computeGraphLayout(pending);
        PieGraphLayout pendingStable = stabilizeLiveLayout(pending, pendingFresh, live);
        const GraphNode* before = nullptr;
        for (const GraphNode& n : pending.nodes) if (n.family == NodeFamily::Propose) before = &n;
        check(before && before->frameId && *before->frameId == "f1::next",
              "proposal initially targets the stable pending successor");
        check(pendingFresh.nodeRects.at("d1").y == pendingStable.nodeRects.at("d1").y &&
                  pendingStable.nodeRects.at("d1").y != provisionalLayout.nodeRects.at("d1").y,
              "live layout moves a reparented proposal into the pending successor");

        // The Belief its Propose produces must follow the same reparenting: its
        // display anchor re-aims at the pending successor, and the already-warmed
        // stableBeliefRects cache must not pin it to its old producing row.
        const GraphNode* pendingBelief = nullptr;
        for (const GraphNode& n : pending.nodes)
            if (n.family == NodeFamily::Belief && n.id.value == "B1") pendingBelief = &n;
        check(pendingBelief && pendingBelief->createdInFrame &&
                  *pendingBelief->createdInFrame == "f1::next",
              "belief re-anchors to the pending successor to match its Propose");
        check(pendingFresh.nodeRects.at("B1").y == pendingStable.nodeRects.at("B1").y &&
                  pendingStable.nodeRects.at("B1").y != provisionalLayout.nodeRects.at("B1").y,
              "live layout moves a reparented belief out of its old row (stableBeliefRects invalidated)");
        m.applyLine(R"({"type":"FrameOpened","taskId":"t-2","frameId":"f2","ordinal":2})");
        GraphTaskState materialized = projectGraphTask(m);
        const GraphNode* after = nullptr;
        for (const GraphNode& n : materialized.nodes) if (n.family == NodeFamily::Propose) after = &n;
        check(after && after->id.value == "d1" && after->frameId && *after->frameId == "f2",
              "proposal remaps to the real successor without changing its id");
        check(materialized.frames.size() == 2 && materialized.frames.back().id == "f2",
              "real successor replaces the pending container");
    }

    // --- Create is a sub-state of the write-back semantic, not a separate edge ---
    {
        check(edgeIsCreate(EdgeSemanticType::ProposeToBelief, BeliefOperation::Create),
              "create is a Propose->Belief write-back sub-state");
        check(edgeIsCreate(EdgeSemanticType::DistillToBelief, BeliefOperation::Create),
              "create is a Distill->Belief write-back sub-state");
        check(!edgeIsCreate(EdgeSemanticType::ProposeToBelief, BeliefOperation::Update),
              "non-create Propose write-back is not the create sub-state");
        check(!edgeIsCreate(EdgeSemanticType::ProposeToBelief, std::nullopt),
              "no operation is not a create write-back");
        check(!edgeIsCreate(EdgeSemanticType::DistillToPropose, BeliefOperation::Create),
              "non-write-back semantics are never create");
    }

    // --- M1: belief node title carries the authoritative status suffix ---
    {
        GraphNode b;
        b.id = NodeId{"B1"};
        b.title = "B1";
        b.family = NodeFamily::Belief;
        b.domain = "";
        b.displayType = "";
        check(beliefNodeTitle(b) == "Belief B1", "no status -> no suffix (Belief B1)");
        b.displayType = "belief";
        check(beliefNodeTitle(b) == "Belief B1", "'belief' placeholder -> no suffix");
        b.displayType = "proposed";
        check(beliefNodeTitle(b) == "Belief B1 (proposed)", "proposed suffix");
        b.displayType = "supported";
        check(beliefNodeTitle(b) == "Belief B1 (supported)", "supported suffix");
        b.displayType = "refuted";
        check(beliefNodeTitle(b) == "Belief B1 (refuted)", "refuted suffix");
        b.displayType = "superseded";
        check(beliefNodeTitle(b) == "Belief B1 (superseded)", "authoritative 'superseded' spelling");
        check(beliefNodeTitle(b) != "Belief B1 (superceded)", "misspelling 'superceded' is not emitted");
        b.domain = "framing";
        check(beliefNodeTitle(b) == "Target B1 (superseded)", "framing domain -> Target prefix");
        b.domain = "routing";
        check(beliefNodeTitle(b) == "Route B1 (superseded)", "routing domain -> Route prefix");
        b.title = "";
        check(beliefNodeTitle(b) == "Route B1 (superseded)", "empty title falls back to id");
    }

    if (failures == 0) std::printf("PASS\n");
    std::printf("graph test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
