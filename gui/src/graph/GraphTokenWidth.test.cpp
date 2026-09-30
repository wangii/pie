// Block width from token telemetry, verified with synthetic telemetry.
//
// The demo fixture carries no message_start/message_end, so the token-proportional
// width path can never be exercised by the demo-derived tests: it is always the
// fallback there. This test feeds WIRE lines through applyRpcLine to produce real
// turn telemetry, then asserts that (a) a stage's tokens aggregate by
// (episodeId, stage), (b) the block widens monotonically with tokens but stays
// within the fixed station slot, and (c) with no telemetry the block falls back to
// the base width.

#include <cstdio>
#include <string>
#include <vector>

#include "DemoEvents.h"
#include "DomainEvents.h"
#include "Model.h"
#include "graph/GraphModel.h"
#include "graph/GraphStyle.h"
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

static const char* kTaskOpened =
    R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","timestamp":"2026-01-01T00:00:00.000Z","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"Is pytest available?","effective":"Is pytest available?"},"inheritedBeliefs":[]})";
static const char* kEpisodeOpened =
    R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","timestamp":"2026-01-01T00:00:01.000Z","taskId":"task-1","episodeId":"episode-1","ordinal":1})";
static const char* kCursorRouting =
    R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e3","timestamp":"2026-01-01T00:00:01.100Z","taskId":"task-1","episodeId":"episode-1","stage":"routing"})";
static const char* kCursorProposing =
    R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e4","timestamp":"2026-01-01T00:00:02.000Z","taskId":"task-1","episodeId":"episode-1","stage":"proposing"})";
static const char* kBodySelected =
    R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e5","timestamp":"2026-01-01T00:00:02.100Z","taskId":"task-1","episodeId":"episode-1","body":"belief-loop","openBeliefsAtStart":[]})";
static const char* kPlanProduced =
    R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e6","timestamp":"2026-01-01T00:00:03.000Z","taskId":"task-1","episodeId":"episode-1","plan":{"id":"plan-1","selectedToExplore":[],"intent":"probe quietly","formulation":{"kind":"unformed"}}})";
static const char* kCursorExecuting =
    R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e7","timestamp":"2026-01-01T00:00:03.100Z","taskId":"task-1","episodeId":"episode-1","stage":"executing"})";
static const char* kExec1 =
    R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"e8","timestamp":"2026-01-01T00:00:03.200Z","taskId":"task-1","episodeId":"episode-1","execution":{"id":"exec-1","planId":"plan-1","intention":"a","tool":"bash","input":{"command":"true"}}})";
static const char* kExec2 =
    R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"e9","timestamp":"2026-01-01T00:00:03.300Z","taskId":"task-1","episodeId":"episode-1","execution":{"id":"exec-2","planId":"plan-1","intention":"b","tool":"bash","input":{"command":"true"}}})";

static void apply(NativeGuiModel& model, const std::string& line) { (void)applyRpcLine(model, line); }

// One assistant turn with an explicit input token count, start to end.
static std::vector<std::string> turn(long input, const std::string& startAt, const std::string& endAt) {
    const std::string usage = "{\"input\":" + std::to_string(input) +
                              ",\"output\":10,\"cacheRead\":0,\"cacheWrite\":0}";
    return {
        "{\"type\":\"message_start\",\"timestamp\":\"" + startAt +
            "\",\"message\":{\"role\":\"assistant\",\"model\":{\"id\":\"m\",\"provider\":\"p\"},\"usage\":" +
            usage + ",\"content\":[{\"type\":\"text\",\"text\":\"working\"}]}}",
        "{\"type\":\"message_end\",\"timestamp\":\"" + endAt +
            "\",\"message\":{\"role\":\"assistant\",\"model\":{\"id\":\"m\",\"provider\":\"p\"},\"usage\":" +
            usage + ",\"stopReason\":\"stop\"}}",
    };
}

// A model with one episode, a plan node, and the cursor in the proposing stage.
static NativeGuiModel opened() {
    NativeGuiModel model;
    apply(model, kTaskOpened);
    apply(model, kEpisodeOpened);
    apply(model, kCursorRouting);
    apply(model, kCursorProposing);
    apply(model, kBodySelected);
    apply(model, kPlanProduced);
    return model;
}

