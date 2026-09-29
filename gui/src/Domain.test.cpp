// Headless unit tests for the v7 domain fold (docs/milestones.md M2).
// Run: ./pi_gui_domain_test   (returns non-zero on failure).
//
// Replaces the v1-era pi_gui_model_test. What it pins down:
//  * the wire vocabulary is v7 (a v1 line is not silently misread),
//  * a full scripted stream folds into the expected snapshot,
//  * every applier is idempotent — the property the snapshot/stream overlap
//    depends on (docs/milestones.md §5.3),
//  * belief status is derived from provenance, never stored,
//  * a closed episode is immutable,
//  * display labels come from record order, not an accumulator,
//  * a log the runtime itself would reject becomes a ReplayIssue, never a crash
//    and never silence,
//  * the RPC telemetry and the in-message stream still behave.

#include "DomainEvents.h"
#include "DemoEvents.h"
#include "Model.h"

#include <cstdio>
#include <string>
#include <vector>

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

// Feed a raw wire line through the real parse + apply path.
static bool feedLine(NativeGuiModel& model, const std::string& line, const char* what = nullptr) {
    DomainEvent event;
    const DomainParseResult result = parseDomainEvent(line, event, nullptr);
    if (result != DomainParseResult::Parsed) {
        std::fprintf(stderr, "FAIL(fixture): %s did not parse as a domain event\n", what ? what : line.c_str());
        ++failures;
        return false;
    }
    model.applyDomainEvent(event);
    return true;
}

// Replay the whole scripted fixture.
static void feedDemo(NativeGuiModel& model) {
    for (const std::string& line : demoEvents()) {
        DomainEvent event;
        if (parseDomainEvent(line, event, nullptr) != DomainParseResult::Parsed) {
            std::fprintf(stderr, "FAIL(fixture): demo line did not parse:\n  %s\n", line.c_str());
            ++failures;
            continue;
        }
        if (!model.applyDomainEvent(event)) {
            std::fprintf(stderr, "FAIL(fixture): demo line was not recognized:\n  %s\n", line.c_str());
            ++failures;
        }
    }
}

