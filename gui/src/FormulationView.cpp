#include "FormulationView.h"

#include <string>

namespace pie::gui {

namespace {

bool failed(const std::optional<FormulationResumeState>& resume) {
    return resume.has_value() && resume->phase == FormulationResumePhase::Failed;
}

std::string sourceLabel(const NativeGuiModel& model, const FormulationSource& source) {
    switch (source.kind) {
        case FormulationSourceKind::Belief:
            return model.beliefLabel(source.beliefId);
        case FormulationSourceKind::Execution:
            return "exec " + source.executionId;
        case FormulationSourceKind::Distillation:
            return "distill " + source.distillationId;
        case FormulationSourceKind::Prompt:
            return "prompt " + source.promptId;
        case FormulationSourceKind::Intervention:
            return "steer " + source.interventionId;
        case FormulationSourceKind::Correction:
            return "correction " + source.correctionId;
        case FormulationSourceKind::Unknown:
            return {};
    }
    return {};
}

const FormulationSource* pickSource(const FormulationSource& source) {
    return source.kind == FormulationSourceKind::Unknown ? nullptr : &source;
}

} // namespace

const char* frameBannerText(FrameBanner banner) {
    switch (banner) {
        case FrameBanner::None: return "";
        case FrameBanner::AwaitingResponse: return "Waiting for your response";
        case FrameBanner::ApprovedContinuing: return "Approved \xe2\x80\x94 continuing";
        case FrameBanner::ApprovedNoRun: return "Approved \xe2\x80\x94 no run continuing";
        case FrameBanner::ApprovalFailed: return "Approval continuation failed";
        case FrameBanner::ProposeOwesReading: return "propose owes a reading";
        case FrameBanner::RecheckOwed: return "owes a reconsideration";
    }
    return "";
}

FormulationView deriveFormulationView(const NativeGuiModel& model, const Task* task) {
    FormulationView view;
    const SessionState& session = model.sessionState();
    // The runtime's formulation state describes the ACTIVE task, so it is only
    // applied when the task being shown is that one. Applying it to a historical
    // task would attribute this moment's pause to a round that ended long ago.
    const bool runtimeIsAboutThisTask =
        session.present && session.formulation.has_value() && task != nullptr &&
        model.cursor().valid() && model.cursor().taskId == task->id;
    if (runtimeIsAboutThisTask) {
        const FormulationState& runtime = *session.formulation;
        view.runtimeKnown = true;
        view.awaitingResponse = runtime.awaitingResponse;
        view.approved = runtime.approved;
        view.resume = runtime.resume;
    }

    if (task == nullptr) {
        view.banner = FrameBanner::None;
        return view;
    }
    view.hasTask = true;

    view.current = currentFormulation(*task);
    view.deferral = task->formulationDeferral.has_value() ? &*task->formulationDeferral : nullptr;
    view.review = task->formulationReview.has_value() ? &*task->formulationReview : nullptr;
    view.recheck = task->formulationRecheck.has_value() ? &*task->formulationRecheck : nullptr;
    for (const ProblemFormulationVersion& version : task->formulations) {
        view.history.push_back(&version);
    }

    // Pending first: a correction nobody has answered is the one the user is
    // waiting on, and burying it under the answered ones hides exactly that.
    for (const FormulationCorrection& correction : task->formulationCorrections) {
        if (correction.status == FormulationCorrectionStatus::Pending) view.corrections.push_back(&correction);
    }
    for (const FormulationCorrection& correction : task->formulationCorrections) {
        if (correction.status != FormulationCorrectionStatus::Pending) view.corrections.push_back(&correction);
    }

    view.firstReadingOwed = firstFormulationDecisionOwed(*task);
    view.recheckOwed = formulationRecheckOwed(*task);
    view.decisionOwed = view.firstReadingOwed || view.recheckOwed;
    view.pendingApplicability = pendingApplicabilityBeliefs(*task);
    view.unrevalidated.clear();
    for (const FormulationApplicabilityEntry* entry : unrevalidatedApplicability(*task)) {
        view.unrevalidated.push_back(entry->beliefId);
    }
    if (view.recheckOwed) {
        if (const ExecutionEpisode* distilled = latestDistilledEpisode(*task)) {
            view.recheckEpisodeOrdinal = distilled->ordinal;
        }
    }
    if (view.review != nullptr) view.reviewVersionId = view.review->versionId;

    // --- the banner, exactly one case -------------------------------------
    // Order is the whole design: what the USER must act on outranks what the
    // agent owes, because the run is paused in the first case and merely owes
    // something in the others.
    if (view.awaitingResponse) {
        view.banner = FrameBanner::AwaitingResponse;
        view.canApprove = true;
    } else if (failed(view.resume)) {
        view.banner = FrameBanner::ApprovalFailed;
        view.bannerDetail = view.resume->reason.value_or(std::string{});
    } else if (view.resume.has_value() && view.resume->phase == FormulationResumePhase::Started) {
        view.banner = FrameBanner::ApprovedContinuing;
    } else if (view.approved) {
        // Covers `settled` as well as "never launched". A continuation that
        // settled is not continuing either, and the phase itself is in the resume
        // block rather than in the banner — §7.2 names exactly four approved
        // states and this is the honest rendering of the second of them.
        view.banner = FrameBanner::ApprovedNoRun;
    } else if (view.firstReadingOwed) {
        view.banner = FrameBanner::ProposeOwesReading;
    } else if (view.recheckOwed) {
        view.banner = FrameBanner::RecheckOwed;
    } else {
        view.banner = FrameBanner::None;
    }
    return view;
}

std::vector<FormulationChip> formulationChips(const NativeGuiModel& model,
                                              const ProblemFormulationVersion& version) {
    std::vector<FormulationChip> chips;
    for (const FormulationSource& source : version.sources) {
        if (pickSource(source) == nullptr) continue;
        FormulationChip chip;
        chip.kind = source.kind;
        chip.label = sourceLabel(model, source);
        switch (source.kind) {
            case FormulationSourceKind::Belief:
                chip.id = source.beliefId;
                chip.opensBeliefs = true;
                break;
            case FormulationSourceKind::Execution:
                chip.id = source.executionId;
                chip.centresCanvas = true;
                break;
            case FormulationSourceKind::Distillation:
                chip.id = source.distillationId;
                chip.centresCanvas = true;
                break;
            case FormulationSourceKind::Prompt:
                chip.id = source.promptId;
                break;
            case FormulationSourceKind::Intervention:
                chip.id = source.interventionId;
                break;
            case FormulationSourceKind::Correction:
                chip.id = source.correctionId;
                break;
            case FormulationSourceKind::Unknown:
                break;
        }
        if (chip.label.empty()) continue;
        chips.push_back(std::move(chip));
    }
    return chips;
}

std::vector<std::string> formulationChangedFields(const ProblemFormulationVersion& previous,
                                                  const ProblemFormulationVersion& next) {
    std::vector<std::string> changed;
    // An optional that is present-and-blank is the same reading as an absent one
    // for display purposes: the tool refuses a blank optional, so both mean the
    // agent had nothing to say about it.
    auto text = [](const std::string& value) { return value; };
    auto optionalText = [](const std::optional<std::string>& value) {
        return value.value_or(std::string{});
    };
    if (text(previous.content.interpretation) != text(next.content.interpretation)) {
        changed.push_back("interpretation");
    }
    if (optionalText(previous.content.alternative) != optionalText(next.content.alternative)) {
        changed.push_back("alternative");
    }
    if (text(previous.content.focus) != text(next.content.focus)) changed.push_back("focus");
    if (optionalText(previous.content.tension) != optionalText(next.content.tension)) {
        changed.push_back("tension");
    }
    if (text(previous.content.implication) != text(next.content.implication)) {
        changed.push_back("implication");
    }
    if (text(previous.reason) != text(next.reason)) changed.push_back("reason");
    return changed;
}

bool autoOpenEdge(const FormulationView& prev, const FormulationView& next,
                  FormulationVersionId& latchVersionId) {
    const bool awaitingEdge = next.awaitingResponse && !prev.awaitingResponse;
    const bool failedEdge = failed(next.resume) && !failed(prev.resume);
    if (!awaitingEdge && !failedEdge) return false;

    // A failed continuation is about the version the continuation was started for;
    // a pause is about the version under review.
    const FormulationVersionId version =
        failedEdge ? next.resume->versionId : next.reviewVersionId;
    if (!version.empty() && version == latchVersionId) return false;
    latchVersionId = version;
    return true;
}

} // namespace pie::gui