int main() {
    const float base = kGraphStyle.dotDiameter;

    // --- no telemetry: the fallback ---------------------------------------
    {
        NativeGuiModel model = opened();
        const GraphTaskState state = projectGraphTask(model);
        const GraphNode* plan = state.node("plan:plan-1");
        check(plan != nullptr, "the plan block is projected");
        check(plan != nullptr && plan->blockTokens < 0, "no telemetry leaves the block's token count unset");
        const PieGraphLayout layout = computeGraphLayout(state);
        const Dot* dot = layout.dot("plan:plan-1");
        check(dot != nullptr && std::fabs(dot->w - base) < 0.001f,
              "with no telemetry the block keeps the base width");
    }

    // --- synthetic telemetry: the block widens ----------------------------
    {
        NativeGuiModel model = opened();
        for (const std::string& line : turn(1000, "2026-01-01T00:00:04.000Z", "2026-01-01T00:00:05.000Z")) {
            apply(model, line);
        }
        check(model.issues().empty(), "the synthetic turn folds without issues");
        const GraphTaskState state = projectGraphTask(model);
        const GraphNode* plan = state.node("plan:plan-1");
        check(plan != nullptr && plan->blockTokens > 0, "the proposing turn's tokens land on the plan block");
        const PieGraphLayout layout = computeGraphLayout(state);
        const Dot* dot = layout.dot("plan:plan-1");
        check(dot != nullptr && dot->w > base, "a token-bearing block is wider than the base width");
        check(dot != nullptr && dot->w <= kGraphStyle.dotDiameter + kGraphStyle.columnGap,
              "the width stays within the fixed station slot");
    }

    // --- two turns in one stage aggregate ---------------------------------
    {
        NativeGuiModel model = opened();
        for (const std::string& line : turn(1000, "2026-01-01T00:00:04.000Z", "2026-01-01T00:00:05.000Z")) {
            apply(model, line);
        }
        for (const std::string& line : turn(3000, "2026-01-01T00:00:06.000Z", "2026-01-01T00:00:07.000Z")) {
            apply(model, line);
        }
        const GraphTaskState state = projectGraphTask(model);
        const GraphNode* plan = state.node("plan:plan-1");
        // Each turn totals input + output = input + 10.
        check(plan != nullptr && plan->blockTokens == 1000 + 10 + 3000 + 10,
              "two turns in one stage sum onto the same block");
    }

    // --- monotonic: more tokens is never narrower -------------------------
    {
        NativeGuiModel small = opened();
        for (const std::string& line : turn(500, "2026-01-01T00:00:04.000Z", "2026-01-01T00:00:05.000Z")) {
            apply(small, line);
        }
        NativeGuiModel big = opened();
        for (const std::string& line : turn(5000, "2026-01-01T00:00:04.000Z", "2026-01-01T00:00:05.000Z")) {
            apply(big, line);
        }
        const Dot* s = computeGraphLayout(projectGraphTask(small)).dot("plan:plan-1");
        const Dot* b = computeGraphLayout(projectGraphTask(big)).dot("plan:plan-1");
        check(s != nullptr && b != nullptr && b->w >= s->w, "more tokens never narrows the block");
    }

    // --- frame version placed at the boundary it formed at -----------------
    {
        NativeGuiModel model;
        for (const std::string& line : demoEvents()) apply(model, line);
        const GraphTaskState state = projectGraphTask(model);
        const PieGraphLayout layout = computeGraphLayout(state);
        const Dot* v1 = layout.dot("Fv:formulation-1");  // formed in episode 1, prompt-sourced
        const Dot* v2 = layout.dot("Fv:formulation-2");  // formed in episode 2, cites an execution
        check(v1 != nullptr && v2 != nullptr, "both frame versions are placed");
        check(v1 != nullptr && v2 != nullptr && v2->y > v1->y,
              "a version formed later in the episode order is placed below the earlier one");
    }

    // --- two executions in one episode: how is the stage total distributed? ---
    {
        NativeGuiModel model = opened();
        apply(model, kExec1);
        apply(model, kExec2);
        apply(model, kCursorExecuting);
        for (const std::string& line : turn(2000, "2026-01-01T00:00:04.000Z", "2026-01-01T00:00:05.000Z")) {
            apply(model, line);
        }
        const GraphTaskState state = projectGraphTask(model);
        const GraphNode* e1 = state.node("exec:exec-1");
        const GraphNode* e2 = state.node("exec:exec-2");
        check(e1 != nullptr && e2 != nullptr, "both executions are projected");
        const PieGraphLayout layout = computeGraphLayout(state);
        const Dot* d1 = layout.dot("exec:exec-1");
        const Dot* d2 = layout.dot("exec:exec-2");
        check(e1 != nullptr && e2 != nullptr && e1->blockTokens > 0 && e2->blockTokens > 0,
              "both execution blocks carry a token count");
        check(e1 != nullptr && e2 != nullptr && e1->blockTokens == e2->blockTokens,
              "each execution block is assigned the whole stage total (not split)");
        check(d1 != nullptr && d2 != nullptr && std::fabs(d1->w - d2->w) < 0.001f,
              "the two execution blocks are drawn the same width");
        std::printf("     exec-1 tokens=%ld exec-2 tokens=%ld stage turn total=%d\n",
                    e1 != nullptr ? e1->blockTokens : -1,
                    e2 != nullptr ? e2->blockTokens : -1, 2000 + 10);
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