int main() {
    // ---------------------------------------------------------------------
    // The vocabulary is v7. The old names are NOT aliased onto the new ones:
    // a v1 log must be refused rather than replayed with records missing.
    // ---------------------------------------------------------------------
    {
        check(domainEventKindFromName("EpisodeOpened") == DomainEventKind::EpisodeOpened, "v7: EpisodeOpened is known");
        check(domainEventKindFromName("BeliefDeltaApplied") == DomainEventKind::BeliefDeltaApplied,
              "v7: BeliefDeltaApplied is known");
        check(domainEventKindFromName("FrameOpened") == DomainEventKind::Unknown, "v1: FrameOpened is not a v7 event");
        check(domainEventKindFromName("FrameBodySelected") == DomainEventKind::Unknown,
              "v1: FrameBodySelected is not a v7 event");
        check(domainEventKindFromName("FrameClosed") == DomainEventKind::Unknown, "v1: FrameClosed is not a v7 event");
        check(domainEventKindFromName("nonsense") == DomainEventKind::Unknown, "an unknown name is Unknown");

        // Every kind has a wire name and round-trips, and the count matches the
        // authoritative DOMAIN_EVENT_APPLIERS list.
        size_t named = 0;
        for (size_t i = 0; i < 25; ++i) {
            const DomainEventKind kind = static_cast<DomainEventKind>(i + 1);
            const char* name = domainEventKindName(kind);
            if (name == nullptr || std::string(name) == "Unknown") continue;
            ++named;
            if (domainEventKindFromName(name) != kind) {
                std::fprintf(stderr, "FAIL: %s does not round-trip\n", name);
                ++failures;
            }
        }
        check(named == kDomainEventKindCount, "every kind has a distinct wire name");

        // A v1 line names a type that v7 does not have: it is simply not a domain
        // event, so nothing is applied and no issue is raised.
        NativeGuiModel model;
        const std::string v1 =
            R"({"type":"FrameOpened","schemaVersion":1,"eventId":"ev-1","taskId":"task-1","frameId":"frame-1","ordinal":1})";
        DomainEvent event;
        check(parseDomainEvent(v1, event, nullptr) == DomainParseResult::NotDomainEvent,
              "a v1 line is not a v7 domain event");
        check(model.snapshot().tasks.empty(), "a v1 line leaves the task registry empty");
    }

    // ---------------------------------------------------------------------
    // A non-domain line is routed elsewhere rather than misapplied.
    // ---------------------------------------------------------------------
    {
        DomainEvent event;
        check(parseDomainEvent(R"({"type":"message_start","message":{"role":"assistant"}})", event, nullptr) ==
                  DomainParseResult::NotDomainEvent,
              "message_start is not a domain event");
        check(parseDomainEvent("not json", event, nullptr) == DomainParseResult::Malformed, "garbage is Malformed");
        check(parseDomainEvent("[1,2]", event, nullptr) == DomainParseResult::Malformed, "a non-object is Malformed");
        check(parseDomainEvent(R"({"foo":1})", event, nullptr) == DomainParseResult::Malformed, "a line with no type is Malformed");
        // A wrong schema version IS a domain event by name; the fold refuses it.
        NativeGuiModel model;
        DomainEvent v8;
        check(parseDomainEvent(
                  R"({"type":"EpisodeOpened","schemaVersion":8,"eventId":"ev-9","taskId":"t","episodeId":"e","ordinal":1})",
                  v8, nullptr) == DomainParseResult::Parsed,
              "a v8 line parses by name");
        model.applyDomainEvent(v8);
        check(model.issues().size() == 1, "a v8 line raises exactly one issue");
        check(!model.issues().empty() && model.issues()[0].message.find("schema version") != std::string::npos,
              "the issue names the schema version");
        check(model.snapshot().tasks.empty(), "a v8 line applies nothing");
    }

    // ---------------------------------------------------------------------
    // The full scripted stream folds into the expected snapshot.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedDemo(model);
        if (!model.issues().empty()) {
            for (const ReplayIssue& issue : model.issues()) {
                std::fprintf(stderr, "  issue: %s (%s): %s\n", issue.eventType.c_str(), issue.eventId.c_str(),
                             issue.message.c_str());
            }
        }
        check(model.issues().empty(), "the scripted stream replays with no issues");

        check(model.tasks().size() == 1, "one task");

        const Task* task = model.task("task-1");
        check(task != nullptr, "task-1 exists");
        if (task != nullptr) {
            check(task->status == TaskStatus::Completed, "task completed");
            check(task->initialTarget.has_value() && task->initialTarget->statement == "Is pytest available in the runtime?",
                  "target recorded");
            check(task->episodes.size() == 2, "two episodes");
            check(task->focusDeclared, "focus declared");
            check(task->focus.size() == 1 && task->focus[0] == "belief-1", "focus holds belief-1");
            check(task->inFocus("belief-1"), "inFocus answers from the declared slice");
            check(!task->inFocus("belief-2"), "an undeclared belief is out of focus");
            check(task->taskOutcome.has_value() && task->taskOutcome->present(), "task outcome recorded");
            check(task->taskOutcome.has_value() &&
                      task->taskOutcome->blockers == "only the local runtime was checked",
                  "outcome blockers survive");
            check(task->introducedBeliefs.size() == 2, "two beliefs introduced by this task");

            // --- Episode 1 ---
            const ExecutionEpisode* ep1 = task->episode("episode-1");
            check(ep1 != nullptr, "episode-1 exists");
            if (ep1 != nullptr) {
                check(ep1->ordinal == 1, "episode-1 ordinal");
                check(ep1->status == EpisodeStatus::Closed, "episode-1 closed");
                check(ep1->stage == EpisodeStage::Closed, "episode-1 stage closed");
                check(ep1->routing.has_value() && ep1->routing->decision == RoutingDecision::BeliefLoop,
                      "episode-1 routing is belief-loop");
                check(ep1->routing.has_value() && ep1->routing->difficulty == RoutingDifficulty::Medium,
                      "episode-1 routing difficulty");
                check(!ep1->experimentSelection.has_value(), "the plan committed episode-1's selection");
                check(ep1->body.kind == EpisodeBodyKind::BeliefLoop, "episode-1 body is belief-loop");
                check(ep1->body.plan.has_value() && ep1->body.plan->id == "plan-1", "episode-1 plan");
                check(ep1->body.plan.has_value() && ep1->body.plan->intent.has_value(),
                      "the plan carries its intent");
                check(ep1->body.plan.has_value() &&
                          ep1->body.plan->formulation.kind == FormulationAdoptionKind::Version &&
                          ep1->body.plan->formulation.versionId == "formulation-1",
                      "the plan names the version it ran under");
                check(ep1->body.plan.has_value() && ep1->body.plan->advancementAction.has_value() &&
                          ep1->body.plan->advancementCondition.has_value() && ep1->body.plan->advancementNext.has_value(),
                      "the plan's advancement is whole");
                check(ep1->body.trajectory.size() == 2, "episode-1 has two executions");
                check(ep1->execution("exec-1") != nullptr &&
                          ep1->execution("exec-1")->status == ExecutionStatus::Succeeded,
                      "exec-1 succeeded");
                check(ep1->execution("exec-1") != nullptr && ep1->execution("exec-1")->inputSummary == "requirements.txt",
                      "exec-1 input summarized from `path`");
                check(ep1->execution("exec-2") != nullptr && ep1->execution("exec-2")->status == ExecutionStatus::Failed,
                      "exec-2 failed");
                check(ep1->execution("exec-2") != nullptr && ep1->execution("exec-2")->error.has_value() &&
                          *ep1->execution("exec-2")->error == "Package(s) not found: pytest",
                      "exec-2 carries its error text");
                check(ep1->execution("exec-2") != nullptr && ep1->execution("exec-2")->planId.has_value() &&
                          *ep1->execution("exec-2")->planId == "plan-1",
                      "exec-2 names its plan (the plan->execution edge)");
                check(ep1->body.distillation.has_value() && ep1->body.distillation->id == "distillation-1",
                      "episode-1 distillation");
                check(ep1->body.distillation.has_value() && ep1->body.distillation->inputs.size() == 2,
                      "distillation names its execution inputs");
                check(ep1->body.distillation.has_value() && ep1->body.distillation->outputs.size() == 1 &&
                          ep1->body.distillation->outputs[0] == "delta-3",
                      "distillation names its belief-delta outputs");
                // Two propose deltas plus one distill delta, in arrival order.
                check(ep1->body.beliefDeltas.size() == 3, "episode-1 holds three belief deltas");
                check(ep1->body.beliefDeltas.size() == 3 && ep1->body.beliefDeltas[0].id == "delta-1" &&
                          ep1->body.beliefDeltas[1].id == "delta-2" && ep1->body.beliefDeltas[2].id == "delta-3",
                      "episode-1's deltas are in arrival order");
                check(ep1->body.beliefDeltas.size() == 3 &&
                          ep1->body.beliefDeltas[0].producerPhase == BeliefDeltaProducerPhase::Propose &&
                          ep1->body.beliefDeltas[2].producerPhase == BeliefDeltaProducerPhase::Distill,
                      "the producer phase is explicit, not inferred from event order");
                check(ep1->body.beliefDeltas.size() == 3 &&
                          ep1->body.beliefDeltas[2].distillationId.has_value() &&
                          *ep1->body.beliefDeltas[2].distillationId == "distillation-1",
                      "the distill-phase delta names its distillation");
                check(ep1->body.beliefDeltas.size() == 3 && !ep1->body.beliefDeltas[0].distillationId.has_value(),
                      "a propose-phase delta names no distillation");
                check(ep1->body.openBeliefsAtStart.empty(), "episode-1 opened on an empty belief set");
            }

            // --- Episode 2 ---
            const ExecutionEpisode* ep2 = task->episode("episode-2");
            check(ep2 != nullptr, "episode-2 exists");
            if (ep2 != nullptr) {
                check(ep2->ordinal == 2, "episode-2 ordinal");
                check(ep2->body.openBeliefsAtStart.size() == 1, "episode-2 opened on belief-1");
                check(ep2->body.plan.has_value() && ep2->body.plan->selectedToExplore.size() == 1,
                      "episode-2 plan selects one belief");
                check(ep2->body.distillation.has_value() &&
                          ep2->body.distillation->outputs[0] == "delta-4",
                      "episode-2 distillation output");
            }

            // --- Formulation history ---
            check(task->formulations.size() == 2, "two formulation versions");
            const ProblemFormulationVersion* current = currentFormulation(*task);
            check(current != nullptr && current->id == "formulation-2", "the current version is the revision");
            check(current != nullptr && current->ordinal == 2, "the revision is ordinal 2");
            check(current != nullptr && current->previousVersionId.has_value() &&
                      *current->previousVersionId == "formulation-1",
                  "the revision chains to its predecessor");
            check(current != nullptr && current->content.alternative.has_value(),
                  "the revision states an optional alternative");
            check(current != nullptr && !current->content.tension.has_value(),
                  "an absent optional stays absent rather than blank");
            check(current != nullptr && current->sources.size() == 2, "the revision cites two sources");
            check(current != nullptr && current->sources.size() == 2 &&
                      current->sources[1].kind == FormulationSourceKind::Belief &&
                      current->sources[1].beliefDeltaId == "delta-4",
                  "a belief source is cited with the delta that recorded its state");

            // --- Correction ---
            check(task->formulationCorrections.size() == 1, "one correction");
            if (!task->formulationCorrections.empty()) {
                const FormulationCorrection& correction = task->formulationCorrections[0];
                check(correction.status == FormulationCorrectionStatus::Resolved, "the correction is resolved");
                check(correction.response.has_value(), "the correction carries propose's response");
                check(correction.recordedVersionId.has_value() && *correction.recordedVersionId == "formulation-2",
                      "the correction names the version published while answering it");
            }
            check(pendingFormulationCorrections(*task).empty(), "no correction is left pending");

            // --- Review, applicability, approval, recheck ---
            check(task->formulationReview.has_value(), "a review is owed/held");
            if (task->formulationReview.has_value()) {
                const FormulationReview& review = *task->formulationReview;
                check(review.versionId == "formulation-2", "the review names the current version");
                check(review.approval.has_value(), "the version was approved");
                check(review.approval.has_value() && review.approval->versionId == "formulation-2",
                      "the approval is bound to the version it approved");
                check(review.scopedBeliefIds.size() == 1, "one belief is in the review scope");
                check(applicabilityComplete(review), "every scoped belief carries a live decision");
                check(review.applicability.size() == 1 &&
                          review.applicability[0].decision == FormulationApplicabilityDecision::CarriesOver,
                      "belief-1 carries over");
                check(review.focusReviewed, "the reading counts as reviewed");
            }
            check(pendingApplicabilityBeliefs(*task).empty(), "no belief awaits classification");
            check(unrevalidatedApplicability(*task).empty(), "nothing awaits revalidation");
            check(task->formulationRecheck.has_value(), "a recheck is recorded");
            check(task->formulationRecheck.has_value() &&
                      task->formulationRecheck->verdict == FormulationRecheckVerdict::Revised,
                  "the latest recheck is the revision");
            check(task->formulationRecheck.has_value() && task->formulationRecheck->versionId.has_value() &&
                      *task->formulationRecheck->versionId == "formulation-2",
                  "a revised recheck names the version it published");

            // --- The gates are settled ---
            check(!firstFormulationDecisionOwed(*task), "the first decision is settled");
            check(!formulationRecheckOwed(*task), "the per-round recheck is settled");
            check(!formulationDecisionOwed(*task), "no formulation decision is owed");

            // --- The latest dispatched round's adoption ---
            const std::optional<FormulationAdoption> adoption = latestFormulationAdoption(*task);
            check(adoption.has_value() && adoption->kind == FormulationAdoptionKind::Version &&
                      adoption->versionId == "formulation-1",
                  "the latest dispatched round ran under formulation-1");
            check(latestDispatchedEpisodeOrdinal(*task).value_or(0) == 2, "the latest dispatched ordinal is 2");
            check(latestDistilledEpisode(*task) != nullptr && latestDistilledEpisode(*task)->id == "episode-2",
                  "the latest distilled round is episode-2");
        }

        // --- The belief registry ---
        check(model.beliefs().size() == 2, "two beliefs registered");
        const Belief* b1 = model.belief("belief-1");
        check(b1 != nullptr, "belief-1 exists");
        if (b1 != nullptr) {
            check(b1->domain == BeliefDomain::Code, "belief-1 domain is code");
            check(b1->supportedBy.size() == 1, "belief-1 has one support");
            check(b1->refutedBy.size() == 1, "belief-1 has one refutation");
            // Derived, never stored: refuted outranks supported.
            check(b1->status() == BeliefStatus::Refuted, "belief-1 status derives to refuted");
            check(std::string(toString(b1->status())) == "refuted", "the derived status spells as the wire does");
        }
        const Belief* b2 = model.belief("belief-2");
        check(b2 != nullptr && b2->status() == BeliefStatus::Proposed, "belief-2 is still proposed");

        // --- Display labels come from record order ---
        check(model.beliefLabel("belief-1") == "B1", "the first recorded belief is B1");
        check(model.beliefLabel("belief-2") == "B2", "the second recorded belief is B2");
        check(model.beliefLabel("belief-unknown") == "belief-unknown", "an unknown belief falls back to its id");

        // --- The cursor came only from CursorChanged (and from the close that
        // mirrors it), never from an inferred stage ---
        check(model.cursor().episodeId == "episode-1", "the cursor names the episode that last reported a stage");
        check(model.cursor().stage == EpisodeStage::Closed,
              "closing the cursored episode moves the cursor to closed");

        // --- The session file list followed the domain events ---
        const auto& files = model.fileList();
        check(files.size() == 1, "one file op recorded from exec-1");
        check(!files.empty() && files[0].op == "read" && files[0].path == "requirements.txt",
              "the read path came from the execution");
    }

    // ---------------------------------------------------------------------
    // Idempotence: replaying the SAME stream a second time changes nothing.
    // This is the property the snapshot/stream overlap rests on
    // (docs/milestones.md §5.3).
    // ---------------------------------------------------------------------
    {
        NativeGuiModel once;
        feedDemo(once);
        const size_t issuesAfterFirst = once.issues().size();
        const size_t beliefsAfterFirst = once.beliefs().size();

        for (const std::string& line : demoEvents()) {
            DomainEvent event;
            if (parseDomainEvent(line, event, nullptr) != DomainParseResult::Parsed) continue;
            once.applyDomainEvent(event);
        }

        check(once.issues().size() == issuesAfterFirst, "a second replay raises no new issues");
        check(once.beliefs().size() == beliefsAfterFirst, "a second replay does not duplicate beliefs");
        check(once.beliefLabel("belief-1") == "B1", "record order survives a replay (labels do not drift)");
        const Task* task = once.task("task-1");
        check(task != nullptr && task->episodes.size() == 2, "episodes are not duplicated by a replay");
        check(task != nullptr && task->formulations.size() == 2, "versions are not duplicated by a replay");
        check(task != nullptr && task->episode("episode-1") != nullptr &&
                  task->episode("episode-1")->body.trajectory.size() == 2,
              "executions are not duplicated by a replay");
        check(task != nullptr && task->episode("episode-1") != nullptr &&
                  task->episode("episode-1")->body.beliefDeltas.size() == 3,
              "belief deltas are not duplicated by a replay");
        check(task != nullptr && task->episode("episode-1") != nullptr &&
                  task->episode("episode-1")->body.distillation.has_value(),
              "the distillation survives a replay");
        check(task != nullptr && task->formulationCorrections.size() == 1, "corrections are not duplicated");
        check(once.cursor().stage == EpisodeStage::Closed, "the cursor is unchanged by a replay");
        check(task != nullptr && task->formulationReview.has_value() &&
                  task->formulationReview->applicability.size() == 1,
              "applicability decisions are not duplicated by a replay");
    }

    // ---------------------------------------------------------------------
    // Immutability: events arriving after an episode closed must not rewrite it.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedDemo(model);
        const Task* before = model.task("task-1");
        const size_t trajectory = before->episode("episode-1")->body.trajectory.size();
        const size_t deltas = before->episode("episode-1")->body.beliefDeltas.size();

        // A late execution for a closed episode is refused, and said so.
        const std::string late =
            R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"ev-late","taskId":"task-1","episodeId":"episode-1","execution":{"id":"exec-late","planId":"plan-1","tool":"bash","input":{"command":"true"}}})";
        DomainEvent event;
        parseDomainEvent(late, event, nullptr);
        model.applyDomainEvent(event);

        const Task* after = model.task("task-1");
        check(after->episode("episode-1")->body.trajectory.size() == trajectory,
              "a closed episode does not gain executions");
        check(after->episode("episode-1")->body.beliefDeltas.size() == deltas,
              "a closed episode does not gain belief deltas");
        check(after->episode("episode-1")->status == EpisodeStatus::Closed, "the closed episode stays closed");
        check(!model.issues().empty(), "the refusal is reported rather than swallowed");
    }

    // ---------------------------------------------------------------------
    // Invariant violations become issues and no-ops — never a crash, never
    // silence. (The design keeps the GUI from dying on a log the runtime itself
    // would reject.)
    // ---------------------------------------------------------------------
    {
        // A non-consecutive episode ordinal, on a task that is still active so
        // the ordinal check is the one that fires.
        NativeGuiModel ordinal;
        feedLine(ordinal, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(ordinal, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep-9","ordinal":9})", "skipped ordinal");
        check(ordinal.task("t")->episodes.empty(), "a first episode numbered 9 does not open");
        check(ordinal.issues().size() == 1 &&
                  ordinal.issues()[0].message.find("does not follow") != std::string::npos,
              "the ordinal issue is reported");

        // A duplicate TaskOpened for a live task.
        NativeGuiModel dup;
        feedLine(dup, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"ev-1","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"x","effective":"x"},"inheritedBeliefs":[]})", "TaskOpened");
        feedLine(dup, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"ev-2","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"x","effective":"x"},"inheritedBeliefs":[]})", "TaskOpened again");
        check(dup.tasks().size() == 1, "a duplicate TaskOpened does not create a second task");
        check(dup.issues().empty(), "an identical duplicate TaskOpened is a silent no-op");

        feedLine(dup, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"ev-3","taskId":"task-1","initialPrompt":{"id":"other","original":"y","effective":"y"},"inheritedBeliefs":[]})", "conflicting TaskOpened");
        check(dup.issues().size() == 1, "a CONFLICTING duplicate TaskOpened is reported");
        check(dup.tasks().size() == 1, "a conflicting duplicate still does not create a second task");

        // A belief delta that does not carry its own result.
        NativeGuiModel badDelta;
        feedLine(badDelta, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(badDelta, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(badDelta, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        feedLine(badDelta,
                 R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","delta":{"id":"d1","episodeId":"ep","producerPhase":"propose","operation":"propose","resultBeliefId":"b1","resultingBeliefs":[{"id":"b2","statement":"s","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":[]})",
                 "delta without its result");
        check(badDelta.beliefs().empty(), "a delta that omits its own result applies nothing");
        check(!badDelta.issues().empty(), "the omission is reported");

        // A dangling citation is reported but the record is still kept: a
        // debugger must show what the runtime said.
        NativeGuiModel dangling;
        feedLine(dangling, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":["belief-absent"]})", "task with a dangling inherited belief");
        check(dangling.tasks().size() == 1, "a task with a dangling inherited belief is still recorded");
        check(!dangling.issues().empty(), "the dangling inherited belief is reported");
    }

    // ---------------------------------------------------------------------
    // Belief status precedence: superseded > refuted > supported > inconclusive
    // > proposed. The status is derived, never stored.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        const char* head =
            R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})";
        feedLine(model, head, "task");
        feedLine(model, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(model, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");

        auto propose = [&](const char* deltaId, const char* beliefId, const char* supported, const char* refuted,
                           const char* inconclusive) {
            std::string line = R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":")";
            line += deltaId;
            line += R"(","taskId":"t","episodeId":"ep","delta":{"id":")";
            line += deltaId;
            line += R"(","episodeId":"ep","producerPhase":"propose","operation":"propose","resultBeliefId":")";
            line += beliefId;
            line += R"(","resultingBeliefs":[{"id":")";
            line += beliefId;
            line += R"(","statement":"s","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":)";
            line += supported;
            line += R"(,"refutedBy":)";
            line += refuted;
            line += R"(,"inconclusiveBy":)";
            line += inconclusive;
            line += R"(,"withdrawn":false}]},"activeBeliefs":[]})";
            feedLine(model, line, "belief delta");
        };

        propose("d1", "b-plain", "[]", "[]", "[]");
        propose("d2", "b-sup", R"([{"evidence":"e"}])", "[]", "[]");
        propose("d3", "b-ref", "[]", R"([{"evidence":"e"}])", "[]");
        propose("d4", "b-inc", "[]", "[]", R"([{"evidence":"e"}])");
        // Both supported and refuted: refuted wins.
        propose("d5", "b-both", R"([{"evidence":"s"}])", R"([{"evidence":"r"}])", "[]");

        check(model.belief("b-plain")->status() == BeliefStatus::Proposed, "precedence: plain -> proposed");
        check(model.belief("b-sup")->status() == BeliefStatus::Supported, "precedence: support -> supported");
        check(model.belief("b-ref")->status() == BeliefStatus::Refuted, "precedence: refutation -> refuted");
        check(model.belief("b-inc")->status() == BeliefStatus::Inconclusive, "precedence: inconclusive -> inconclusive");
        check(model.belief("b-both")->status() == BeliefStatus::Refuted, "precedence: refuted outranks supported");

        // Withdrawal and supersession both derive to superseded, and superseded
        // outranks refuted.
        NativeGuiModel sup;
        feedLine(sup, head, "task");
        feedLine(sup, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(sup, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        feedLine(sup,
                 R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"d1","taskId":"t","episodeId":"ep","delta":{"id":"d1","episodeId":"ep","producerPhase":"distill","operation":"refine","sourceBeliefId":"b1","resultBeliefId":"b2","resultingBeliefs":[{"id":"b1","statement":"s","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[{"evidence":"r"}],"supersededBy":"b2","withdrawn":false},{"id":"b2","statement":"s2","domain":"code","expectation":"e2","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b2"]})",
                 "refinement");
        check(sup.belief("b1") != nullptr && sup.belief("b1")->status() == BeliefStatus::Superseded,
              "precedence: superseded outranks refuted");
        check(sup.belief("b1") != nullptr && sup.belief("b1")->supersededBy.has_value() &&
                  *sup.belief("b1")->supersededBy == "b2",
              "a refinement records both sides of the chain");
        check(sup.belief("b2") != nullptr && sup.belief("b2")->status() == BeliefStatus::Proposed,
              "the refinement's successor is its own record");
        check(sup.beliefs().size() == 2, "both sides of a refinement are registered");
    }

    // ---------------------------------------------------------------------
    // The formulation gates: what propose owes, and what settles it.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedLine(model, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(model, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(model, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        check(!firstFormulationDecisionOwed(*model.task("t")), "nothing is owed before the first dispatch");

        // Routing and a body alone are not an investigation.
        feedLine(model, R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","routing":{"id":"r","statement":"s","decision":"belief-loop","suitabilityProbability":0.5,"successProbability":0.5,"estimatedSteps":1,"difficulty":"low","reason":"r"}})", "routing");
        check(!firstFormulationDecisionOwed(*model.task("t")), "routing alone does not create the obligation");

        // A plan is a dispatch, so now a reading is owed.
        feedLine(model, R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e5","taskId":"t","episodeId":"ep","plan":{"id":"pl","selectedToExplore":[],"formulation":{"kind":"unformed"}}})", "plan");
        check(firstFormulationDecisionOwed(*model.task("t")), "a dispatch owes the first reading");
        check(formulationDecisionOwed(*model.task("t")), "and therefore a formulation decision");
        check(!formulationRecheckOwed(*model.task("t")), "but not a per-round recheck");

        // Publishing settles it for good.
        feedLine(model,
                 R"({"type":"ProblemFormulationRecorded","schemaVersion":7,"eventId":"e6","taskId":"t","version":{"id":"f1","taskId":"t","ordinal":1,"recordedAt":"now","origin":"propose","content":{"interpretation":"i","focus":"f","implication":"im"},"reason":"r","sources":[{"kind":"prompt","promptId":"p"}]}})",
                 "formulation");
        check(!firstFormulationDecisionOwed(*model.task("t")), "publishing settles the first decision");
        check(!formulationRecheckOwed(*model.task("t")), "an undistilled round owes no recheck");

        // A distillation creates the per-round obligation.
        feedLine(model,
                 R"({"type":"DistillationProduced","schemaVersion":7,"eventId":"e7","taskId":"t","episodeId":"ep","distillation":{"id":"ds","inputs":[],"contents":"c","outputs":[]}})",
                 "distillation");
        check(latestDistilledEpisode(*model.task("t")) != nullptr, "the distilled round is found");
        check(formulationRecheckOwed(*model.task("t")), "a distilled round owes a recheck");
        check(formulationDecisionOwed(*model.task("t")), "and therefore a formulation decision");

        // Recording the recheck settles it.
        feedLine(model,
                 R"({"type":"FormulationRecheckRecorded","schemaVersion":7,"eventId":"e8","taskId":"t","episodeId":"ep","recheck":{"episodeId":"ep","verdict":"maintained","reason":"r","recordedAt":"now"}})",
                 "recheck");
        check(!formulationRecheckOwed(*model.task("t")), "recording the recheck settles it");
        check(!formulationDecisionOwed(*model.task("t")), "nothing is owed once both are settled");

        // A recheck that claims a revision without naming the version is refused.
        NativeGuiModel bad;
        feedLine(bad, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(bad, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(bad, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        feedLine(bad, R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","plan":{"id":"pl","selectedToExplore":[],"formulation":{"kind":"unformed"}}})", "plan");
        feedLine(bad, R"({"type":"DistillationProduced","schemaVersion":7,"eventId":"e5","taskId":"t","episodeId":"ep","distillation":{"id":"ds","inputs":[],"contents":"c","outputs":[]}})", "distillation");
        feedLine(bad, R"({"type":"FormulationRecheckRecorded","schemaVersion":7,"eventId":"e6","taskId":"t","episodeId":"ep","recheck":{"episodeId":"ep","verdict":"revised","reason":"r","recordedAt":"now"}})", "unversioned revision");
        check(!bad.task("t")->formulationRecheck.has_value(), "a revised recheck must name its version");
        check(!bad.issues().empty(), "the missing version is reported");
    }

    // ---------------------------------------------------------------------
    // The approval gate: rejecting "nothing was waiting" instead of reporting it
    // as consent (docs/milestones.md §3.4).
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedLine(model, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(model, R"({"type":"ProblemFormulationRecorded","schemaVersion":7,"eventId":"e2","taskId":"t","version":{"id":"f1","taskId":"t","ordinal":1,"recordedAt":"now","origin":"propose","content":{"interpretation":"i","focus":"f","implication":"im"},"reason":"r","sources":[{"kind":"prompt","promptId":"p"}]}})", "formulation");

        // Approving an unknown version is refused.
        feedLine(model, R"({"type":"FormulationApproved","schemaVersion":7,"eventId":"e3","taskId":"t","versionId":"f-nope","approvedAt":"now"})", "bad approval");
        check(!model.task("t")->formulationReview->approval.has_value(), "an unknown version cannot be approved");
        check(!model.issues().empty(), "the unknown version is reported");

        // An unanswered objection blocks consent.
        feedLine(model, R"({"type":"FormulationCorrectionSubmitted","schemaVersion":7,"eventId":"e4","taskId":"t","correction":{"id":"c1","taskId":"t","targetVersionId":"f1","original":"you have this wrong","receivedAt":"now","status":"pending"}})", "correction");
        feedLine(model, R"({"type":"FormulationApproved","schemaVersion":7,"eventId":"e5","taskId":"t","versionId":"f1","approvedAt":"now"})", "approval of an objected version");
        check(!model.task("t")->formulationReview->approval.has_value(),
              "a version with an unanswered objection is not approved");
        check(model.task("t")->formulationReview->responseCorrectionId.has_value() &&
                  *model.task("t")->formulationReview->responseCorrectionId == "c1",
              "the objection is recorded against the review");

        // Answering it releases the gate.
        feedLine(model, R"({"type":"FormulationCorrectionResolved","schemaVersion":7,"eventId":"e6","taskId":"t","correctionId":"c1","response":"fair point"})", "resolution");
        feedLine(model, R"({"type":"FormulationApproved","schemaVersion":7,"eventId":"e7","taskId":"t","versionId":"f1","approvedAt":"now"})", "approval");
        check(model.task("t")->formulationReview->approval.has_value(), "the version is approved once answered");
        // Idempotent: approving again does not create a second record.
        feedLine(model, R"({"type":"FormulationApproved","schemaVersion":7,"eventId":"e8","taskId":"t","versionId":"f1","approvedAt":"later"})", "approval again");
        check(model.task("t")->formulationReview->approval->approvedAt == "now",
              "a repeated approval is a no-op, not a second decision");
        check(model.issues().size() == 2, "no issue is raised for the idempotent re-approval");
    }

    // ---------------------------------------------------------------------
    // Applicability: a belief declared back into focus makes a not-applicable
    // decision stop counting, so the review cannot be skipped by narrowing scope.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedLine(model, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(model, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(model, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        feedLine(model,
                 R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","delta":{"id":"d1","episodeId":"ep","producerPhase":"propose","operation":"propose","resultBeliefId":"b1","resultingBeliefs":[{"id":"b1","statement":"s","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b1"]})",
                 "belief");
        feedLine(model, R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"e5","taskId":"t","beliefIds":["b1"]})", "focus");
        feedLine(model, R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e6","taskId":"t","episodeId":"ep","plan":{"id":"pl","selectedToExplore":["b1"],"formulation":{"kind":"unformed"}}})", "plan");
        feedLine(model,
                 R"({"type":"ProblemFormulationRecorded","schemaVersion":7,"eventId":"e7","taskId":"t","version":{"id":"f1","taskId":"t","ordinal":1,"recordedAt":"now","origin":"propose","content":{"interpretation":"i","focus":"f","implication":"im"},"reason":"r","sources":[{"kind":"prompt","promptId":"p"}]}})",
                 "formulation");
        check(model.task("t")->formulationReview->scopedBeliefIds.size() == 1,
              "publication scopes the declared focus");
        check(!applicabilityComplete(*model.task("t")->formulationReview), "the scoped belief owes a decision");

        feedLine(model,
                 R"({"type":"FormulationApplicabilityRecorded","schemaVersion":7,"eventId":"e8","taskId":"t","versionId":"f1","entries":[{"beliefId":"b1","decision":"not-applicable","reason":"out of scope now"}]})",
                 "applicability");
        check(applicabilityComplete(*model.task("t")->formulationReview), "the decision completes the review");

        // Put it back in scope: the decision stops counting.
        feedLine(model, R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"e9","taskId":"t","beliefIds":["b1"],"formulation":{"kind":"version","versionId":"f1"}})", "re-declaration");
        check(!applicabilityComplete(*model.task("t")->formulationReview),
              "a not-applicable belief put back in scope is owed a fresh decision");
        check(model.task("t")->formulationReview->applicability.size() == 1 &&
                  model.task("t")->formulationReview->applicability[0].stale,
              "the earlier decision is marked stale rather than erased");
        check(pendingApplicabilityBeliefs(*model.task("t")).size() == 1, "the belief is pending again");
        check(!model.task("t")->formulationReview->focusReviewed, "and the reading is no longer reviewed");
    }

    // ---------------------------------------------------------------------
    // A needs-revalidation classification is answered by the delta that
    // re-states or replaces the belief — following the refinement chain.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedLine(model, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(model, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(model, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        feedLine(model,
                 R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","delta":{"id":"d1","episodeId":"ep","producerPhase":"propose","operation":"propose","resultBeliefId":"b1","resultingBeliefs":[{"id":"b1","statement":"s","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[{"evidence":"old"}],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b1"]})",
                 "belief");
        feedLine(model, R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"e5","taskId":"t","beliefIds":["b1"]})", "focus");
        feedLine(model, R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e6","taskId":"t","episodeId":"ep","plan":{"id":"pl","selectedToExplore":["b1"],"formulation":{"kind":"unformed"}}})", "plan");
        feedLine(model,
                 R"({"type":"ProblemFormulationRecorded","schemaVersion":7,"eventId":"e7","taskId":"t","version":{"id":"f1","taskId":"t","ordinal":1,"recordedAt":"now","origin":"propose","content":{"interpretation":"i","focus":"f","implication":"im"},"reason":"r","sources":[{"kind":"prompt","promptId":"p"}]}})",
                 "formulation");
        feedLine(model,
                 R"({"type":"FormulationApplicabilityRecorded","schemaVersion":7,"eventId":"e8","taskId":"t","versionId":"f1","entries":[{"beliefId":"b1","decision":"needs-revalidation","reason":"its evidence predates the reading"}]})",
                 "applicability");
        check(unrevalidatedApplicability(*model.task("t")).size() == 1, "the belief owes a probe");

        // Refining it into an explicit successor is how a supported belief gets
        // probed again: the delta touches b1 through sourceBeliefId.
        feedLine(model,
                 R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"e9","taskId":"t","episodeId":"ep","delta":{"id":"d2","episodeId":"ep","producerPhase":"distill","operation":"refine","sourceBeliefId":"b1","resultBeliefId":"b2","resultingBeliefs":[{"id":"b1","statement":"s","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[{"evidence":"old"}],"refutedBy":[],"supersededBy":"b2","withdrawn":false},{"id":"b2","statement":"s2","domain":"code","expectation":"e2","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b2"]})",
                 "refinement");
        check(unrevalidatedApplicability(*model.task("t")).empty(),
              "the refinement answers the revalidation it was asked for");
        check(model.task("t")->formulationReview->applicability[0].revalidatedByDeltaId.has_value() &&
                  *model.task("t")->formulationReview->applicability[0].revalidatedByDeltaId == "d2",
              "the answering delta is recorded on the decision");

        // A delta that does not follow the chain does NOT answer it.
        NativeGuiModel unrelated;
        feedLine(unrelated, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(unrelated, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(unrelated, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        feedLine(unrelated,
                 R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","delta":{"id":"d1","episodeId":"ep","producerPhase":"propose","operation":"propose","resultBeliefId":"b1","resultingBeliefs":[{"id":"b1","statement":"s","domain":"code","expectation":"e","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b1"]})",
                 "belief");
        feedLine(unrelated, R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"e5","taskId":"t","beliefIds":["b1"]})", "focus");
        feedLine(unrelated, R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e6","taskId":"t","episodeId":"ep","plan":{"id":"pl","selectedToExplore":["b1"],"formulation":{"kind":"unformed"}}})", "plan");
        feedLine(unrelated,
                 R"({"type":"ProblemFormulationRecorded","schemaVersion":7,"eventId":"e7","taskId":"t","version":{"id":"f1","taskId":"t","ordinal":1,"recordedAt":"now","origin":"propose","content":{"interpretation":"i","focus":"f","implication":"im"},"reason":"r","sources":[{"kind":"prompt","promptId":"p"}]}})",
                 "formulation");
        feedLine(unrelated,
                 R"({"type":"FormulationApplicabilityRecorded","schemaVersion":7,"eventId":"e8","taskId":"t","versionId":"f1","entries":[{"beliefId":"b1","decision":"needs-revalidation","reason":"stale evidence"}]})",
                 "applicability");
        feedLine(unrelated,
                 R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"e9","taskId":"t","episodeId":"ep","delta":{"id":"d9","episodeId":"ep","producerPhase":"distill","operation":"propose","resultBeliefId":"b-other","resultingBeliefs":[{"id":"b-other","statement":"x","domain":"code","expectation":"y","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["b1","b-other"]})",
                 "unrelated delta");
        check(unrevalidatedApplicability(*unrelated.task("t")).size() == 1,
              "a delta that does not touch the belief does not answer the revalidation");
    }

    // ---------------------------------------------------------------------
    // Snapshot loading: the whole state arrives at once and record order is the
    // array order (so labels still derive correctly).
    // ---------------------------------------------------------------------
    {
        const std::string snapshot = R"({
          "sessionId":"session-1",
          "activeBranchTasks":["task-1"],
          "tasks":[{"id":"task-1","initialPrompt":{"id":"p1","original":"x","effective":"x"},
                    "status":"active","inheritedBeliefs":[],"introducedBeliefs":["belief-1"],
                    "focus":["belief-1"],"focusDeclared":true,"formulations":[],"formulationCorrections":[],
                    "episodes":[{"id":"episode-1","taskId":"task-1","ordinal":1,"status":"active",
                                 "stage":"executing","steering":[],
                                 "routing":{"id":"r1","statement":"s","decision":"belief-loop",
                                            "suitabilityProbability":0.5,"successProbability":0.5,
                                            "estimatedSteps":1,"difficulty":"low","reason":"r"},
                                 "body":{"kind":"belief-loop","openBeliefsAtStart":[],
                                         "plan":{"id":"plan-1","selectedToExplore":["belief-1"],
                                                 "intent":"i","formulation":{"kind":"unformed"}},
                                         "trajectory":[{"id":"exec-1","planId":"plan-1","tool":"bash",
                                                        "intention":"i","input":{"command":"ls"},
                                                        "output":"a\nb","status":"succeeded"}],
                                         "beliefDeltas":[]}}]},
                   {"id":"task-2","initialPrompt":{"id":"p2","original":"y","effective":"y"},
                    "status":"active","inheritedBeliefs":[],"introducedBeliefs":[],
                    "focus":[],"focusDeclared":false,"formulations":[],"formulationCorrections":[],
                    "episodes":[]}],
          "beliefs":[{"id":"belief-1","statement":"the project declares pytest","domain":"code",
                      "expectation":"requirements lists pytest","evidenceRounds":2,"skillRefs":[],
                      "supportedBy":[{"evidence":"requirements"}],"refutedBy":[],"withdrawn":false},
                     {"id":"belief-2","statement":"second","domain":"product","expectation":"e",
                      "evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}],
          "activeBeliefs":["belief-1"],
          "cursor":{"taskId":"task-1","episodeId":"episode-1","stage":"executing"}
        })";

        json::Value parsed;
        check(json::parse(snapshot, parsed, nullptr), "the snapshot payload parses");
        AgentSessionSnapshot state;
        check(readDomainSnapshot(parsed, state), "the snapshot payload reads");

        NativeGuiModel model;
        model.applyDomainSnapshot(state);
        check(model.tasks().size() == 2, "both snapshot tasks loaded");
        check(model.tasks()[1]->id == "task-2", "task order is the array order (task-2 is not shadowed)");
        check(model.beliefs().size() == 2, "both snapshot beliefs loaded");
        check(model.beliefLabel("belief-1") == "B1", "the snapshot's first belief is B1");
        check(model.beliefLabel("belief-2") == "B2", "the snapshot's second belief is B2");
        check(model.cursor().episodeId == "episode-1", "the cursor came from the snapshot");
        check(model.cursor().stage == EpisodeStage::Executing, "the snapshot cursor stage");
        check(model.belief("belief-1") != nullptr && model.belief("belief-1")->status() == BeliefStatus::Supported,
              "a snapshot belief's status derives from its provenance");
        check(model.belief("belief-1") != nullptr && model.belief("belief-1")->supportedBy.size() == 1,
              "snapshot belief evidence loaded");

        const Task* task = model.task("task-1");
        check(task != nullptr && task->episodes.size() == 1, "the snapshot episode loaded");
        check(task != nullptr && task->focusDeclared && task->focus.size() == 1, "the snapshot focus loaded");
        if (task != nullptr && !task->episodes.empty()) {
            const ExecutionEpisode& episode = task->episodes[0];
            check(episode.body.kind == EpisodeBodyKind::BeliefLoop, "the snapshot body kind loaded");
            check(episode.body.plan.has_value() && episode.body.plan->id == "plan-1", "the snapshot plan loaded");
            check(episode.body.trajectory.size() == 1, "the snapshot trajectory loaded");
            check(!episode.body.trajectory.empty() &&
                      episode.body.trajectory[0].status == ExecutionStatus::Succeeded,
                  "a snapshot execution carries its terminal status directly");
            check(!episode.body.trajectory.empty() && episode.body.trajectory[0].inputSummary == "ls",
                  "a snapshot execution's input is summarized");
        }

        // The snapshot REPLACES: loading a second one does not merge.
        AgentSessionSnapshot empty;
        empty.id = "session-2";
        model.applyDomainSnapshot(empty);
        check(model.tasks().empty(), "a snapshot replaces the state rather than merging");
        check(model.beliefs().empty(), "the belief registry is replaced too");
        check(!model.cursor().valid(), "the cursor is replaced too");
    }

    // ---------------------------------------------------------------------
    // A truncated execution output keeps an honest byte count.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        feedLine(model, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})", "task");
        feedLine(model, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})", "episode");
        feedLine(model, R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","body":"belief-loop","openBeliefsAtStart":[]})", "body");
        feedLine(model, R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e4","taskId":"t","episodeId":"ep","plan":{"id":"pl","selectedToExplore":[],"formulation":{"kind":"unformed"}}})", "plan");
        feedLine(model, R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"e5","taskId":"t","episodeId":"ep","execution":{"id":"x1","planId":"pl","tool":"bash","intention":"i","input":{"command":"cat big"}}})", "execution");

        std::string big = R"({"type":"ExecutionCompleted","schemaVersion":7,"eventId":"e6","taskId":"t","episodeId":"ep","executionId":"x1","output":")";
        big.append(5000, 'z');
        big += R"(","status":"succeeded"})";
        feedLine(model, big, "large output");

        const Execution* execution = model.task("t")->episodes[0].execution("x1");
        check(execution != nullptr, "the execution exists");
        check(execution != nullptr && execution->outputPreview.size() == kExecutionOutputPreviewChars,
              "the output is truncated to the display cap");
        check(execution != nullptr && execution->outputBytes == 5000, "the untruncated byte count is honest");
    }

    // ---------------------------------------------------------------------
    // RPC telemetry: session_status is thin, and a missing value is "unknown"
    // rather than zero or a mismatch (docs/milestones.md §3.6).
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        const std::string status =
            R"({"type":"session_status","roleStatus":{"epistemic":{"model":{"provider":"anthropic","id":"claude-sonnet-5"},"latestCacheHitRate":0.62},"distillation":{"model":{"provider":"anthropic","id":"claude-haiku-4-5-20251001"},"latestCacheHitRate":null},"execution":{"model":{"provider":"anthropic","id":"claude-sonnet-5"},"latestCacheHitRate":0.5}},"roleUsage":{"epistemic":{"tokens":12000,"contextWindow":200000,"percent":6},"execution":{"tokens":null,"contextWindow":null,"percent":null}},"cost":0.0123})";
        check(applyRpcLine(model, status) == RpcApplyResult::Applied, "session_status is applied");
        const Footer& footer = model.footer();
        check(footer.hasData, "footer telemetry arrived");
        check(footer.epistemic.model == "claude-sonnet-5", "the epistemic role model");
        check(footer.epistemic.cacheHitRate > 0.61f && footer.epistemic.cacheHitRate < 0.63f,
              "the epistemic cache hit rate");
        check(footer.distillation.cacheHitRate < 0.0f, "a null cache hit rate stays unknown, not zero");
        check(footer.sessionCost == 0.0123, "the session cost");
        check(model.roleContext().hasData, "role context arrived");
        check(model.roleContext().epistemic.tokens == 12000, "the epistemic context length");
        check(!model.roleContext().execution.valid(), "a null token count stays unknown");

        // A later status with no roleStatus at all must not be read as a
        // mismatch — it simply has no data.
        NativeGuiModel bare;
        check(applyRpcLine(bare, R"({"type":"session_status","cost":0.5})") == RpcApplyResult::Applied,
              "a bare session_status applies");
        check(!bare.footer().hasData, "a session_status with no roleStatus has no telemetry");
        check(bare.footer().epistemic.model.empty(), "and no role model to report");
    }

    // ---------------------------------------------------------------------
    // The state-refresh trigger: a settled run is when a new pause can exist, and
    // no event carries the pause, so the model asks for a `get_state`.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        // Not a poll: nothing but a run boundary asks.
        check(!model.takeStateRefreshRequest(), "a fresh model asks for nothing");

        check(applyRpcLine(model, R"({"type":"turn_end"})") == RpcApplyResult::Ignored, "turn_end applies");
        check(!model.takeStateRefreshRequest(), "a turn boundary is not a settled run");

        check(applyRpcLine(model, R"({"type":"agent_settled"})") == RpcApplyResult::Ignored,
              "agent_settled applies");
        check(model.takeStateRefreshRequest(), "a settled run asks for a fresh get_state");
        // Taken, not latched: one reason, one command.
        check(!model.takeStateRefreshRequest(), "the request is consumed by the first read");

        // And it can be asked for again by the next boundary.
        check(applyRpcLine(model, R"({"type":"agent_settled"})") == RpcApplyResult::Ignored,
              "a second settled run applies");
        check(model.takeStateRefreshRequest(), "and asks again");
    }

    // ---------------------------------------------------------------------
    // The in-message stream and the failed-command surface.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        check(applyRpcLine(model, R"({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"seed "}]}})") == RpcApplyResult::Applied,
              "message_start seeds the in-message");
        check(model.inMessage() == "seed ", "the seeded text");
        check(applyRpcLine(model, R"({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}})") == RpcApplyResult::Applied,
              "a text delta applies");
        check(model.inMessage() == "seed hello", "the delta appended");
        check(applyRpcLine(model, R"({"type":"message_update","assistantMessageEvent":{"type":"thinking_start"}})") == RpcApplyResult::Applied,
              "a thinking start applies");
        check(model.inMessageThinking(), "the thinking flag is set");
        check(applyRpcLine(model, R"({"type":"message_end"})") == RpcApplyResult::Applied, "message_end applies");

        // A refused command surfaces rather than reading as consent.
        check(applyRpcLine(model, R"({"type":"response","id":"r1","command":"approve_frame","success":false,"error":"nothing was waiting for approval"})") == RpcApplyResult::Ignored,
              "a failed response is a control event");
        check(model.inMessageError(), "a refusal is surfaced");
        check(model.inMessage() == "nothing was waiting for approval", "the refusal text is shown verbatim");

        // A successful ack leaves the message alone.
        NativeGuiModel ok;
        ok.beginInMessage("a reply");
        check(applyRpcLine(ok, R"({"type":"response","id":"r2","command":"prompt","success":true})") == RpcApplyResult::Ignored,
              "a successful ack is ignored");
        check(ok.inMessage() == "a reply" && !ok.inMessageError(), "a successful ack leaves the message alone");

        // A stream failure is surfaced, and only from an assistant message.
        NativeGuiModel failed;
        check(applyRpcLine(failed, R"({"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"connection dropped"}})") == RpcApplyResult::Applied,
              "a failed message_end applies");
        check(failed.inMessageError() && failed.inMessage() == "connection dropped", "the stream failure is surfaced");

        NativeGuiModel notAssistant;
        applyRpcLine(notAssistant,
                     R"({"type":"message_end","message":{"role":"user","content":[],"stopReason":"error","errorMessage":"nope"}})");
        check(!notAssistant.inMessageError(), "a non-assistant message_end is not an error");

        // The DOM reads the message's OWN members, so a same-named key nested in
        // content cannot shadow the real stopReason.
        NativeGuiModel shadow;
        applyRpcLine(shadow,
                     R"({"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","input":{"cmd":"x","stopReason":"error"}}],"stopReason":"stop"}})");
        check(!shadow.inMessageError(), "a nested stopReason does not shadow the message's own");
    }

    // ---------------------------------------------------------------------
    // In-message history: every replaced non-empty reply is archived, oldest
    // first, so an index keeps naming the same reply.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        model.beginInMessage("a");
        model.beginInMessage("bb");
        model.beginInMessage("ccc");
        model.setInMessageError("err");
        const auto& history = model.inMessageHistory();
        check(history.size() == 3, "every replaced non-empty reply is archived");
        check(history.size() == 3 && history[0].text == "a" && !history[0].error, "history[0] is the oldest");
        check(history.size() == 3 && history[2].text == "ccc" && !history[2].error, "history[2] is the pre-error reply");
        check(model.inMessage() == "err" && model.inMessageError(), "the current message is the error");
        model.beginInMessage("newest");
        check(model.inMessageHistory().size() == 4 && history[0].text == "a", "earlier indices stay stable");
        check(model.inMessageHistory()[3].error, "the archived error flag is retained");
    }

    // ---------------------------------------------------------------------
    // Turn boundaries and non-domain telemetry never create domain state.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        check(applyRpcLine(model, R"({"type":"agent_start"})") == RpcApplyResult::Ignored, "agent_start is ignored");
        check(applyRpcLine(model, R"({"type":"turn_start"})") == RpcApplyResult::Ignored, "turn_start is ignored");
        check(applyRpcLine(model, R"({"type":"tool_execution_end"})") == RpcApplyResult::Ignored, "tool_execution_end is ignored");
        check(model.tasks().empty(), "no task was created by a turn boundary");
        check(applyRpcLine(model, "not json") == RpcApplyResult::Error, "garbage is an Error");
        check(applyRpcLine(model, R"({"foo":1})") == RpcApplyResult::Error, "a line with no type is an Error");

        model.setSession("/a/b");
        check(applyRpcLine(model, R"({"type":"tool_execution_start","toolCallId":"c1","toolName":"read","args":{"path":"src/x.cpp"}})") == RpcApplyResult::Applied,
              "tool_execution_start applies");
        check(applyRpcLine(model, R"({"type":"tool_execution_start","toolCallId":"c2","toolName":"edit","args":{"file_path":"/a/b/src/y.cpp"}})") == RpcApplyResult::Applied,
              "a file_path tool applies");
        const auto& files = model.fileList();
        check(files.size() == 2, "two file ops recorded");
        check(files[0].op == "read" && files[0].path == "src/x.cpp", "the read path came from args.path");
        check(files[1].op == "edit" && files[1].path == "src/y.cpp", "the edit path was normalized against the session");
    }

    // ---------------------------------------------------------------------
    // A live domain line goes through applyRpcLine to the same fold.
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        check(applyRpcLine(model, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t","initialPrompt":{"id":"p","original":"x","effective":"x"},"inheritedBeliefs":[]})") == RpcApplyResult::Applied,
              "a live TaskOpened applies");
        check(applyRpcLine(model, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","taskId":"t","episodeId":"ep","ordinal":1})") == RpcApplyResult::Applied,
              "a live EpisodeOpened applies");
        check(model.task("t") != nullptr && model.task("t")->episodes.size() == 1, "the episode is in the model");
        check(applyRpcLine(model, R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e3","taskId":"t","episodeId":"ep","stage":"proposing"})") == RpcApplyResult::Applied,
              "a live CursorChanged applies");
        check(model.cursor().stage == EpisodeStage::Proposing, "the cursor stage came from the runtime");
        check(std::string(toString(model.cursor().stage)) == "proposing", "the stage spells as the wire does");
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
