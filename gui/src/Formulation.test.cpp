// M8: the Frame view (docs/milestones.md §7.2).
//
// The pane's two halves are asserted separately, because they come from different
// places and only one of them is replayable:
//
//   * the banner and the content derived from the domain records, exercised by
//     folding PREFIXES of the demo stream — each prefix is a real state of a real
//     round, and stopping mid-stream is how "what does the pane say after the
//     distillation but before the recheck" becomes a test rather than a guess;
//   * the runtime half (`awaitingResponse`, `approved`, `resume`), which no domain
//     event carries, applied through the same `readSessionState` the bootstrap
//     uses.
//
// The auto-open edge gets its own attention: §7.2 makes it the difference between
// a pane that appears when the user must act and one that appears every round.

#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

#include "DemoEvents.h"
#include "DomainEvents.h"
#include "FormulationView.h"
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

// Fold the first `count` events of the demo stream. Prefixes are how a mid-round
// state is produced without hand-writing an event log per case.
static NativeGuiModel foldDemo(size_t count) {
    NativeGuiModel model;
    const std::vector<std::string> events = demoEvents();
    for (size_t i = 0; i < count && i < events.size(); ++i) applyRpcLine(model, events[i]);
    return model;
}

// The index of a demo event by its id, so the prefixes below stay readable and a
// reordered fixture fails loudly instead of silently shifting a test's meaning.
static size_t indexOfEvent(const std::string& eventId) {
    const std::vector<std::string> events = demoEvents();
    for (size_t i = 0; i < events.size(); ++i) {
        if (events[i].find("\"eventId\":\"" + eventId + "\"") != std::string::npos) return i;
    }
    return events.size();
}

// Apply a `get_state` payload — the same reader the bootstrap uses, so the test
// cannot pass on a shape the wire would never produce.
static void applyState(NativeGuiModel& model, const std::string& stateJson) {
    json::Value value;
    json::ParseError error;
    if (!json::parse(stateJson, value, &error)) {
        std::fprintf(stderr, "FAIL: the state fixture is not JSON: %s\n", error.message.c_str());
        ++failures;
        return;
    }
    SessionState state;
    if (!readSessionState(value, state)) {
        std::fprintf(stderr, "FAIL: the state fixture did not read\n");
        ++failures;
        return;
    }
    model.applySessionState(std::move(state));
}

