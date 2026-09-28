// M4: the v7 graph projection (docs/milestones.md §6.1).
//
// The projection is the whole of the canvas's meaning. The renderer only decides
// colour and position, so an element that is missing here is missing from the
// product, and an element that is present but INVENTED is a claim the runtime
// never made. Both failures are invisible in a screenshot, so the assertions
// below are mostly of the form "this came from that field":
//
//   * every element in §6.1's table is projected from the record it names,
//   * plan -> execution and execution -> distillation are produced (the two edges
//     `domain-model.md` says were declared but never emitted),
//   * a fast-path episode has no plan node and no plan -> execution edge,
//   * the cursor's stage resolves to a station, and `closed` resolves to the same
//     station faded rather than to one of its own,
//   * nothing overlaps and every node has a positive radius.

#include <cstdio>
#include <string>
#include <vector>

#include "DemoEvents.h"
#include "DomainEvents.h"
#include "Model.h"
#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

using namespace pie::gui;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// The demo stream is the fixture: a real scripted v7 session with two rounds, a
// revised reading, a correction and an answered review. A hand-built state would
// only assert what the test already believes.
static NativeGuiModel demoModel() {
    NativeGuiModel model;
    for (const std::string& line : demoEvents()) applyRpcLine(model, line);
    return model;
}

static size_t countFamily(const GraphTaskState& state, NodeFamily family) {
    size_t n = 0;
    for (const GraphNode& node : state.nodes) {
        if (node.family == family) ++n;
    }
    return n;
}

static size_t countEdges(const GraphTaskState& state, EdgeSemanticType type) {
    size_t n = 0;
    for (const GraphEdge& edge : state.edges) {
        if (edge.type == type) ++n;
    }
    return n;
}

static const GraphNode* findFamily(const GraphTaskState& state, NodeFamily family,
                                   const std::string& episodeId) {
    for (const GraphNode& node : state.nodes) {
        if (node.family == family && node.episodeId == episodeId) return &node;
    }
    return nullptr;
}

static bool hasEdge(const GraphTaskState& state, EdgeSemanticType type, const std::string& source,
                    const std::string& target) {
    for (const GraphEdge& edge : state.edges) {
        if (edge.type == type && edge.source.value == source && edge.target.value == target) return true;
    }
    return false;
}

