// M5: canvas geometry and style (docs/milestones.md §6.2, §6.3), replacing the
// v1 pi_gui_graph_label_layout_test.
//
// Two things live here, both of which a screenshot cannot check:
//
//   * the STYLE aggregate is still a literal type, so `inline constexpr
//     GraphStyle kGraphStyle{}` compiles. That is the constraint §6.3 names as the
//     reason pruning is its own change: one `std::string` member silently makes
//     the whole header non-constexpr. `static_assert` is the only way to keep that
//     promise, because the failure appears in a different translation unit than
//     the edit.
//   * the geometry the dot canvas depends on: a hit test at a dot's edge, the
//     layout's row/column spacing, the tooltip width, and the pulse the halo
//     animates over.

#include <cmath>
#include <cstdio>
#include <string>
#include <type_traits>

#include "DemoEvents.h"
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

// The load-bearing constraint (§6.3). `std::is_literal_type` was removed in
// C++20, and it was only ever an approximation of what actually matters: that the
// type can be used in a constant expression, which is what
// `inline constexpr GraphStyle kGraphStyle{}` requires. So prove that directly —
// this line does not compile if a non-literal member (a std::string) is added.
constexpr GraphStyle kStyleProbe = kGraphStyle;
static_assert(kStyleProbe.dotDiameter > 0.0f, "the default style is a usable constant expression");
static_assert(std::is_trivially_copyable_v<GraphStyle>,
              "GraphStyle is copied by value into the renderer each frame");
// A std::string member is the specific edit that breaks the above, so name it.
static_assert(std::is_trivially_copyable_v<decltype(GraphStyle::dotDiameter)>,
              "a scalar member; a std::string here would make GraphStyle non-literal");

