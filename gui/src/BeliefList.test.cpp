// M6: the belief list rows (docs/milestones.md §7.1).
//
// The panel's whole content is decided here, so what is worth pinning is the set
// of things that would look plausible on screen while being wrong:
//
//   * a label that comes from anywhere but record order (drift after a reconnect),
//   * an undeclared focus rendered as an empty one,
//   * a status read off a field instead of derived from provenance,
//   * a supersession chain that dead-ends instead of naming the belief now standing,
//   * a chain walk that does not terminate on a cycle.

#include <cstdio>
#include <string>
#include <vector>

#include "BeliefListModel.h"
#include "DemoEvents.h"
#include "DomainEvents.h"
#include "Model.h"

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

static NativeGuiModel demoModel() {
    NativeGuiModel model;
    for (const std::string& line : demoEvents()) applyRpcLine(model, line);
    return model;
}

static const BeliefRow* findRow(const BeliefListModel& list, const BeliefId& id) {
    for (const BeliefRow& row : list.rows) {
        if (row.id == id) return &row;
    }
    return nullptr;
}

// A model with three beliefs in a supersession chain: a -> b -> c.
static NativeGuiModel chainModel() {
    NativeGuiModel model;
    const char* lines[] = {
        R"({"type":"TaskOpened","schemaVersion":7,"eventId":"c1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})",
        R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"c2","taskId":"t","episodeId":"e1","ordinal":1})",
        R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"c3","taskId":"t","episodeId":"e1","routing":{"id":"r1","statement":"s","decision":"belief-loop","suitabilityProbability":0.5,"successProbability":0.5,"estimatedSteps":1,"difficulty":"low","reason":"r"}})",
        R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"c4","taskId":"t","episodeId":"e1","body":"belief-loop","openBeliefsAtStart":[]})",
        // b1 proposed.
        R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"c5","taskId":"t","episodeId":"e1","delta":{"id":"d1","episodeId":"e1","producerPhase":"propose","operation":"propose","resultBeliefId":"b1","resultingBeliefs":[{"id":"b1","statement":"first claim","domain":"code","expectation":"e1","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b1"]})",
        // b1 refined into a NEW record b2, which supersedes b1.
        R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"c6","taskId":"t","episodeId":"e1","delta":{"id":"d2","episodeId":"e1","producerPhase":"distill","operation":"refine","sourceBeliefId":"b1","resultBeliefId":"b2","resultingBeliefs":[{"id":"b1","statement":"first claim","domain":"code","expectation":"e1","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"supersededBy":"b2","withdrawn":false},{"id":"b2","statement":"refined claim","domain":"code","expectation":"e2","evidenceRounds":2,"skillRefs":[],"supportedBy":[{"evidence":"probe"}],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b2"]})",
        // b2 refined again into b3.
        R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"c7","taskId":"t","episodeId":"e1","delta":{"id":"d3","episodeId":"e1","producerPhase":"distill","operation":"refine","sourceBeliefId":"b2","resultBeliefId":"b3","resultingBeliefs":[{"id":"b2","statement":"refined claim","domain":"code","expectation":"e2","evidenceRounds":2,"skillRefs":[],"supportedBy":[{"evidence":"probe"}],"refutedBy":[],"supersededBy":"b3","withdrawn":false},{"id":"b3","statement":"final claim","domain":"product","expectation":"e3","evidenceRounds":3,"skillRefs":[],"supportedBy":[{"evidence":"probe"},{"evidence":"probe2"}],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b3"]})",
    };
    for (const char* line : lines) applyRpcLine(model, line);
    return model;
}

int main() {
    NativeGuiModel model = demoModel();
    check(model.issues().empty(), "the demo folds without issues");
    const Task* task = model.task("task-1");
    check(task != nullptr, "the demo's task is present");

    // ---------------------------------------------------------------------
    // Record order is the default, and the labels follow it
    // ---------------------------------------------------------------------
    {
        const BeliefListModel list = buildBeliefList(model, task, BeliefSort::RecordOrder, {});
        check(list.rows.size() == 2, "both beliefs are listed");
        check(list.totalCount == 2, "the total count is the registry's size");
        check(!list.filterActive, "an empty filter is not active");
        check(list.rows[0].label == "B1" && list.rows[1].label == "B2",
              "labels are B1 then B2 in record order");
        // The label must survive a sort that reorders the rows: it is a property of
        // the record, not of the row's position.
        const BeliefListModel byDomain =
            buildBeliefList(model, task, BeliefSort::Domain,
                            [] {
                                BeliefFilter f;
                                f.domain = BeliefDomain::Product;
                                return f;
                            }());
        check(byDomain.rows.size() == 1 && byDomain.rows[0].label == "B2",
              "the label is unchanged by filtering and sorting");
    }

    // ---------------------------------------------------------------------
    // Status is derived from provenance
    // ---------------------------------------------------------------------
    {
        const BeliefListModel list = buildBeliefList(model, task, BeliefSort::RecordOrder, {});
        const BeliefRow* b1 = findRow(list, "belief-1");
        const BeliefRow* b2 = findRow(list, "belief-2");
        check(b1 != nullptr && b1->status == BeliefStatus::Refuted,
              "belief-1 carries one support and one refutation, so the precedence says refuted");
        check(b1 != nullptr && b1->supportCount == 1 && b1->refuteCount == 1,
              "the evidence counts are the provenance's own lengths");
        check(b2 != nullptr && b2->status == BeliefStatus::Proposed,
              "belief-2 was never adjudicated");
        check(b2 != nullptr && b2->supportCount == 0 && b2->refuteCount == 0,
              "belief-2 has no evidence");
    }

    // ---------------------------------------------------------------------
    // Focus: declared-and-empty is not undeclared
    // ---------------------------------------------------------------------
    {
        const BeliefListModel list = buildBeliefList(model, task, BeliefSort::RecordOrder, {});
        check(list.focusDeclared, "the demo declares a focus");
        const BeliefRow* b1 = findRow(list, "belief-1");
        const BeliefRow* b2 = findRow(list, "belief-2");
        check(b1 != nullptr && b1->inFocus, "belief-1 is in the declared focus");
        check(b2 != nullptr && !b2->inFocus, "belief-2 is out of focus but still listed");
        check(b2 != nullptr && b2->focusDeclared,
              "every row repeats that a focus WAS declared");
        check(b1 != nullptr && b1->introducedByThisTask && b2 != nullptr && b2->introducedByThisTask,
              "both beliefs were introduced by this task");
        check(b1 != nullptr && b1->taskCount == 1, "one task introduces belief-1");
    }
    {
        // A task that never declared a focus: focusOnly matches nothing, and the
        // model says the focus is undeclared so the panel can explain the empty
        // list instead of showing an empty focus.
        NativeGuiModel bare;
        applyRpcLine(bare, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"b1","taskId":"bare","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        BeliefFilter focusOnly;
        focusOnly.focusOnly = true;
        const BeliefListModel list =
            buildBeliefList(bare, bare.task("bare"), BeliefSort::RecordOrder, focusOnly);
        check(!list.focusDeclared, "the task declared no focus");
        check(list.rows.empty(), "focusOnly with no declared focus matches nothing");
        check(buildBeliefList(bare, bare.task("bare"), BeliefSort::RecordOrder, {}).focusDeclared == false,
              "the undeclared focus is reported even with no filter");
        // A null task: still reports the session's beliefs, with no task-scoped
        // columns set.
        const BeliefListModel noTask = buildBeliefList(model, nullptr, BeliefSort::RecordOrder, {});
        check(noTask.rows.size() == 2, "a null task still lists the session's beliefs");
        check(!noTask.focusDeclared && !noTask.rows[0].introducedByThisTask,
              "with no task nothing is in focus or introduced");
    }

    // ---------------------------------------------------------------------
    // Filtering
    // ---------------------------------------------------------------------
    {
        BeliefFilter hideSuperseded;
        hideSuperseded.hideSuperseded = true;
        const BeliefListModel list =
            buildBeliefList(model, task, BeliefSort::RecordOrder, hideSuperseded);
        check(list.rows.size() == 2, "the demo supersedes nothing, so nothing is hidden");
        check(list.hiddenSupersededCount == 0, "no superseded rows were counted");
    }
    {
        BeliefFilter query;
        query.query = "PYTEST";
        const BeliefListModel list = buildBeliefList(model, task, BeliefSort::RecordOrder, query);
        check(list.rows.size() == 1 && list.rows[0].id == "belief-1",
              "the query matches case-insensitively on the statement");
        check(list.hiddenByFilterCount == 1, "the hidden count is reported");
    }
    {
        BeliefFilter byExpectation;
        byExpectation.query = "importable";
        check(buildBeliefList(model, task, BeliefSort::RecordOrder, byExpectation).rows.size() == 1,
              "the query also matches the expectation");
    }
    {
        BeliefFilter byId;
        byId.query = "belief-2";
        check(buildBeliefList(model, task, BeliefSort::RecordOrder, byId).rows.size() == 1,
              "the query matches the id, so a tooltip's id can be searched");
    }
    {
        BeliefFilter noMatch;
        noMatch.query = "nothing says this";
        const BeliefListModel list = buildBeliefList(model, task, BeliefSort::RecordOrder, noMatch);
        check(list.rows.empty(), "a query matching nothing lists nothing");
        check(list.totalCount == 2, "the total is still reported, so the panel can say 0 of 2");
    }

    // ---------------------------------------------------------------------
    // Sorting is total, and stable on ties
    // ---------------------------------------------------------------------
    {
        const BeliefListModel byStatus = buildBeliefList(model, task, BeliefSort::Status, {});
        check(byStatus.rows.size() == 2 && byStatus.rows[0].id == "belief-1",
              "sorting by status puts the refuted belief first");
        const BeliefListModel byRounds = buildBeliefList(model, task, BeliefSort::EvidenceRounds, {});
        check(byRounds.rows.size() == 2 && byRounds.rows[0].id == "belief-1",
              "sorting by evidence rounds puts the higher count first");
        // Ties keep record order (stable_sort), so two renders of the same state
        // cannot disagree.
        const BeliefListModel a = buildBeliefList(model, task, BeliefSort::Domain, {});
        const BeliefListModel b = buildBeliefList(model, task, BeliefSort::Domain, {});
        bool same = a.rows.size() == b.rows.size();
        for (size_t i = 0; same && i < a.rows.size(); ++i) same = a.rows[i].id == b.rows[i].id;
        check(same, "the same state sorts identically twice");
        check(std::string(beliefSortToString(BeliefSort::EvidenceRounds)) == "evidence-rounds",
              "the sort has a stable name for the UI");
    }

    // ---------------------------------------------------------------------
    // The supersession chain does not dead-end
    // ---------------------------------------------------------------------
    {
        NativeGuiModel chain = chainModel();
        check(chain.issues().empty(), "the chain fixture folds without issues");
        const BeliefListModel list =
            buildBeliefList(chain, chain.task("t"), BeliefSort::RecordOrder, {});
        check(list.rows.size() == 3, "all three beliefs are listed");

        const BeliefRow* first = findRow(list, "b1");
        check(first != nullptr && first->supersededChain.size() == 3,
              "the oldest belief's chain walks to the end");
        check(first != nullptr && first->supersededChain[0] == "b1" &&
                  first->supersededChain[1] == "b2" && first->supersededChain[2] == "b3",
              "the chain is oldest to newest and starts at the row's own belief");
        check(first != nullptr && first->lineageHead.has_value() && *first->lineageHead == "b3",
              "the lineage head is the belief now standing");
        check(first != nullptr && first->lineageStatus == BeliefStatus::Supported,
              "the head's DERIVED status is reported, not a stored one");
        check(first != nullptr && first->status == BeliefStatus::Superseded,
              "the row's own status is superseded, which is why the head matters");

        const BeliefRow* last = findRow(list, "b3");
        check(last != nullptr && last->supersededChain.size() == 1,
              "the head's chain is just itself");
        check(last != nullptr && !last->lineageHead.has_value(),
              "the head has no lineage head of its own");
        check(last != nullptr && !last->chainTruncated, "no chain was truncated");

        // Hiding superseded rows leaves only the head, which is the point of the
        // filter: the claim is still visible, through the record that now stands.
        BeliefFilter hide;
        hide.hideSuperseded = true;
        const BeliefListModel heads =
            buildBeliefList(chain, chain.task("t"), BeliefSort::RecordOrder, hide);
        check(heads.rows.size() == 1 && heads.rows[0].id == "b3",
              "hiding superseded rows leaves the live head");
        check(heads.hiddenSupersededCount == 2, "both superseded rows are counted as hidden");
    }
    {
        // A cycle in supersededBy: the runtime cannot write one, so this is a
        // corrupt log. The walk must stop and SAY it stopped rather than hang.
        NativeGuiModel cyclic;
        applyRpcLine(cyclic, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"z1","taskId":"z","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})");
        applyRpcLine(cyclic, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"z2","taskId":"z","episodeId":"e","ordinal":1})");
        applyRpcLine(cyclic, R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"z3","taskId":"z","episodeId":"e","routing":{"id":"r","statement":"s","decision":"belief-loop","suitabilityProbability":0.5,"successProbability":0.5,"estimatedSteps":1,"difficulty":"low","reason":"r"}})");
        applyRpcLine(cyclic, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"z4","taskId":"z","episodeId":"e","body":"belief-loop","openBeliefsAtStart":[]})");
        // Two beliefs that each say the other supersedes them.
        applyRpcLine(cyclic, R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"z5","taskId":"z","episodeId":"e","delta":{"id":"zd","episodeId":"e","producerPhase":"propose","operation":"propose","resultBeliefId":"zb1","resultingBeliefs":[{"id":"zb1","statement":"a","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"supersededBy":"zb2","withdrawn":false},{"id":"zb2","statement":"b","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"supersededBy":"zb1","withdrawn":false}]},"activeBeliefs":["zb1"]})");
        const SupersessionChain chain = followSupersession(cyclic, "zb1");
        check(chain.truncated, "a supersession cycle is reported as truncated");
        check(chain.ids.size() == 2, "the walk stops after visiting each belief once");
        const BeliefListModel list =
            buildBeliefList(cyclic, cyclic.task("z"), BeliefSort::RecordOrder, {});
        const BeliefRow* row = findRow(list, "zb1");
        check(row != nullptr && row->chainTruncated, "the row carries the truncation flag");
    }

    // ---------------------------------------------------------------------
    // Applicability obligations: the columns that block a conclusion
    // ---------------------------------------------------------------------
    {
        // Before any version is published there is no review, so no belief owes a
        // decision and none carries one. (Replaying the FIRST NINE events: the
        // first publication is event 10, and the review arrives with it.)
        NativeGuiModel early;
        {
            const std::vector<std::string> prefix = demoEvents();
            for (size_t i = 0; i < 9; ++i) applyRpcLine(early, prefix[i]);
        }
        const BeliefListModel beforeReview =
            buildBeliefList(early, early.task("task-1"), BeliefSort::RecordOrder, {});
        check(!beforeReview.rows.empty(), "the early fixture has beliefs to show");
        check(!beforeReview.rows[0].owesDecision && !beforeReview.rows[0].applicability.has_value(),
              "a belief owes nothing and carries no decision before a review covers it");

        // Replay only up to the point where formulation-2's review is open and the
        // applicability has not been recorded: belief-1 is then pending.
        NativeGuiModel open;
        const std::vector<std::string> demo = demoEvents();
        for (size_t i = 0; i < 32; ++i) applyRpcLine(open, demo[i]);
        const BeliefListModel pending =
            buildBeliefList(open, open.task("task-1"), BeliefSort::RecordOrder, {});
        const BeliefRow* b1 = findRow(pending, "belief-1");
        check(b1 != nullptr && b1->owesDecision,
              "a belief the open review has not classified yet owes a decision");

        // After the applicability is recorded it carries a decision.
        const BeliefListModel classified =
            buildBeliefList(model, task, BeliefSort::RecordOrder, {});
        const BeliefRow* done = findRow(classified, "belief-1");
        check(done != nullptr && done->applicability.has_value() &&
                  *done->applicability == FormulationApplicabilityDecision::CarriesOver,
              "the recorded decision is on the row");
        check(done != nullptr && !done->applicabilityStale, "the decision still counts");
        check(done != nullptr && !done->owesDecision, "a classified belief owes nothing");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
