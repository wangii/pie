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

static void testExecSummary();
static void testProposeOps();

// Build a model with one complete epistemic transaction and a second partial
// frame, mirroring the demo event vocabulary used by Model.test.cpp.
static NativeGuiModel buildModel() {
    NativeGuiModel model;
    model.applyLine(R"({"type":"FrameOpened","id":128,"summary":"runtime pytest mismatch","opened_at":"t0"})");
    model.applyLine(R"({"type":"BeliefsSelected","frameId":128,"beliefs":[42,47]})");
    model.applyLine(R"({"type":"PlanProduced","frameId":128,"label":"P-128","question":"Is pytest actually available?","intent":"verify dependency against runtime"})");
    model.applyLine(R"({"type":"ExecutionStarted","frameId":128})");
    model.applyLine(R"({"type":"ToolCalled","frameId":128,"id":"E-88","tool":"read","command":"requirements.txt","status":"ok"})");
    model.applyLine(R"({"type":"ToolReturned","frameId":128,"id":"E-88","result":"pytest==8.0","warning":""})");
    model.applyLine(R"({"type":"ToolCalled","frameId":128,"id":"E-89","tool":"bash","command":"pip show pytest","status":"running"})");
    model.applyLine(R"({"type":"ToolReturned","frameId":128,"id":"E-89","result":"exit code 1","warning":"Package(s) not found: pytest","status":"failed"})");
    // A declare_belief call is a belief-surface tool, not an execution probe.
    model.applyLine(R"({"type":"ToolCalled","frameId":128,"id":"E-92","tool":"declare_belief","command":"{\"op\":\"propose\",\"statement\":\"x\"}","status":"ok"})");
    model.applyLine(R"({"type":"ToolReturned","frameId":128,"id":"E-92","result":"ok","warning":"","status":"ok"})");
    model.applyLine(R"({"type":"ExecutionCompleted","frameId":128})");
    model.applyLine(R"({"type":"DistillationStarted","frameId":128})");
    model.applyLine(R"({"type":"DistillationProduced","frameId":128,"label":"D-42","inputIds":["E-88","E-89"],"unexplained":"B42 predicts pytest but runtime lacks it","interpretation":"declared vs runtime differ"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":128,"op":"~","belief":"B42","detail":"confidence 0.62 -> 0.31","lhs":"project","relation":"uses","rhs":"pytest"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":128,"op":"+","belief":"B53","detail":"new","lhs":"runtime_environment","relation":"lacks","rhs":"pytest"})");
    model.applyLine(R"({"type":"CursorChanged","frameId":128,"stage":"EXECUTING","item":"E-89"})");
    model.applyLine(R"({"type":"BeliefUpdated","beliefId":42,"confidence":0.31,"status":"open","sourceFrame":128,"lhs":"project","relation":"uses","rhs":"pytest"})");
    model.applyLine(R"({"type":"BeliefUpdated","beliefId":53,"confidence":0.9,"status":"open","sourceFrame":128,"lhs":"runtime_environment","relation":"lacks","rhs":"pytest"})");

    // A second closed frame with a create-only proposal.
    model.applyLine(R"({"type":"FrameOpened","id":129,"summary":"second frame","opened_at":"t1"})");
    model.applyLine(R"({"type":"BeliefsSelected","frameId":129,"beliefs":[53]})");
    model.applyLine(R"({"type":"PlanProduced","frameId":129,"label":"P-129","question":"q","intent":"check env"})");
    model.applyLine(R"({"type":"ToolCalled","frameId":129,"id":"E-91","tool":"bash","command":"ls","status":"ok"})");
    model.applyLine(R"({"type":"ToolReturned","frameId":129,"id":"E-91","result":"a b c","warning":"","status":"ok"})");
    model.applyLine(R"({"type":"DistillationProduced","frameId":129,"label":"D-43","inputIds":["E-91"],"unexplained":"","interpretation":"ok"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":129,"op":"+","belief":"B77","detail":"new","lhs":"a","relation":"b","rhs":"c"})");
    model.applyLine(R"({"type":"FrameClosed","frameId":129})");
    return model;
}