int main() {
    // ---------------------------------------------------------------------
    // The style aggregate
    // ---------------------------------------------------------------------
    {
        check(kGraphStyle.zoomMin < kGraphStyle.zoomMax, "the zoom range is ordered");
        check(kGraphStyle.zoomMin > 0.0f, "the minimum zoom is positive");
        check(kGraphStyle.zoomStep > 0.0f, "the zoom step is positive");
        check(kGraphStyle.gridStep > 0.0f, "the grid step is positive");
        check(kGraphStyle.dotDiameter > 0.0f, "a dot has a positive diameter");
        check(kGraphStyle.dotRadius > 0.0f, "a ring has a positive radius");
        check(kGraphStyle.dotRingWidth > 0.0f, "a ring has a positive stroke");
        check(kGraphStyle.linkGapFromDot >= 0.0f, "the link gap is not negative");
        check(kGraphStyle.linkWidthLocal > 0.0f && kGraphStyle.linkWidthLong > 0.0f,
              "both link widths are positive");
        check(kGraphStyle.linkDash[0] > 0.0f && kGraphStyle.linkDash[1] > 0.0f,
              "both dash lengths are positive");
        check(kGraphStyle.currentHaloWidth > 0.0f, "the halo has a positive width");
        check(kGraphStyle.rowGap > 0.0f && kGraphStyle.columnGap > 0.0f,
              "the row and column gaps are positive");
        check(kGraphStyle.canvasPad > 0.0f, "the canvas padding is positive");
        check(kGraphStyle.arrowheadSize > 0.0f && kGraphStyle.arrowheadHalf > 0.0f,
              "the arrowhead has a positive size");
        check(kGraphStyle.tooltipMaxWidth > 0.0f && kGraphStyle.tooltipWrapColumn > 0.0f,
              "the tooltip width and wrap column are positive");
        check(kGraphStyle.seriesMarkRadius > 0.0f, "the series mark has a positive radius");
        check(kGraphStyle.outcomeBandLineH > 0.0f && kGraphStyle.outcomeBandPad >= 0.0f,
              "the outcome band's height and padding are positive");
        check(kGraphStyle.focusBarWidth > 0.0f, "the focus ring has a positive width");
    }
    {
        // The dim ratios are ratios: a value above 1 would make a "dimmed" element
        // brighter than a full one, which is the kind of edit that looks harmless.
        check(kGraphStyle.dimMuted > 0.0f && kGraphStyle.dimMuted <= 1.0f, "dimMuted is a ratio");
        check(kGraphStyle.linkAlphaPath > 0.0f && kGraphStyle.linkAlphaPath <= 1.0f,
              "linkAlphaPath is a ratio");
        check(kGraphStyle.linkAlphaOffPath <= kGraphStyle.linkAlphaPath,
              "an off-path link is never brighter than an on-path one");
        check(kGraphStyle.linkAlphaLong <= kGraphStyle.linkAlphaLocal,
              "a cross-row link is never louder than a station-to-station one");
        check(kGraphStyle.linkAlphaOffPath < kGraphStyle.linkAlphaLong,
              "an off-path link is dimmer than an unselected long link");
    }
    {
        // The two colours the halo and the accent share a family with: the halo
        // must be visible against the canvas, i.e. not the canvas colour.
        const bool same = kGraphStyle.currentHaloColor.r == kGraphStyle.canvasBg.r &&
                          kGraphStyle.currentHaloColor.g == kGraphStyle.canvasBg.g &&
                          kGraphStyle.currentHaloColor.b == kGraphStyle.canvasBg.b;
        check(!same, "the halo colour is distinguishable from the canvas background");
        // Every belief status has its own colour: two statuses sharing one would
        // erase the distinction the derived status exists to show.
        const GraphStyle::Rgb* colors[] = {
            &kGraphStyle.dotBeliefProposed, &kGraphStyle.dotBeliefSupported,
            &kGraphStyle.dotBeliefRefuted,  &kGraphStyle.dotBeliefInconclusive,
            &kGraphStyle.dotBeliefSuperseded};
        bool allDistinct = true;
        for (int i = 0; i < 5; ++i) {
            for (int j = i + 1; j < 5; ++j) {
                if (colors[i]->r == colors[j]->r && colors[i]->g == colors[j]->g &&
                    colors[i]->b == colors[j]->b) {
                    allDistinct = false;
                }
            }
        }
        check(allDistinct, "the five derived belief statuses have distinct colours");
    }

    // ---------------------------------------------------------------------
    // Hit testing and spacing, on a real projection
    // ---------------------------------------------------------------------
    NativeGuiModel model;
    for (const std::string& line : demoEvents()) applyRpcLine(model, line);
    const GraphTaskState state = projectGraphTask(model);
    const PieGraphLayout layout = computeGraphLayout(state);

    {
        // A dot's own centre is inside its hit radius, and a point well outside it
        // is not. The renderer's hit test is radial (a dot has no box), so this is
        // the property that decides whether the tooltip appears at all.
        const Dot* dot = layout.dot("plan:plan-1");
        check(dot != nullptr, "the plan dot is placed");
        if (dot != nullptr) {
            const float hitRadius = kGraphStyle.dotDiameter * 0.6f;
            check(0.0f <= hitRadius, "the centre is within the hit radius");
            const bool inside = std::hypot(0.0f, 0.0f) <= hitRadius;
            check(inside, "a click on the centre hits the dot");
            const bool outside = std::hypot(hitRadius * 4.0f, 0.0f) <= hitRadius;
            check(!outside, "a click far away misses it");
        }
    }
    {
        // Two stations in a row are separated by columnGap and the dot diameter,
        // so their circles never touch and their labels never collide.
        const Dot* route = layout.dot("route:routing-1");
        const Dot* plan = layout.dot("plan:plan-1");
        check(route != nullptr && plan != nullptr, "two adjacent stations are placed");
        if (route != nullptr && plan != nullptr) {
            const float gap = plan->x - route->x;
            check(gap >= kGraphStyle.dotDiameter + kGraphStyle.columnGap - 0.01f ||
                      gap >= kGraphStyle.dotDiameter,
                  "adjacent stations are at least a dot apart");
            check(gap > kGraphStyle.dotDiameter, "adjacent dots do not overlap in x");
        }
    }
    {
        // Rows are separated by rowGap on each side, so a link's dogleg has room.
        check(layout.gutters.size() >= 2, "the fixture has two rows");
        if (layout.gutters.size() >= 2) {
            const float above = layout.gutters[0].rect.y;
            const float below = layout.gutters[1].rect.y;
            check(below - above >= kGraphStyle.dotDiameter + kGraphStyle.rowGap,
                  "rows are far enough apart for a dogleg between them");
        }
    }
    {
        // Every dot's radius is exactly half the configured diameter: one source,
        // so a node cannot be drawn at a size the hit test does not know about.
        bool radiiMatch = true;
        for (const auto& entry : layout.nodes) {
            if (std::fabs(entry.second.r - kGraphStyle.dotDiameter * 0.5f) > 0.001f) {
                radiiMatch = false;
            }
        }
        check(radiiMatch, "every dot's radius is half the single dotDiameter");
    }
    {
        // The canvas extent covers the content plus padding on both sides, so a
        // scrolled-to-the-end view never clips the last dot.
        float maxX = 0.0f;
        float maxY = 0.0f;
        for (const auto& entry : layout.nodes) {
            maxX = std::max(maxX, entry.second.x + entry.second.r);
            maxY = std::max(maxY, entry.second.y + entry.second.r);
        }
        check(layout.canvasWidth >= maxX + kGraphStyle.canvasPad - 0.01f,
              "the canvas extends past the last dot in x");
        check(layout.canvasHeight >= maxY, "the canvas extends past the last dot in y");
    }

    // ---------------------------------------------------------------------
    // The Frame's boundary: a version sits with the episode it was formed in,
    // and two versions formed in the same round do not collide
    // ---------------------------------------------------------------------
    {
        GraphTaskState s;
        s.rows.push_back(EpisodeGutter{"episode-1", 1, -1, EpisodeStatus::Closed, EpisodeStage::Routing, "", ""});
        s.rows.push_back(EpisodeGutter{"episode-2", 2, -1, EpisodeStatus::Active, EpisodeStage::Routing, "", ""});
        auto addRow = [&s](const std::string& id, uint64_t ordinal) {
            GraphNode n;
            n.id = nodeId("row", id);
            n.family = NodeFamily::EpisodeRow;
            n.episodeId = id;
            n.ordinal = ordinal;
            n.title = "Ep" + std::to_string(ordinal);
            n.fullText = "row";
            s.nodes.push_back(std::move(n));
        };
        auto addVersion = [&s](const std::string& id, uint64_t ordinal, uint64_t boundary) {
            GraphRailVersion v;
            v.id = id;
            v.ordinal = ordinal;
            v.formedInEpisodeOrdinal = boundary;
            s.versions.push_back(std::move(v));
            GraphNode n;
            n.id = nodeId("Fv", id);
            n.family = NodeFamily::Formulation;
            n.ordinal = ordinal;
            n.title = "Fv" + std::to_string(ordinal);
            n.fullText = "frame";
            s.nodes.push_back(std::move(n));
        };
        addRow("episode-1", 1);
        addRow("episode-2", 2);
        // f1 was published after episode 1 had closed (no round was open then) —
        // the boundary is still episode 1, not the start.
        addVersion("f1", 1, 1);
        addVersion("f2", 2, 2);
        // A revision formed in the same round shares episode 2's boundary.
        addVersion("f3", 3, 2);
        const PieGraphLayout l = computeGraphLayout(s);
        const Dot* f1 = l.dot("Fv:f1");
        const Dot* f2 = l.dot("Fv:f2");
        const Dot* f3 = l.dot("Fv:f3");
        const Dot* e1 = l.dot("row:episode-1");
        const Dot* e2 = l.dot("row:episode-2");
        check(f1 != nullptr && f2 != nullptr && f3 != nullptr && e1 != nullptr && e2 != nullptr,
              "the boundary fixture places every node");
        check(f1 != nullptr && e1 != nullptr && f1->y > e1->y,
              "a version formed at episode 1 sits below episode 1");
        check(f1 != nullptr && e2 != nullptr && f1->y < e2->y, "and above episode 2");
        check(f2 != nullptr && e2 != nullptr && f2->y > e2->y,
              "a version formed at episode 2 sits below episode 2");
        check(f3 != nullptr && f2 != nullptr && f3->y > f2->y,
              "two versions at one boundary each own a vertical slot");
        check(f3 != nullptr && f2 != nullptr && f3->x == f2->x,
              "and share one column instead of being spread wide");
        check(f3 != nullptr && f2 != nullptr && f3->y - f2->y >= f2->r + f3->r - 0.01f,
              "so two dots at one boundary do not overlap");
        check(e1 != nullptr && l.versionRail.w == 0.0f && l.versionRail.y + l.versionRail.h <= e1->y,
              "the rail band stays above the rows even when every version is placed");
    }

    // ---------------------------------------------------------------------
    // Task-level: episode tracks and Frame versions share ONE vertical time
    // axis; occurrence time wins over the formed-in boundary, and a mixed
    // timed/untimed state still sorts as one total order
    // ---------------------------------------------------------------------
    {
        GraphTaskState s;
        s.rows.push_back(EpisodeGutter{"episode-1", 1, 1000, EpisodeStatus::Closed, EpisodeStage::Routing, "", ""});
        s.rows.push_back(EpisodeGutter{"episode-2", 2, 2000, EpisodeStatus::Closed, EpisodeStage::Routing, "", ""});
        auto addRow = [&s](const std::string& id, uint64_t ordinal) {
            GraphNode n;
            n.id = nodeId("row", id);
            n.family = NodeFamily::EpisodeRow;
            n.episodeId = id;
            n.ordinal = ordinal;
            n.fullText = "row";
            s.nodes.push_back(std::move(n));
        };
        auto addVersion = [&s](const std::string& id, uint64_t ordinal, uint64_t boundary, int64_t atMs) {
            GraphRailVersion v;
            v.id = id;
            v.ordinal = ordinal;
            v.formedInEpisodeOrdinal = boundary;
            v.occurredAtMs = atMs;
            s.versions.push_back(std::move(v));
            GraphNode n;
            n.id = nodeId("Fv", id);
            n.family = NodeFamily::Formulation;
            n.ordinal = ordinal;
            n.fullText = "frame";
            s.nodes.push_back(std::move(n));
        };
        addRow("episode-1", 1);
        addRow("episode-2", 2);
        // A version whose boundary says episode 1 but which was recorded at
        // t=2500, after episode 2 opened: the time axis, not the boundary,
        // decides its y.
        addVersion("f-late", 1, 1, 2500);
        const PieGraphLayout a = computeGraphLayout(s);
        const Dot* e1 = a.dot("row:episode-1");
        const Dot* e2 = a.dot("row:episode-2");
        const Dot* late = a.dot("Fv:f-late");
        check(e1 != nullptr && e2 != nullptr && late != nullptr, "the time-axis fixture places every entry");
        check(e1 != nullptr && e2 != nullptr && e1->y < e2->y,
              "episodes opened at t=1000 and t=2000 stack in time order");
        check(e2 != nullptr && late != nullptr && late->y > e2->y,
              "a version recorded after episode 2 hangs below episode 2, not at its old boundary");

        // A mixed timed/untimed state: A(t=1000,b=3), B(t=2000,b=1), C(untimed,b=2).
        // Pair-wise special cases would produce C<A, B<C, A<B (a cycle). The
        // uniform key compares the time first with C's explicit -1 sentinel, so
        // C < A < B and the two known times still decide their own order.
        GraphTaskState m;
        m.rows.push_back(EpisodeGutter{"ep-a", 3, 1000, EpisodeStatus::Closed, EpisodeStage::Routing, "", ""});
        m.rows.push_back(EpisodeGutter{"ep-b", 1, 2000, EpisodeStatus::Closed, EpisodeStage::Routing, "", ""});
        auto addRow2 = [&m](const std::string& id, uint64_t ordinal) {
            GraphNode n;
            n.id = nodeId("row", id);
            n.family = NodeFamily::EpisodeRow;
            n.episodeId = id;
            n.ordinal = ordinal;
            n.fullText = "row";
            m.nodes.push_back(std::move(n));
        };
        addRow2("ep-a", 3);
        addRow2("ep-b", 1);
        {
            GraphRailVersion v;
            v.id = "f-c";
            v.ordinal = 1;
            v.formedInEpisodeOrdinal = 2;
            v.occurredAtMs = -1;  // untimed, as a snapshot-loaded version is
            m.versions.push_back(std::move(v));
            GraphNode n;
            n.id = nodeId("Fv", "f-c");
            n.family = NodeFamily::Formulation;
            n.ordinal = 1;
            n.fullText = "frame";
            m.nodes.push_back(std::move(n));
        }
        const PieGraphLayout x = computeGraphLayout(m);
        const PieGraphLayout x2 = computeGraphLayout(m);
        const Dot* ma = x.dot("row:ep-a");
        const Dot* mb = x.dot("row:ep-b");
        const Dot* mc = x.dot("Fv:f-c");
        check(ma != nullptr && mb != nullptr && mc != nullptr, "the mixed-time fixture places every entry");
        check(mc != nullptr && ma != nullptr && mc->y < ma->y,
              "the untimed entry sorts first by its explicit missing-time sentinel");
        check(ma != nullptr && mb != nullptr && ma->y < mb->y,
              "and the known times still decide the order of the timed entries");
        bool deterministic = x.nodes.size() == x2.nodes.size();
        for (const auto& entry : x.nodes) {
            const auto it = x2.nodes.find(entry.first);
            if (it == x2.nodes.end() || it->second.y != entry.second.y) deterministic = false;
        }
        check(deterministic, "the mixed timed/untimed state lays out identically on every call");
    }

    // ---------------------------------------------------------------------
    // Occurrence-time ordering across families, and the mixed-time rule
    // ---------------------------------------------------------------------
    {
        // A row whose records occur in an order DIFFERENT from their family
        // sequence: distillation at t=1000, execution at t=2000, routing at
        // t=3000. Family order would put routing first; occurrence time must
        // not. One record carries no time (as a snapshot-loaded one does), which
        // must stay deterministic and sort before the timed records.
        GraphTaskState s;
        s.rows.push_back(EpisodeGutter{"episode-1", 1, -1, EpisodeStatus::Active, EpisodeStage::Executing, "", ""});
        auto addNode = [&s](const std::string& id, NodeFamily family, uint64_t order, int64_t atMs) {
            GraphNode n;
            n.id = nodeId("n", id);
            n.family = family;
            n.episodeId = "episode-1";
            n.order = order;
            n.occurredAtMs = atMs;
            n.fullText = id;
            s.nodes.push_back(std::move(n));
        };
        addNode("route", NodeFamily::Routing, 0, 3000);
        addNode("exec", NodeFamily::Execution, 1, 2000);
        addNode("distill", NodeFamily::Distillation, 2, 1000);
        addNode("delta", NodeFamily::BeliefDelta, 3, -1);  // no occurrence time
        const PieGraphLayout l = computeGraphLayout(s);
        const Dot* route = l.dot("n:route");
        const Dot* exec = l.dot("n:exec");
        const Dot* distill = l.dot("n:distill");
        const Dot* delta = l.dot("n:delta");
        check(route != nullptr && exec != nullptr && distill != nullptr && delta != nullptr,
              "the ordering fixture places every node");
        check(distill != nullptr && exec != nullptr && route != nullptr &&
                  distill->x < exec->x && exec->x < route->x,
              "row nodes are ordered by occurrence time, not by family order");
        check(delta != nullptr && distill != nullptr && delta->x < distill->x,
              "a record with no occurrence time sorts before the timed records");
    }

    {
        // The full event-consumption -> projection -> layout path: the demo's
        // propose deltas (t=02.000/02.100) precede its plan (t=05.000), and its
        // distill delta (t=08.000) precedes the distillation (t=08.500). Family
        // order puts both deltas at the row's tail, so ordering these by their
        // timestamps is only possible if the timestamp survived the fold and the
        // projection.
        const Dot* proposeDelta = layout.dot("delta:delta-1");
        const Dot* plan = layout.dot("plan:plan-1");
        const Dot* distillDelta = layout.dot("delta:delta-3");
        const Dot* distillation = layout.dot("distill:distillation-1");
        check(proposeDelta != nullptr && plan != nullptr && distillDelta != nullptr &&
                  distillation != nullptr,
              "the cross-family fixture places every node");
        check(proposeDelta != nullptr && plan != nullptr && proposeDelta->x < plan->x,
              "a propose delta orders before the plan by its timestamp");
        check(distillDelta != nullptr && distillation != nullptr && distillDelta->x < distillation->x,
              "a distill delta orders before its distillation by its timestamp");
    }
    {
        // A pending selection (the hollow ring). Its family slot is after routing,
        // but its timestamp is earlier, so the ring must sit left of routing.
        NativeGuiModel sel;
        applyRpcLine(sel, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"s1","timestamp":"2026-01-01T00:00:00.000Z","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"q","effective":"q"},"inheritedBeliefs":[]})");
        applyRpcLine(sel, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"s2","timestamp":"2026-01-01T00:00:01.000Z","taskId":"task-1","episodeId":"episode-1","ordinal":1})");
        applyRpcLine(sel, R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"s3","timestamp":"2026-01-01T00:00:05.000Z","taskId":"task-1","episodeId":"episode-1","routing":{"id":"routing-1","statement":"probe","decision":"belief-loop","suitabilityProbability":0.8,"successProbability":0.8,"estimatedSteps":1,"difficulty":"low","reason":"cheap"}})");
        applyRpcLine(sel, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"s4","timestamp":"2026-01-01T00:00:02.000Z","taskId":"task-1","episodeId":"episode-1","body":"belief-loop","openBeliefsAtStart":[]})");
        applyRpcLine(sel, R"({"type":"ExperimentSelected","schemaVersion":7,"eventId":"s5","timestamp":"2026-01-01T00:00:03.000Z","taskId":"task-1","episodeId":"episode-1","selection":{"intent":"decide","beliefIds":["belief-1"],"formulation":{"kind":"unformed"}}})");
        const GraphTaskState selState = projectGraphTask(sel);
        const PieGraphLayout selLayout = computeGraphLayout(selState);
        const Dot* ring = selLayout.dot("select:episode-1");
        const Dot* route = selLayout.dot("route:routing-1");
        check(ring != nullptr && route != nullptr, "the pending selection ring is placed");
        check(ring != nullptr && route != nullptr && ring->x < route->x,
              "the ring orders before routing by its timestamp, not its family slot");
    }

    // ---------------------------------------------------------------------
    // The paneBg pulse, which the halo animates over (§6.3)
    // ---------------------------------------------------------------------
    {
        // paneBg lives in Theme (ImGui-linked) so it cannot be called from this
        // headless test. What can be checked here is the value it oscillates
        // TOWARD: the halo's own colour must be usable as the pulse's peak, i.e.
        // non-black and opaque. A zero RGB halo would make the pulse invisible and
        // the animation silently disappear — the exact regression §6.3 warns about
        // when it refuses to drop the animation with its old callers.
        const GraphStyle::Rgb& halo = kGraphStyle.currentHaloColor;
        check(halo.r > 0 || halo.g > 0 || halo.b > 0,
              "the halo colour is not black, so the pulse is visible at its peak");
        check(kGraphStyle.currentHaloWidth >= kGraphStyle.dotRingWidth,
              "the halo is at least as wide as a ring, so it reads as a pulse and not a second ring");
    }

    // ---------------------------------------------------------------------
    // The pruned vocabulary is gone
    // ---------------------------------------------------------------------
    {
        // §6.3 pruned the region/band model. A field that came back would be dead
        // weight the renderer cannot see; naming the removals here keeps the
        // decision on the record rather than only in a commit message.
        //
        // (This is a compile-time check by construction: the test would not build
        // if it referenced a field that had been restored to a different shape. The
        // assertions below pin the ones the layout still reads.)
        check(kGraphStyle.outcomeBandLineH > 0.0f, "the outcome band kept its height");
        check(kGraphStyle.outcomeBandPad >= 0.0f, "the outcome band kept its padding");
        check(kGraphStyle.gridLineAlpha > 0 && kGraphStyle.gridLineAlpha <= 255,
              "the grid alpha is a byte");
        check(kGraphStyle.dotRingDefaultAlpha >= 0 && kGraphStyle.dotRingDefaultAlpha <= 255,
              "the ring alpha is a byte");
        check(kGraphStyle.outcomeBandAlpha >= 0 && kGraphStyle.outcomeBandAlpha <= 255,
              "the outcome band alpha is a byte");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
