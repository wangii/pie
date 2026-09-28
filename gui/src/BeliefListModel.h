// BeliefListModel: the rows the belief panel renders (docs/milestones.md §7.1).
//
// Headless and ImGui-free, so the panel's whole content — ordering, filtering,
// labels, lineage — is testable without a window. The renderer draws a row; it
// decides nothing.
//
// Three rules from the plan are load-bearing here and are easy to get wrong in a
// way that looks right on screen:
//
//  1. THE LABEL IS DERIVED, NOT STORED. `label` is "B7" by record order, computed
//     at build time from the belief registry's order. The v1 GUI stored belief
//     ordinals and drifted after a reconnect (§5.3).
//
//  2. "NO FOCUS DECLARED" IS NOT "AN EMPTY FOCUS". `focusDeclared` is reported
//     beside the rows so the panel can say which of the two it is showing. An
//     undeclared focus filters to nothing under `focusOnly`, and that is the
//     honest answer rather than a bug to paper over.
//
//  3. STATUS IS DERIVED FROM PROVENANCE. The row reads `Belief::status()`, which
//     applies the contract's precedence (superseded > refuted > supported >
//     inconclusive > proposed). It is never read off a stored field, because
//     there is none.
//
// A superseded belief is the interesting row: it is retracted but still
// meaningful, so the row carries the whole chain forward (`B7 → B12 → B19`) and
// the status of the head, so it does not read as a dead end.

#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

#include "Model.h"

namespace pie::gui {

enum class BeliefSort {
    RecordOrder,     // the registry's own order (§5.3's stable default)
    Status,          // by derived status, most-settled first
    Domain,          // by domain, then record order
    EvidenceRounds,  // by rounds carried, most first
};
const char* beliefSortToString(BeliefSort sort);

struct BeliefFilter {
    // Only beliefs in the task's declared focus. With no focus declared this
    // matches nothing, which is a fact about the task rather than about beliefs.
    bool focusOnly = false;
    bool hideSuperseded = false;
    std::optional<BeliefDomain> domain;
    // Case-insensitive substring match against the statement, the expectation and
    // the id. Matches the id so a user can jump to a belief they saw in a tooltip.
    std::string query;

    bool active() const {
        return focusOnly || hideSuperseded || domain.has_value() || !query.empty();
    }
};

struct BeliefRow {
    BeliefId id;
    // "B7", by record order. DERIVED AT BUILD TIME, never stored on the record.
    std::string label;
    const Belief* record = nullptr;

    // Derived from provenance by Belief::status().
    BeliefStatus status = BeliefStatus::Proposed;
    size_t supportCount = 0;
    size_t refuteCount = 0;
    size_t inconclusiveCount = 0;

    // Scope, not truth. `focusDeclared` is repeated per row so a row rendered in
    // isolation still knows which case it is in.
    bool inFocus = false;
    bool focusDeclared = false;
    // Whether the projected task introduced this belief. A belief the task
    // inherited is in scope but is not this task's own finding.
    bool introducedByThisTask = false;
    // How many of the session's tasks introduce it. A belief carried by several
    // tasks is the closest thing the log has to a load-bearing claim.
    size_t taskCount = 0;

    // The supersession chain, oldest first, STARTING AT THIS BELIEF. Size 1 means
    // nothing superseded it; the first element is always `id`.
    std::vector<BeliefId> supersededChain;
    // The belief now standing in this row's place (the chain's last element), or
    // nullopt when the row is not superseded.
    std::optional<BeliefId> lineageHead;
    // The head's derived status — `Superseded` when the row is superseded and the
    // head is live.
    BeliefStatus lineageStatus = BeliefStatus::Proposed;
    // Set when following supersededBy had to stop early (the runtime wrote a cycle,
    // which no correct log contains but a hostile one can).
    bool chainTruncated = false;

    // This task's applicability decision for the belief, when a review covers it.
    std::optional<FormulationApplicabilityDecision> applicability;
    // The decision describes a scope the task no longer holds, so it stops
    // counting and the belief is owed a new one.
    bool applicabilityStale = false;
    // The review still has to classify this belief.
    bool awaitsRevalidation = false;
    // The review listed it and it still has no live decision: it blocks the
    // conclusion (§7.2 item 5).
    bool owesDecision = false;
};

struct BeliefListModel {
    std::vector<BeliefRow> rows;
    // Whether the projected task declared a focus at all. Reported beside the rows
    // because "declared and empty" and "never declared" are different facts.
    bool focusDeclared = false;
    // Counts before and after filtering, so the panel can say "12 of 30 hidden".
    size_t totalCount = 0;
    size_t hiddenByFilterCount = 0;
    size_t hiddenSupersededCount = 0;
    bool filterActive = false;
    BeliefSort sort = BeliefSort::RecordOrder;
};

// Build the rows for `task` (which may be null, yielding an empty list that still
// reports the session's belief count).
BeliefListModel buildBeliefList(const NativeGuiModel& model, const Task* task, BeliefSort sort,
                                const BeliefFilter& filter);

// Follow `supersededBy` from `id` to its head. Exposed because the supersession
// chain is the one part of this module with a loop in it, and the only part whose
// failure mode (an infinite walk) is not visible in a screenshot.
struct SupersessionChain {
    std::vector<BeliefId> ids;  // oldest first, starting with `id`
    bool truncated = false;     // stopped because a cycle or the depth cap was hit
};
SupersessionChain followSupersession(const NativeGuiModel& model, const BeliefId& id);

} // namespace pie::gui