int main() {
    NativeGuiModel model = buildModel();
    // Cursor is on the open frame 128 / E-89 (the current node).
    GraphTaskState state = projectGraphTask(model);

    // --- M1: no Proposal / Observation / ExecutionStep node ---
    // --- M1: ProposalCreated occurrences project as Propose nodes on the chain
    // Distill -> Propose -> Belief (never a synthetic wrapper). ---
    int proposeNodes128 = 0, proposeNodes129 = 0;
    for (const auto& n : state.nodes) {
        if (n.family != NodeFamily::Propose) continue;
        if (n.frameId && *n.frameId == 128) ++proposeNodes128;
        if (n.frameId && *n.frameId == 129) ++proposeNodes129;
    }
    check(proposeNodes128 == 2, "two Propose nodes for frame 128 (B42, B53)");
    check(proposeNodes129 == 0, "no Propose node for frame 129 (B77 dropped as dangling target)");

    // --- M1: Beliefs are global (no owning frame) ---
    bool beliefsGlobal = true;
    int beliefCount = 0;
    for (const auto& n : state.nodes) {
        if (n.family == NodeFamily::Belief) {
            ++beliefCount;
            if (n.frameId.has_value()) beliefsGlobal = false;
        }
    }
    check(beliefsGlobal, "beliefs are global (no owning frame)");
    check(beliefCount == 2, "two global belief nodes (B42, B53)");

    // --- M1: tool call + result merged into one Execution node each ---
    int execNodes128 = 0;
    for (const auto& n : state.nodes) {
        if (n.family == NodeFamily::Execution && n.frameId && *n.frameId == 128) ++execNodes128;
    }
    check(execNodes128 == 2, "two Execution nodes for frame 128 (no per-step wrapper)");

    // --- declare_belief is a belief-surface tool, not an execution probe: it must
    // not be projected as an Execution node nor become a Plan->Execution target. ---
    bool declareExecMissing = true;
    bool declareEdgeMissing = true;
    for (const auto& n : state.nodes) {
        if (n.family == NodeFamily::Execution &&
            (n.id.value == "E-92" || n.title.find("declare_belief") != std::string::npos))
            declareExecMissing = false;
    }
    for (const auto& e : state.edges) {
        if (e.type == EdgeSemanticType::PlanToExecution && e.target.value == "E-92")
            declareEdgeMissing = false;
    }
    check(declareExecMissing, "declare_belief is not projected as an Execution node");
    check(declareEdgeMissing, "declare_belief produces no Plan->Execution edge");

    // --- M1: Execution node title is a simplified "<tool> <command>" summary
    // (no "exec:" prefix) so it reads as one concise line on the graph. ---
    bool execTitleSimplified = true;
    for (const auto& n : state.nodes) {
        if (n.family != NodeFamily::Execution) continue;
        if (n.title.rfind("exec: ", 0) == 0) execTitleSimplified = false;
        if (n.title.empty()) execTitleSimplified = false;
        if (n.title.rfind("read ", 0) != 0 && n.title.rfind("bash ", 0) != 0 &&
            n.title.rfind("write ", 0) != 0 && n.title.rfind("edit ", 0) != 0)
            execTitleSimplified = false;
    }
    check(execTitleSimplified, "every Execution node title is a simplified '<tool> <command>' summary");

    // --- M1: typed, directed edges ---
    bool allEdgesTyped = !state.edges.empty();
    for (const auto& e : state.edges) {
        const bool known = e.type == EdgeSemanticType::BeliefToPlan ||
                           e.type == EdgeSemanticType::PlanToExecution ||
                           e.type == EdgeSemanticType::ExecutionToDistill ||
                           e.type == EdgeSemanticType::DistillToBelief ||
                           e.type == EdgeSemanticType::DistillToPropose ||
                           e.type == EdgeSemanticType::ProposeToBelief;
        if (!known) allEdgesTyped = false;
        if (!e.source.valid() || !e.target.valid()) allEdgesTyped = false;
    }
    check(allEdgesTyped, "all edges are typed and have valid source/target");

    // --- M1: Distill -> Belief edges encode create/update operations ---
    int updEdges = 0, newEdges = 0;
    for (const auto& e : state.edges) {
        if (e.type == EdgeSemanticType::ProposeToBelief) {
            if (e.beliefOperation && *e.beliefOperation == BeliefOperation::Update) ++updEdges;
            if (e.beliefOperation && *e.beliefOperation == BeliefOperation::Create) ++newEdges;
        }
    }
    check(updEdges == 1, "one Propose->Belief update edge (B42)");
    check(newEdges == 1, "one Propose->Belief create edge (B53); B77 dropped as dangling target");

    // --- M1: frames present. Frame 128 was the active frame when its EXECUTING
    // cursor was set, but frame 129 opens afterward and re-bases the cursor to
    // 129 (openFrame sets cursor_.frameId = 129 / PLANNING). So frame 128 is NOT
    // the executing frame in the final state.
    check(state.frames.size() == 2, "two frame containers");
    bool frame128Executing = false;
    bool frame129Executing = false;
    for (const auto& fi : state.frames) {
        if (fi.id == 128) frame128Executing = fi.executing;
        if (fi.id == 129) frame129Executing = fi.executing;
    }
    check(!frame128Executing, "frame 128 not executing after frame 129 opened");
    (void)frame129Executing;

    // --- M1: current node follows the runtime cursor. After frame 129 closed,
    // the cursor is reset (frameId = -1) so there is no current node.
    check(!state.currentNode.has_value(), "no current node after frame 129 closed (cursor invalid)");

    // --- M1: current node follows the runtime cursor while a frame is active ---
    // A separate model with a live EXECUTING cursor on frame 128 has the current
    // node E-89.
    NativeGuiModel live;
    live.applyLine(R"({"type":"FrameOpened","id":128,"summary":"s","opened_at":"t0"})");
    live.applyLine(R"({"type":"CursorChanged","frameId":128,"stage":"EXECUTING","item":"E-89"})");
    GraphTaskState liveState = projectGraphTask(live);
    check(liveState.currentNode.has_value() && liveState.currentNode->value == "E-89", "live current node is E-89");

    // --- M3: layout determinism + feedback-loop region placement ---
    PieGraphLayout layout = computeGraphLayout(state);
    // Recompute and compare (determinism).
    PieGraphLayout layout2 = computeGraphLayout(state);
    bool deterministic = true;
    if (layout.nodeRects.size() != layout2.nodeRects.size()) deterministic = false;
    for (const auto& [k, r] : layout.nodeRects) {
        auto it = layout2.nodeRects.find(k);
        if (it == layout2.nodeRects.end() ||
            it->second.x != r.x || it->second.y != r.y ||
            it->second.w != r.w || it->second.h != r.h) deterministic = false;
    }
    check(deterministic, "layout is deterministic");

    // Semantic columns: Belief | Plan/Distillation | Execution.
    auto findRect = [&](const std::string& id) -> const pie::gui::GraphRect* {
        auto it = layout.nodeRects.find(id);
        return it == layout.nodeRects.end() ? nullptr : &it->second;
    };
    const auto* b42 = findRect("B42");
    const auto* p128 = findRect("P-128");
    const auto* e88 = findRect("E-88");
    const auto* e89 = findRect("E-89");
    const auto* d42 = findRect("D-42");
    check(b42 && p128 && e89 && d42, "core nodes (B42, P-128, E-89, D-42) all placed");
    const auto* pr10 = findRect("PR-128-0");
    const auto* pr11 = findRect("PR-128-1");
    check(pr10 && pr11, "Propose nodes (PR-128-0, PR-128-1) are placed");
    check(pr10 && d42 && pr10->y < d42->y, "Propose sits above the distillation in the middle region");
    check(b42 && p128 && b42->x + b42->w < p128->x,
          "Belief column is left of Plan");
    check(p128 && e88 && p128->x + p128->w < e88->x,
          "Plan region is left of Execution");
    check(d42 && e89 && d42->x + d42->w < e89->x,
          "Distillation region is left of Execution");
    check(p128 && d42 && p128->y < d42->y,
          "Plan is in the upper band and Distillation in the lower band");
    check(e88 && e89 && e88->y < e89->y,
          "Execution nodes are vertical in execution order");
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

    // LoopFrames are complete rows stacked top-to-bottom.
    auto f128 = layout.frameRects.find(128);
    auto f129 = layout.frameRects.find(129);
    check(f128 != layout.frameRects.end() && f128->second.w > 0, "frame 128 has a container");
    check(f128 != layout.frameRects.end() && f129 != layout.frameRects.end() &&
          f129->second.y >= f128->second.y + f128->second.h,
          "LoopFrame rows are stacked without overlap");
    check(layout.planRegionRects.count(128) && layout.distillRegionRects.count(128) &&
          layout.executionRegionRects.count(128),
          "frame 128 exposes Plan, Distillation, and Execution regions");

    // The round-anchored belief B53 (created in frame 128) must be placed in the
    // left belief column, anchored at/after its create round's row top, and sit
    // below the pre-existing belief B42.
    const auto* b53 = findRect("B53");
    check(b53, "round-anchored belief (B53) is placed");
    check(b53 && b42 && b53->x < b42->x + b42->w, "round belief is in the left belief column");
    check(b53 && b42 && b53->y >= b42->y + b42->h + 0.0f, "round belief sits below the pre-existing belief column");
    check(layout.beliefRegionRects.count(128),
          "frame 128 exposes its newly-created belief group");

    // Belief region nodes are in creation order along columns increasing.
    check(layout.canvasWidth > 0 && layout.canvasHeight > 0, "canvas size is positive");

    // Propose op semantics + dangling-target drop.
    testProposeOps();

    // execSummary dedup + fallback behavior (read / bash grep / grep-dup / unknown).
    testExecSummary();

    if (failures == 0) std::printf("PASS: %d checks\n", 0);
    std::printf("graph test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}

// --- M1: execSummary dedup + fallback behavior ---
// The exec node label is a simplified "<tool> <command>" summary: the tool verb
// is not duplicated when the command already begins with it (tool="grep"
// command="grep pytest ." -> "grep pytest ."), and an empty command falls back to
// the bare tool name. Unknown tools keep the "<tool> <command>" form.
static void testExecSummary() {
    NativeGuiModel model;
    model.applyLine(R"({"type":"FrameOpened","id":300,"summary":"s","opened_at":"t0"})");
    model.applyLine(R"({"type":"ToolCalled","frameId":300,"id":"E-1","tool":"read","command":"config.yaml","status":"ok"})");
    model.applyLine(R"({"type":"ToolCalled","frameId":300,"id":"E-2","tool":"bash","command":"grep foo .","status":"ok"})");
    model.applyLine(R"({"type":"ToolCalled","frameId":300,"id":"E-3","tool":"grep","command":"grep pytest .","status":"ok"})");
    model.applyLine(R"({"type":"ToolCalled","frameId":300,"id":"E-4","tool":"aws","command":"s3 ls","status":"ok"})");
    model.applyLine(R"({"type":"ToolCalled","frameId":300,"id":"E-5","tool":"grep","command":"","status":"ok"})");

    GraphTaskState st = projectGraphTask(model);
    auto title = [&](const std::string& id) -> const std::string* {
        for (const auto& n : st.nodes) {
            if (n.family == NodeFamily::Execution && n.id.value == id) return &n.title;
        }
        return nullptr;
    };
    auto expect = [&](const char* id, const char* want) {
        const std::string* got = title(id);
        check(got && *got == want, (std::string("execSummary: ") + id + " -> " + want).c_str());
    };
    expect("E-1", "read config.yaml");
    expect("E-2", "bash grep foo .");
    expect("E-3", "grep pytest .");
    expect("E-4", "aws s3 ls");
    expect("E-5", "grep");
}

// --- M1: Propose op semantics + dangling-target drop ---
// A ProposalCreated op maps to a Create/Update/Remove/Unresolved Propose->Belief
// edge (not degraded to Update), and a proposal whose target belief is not in the
// projected belief set is dropped instead of leaving a dangling edge.
static void testProposeOps() {
    NativeGuiModel model;
    model.applyLine(R"({"type":"FrameOpened","id":700,"summary":"s","opened_at":"t0"})");
    // The demo applyLine path registers beliefs via BeliefUpdated (upsertBelief);
    // BeliefCreated is ignored there.
    model.applyLine(R"({"type":"BeliefUpdated","beliefId":1,"lhs":"a","relation":"b","rhs":"c","status":"proposed"})");
    model.applyLine(R"({"type":"BeliefUpdated","beliefId":2,"lhs":"a","relation":"b","rhs":"c","status":"proposed"})");
    model.applyLine(R"({"type":"BeliefUpdated","beliefId":3,"lhs":"a","relation":"b","rhs":"c","status":"proposed"})");
    model.applyLine(R"({"type":"DistillationProduced","frameId":700,"label":"D-700","interpretation":"i"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":700,"op":"+","belief":"B1","detail":"create"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":700,"op":"~","belief":"B2","detail":"update"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":700,"op":"-","belief":"B3","detail":"remove"})");
    model.applyLine(R"({"type":"ProposalCreated","frameId":700,"op":"?","belief":"B2","detail":"unresolved"})");
    // No BeliefCreated for 99: this proposal must be dropped (no dangling edge).
    model.applyLine(R"({"type":"ProposalCreated","frameId":700,"op":"+","belief":"B99","detail":"dangling"})");

    GraphTaskState st = projectGraphTask(model);
    int create = 0, update = 0, remove = 0, unres = 0;
    for (const auto& e : st.edges) {
        if (e.type != EdgeSemanticType::ProposeToBelief) continue;
        if (e.beliefOperation && *e.beliefOperation == BeliefOperation::Create) ++create;
        if (e.beliefOperation && *e.beliefOperation == BeliefOperation::Update) ++update;
        if (e.beliefOperation && *e.beliefOperation == BeliefOperation::Remove) ++remove;
        if (e.beliefOperation && *e.beliefOperation == BeliefOperation::Unresolved) ++unres;
    }
    check(create == 1 && update == 1, "propose ops: one Create (B1) and one Update (B2) edge");
    check(remove == 1, "propose ops: '-' maps to a Remove edge (B3)");
    check(unres == 1, "propose ops: '?' maps to an Unresolved edge (B2)");

    bool b99Dropped = true;
    for (const auto& n : st.nodes) {
        if (n.family == NodeFamily::Propose && n.title.find("B99") != std::string::npos) b99Dropped = false;
    }
    for (const auto& e : st.edges) {
        if (e.target.value == "B99") b99Dropped = false;
    }
    check(b99Dropped, "propose ops: dangling B99 proposal is dropped");
}