int main() {
    // ---------------------------------------------------------------------
    // No task: the pane has nothing to show and says so
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        const FormulationView view = deriveFormulationView(model, nullptr);
        check(!view.hasTask, "an empty session has no Frame to show");
        check(view.banner == FrameBanner::None, "and no banner");
        check(!view.runtimeKnown, "with no get_state the runtime half is UNKNOWN, not false");
        check(!view.canApprove, "and nothing is approvable");
        check(view.current == nullptr && view.history.empty(), "no version and no history");
        check(std::string(frameBannerText(view.banner)).empty(), "FrameBanner::None renders as nothing at all");
    }

    // ---------------------------------------------------------------------
    // The FIRST reading is owed: propose has investigated and named nothing
    // ---------------------------------------------------------------------
    {
        // Built rather than taken from a demo prefix: the demo publishes its first
        // reading BEFORE dispatching the plan, so no prefix of it is the state
        // "investigated, and nothing stated". A plan with no publication is.
        NativeGuiModel model;
        const char* lines[] = {
            R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})",
            R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})",
            R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})",
            R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","plan":{"id":"pl","selectedToExplore":[],"formulation":{"kind":"unformed"}}})",
        };
        for (const char* line : lines) applyRpcLine(model, line);
        check(model.issues().empty(), "the fixture folds without issues");
        const Task* task = model.task("t");
        const FormulationView view = deriveFormulationView(model, task);
        check(view.hasTask && view.current == nullptr, "no reading has been published yet");
        check(view.firstReadingOwed, "a dispatched round with no reading owes one");
        check(!view.recheckOwed, "and it is the FIRST reading, not a reconsideration");
        check(view.banner == FrameBanner::ProposeOwesReading, "so the banner says propose owes a reading");
        check(std::string(frameBannerText(view.banner)) == "propose owes a reading",
              "with the wording §7.2 names");
        check(!view.canApprove, "there is nothing to approve: Approve is not offered");
    }

    // ---------------------------------------------------------------------
    // A reconsideration is owed: the round distilled, the recheck has not come
    // ---------------------------------------------------------------------
    {
        // Through the distillation of episode 1, before its recheck.
        NativeGuiModel model = foldDemo(indexOfEvent("ev-19"));
        const Task* task = model.task("task-1");
        const FormulationView view = deriveFormulationView(model, task);
        check(view.current != nullptr && view.current->ordinal == 1, "the first reading is current");
        check(view.recheckOwed && !view.firstReadingOwed, "the per-round obligation is the one owed");
        check(view.decisionOwed, "decisionOwed of either kind is true");
        check(view.banner == FrameBanner::RecheckOwed, "the banner names the reconsideration");
        check(view.recheckEpisodeOrdinal.has_value() && *view.recheckEpisodeOrdinal == 1,
              "and the episode it is owed for, for the banner's #{ordinal}");
    }

    // ---------------------------------------------------------------------
    // The runtime half: the run is paused, and the banner outranks the rest
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model = foldDemo(indexOfEvent("ev-22"));
        // Without get_state the pause is UNKNOWN. The pane must not guess it from
        // the domain log, where it does not appear.
        {
            const FormulationView view = deriveFormulationView(model, model.task("task-1"));
            check(!view.runtimeKnown, "a domain-only fold cannot know the run is paused");
            check(!view.awaitingResponse && !view.canApprove,
                  "and reports no pause rather than inventing one");
        }
        applyState(model,
                   R"({"sessionId":"session-1","formulation":{"review":{"versionId":"formulation-1"},"awaitingResponse":true,"approved":false}})");
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.runtimeKnown && view.awaitingResponse, "the runtime says the run is paused");
        check(view.banner == FrameBanner::AwaitingResponse, "so the banner asks for the user");
        check(std::string(frameBannerText(view.banner)) == "Waiting for your response",
              "with the wording §7.2 names");
        check(view.canApprove, "and Approve is live");
        check(view.reviewVersionId == "formulation-1",
              "the approval target is the REVIEW's version, which is what approve_frame will accept");
        // No `autoApproveFrame` in that payload, so the toggle is UNKNOWN rather
        // than off: a runtime that did not report it has not said it is disabled,
        // and an unticked box would be exactly that claim.
        check(!view.autoApproveKnown, "an unreported auto-approve toggle is unknown, not off");
    }

    // ---------------------------------------------------------------------
    // The session toggle is not a property of the task's formulation
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model = foldDemo(indexOfEvent("ev-19"));
        applyState(model,
                   R"({"sessionId":"session-1","autoApproveFrame":true,"formulation":{"review":{"versionId":"formulation-1"},"awaitingResponse":true}})");
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.autoApproveKnown && view.autoApproveFrame, "the session toggle is carried");

        // Read even with no task open: it is a setting on the SESSION, and the user
        // can set it before the first reading exists.
        const FormulationView none = deriveFormulationView(model, nullptr);
        check(!none.hasTask, "there is no task to show");
        check(none.autoApproveKnown && none.autoApproveFrame,
              "but the session toggle is still readable, because it is not the task's");

        // And it is NOT gated on the runtime having described THIS task, which is
        // what the pause and the resume are gated on: those describe one task's
        // review, while this describes the session.
        NativeGuiModel other = foldDemo(indexOfEvent("ev-19"));
        applyState(other, R"({"autoApproveFrame":true})");
        check(!deriveFormulationView(other, other.task("task-1")).runtimeKnown,
              "no formulation block means the task-level runtime facts are unknown");
        check(deriveFormulationView(other, other.task("task-1")).autoApproveKnown,
              "but the session toggle is still known");
    }

    // ---------------------------------------------------------------------
    // The banner is exactly one case, in the order the user's own act outranks
    // ---------------------------------------------------------------------
    {
        // Paused AND owing a reconsideration: the pause wins, because the run is
        // stopped in the first case and merely owes something in the second.
        NativeGuiModel model = foldDemo(indexOfEvent("ev-19"));
        applyState(model,
                   R"({"formulation":{"review":{"versionId":"formulation-1"},"awaitingResponse":true,"decisionOwed":true,"recheckOwed":true}})");
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.recheckOwed, "the reconsideration is still owed underneath");
        check(view.banner == FrameBanner::AwaitingResponse, "but the pause is what the banner shows");
    }
    {
        NativeGuiModel model = foldDemo(indexOfEvent("ev-36"));
        applyState(model,
                   R"({"formulation":{"review":{"versionId":"formulation-2"},"approved":true,"resume":{"versionId":"formulation-2","phase":"started"}}})");
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.banner == FrameBanner::ApprovedContinuing, "a started continuation is reported as continuing");
        check(!view.canApprove, "and Approve is withdrawn once the approval is recorded");
    }
    {
        NativeGuiModel model = foldDemo(indexOfEvent("ev-36"));
        applyState(model, R"({"formulation":{"approved":true}})");
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.banner == FrameBanner::ApprovedNoRun,
              "an approval with no continuation says no run is continuing");
    }
    {
        // `settled` is not `started`. §7.2 names four approved states and no
        // separate one for a finished continuation, so it reports the honest half
        // of it: nothing is continuing now.
        NativeGuiModel model = foldDemo(indexOfEvent("ev-36"));
        applyState(model,
                   R"({"formulation":{"approved":true,"resume":{"versionId":"formulation-2","phase":"settled"}}})");
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.banner == FrameBanner::ApprovedNoRun, "a settled continuation is not a continuing one either");
    }
    {
        NativeGuiModel model = foldDemo(indexOfEvent("ev-36"));
        applyState(model,
                   R"({"formulation":{"approved":true,"resume":{"versionId":"formulation-2","phase":"failed","reason":"the provider refused the request"}}})");
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.banner == FrameBanner::ApprovalFailed, "a failed continuation has its own banner");
        check(view.bannerDetail == "the provider refused the request",
              "and carries the reason, which the pane renders after the colon");
    }

    // ---------------------------------------------------------------------
    // A settled task: nothing is owed, so there is no banner
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model = foldDemo(demoEvents().size());
        const Task* task = model.task("task-1");
        const FormulationView view = deriveFormulationView(model, task);
        check(model.issues().empty(), "the whole demo folds without issues");
        check(view.banner == FrameBanner::None, "a settled task shows no banner");
        check(!view.decisionOwed, "because nothing is owed");
        check(view.current != nullptr && view.current->ordinal == 2, "the latest reading is v2");
        check(view.history.size() == 2, "and both versions are in the history");
        check(view.recheck != nullptr && view.recheck->verdict == FormulationRecheckVerdict::Revised,
              "the recheck that settled the obligation is carried");
        check(view.corrections.size() == 1, "the user's correction is carried");
        check(view.corrections[0]->response.has_value(), "with propose's answer to it");
        // A replay has no runtime to answer `get_state`, so the derived half is
        // all there is — and the pane must render the runtime half as unknown
        // rather than as "not paused", which is what this flag is for.
        check(!view.runtimeKnown, "a pure replay reports the runtime half as unknown");
    }

    // ---------------------------------------------------------------------
    // Corrections: a pending one comes first
    // ---------------------------------------------------------------------
    {
        // Through the correction's submission, before propose answered it.
        NativeGuiModel model = foldDemo(indexOfEvent("ev-35"));
        const FormulationView view = deriveFormulationView(model, model.task("task-1"));
        check(view.corrections.size() == 1, "the submitted correction is listed");
        check(view.corrections[0]->status == FormulationCorrectionStatus::Pending,
              "and it is pending");
        check(!view.corrections[0]->response.has_value(), "with no answer yet");
    }

    // ---------------------------------------------------------------------
    // Review obligations: the beliefs that block a conclusion
    // ---------------------------------------------------------------------
    {
        // Through the applicability review, which classified belief-1 as
        // carries-over and left nothing pending.
        NativeGuiModel model = foldDemo(indexOfEvent("ev-36"));
        const Task* task = model.task("task-1");
        const FormulationView view = deriveFormulationView(model, task);
        check(view.pendingApplicability.empty(), "the review's beliefs are all classified");
        check(view.unrevalidated.empty(), "and none is awaiting revalidation");
    }

    // ---------------------------------------------------------------------
    // The source chips: what makes `sources[]` auditable
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model = foldDemo(indexOfEvent("ev-33"));
        const Task* task = model.task("task-1");
        check(task != nullptr && task->formulations.size() == 2, "both versions are recorded");
        const std::vector<FormulationChip> chips = formulationChips(model, task->formulations[1]);
        check(chips.size() == 2, "v2 cites an execution and a belief");
        if (chips.size() == 2) {
            check(chips[0].kind == FormulationSourceKind::Execution && chips[0].id == "exec-3",
                  "the execution chip names the execution");
            check(chips[0].centresCanvas, "and can centre the canvas on it");
            check(chips[1].kind == FormulationSourceKind::Belief && chips[1].id == "belief-1",
                  "the belief chip names the belief");
            // The label is the SAME label the belief pane uses, which is the whole
            // point of the chip: "B1" here and "B1" there are one record.
            check(chips[1].label == model.beliefLabel("belief-1"), "and carries the shared belief label");
            check(chips[1].opensBeliefs, "and can open the belief pane");
        }
        const std::vector<FormulationChip> first = formulationChips(model, task->formulations[0]);
        check(first.size() == 1 && first[0].kind == FormulationSourceKind::Prompt,
              "v1 cites only the prompt it came from");
        check(!first[0].opensBeliefs && !first[0].centresCanvas,
              "a prompt chip has nowhere to go, so it is not clickable");
    }

    // ---------------------------------------------------------------------
    // Changed fields, and NOT a text diff
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model = foldDemo(indexOfEvent("ev-33"));
        const Task* task = model.task("task-1");
        const std::vector<std::string> changed =
            formulationChangedFields(task->formulations[0], task->formulations[1]);
        check(changed.size() == 6, "every field of v2 differs from v1 in this fixture");
        check(std::find(changed.begin(), changed.end(), "interpretation") != changed.end(),
              "the interpretation is marked");
        check(std::find(changed.begin(), changed.end(), "tension") != changed.end(),
              "a field that went from present to absent is marked");
        check(std::find(changed.begin(), changed.end(), "reason") != changed.end(),
              "and the reason is marked");
        // The same version against itself changes nothing: the markers come from
        // the values, not from the version being newer.
        check(formulationChangedFields(task->formulations[1], task->formulations[1]).empty(),
              "a version compared with itself marks nothing");
    }

    // ---------------------------------------------------------------------
    // The auto-open edge
    // ---------------------------------------------------------------------
    {
        FormulationVersionId latch;

        FormulationView prev;
        FormulationView next;
        check(!autoOpenEdge(prev, next, latch), "a quiet frame opens nothing");

        // The pause appears.
        next.awaitingResponse = true;
        next.reviewVersionId = "formulation-1";
        check(autoOpenEdge(prev, next, latch), "the awaitingResponse edge opens the pane");
        check(latch == "formulation-1", "and latches the version it opened for");

        // The user closes it; the state is unchanged.
        prev = next;
        check(!autoOpenEdge(prev, next, latch), "a state that did not change opens nothing again");

        // A RECONNECT re-delivers the same state from a fresh view, which is the
        // case the latch exists for: the user has already seen this version.
        FormulationView fresh;
        check(!autoOpenEdge(fresh, next, latch), "a reconnect does not re-open the pane for a version already seen");

        // A NEW version is a new thing to see.
        FormulationView newer = next;
        newer.reviewVersionId = "formulation-2";
        check(autoOpenEdge(fresh, newer, latch), "a new version opens the pane again");
        check(latch == "formulation-2", "and moves the latch with it");

        // A failed continuation is the other trigger, and is keyed on the version
        // the continuation was started for.
        FormulationView pending;
        FormulationView failedView;
        failedView.resume = FormulationResumeState{"formulation-9", FormulationResumePhase::Failed, "boom"};
        check(autoOpenEdge(pending, failedView, latch), "a failed continuation opens the pane");
        check(latch == "formulation-9", "latched to the version the continuation was for");

        // decisionOwed is NOT a trigger, however loudly it fires: §7.2 is explicit
        // that it is a badge on the banner, because it fires nearly every round.
        FormulationView owes;
        FormulationVersionId owesLatch;
        owes.decisionOwed = true;
        owes.recheckOwed = true;
        check(!autoOpenEdge(FormulationView{}, owes, owesLatch), "an owed decision does not open the pane");
        check(owesLatch.empty(), "and does not touch the latch");
    }

    // ---------------------------------------------------------------------
    // The runtime state is only applied to the task it describes
    // ---------------------------------------------------------------------
    {
        // A get_state describes the ACTIVE task. Applying its pause to a
        // historical task would put this moment's waiting on a round that ended
        // long ago.
        NativeGuiModel model = foldDemo(demoEvents().size());
        applyState(model, R"({"formulation":{"review":{"versionId":"formulation-2"},"awaitingResponse":true}})");
        const Task* task = model.task("task-1");
        // The cursor still points at task-1 after TaskClosed, so the state applies;
        // this asserts the guard reads the CURSOR rather than applying blindly.
        const FormulationView view = deriveFormulationView(model, task);
        check(view.runtimeKnown, "the state describes the cursor's task, so it is applied");
        check(view.banner == FrameBanner::AwaitingResponse, "and the pause shows");

        // A task the cursor is not on gets the derived half only.
        Task other;
        other.id = "task-2";
        const FormulationView otherView = deriveFormulationView(model, &other);
        check(!otherView.runtimeKnown, "a task the runtime did not describe has no runtime half");
        check(!otherView.awaitingResponse, "so its banner cannot claim a pause");
        check(otherView.banner == FrameBanner::None, "and it shows no banner");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