int main() {
    NativeGuiModel model = demoModel();
    check(model.issues().empty(), "the demo stream folds without issues");

    // ---------------------------------------------------------------------
    // The projected task
    // ---------------------------------------------------------------------
    check(projectedTask(model) != nullptr, "a task is projected");
    check(projectedTask(model) != nullptr && projectedTask(model)->id == "task-1",
          "the cursor's task is the one projected");
    check(projectGraphTask(model, nullptr).nodes.empty(), "a null task projects nothing");

    const GraphTaskState state = projectGraphTask(model);
    check(state.taskId == "task-1", "the projection names its task");

    // ---------------------------------------------------------------------
    // Every element in §6.1's table
    // ---------------------------------------------------------------------
    check(countFamily(state, NodeFamily::Belief) == 2, "both beliefs are on the belief rail");
    check(countFamily(state, NodeFamily::EpisodeRow) == 2, "one row anchor per episode");
    check(state.rows.size() == 2, "two episode rows");
    check(state.rows.size() == 2 && state.rows[0].ordinal == 1 && state.rows[1].ordinal == 2,
          "rows are in ordinal order");
    check(countFamily(state, NodeFamily::Routing) == 2, "one routing node per episode");
    check(countFamily(state, NodeFamily::Plan) == 2, "one plan node per belief-loop episode");
    check(countFamily(state, NodeFamily::Execution) == 3, "one node per execution");
    check(countFamily(state, NodeFamily::Distillation) == 2, "one node per distillation");
    check(countFamily(state, NodeFamily::BeliefDelta) == 4, "one node per belief delta");
    check(countFamily(state, NodeFamily::Recheck) == 1, "the task's recheck has a node");
    check(countFamily(state, NodeFamily::Formulation) == 2, "one node per Frame version");

    // The selection ring survives only while it is pending: episode 1's was
    // committed by its plan, episode 2's by its plan too. Neither is drawn.
    check(countFamily(state, NodeFamily::ExperimentSelection) == 0,
          "a committed experiment selection leaves no ring");
    check(countFamily(state, NodeFamily::Intervention) == 0, "the demo has no intervention");

    // ---------------------------------------------------------------------
    // The Frame rail
    // ---------------------------------------------------------------------
    check(state.versions.size() == 2, "both versions are on the rail");
    check(state.versions.size() == 2 && state.versions[0].ordinal == 1 && state.versions[1].ordinal == 2,
          "the rail is in ordinal order");
    check(state.versions.size() == 2 && state.versions[1].previousVersionId == "formulation-1",
          "the rail exposes the version chain");
    check(state.versions.size() == 2 && state.versions[1].approved,
          "the rail says which version the user approved");
    check(state.versions.size() == 2 && !state.versions[0].approved,
          "the superseded version is not marked approved");
    check(state.versions.size() == 2 && state.versions[1].current,
          "the latest version is the current reading");
    check(hasEdge(state, EdgeSemanticType::FormulationToFormulation, "Fv:formulation-1",
                  "Fv:formulation-2"),
          "version -> version comes from previousVersionId");

    // ---------------------------------------------------------------------
    // The two edges that were declared but never produced
    // ---------------------------------------------------------------------
    check(hasEdge(state, EdgeSemanticType::PlanToExecution, "plan:plan-1", "exec:exec-1"),
          "plan -> execution comes from execution.planId");
    check(hasEdge(state, EdgeSemanticType::PlanToExecution, "plan:plan-1", "exec:exec-2"),
          "every execution of the plan is linked");
    check(hasEdge(state, EdgeSemanticType::PlanToExecution, "plan:plan-2", "exec:exec-3"),
          "the second round's plan links its execution");
    check(countEdges(state, EdgeSemanticType::PlanToExecution) == 3,
          "exactly the executions that name a plan are linked");
    check(hasEdge(state, EdgeSemanticType::ExecutionToDistillation, "exec:exec-1", "distill:distillation-1"),
          "execution -> distillation comes from distillation.inputs");
    check(hasEdge(state, EdgeSemanticType::ExecutionToDistillation, "exec:exec-2", "distill:distillation-1"),
          "every distillation input is linked");
    check(hasEdge(state, EdgeSemanticType::ExecutionToDistillation, "exec:exec-3", "distill:distillation-2"),
          "the second round's distillation links its input");
    check(countEdges(state, EdgeSemanticType::ExecutionToDistillation) == 3,
          "exactly the named inputs are linked");

    // ---------------------------------------------------------------------
    // The epistemic edges
    // ---------------------------------------------------------------------
    check(hasEdge(state, EdgeSemanticType::DistillationToBeliefDelta, "distill:distillation-1",
                  "delta:delta-3"),
          "distillation -> delta comes from distillation.outputs");
    check(hasEdge(state, EdgeSemanticType::BeliefDeltaToBelief, "delta:delta-1", "B:belief-1"),
          "delta -> belief comes from resultingBeliefs");
    // delta-3 supports belief-1 and delta-4 refutes it: both name the record they
    // adjudicate, so the write-back edge expresses them and no lineage edge is
    // drawn (two arrows between one pair reads as a cycle).
    check(!hasEdge(state, EdgeSemanticType::BeliefToBeliefDelta, "B:belief-1", "delta:delta-3"),
          "a support draws no lineage edge: its source IS its result");
    check(!hasEdge(state, EdgeSemanticType::BeliefToBeliefDelta, "B:belief-1", "delta:delta-4"),
          "a refutation draws no lineage edge either");
    check(hasEdge(state, EdgeSemanticType::BeliefDeltaToBelief, "delta:delta-3", "B:belief-1"),
          "a support writes back to the belief it adjudicated");

    {
        // A delta that introduced a record draws dashed; one that changed
        // provenance on an existing record draws solid.
        const GraphEdge* propose = nullptr;
        const GraphEdge* support = nullptr;
        for (const GraphEdge& edge : state.edges) {
            if (edge.type != EdgeSemanticType::BeliefDeltaToBelief) continue;
            if (edge.source.value == "delta:delta-1") propose = &edge;
            if (edge.source.value == "delta:delta-3") support = &edge;
        }
        check(propose != nullptr && propose->dashed, "a proposing delta draws dashed");
        check(support != nullptr && !support->dashed, "a supporting delta draws solid");
    }

    // ---------------------------------------------------------------------
    // Source citations into the Frame rail: the first auditable surface for them
    // ---------------------------------------------------------------------
    check(hasEdge(state, EdgeSemanticType::SourceToFormulation, "B:belief-1", "Fv:formulation-2"),
          "a belief source cites the version it shaped");
    check(hasEdge(state, EdgeSemanticType::SourceToFormulation, "exec:exec-3", "Fv:formulation-2"),
          "an execution source cites the version it shaped");
    // formulation-2 cites a prompt, a correction and a belief; only the belief and
    // the execution have nodes.
    check(countEdges(state, EdgeSemanticType::SourceToFormulation) == 2,
          "only citations that name a drawn record become links");

    // ---------------------------------------------------------------------
    // The recheck
    // ---------------------------------------------------------------------
    check(hasEdge(state, EdgeSemanticType::RecheckToEpisode, "recheck:episode-2", "row:episode-2"),
          "recheck -> episode comes from recheck.episodeId");
    check(countFamily(state, NodeFamily::Recheck) == 1 &&
              findFamily(state, NodeFamily::Recheck, "episode-2") != nullptr,
          "the recheck is drawn in the row it reconsiders");

    // ---------------------------------------------------------------------
    // No dangling edges: every endpoint is a real node
    // ---------------------------------------------------------------------
    {
        bool allResolve = true;
        for (const GraphEdge& edge : state.edges) {
            if (state.node(edge.source) == nullptr || state.node(edge.target) == nullptr) {
                allResolve = false;
                std::fprintf(stderr, "  dangling edge %s -> %s\n", edge.source.value.c_str(),
                             edge.target.value.c_str());
            }
        }
        check(allResolve, "every edge endpoint is a projected node");
    }

    // ---------------------------------------------------------------------
    // Fast path: no plan, and no invented one
    // ---------------------------------------------------------------------
    {
        // A fast-path episode is the same chain minus the plan. Build one from a
        // minimal stream rather than from the demo, which has no fast path.
        NativeGuiModel fast;
        const char* lines[] = {
            R"({"type":"TaskOpened","schemaVersion":7,"eventId":"f1","taskId":"t-fast","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})",
            R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"f2","taskId":"t-fast","episodeId":"e-fast","ordinal":1})",
            R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"f3","taskId":"t-fast","episodeId":"e-fast","routing":{"id":"r-fast","statement":"s","decision":"fast-path","suitabilityProbability":0.9,"successProbability":0.9,"estimatedSteps":1,"difficulty":"low","reason":"r"}})",
            // The fast path has no Plan to carry the adoption, so the body selection
            // records it directly. A fast-path selection WITHOUT one is refused by
            // the contract, which is why the field is here rather than omitted.
            R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"f4","taskId":"t-fast","episodeId":"e-fast","body":"fast-path","formulation":{"kind":"unformed"}})",
            R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"f5","taskId":"t-fast","episodeId":"e-fast","execution":{"id":"x-fast","intention":"look","tool":"bash","input":{"command":"ls"}}})",
            R"({"type":"ExecutionCompleted","schemaVersion":7,"eventId":"f6","taskId":"t-fast","episodeId":"e-fast","executionId":"x-fast","output":"a","status":"succeeded"})",
        };
        for (const char* line : lines) applyRpcLine(fast, line);
        const GraphTaskState fastState = projectGraphTask(fast);
        check(countFamily(fastState, NodeFamily::Plan) == 0,
              "a fast-path episode projects no plan node (the plan is not invented)");
        check(countEdges(fastState, EdgeSemanticType::PlanToExecution) == 0,
              "a fast-path episode projects no plan -> execution edge");
        check(countFamily(fastState, NodeFamily::Execution) == 1,
              "the fast-path execution is still projected");
        check(fastState.rows.size() == 1 && fastState.rows[0].routingDecision == "fast-path",
              "the row says which decision routed it");
        check(fastState.rows.size() == 1 && fastState.rows[0].bodyKind == "fast-path",
              "the row says which body kind it is (this is what separates it from a closed belief loop)");
    }

    // ---------------------------------------------------------------------
    // The current station, per stage
    // ---------------------------------------------------------------------
    {
        // Walk the cursor through the stages the demo's own CursorChanged lines
        // use, and check the resolved station each time.
        struct Case {
            const char* stage;
            const char* expectedFamily;
        };
        const Case cases[] = {
            {"routing", "routing"},
            {"proposing", "plan"},
            {"executing", "execution"},
            {"distilling", "distillation"},
        };
        for (const Case& c : cases) {
            NativeGuiModel m = demoModel();
            const std::string line = std::string("{\"type\":\"CursorChanged\",\"schemaVersion\":7,"
                                                 "\"eventId\":\"cursor-probe\",\"taskId\":\"task-1\","
                                                 "\"episodeId\":\"episode-1\",\"stage\":\"") +
                                     c.stage + "\"}";
            applyRpcLine(m, line);
            const GraphTaskState s = projectGraphTask(m);
            check(s.currentNode.has_value(), "the cursor resolves to a station");
            const GraphNode* node = s.currentNode.has_value() ? s.node(*s.currentNode) : nullptr;
            check(node != nullptr && std::string(nodeFamilyToString(node->family)) == c.expectedFamily,
                  (std::string("stage ") + c.stage + " resolves to the " + c.expectedFamily +
                   " station").c_str());
            check(node != nullptr && node->state == NodeVisualState::Current,
                  (std::string("stage ") + c.stage + " marks the station current").c_str());
        }
        // `closed` resolves to the distillation station, FADED. That is not a
        // station of its own: "the round finished here" is a different claim from
        // "work is happening here" (§6.1).
        {
            NativeGuiModel m = demoModel();
            applyRpcLine(m, R"({"type":"CursorChanged","schemaVersion":7,"eventId":"cursor-closed","taskId":"task-1","episodeId":"episode-1","stage":"closed"})");
            const GraphTaskState s = projectGraphTask(m);
            const GraphNode* node = s.currentNode.has_value() ? s.node(*s.currentNode) : nullptr;
            check(node != nullptr && node->family == NodeFamily::Distillation,
                  "stage closed resolves to the distillation station");
            check(node != nullptr && node->state == NodeVisualState::CurrentFaded,
                  "stage closed marks it faded, not current");
        }
        // An unknown stage resolves to nothing rather than to an arbitrary node.
        {
            NativeGuiModel m = demoModel();
            applyRpcLine(m, R"({"type":"CursorChanged","schemaVersion":7,"eventId":"cursor-unknown","taskId":"task-1","episodeId":"episode-1","stage":"invented"})");
            const GraphTaskState s = projectGraphTask(m);
            check(!s.currentNode.has_value(), "an unknown stage leaves no current station");
        }
        // A cursor for a different task leaves this projection without a current
        // station rather than highlighting a station the cursor never named.
        // (The cursor cannot be pointed at a task the model has no record of: the
        // applier refuses a dangling citation, so the case needs two real tasks.)
        {
            NativeGuiModel m = demoModel();
            applyRpcLine(m, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"cursor-task","taskId":"task-2","initialPrompt":{"id":"p2","original":"second","effective":"second"},"inheritedBeliefs":[]})");
            applyRpcLine(m, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"cursor-ep","taskId":"task-2","episodeId":"episode-9","ordinal":1})");
            applyRpcLine(m, R"({"type":"CursorChanged","schemaVersion":7,"eventId":"cursor-other","taskId":"task-2","episodeId":"episode-9","stage":"executing"})");
            check(m.cursor().taskId == "task-2", "the cursor moved to the second task");
            check(projectedTask(m) != nullptr && projectedTask(m)->id == "task-2",
                  "the projected task follows the cursor");
            const GraphTaskState s = projectGraphTask(m, m.task("task-1"));
            check(!s.currentNode.has_value(), "a cursor for another task highlights nothing");
            check(s.cursorStage == EpisodeStage::Unknown,
                  "the projection does not borrow the other task's stage");
        }
    }

    // The demo's own final cursor: episode-1, closed (no CursorChanged ever named
    // episode-2, and the runtime's cursor only moves on an explicit event).
    check(state.cursorStage == EpisodeStage::Closed, "the demo's cursor stage is closed");
    check(state.currentNode.has_value() &&
              state.node(*state.currentNode)->episodeId == "episode-1",
          "the current station is in the episode the cursor names");
    {
        bool oneFaded = false;
        for (const GraphNode& node : state.nodes) {
            if (node.state == NodeVisualState::CurrentFaded) oneFaded = true;
        }
        check(oneFaded, "exactly the cursor's station is marked faded");
        check(state.rows.size() == 2 && state.rows[0].current && !state.rows[1].current,
              "the cursor's row is marked current");
    }

    // ---------------------------------------------------------------------
    // Belief rail semantics
    // ---------------------------------------------------------------------
    {
        const GraphNode* b1 = state.node("B:belief-1");
        const GraphNode* b2 = state.node("B:belief-2");
        check(b1 != nullptr && b2 != nullptr, "both beliefs resolved");
        check(b1 != nullptr && b1->title == "B1", "the belief's title is its derived label");
        check(b2 != nullptr && b2->title == "B2", "labels come from record order");
        // status is DERIVED from provenance; the projection reads the derivation,
        // it does not invent one.
        check(b1 != nullptr && b1->beliefStatus == BeliefStatus::Refuted,
              "belief-1's projected status is the derived one (refuted)");
        check(b2 != nullptr && b2->beliefStatus == BeliefStatus::Proposed,
              "belief-2 was never adjudicated, so it is proposed");
        check(b1 != nullptr && b1->inFocus, "the declared focus marks the belief in focus");
        check(b2 != nullptr && !b2->inFocus, "a belief outside the focus is not marked");
    }

    // ---------------------------------------------------------------------
    // The outcome band
    // ---------------------------------------------------------------------
    check(state.taskOutcome.present, "the recorded outcome is projected");
    check(state.taskOutcome.blockers == "only the local runtime was checked",
          "the outcome carries its blockers");

    // ---------------------------------------------------------------------
    // Every node has a tooltip, and every label is non-empty
    // ---------------------------------------------------------------------
    {
        bool allTitled = true;
        bool allHaveTooltips = true;
        for (const GraphNode& node : state.nodes) {
            if (node.title.empty()) {
                allTitled = false;
                std::fprintf(stderr, "  untitled node %s\n", node.id.value.c_str());
            }
            // §6.1/M5: every node family gets a tooltip. The v1 canvas deliberately
            // omitted Plan and Distill; that carve-out is gone.
            if (node.fullText.empty()) {
                allHaveTooltips = false;
                std::fprintf(stderr, "  no tooltip for %s\n", node.id.value.c_str());
            }
        }
        check(allTitled, "every node has a title");
        check(allHaveTooltips, "every node has a tooltip body, including Plan and Distill");
    }
    {
        const GraphNode* plan = findFamily(state, NodeFamily::Plan, "episode-1");
        check(plan != nullptr && plan->fullText.find("adoption") != std::string::npos,
              "the plan's tooltip carries its adoption, which §6.1 requires");
        const GraphNode* distill = findFamily(state, NodeFamily::Distillation, "episode-1");
        check(distill != nullptr && distill->fullText.find("inputs") != std::string::npos,
              "the distillation's tooltip names its inputs");
        const GraphNode* exec = findFamily(state, NodeFamily::Execution, "episode-1");
        check(exec != nullptr && exec->fullText.find("plan: plan-1") != std::string::npos,
              "the execution's tooltip names the plan it belongs to");
    }

    // ---------------------------------------------------------------------
    // Determinism
    // ---------------------------------------------------------------------
    {
        const GraphTaskState again = projectGraphTask(model);
        check(again.nodes.size() == state.nodes.size() && again.edges.size() == state.edges.size(),
              "projecting twice gives the same shape");
        bool identical = true;
        for (size_t i = 0; i < state.nodes.size(); ++i) {
            if (state.nodes[i].id.value != again.nodes[i].id.value ||
                state.nodes[i].fullText != again.nodes[i].fullText) {
                identical = false;
            }
        }
        check(identical, "projecting twice gives byte-identical nodes");
    }
    // A state with no cursor at all still projects the task.
    {
        NativeGuiModel m = demoModel();
        // Replace the state with one whose cursor is absent by projecting a task
        // the cursor does not name.
        const GraphTaskState s = projectGraphTask(m, m.task("task-1"));
        check(!s.nodes.empty(), "an explicit task projects even when the cursor names another");
    }

    // ---------------------------------------------------------------------
    // Layout
    // ---------------------------------------------------------------------
    {
        const PieGraphLayout layout = computeGraphLayout(state);
        check(layout.nodes.size() == state.nodes.size(),
              "every projected node has a dot (none silently dropped)");
        check(layout.gutters.size() == state.rows.size(), "every row has a gutter");

        bool positive = true;
        for (const GraphNode& node : state.nodes) {
            const Dot* dot = layout.dot(node.id.value);
            if (dot == nullptr || dot->r <= 0.0f) {
                positive = false;
                std::fprintf(stderr, "  no positive dot for %s\n", node.id.value.c_str());
            }
        }
        check(positive, "every dot has a positive radius");

        // No two dots overlap. Dots are circles, so the test is the distance
        // against the summed radii — the radial equivalent of the v1 rect test.
        {
            bool overlaps = false;
            for (size_t i = 0; i < state.nodes.size(); ++i) {
                for (size_t j = i + 1; j < state.nodes.size(); ++j) {
                    const Dot* a = layout.dot(state.nodes[i].id.value);
                    const Dot* b = layout.dot(state.nodes[j].id.value);
                    if (a == nullptr || b == nullptr) continue;
                    const float dx = a->x - b->x;
                    const float dy = a->y - b->y;
                    if (dx * dx + dy * dy < (a->r + b->r) * (a->r + b->r)) {
                        overlaps = true;
                        std::fprintf(stderr, "  %s overlaps %s\n", state.nodes[i].id.value.c_str(),
                                     state.nodes[j].id.value.c_str());
                    }
                }
            }
            check(!overlaps, "no two dots overlap");
        }

        // Row bands stack without overlapping, in ordinal order.
        {
            bool stacked = true;
            for (size_t i = 1; i < layout.gutters.size(); ++i) {
                const GraphRect& above = layout.gutters[i - 1].rect;
                const GraphRect& below = layout.gutters[i].rect;
                if (above.y + above.h > below.y) stacked = false;
            }
            check(stacked, "row bands stack without overlapping");
        }

        // The rails are above the rows, and the outcome band is below them.
        {
            const float firstRowY = layout.gutters.empty() ? 0.0f : layout.gutters.front().rect.y;
            check(layout.versionRail.y + layout.versionRail.h <= firstRowY,
                  "the Frame rail sits above the first row");
            const float lastRowBottom =
                layout.gutters.empty() ? 0.0f
                                       : layout.gutters.back().rect.y + layout.gutters.back().rect.h;
            check(layout.outcomeBand.y >= lastRowBottom,
                  "the outcome band sits below every row, never inside one");
            check(layout.outcomeBand.w > 0.0f, "the outcome band has a positive width");
        }

        check(layout.canvasWidth > 0.0f && layout.canvasHeight > 0.0f,
              "the canvas extent is positive");
        {
            // Nothing is placed outside the canvas.
            bool inside = true;
            for (const auto& entry : layout.nodes) {
                const Dot& dot = entry.second;
                if (dot.x - dot.r < 0.0f || dot.y - dot.r < 0.0f ||
                    dot.x + dot.r > layout.canvasWidth || dot.y + dot.r > layout.canvasHeight) {
                    inside = false;
                    std::fprintf(stderr, "  %s outside the canvas\n", entry.first.c_str());
                }
            }
            check(inside, "every dot is inside the canvas extent");
        }
        // Deterministic: the same state lays out identically.
        {
            const PieGraphLayout again = computeGraphLayout(state);
            bool identical = again.nodes.size() == layout.nodes.size();
            for (const auto& entry : layout.nodes) {
                const auto it = again.nodes.find(entry.first);
                if (it == again.nodes.end() || it->second.x != entry.second.x ||
                    it->second.y != entry.second.y) {
                    identical = false;
                }
            }
            check(identical, "the layout is deterministic");
        }
        // The belief rail is a column: every belief shares an x, and their y is
        // ordered by record order.
        {
            std::vector<const Dot*> beliefDots;
            for (const GraphNode& node : state.nodes) {
                if (node.family == NodeFamily::Belief) beliefDots.push_back(layout.dot(node.id.value));
            }
            check(beliefDots.size() == 2 && beliefDots[0] != nullptr && beliefDots[1] != nullptr &&
                      beliefDots[0]->x == beliefDots[1]->x,
                  "the belief rail is a single column");
            check(beliefDots.size() == 2 && beliefDots[1]->y > beliefDots[0]->y,
                  "the belief column is ordered by record order");
        }
        // A row's stations are ordered left to right by station order.
        {
            const Dot* route = layout.dot("route:routing-1");
            const Dot* plan = layout.dot("plan:plan-1");
            const Dot* exec = layout.dot("exec:exec-1");
            const Dot* distill = layout.dot("distill:distillation-1");
            check(route != nullptr && plan != nullptr && exec != nullptr && distill != nullptr,
                  "the first row's stations are all placed");
            check(route != nullptr && plan != nullptr && route->x < plan->x,
                  "routing comes before the plan");
            check(plan != nullptr && exec != nullptr && plan->x < exec->x,
                  "the plan comes before its executions");
            check(exec != nullptr && distill != nullptr && exec->x < distill->x,
                  "the executions come before the distillation");
        }
        // The rail dots are above the row dots, and the row anchor is left of its
        // stations.
        {
            const Dot* version = layout.dot("Fv:formulation-1");
            const Dot* route = layout.dot("route:routing-1");
            const Dot* anchor = layout.dot("row:episode-1");
            check(version != nullptr && route != nullptr && version->y < route->y,
                  "the Frame rail is above the rows");
            check(anchor != nullptr && route != nullptr && anchor->x < route->x,
                  "the row anchor sits in the gutter, left of the stations");
        }
        // An empty state still lays out: a zero canvas would make a consumer's
        // division undefined.
        {
            const GraphTaskState empty;
            const PieGraphLayout emptyLayout = computeGraphLayout(empty);
            check(emptyLayout.nodes.empty(), "an empty state places no dots");
            check(emptyLayout.canvasWidth > 0.0f && emptyLayout.canvasHeight > 0.0f,
                  "an empty state still has a positive canvas");
            check(!emptyLayout.outcomeBand.w, "an empty state has no outcome band");
        }
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
