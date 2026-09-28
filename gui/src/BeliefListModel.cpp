#include "BeliefListModel.h"

#include <algorithm>
#include <cctype>
#include <set>

namespace pie::gui {

namespace {

// A supersession chain longer than this is not a chain, it is a loop. The cap
// bounds the walk even if `supersededBy` were to form a cycle through ids the
// visited-set somehow missed.
constexpr size_t kMaxChainLength = 4096;

std::string lowered(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    for (char c : text) {
        out += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return out;
}

bool matchesQuery(const Belief& belief, const std::string& loweredQuery) {
    if (loweredQuery.empty()) return true;
    if (lowered(belief.statement).find(loweredQuery) != std::string::npos) return true;
    if (lowered(belief.expectation).find(loweredQuery) != std::string::npos) return true;
    return lowered(belief.id).find(loweredQuery) != std::string::npos;
}

// Status ordering for BeliefSort::Status: the most settled first. This is the
// same precedence the contract uses to derive a status, read as a display order —
// a reader scanning the list wants refuted and supported claims before the ones
// nobody has decided about.
int statusRank(BeliefStatus status) {
    switch (status) {
        case BeliefStatus::Refuted: return 0;
        case BeliefStatus::Supported: return 1;
        case BeliefStatus::Inconclusive: return 2;
        case BeliefStatus::Proposed: return 3;
        case BeliefStatus::Superseded: return 4;
    }
    return 5;
}

int domainRank(BeliefDomain domain) {
    switch (domain) {
        case BeliefDomain::Product: return 0;
        case BeliefDomain::Code: return 1;
        case BeliefDomain::Unknown: return 2;
    }
    return 3;
}

} // namespace

const char* beliefSortToString(BeliefSort sort) {
    switch (sort) {
        case BeliefSort::RecordOrder: return "record-order";
        case BeliefSort::Status: return "status";
        case BeliefSort::Domain: return "domain";
        case BeliefSort::EvidenceRounds: return "evidence-rounds";
    }
    return "unknown";
}

SupersessionChain followSupersession(const NativeGuiModel& model, const BeliefId& id) {
    SupersessionChain chain;
    if (id.empty()) return chain;
    std::set<BeliefId> seen;
    BeliefId current = id;
    while (!current.empty()) {
        if (seen.count(current) != 0) {
            // A cycle. The runtime's own fold cannot produce one, so this is a
            // corrupt or hand-edited log: stop rather than walk forever, and say so.
            chain.truncated = true;
            break;
        }
        if (chain.ids.size() >= kMaxChainLength) {
            chain.truncated = true;
            break;
        }
        seen.insert(current);
        chain.ids.push_back(current);
        const Belief* belief = model.belief(current);
        if (belief == nullptr || !belief->supersededBy.has_value()) break;
        current = *belief->supersededBy;
    }
    return chain;
}

BeliefListModel buildBeliefList(const NativeGuiModel& model, const Task* task, BeliefSort sort,
                                const BeliefFilter& filter) {
    BeliefListModel out;
    out.sort = sort;
    out.filterActive = filter.active();
    // The model's record order IS the order a label derives from, so the list is
    // built in that order and only then re-sorted. Sorting first would renumber
    // the labels, which is the drift §5.3 forbids.
    const std::vector<const Belief*> beliefs = model.beliefs();
    out.totalCount = beliefs.size();
    if (task != nullptr) out.focusDeclared = task->focusDeclared;

    const std::string loweredQuery = lowered(filter.query);
    // The task's review, for the applicability columns.
    const FormulationReview* review =
        (task != nullptr && task->formulationReview.has_value()) ? &*task->formulationReview : nullptr;
    const std::vector<BeliefId> pendingApplicability =
        task != nullptr ? pendingApplicabilityBeliefs(*task) : std::vector<BeliefId>{};

    for (const Belief* belief : beliefs) {
        BeliefRow row;
        row.id = belief->id;
        row.label = model.beliefLabel(belief->id);
        row.record = belief;
        row.status = belief->status();
        row.supportCount = belief->supportedBy.size();
        row.refuteCount = belief->refutedBy.size();
        row.inconclusiveCount = belief->inconclusiveBy.size();
        row.focusDeclared = out.focusDeclared;
        row.inFocus = task != nullptr && task->focusDeclared && task->inFocus(belief->id);
        row.introducedByThisTask = task != nullptr && task->hasIntroduced(belief->id);

        for (const Task* other : model.tasks()) {
            if (other->hasIntroduced(belief->id)) ++row.taskCount;
        }

        const SupersessionChain chain = followSupersession(model, belief->id);
        row.supersededChain = chain.ids;
        row.chainTruncated = chain.truncated;
        if (chain.ids.size() > 1) {
            row.lineageHead = chain.ids.back();
            if (const Belief* head = model.belief(*row.lineageHead)) {
                row.lineageStatus = head->status();
            }
        }

        if (review != nullptr) {
            for (const FormulationApplicabilityEntry& entry : review->applicability) {
                if (entry.beliefId != belief->id) continue;
                row.applicability = entry.decision;
                row.applicabilityStale = entry.stale;
            }
        }
        // `awaitsRevalidation` is the review's own list: classified
        // `needs-revalidation` and not yet probed again under this reading.
        if (task != nullptr) {
            for (const FormulationApplicabilityEntry* entry : unrevalidatedApplicability(*task)) {
                if (entry->beliefId == belief->id) row.awaitsRevalidation = true;
            }
        }
        row.owesDecision =
            std::find(pendingApplicability.begin(), pendingApplicability.end(), belief->id) !=
            pendingApplicability.end();

        // --- filtering --------------------------------------------------
        if (filter.focusOnly && !row.inFocus) {
            ++out.hiddenByFilterCount;
            continue;
        }
        if (filter.hideSuperseded && belief->supersededBy.has_value()) {
            ++out.hiddenByFilterCount;
            ++out.hiddenSupersededCount;
            continue;
        }
        if (filter.domain.has_value() && belief->domain != *filter.domain) {
            ++out.hiddenByFilterCount;
            continue;
        }
        if (!matchesQuery(*belief, loweredQuery)) {
            ++out.hiddenByFilterCount;
            continue;
        }
        out.rows.push_back(std::move(row));
    }

    // --- sorting --------------------------------------------------------
    // Every comparator falls back to record order, so the sort is total and the
    // list cannot reshuffle between two renders of the same state.
    std::stable_sort(out.rows.begin(), out.rows.end(), [sort](const BeliefRow& a, const BeliefRow& b) {
        switch (sort) {
            case BeliefSort::RecordOrder:
                return false;  // already in record order; stable_sort keeps it
            case BeliefSort::Status:
                return statusRank(a.status) < statusRank(b.status);
            case BeliefSort::Domain:
                return domainRank(a.record->domain) < domainRank(b.record->domain);
            case BeliefSort::EvidenceRounds:
                return a.record->evidenceRounds > b.record->evidenceRounds;
        }
        return false;
    });
    return out;
}

} // namespace pie::gui
