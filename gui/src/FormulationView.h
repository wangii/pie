// FormulationView: what the Frame pane renders (docs/milestones.md §7.2).
//
// The Frame is the product's name for the agent's reading of the problem, and the
// pane built on this is "the first GUI surface on which `sources[]` is
// auditable". So this module's job is to assemble, from two DIFFERENT sources,
// everything the pane shows — and to keep the two apart, because they are not
// equally authoritative:
//
//   * DERIVED from the domain records (this task's versions, the review, the
//     deferral, the corrections, the recheck). This is what a replay can rebuild,
//     and it is what the pane shows when the runtime said nothing.
//   * RUNTIME FACTS from `get_state` (`awaitingResponse`, `approved`, `resume`).
//     These are NOT in the domain log — replaying restores an approval, not the
//     delivery of the turn that followed it — so they are carried over as they
//     arrived and never recomputed here.
//
// Where the two could disagree the runtime wins, which is why §5.3 makes the
// bootstrap hold `get_state` until the snapshot has landed.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "Model.h"

namespace pie::gui {

// The banner's state. §7.2 names exactly these six, and the derivation below
// picks exactly one.
enum class FrameBanner {
    None,               // nothing is owed: the pane shows no banner at all
    AwaitingResponse,   // "Waiting for your response" — Approve and Correct are live
    ApprovedContinuing, // "Approved — continuing"
    ApprovedNoRun,      // "Approved — no run continuing"
    ApprovalFailed,     // "Approval continuation failed: {reason}"
    ProposeOwesReading, // "propose owes a reading" — the FIRST reading
    RecheckOwed,        // "owes a reconsideration of episode #{ordinal}"
};
const char* frameBannerText(FrameBanner banner);

// One `sources[]` entry, resolved for display. A chip carries the id AND the
// label the rest of the GUI uses for that record, so "B4" here and "B4" in the
// belief pane are the same belief — which is what makes the citation auditable.
struct FormulationChip {
    FormulationSourceKind kind = FormulationSourceKind::Unknown;
    Id id;
    std::string label;
    // A belief chip can open the belief pane and an execution chip can centre the
    // canvas. A prompt chip has nowhere to go: the prompt is not a node.
    bool opensBeliefs = false;
    bool centresCanvas = false;
};

struct FormulationView {
    // --- runtime facts (`get_state`), authoritative when known -----------
    // False until a `get_state` response was applied. The pane must render the
    // banner's runtime half as unknown rather than as false: "the runtime has not
    // said" is not "the run is not paused".
    bool runtimeKnown = false;
    bool awaitingResponse = false;
    bool approved = false;
    std::optional<FormulationResumeState> resume;
    // Session-scoped auto-approval. Unlike the three above it is not a property of
    // THIS task's formulation — it is a setting on the session — so it is not gated
    // on the shown task being the active one, and it is read even when there is no
    // task at all: the toggle can be set before the first reading exists.
    //
    // `autoApproveKnown` is separate from the value because the checkbox must draw
    // "the runtime has not said" as a disabled control, never as an unticked box:
    // an unticked box is a claim that automatic approval is off.
    bool autoApproveKnown = false;
    bool autoApproveFrame = false;

    // --- derived from the domain records ---------------------------------
    bool hasTask = false;
    const ProblemFormulationVersion* current = nullptr;
    const FormulationDeferral* deferral = nullptr;
    // Pending first, then answered in the order they were received.
    std::vector<const FormulationCorrection*> corrections;
    const FormulationReview* review = nullptr;
    const FormulationRecheck* recheck = nullptr;

    bool decisionOwed = false;      // either kind (§7.2's `decisionOwed`)
    bool firstReadingOwed = false;  // the FIRST reading
    bool recheckOwed = false;       // the per-round reconsideration
    // The episode whose reconsideration is owed, for the banner's `#{ordinal}`.
    std::optional<uint64_t> recheckEpisodeOrdinal;
    std::vector<BeliefId> pendingApplicability;
    std::vector<BeliefId> unrevalidated;

    // The version an Approve or a Correct is aimed at: the REVIEW's, which is the
    // one `approveFormulation(versionId)` will accept. Never the newest published
    // version — a publication that replaced the reviewed one would otherwise send
    // an id the runtime refuses, and the refusal would read as a bug.
    FormulationVersionId reviewVersionId;
    // Every version this task published, oldest first — the history list.
    std::vector<const ProblemFormulationVersion*> history;

    // --- presentation ----------------------------------------------------
    FrameBanner banner = FrameBanner::None;
    std::string bannerDetail;  // the reason, for ApprovalFailed
    // Approve is live ONLY while the run is paused on this reading (§7.2). A
    // button that is offered when nothing is waiting invites exactly the confusion
    // `approve_frame` exists to remove.
    bool canApprove = false;
};

FormulationView deriveFormulationView(const NativeGuiModel& model, const Task* task);

// The chips for one version's `sources[]`, in record order.
std::vector<FormulationChip> formulationChips(const NativeGuiModel& model,
                                              const ProblemFormulationVersion& version);

// Which FIELDS differ between two consecutive versions, as display names. §7.2
// asks for the changed fields and explicitly NOT for a text diff: comparing two
// recorded values is a fact, while a diff of their wording is a reading of the
// agent's intent, which this GUI does not get to perform.
std::vector<std::string> formulationChangedFields(const ProblemFormulationVersion& previous,
                                                  const ProblemFormulationVersion& next);

// The auto-open edge (§7.2). Only `awaitingResponse` and a FAILED continuation
// open the pane: `decisionOwed` fires nearly every round, so it is a badge on the
// banner rather than something that grabs the window.
//
// `latchVersionId` is the version the pane was last opened for. A reconnect
// re-delivers `get_state`, which would otherwise re-open the pane for a state the
// user has already seen; the latch pins it to the version, so a NEW version can
// still open it.
bool autoOpenEdge(const FormulationView& prev, const FormulationView& next,
                  FormulationVersionId& latchVersionId);

} // namespace pie::gui
