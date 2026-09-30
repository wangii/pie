#include "DomainEvents.h"

#include <cstdlib>
#include <utility>

namespace pie::gui {

namespace {

// Every wire spelling lives here, in one table per enum, so `toString` and the
// parser cannot drift apart. `toString` is declared in Model.h and defined in
// this file for exactly that reason.
struct StageName {
    EpisodeStage value;
    const char* name;
};
constexpr StageName kStageNames[] = {
    {EpisodeStage::Routing, "routing"},
    {EpisodeStage::Proposing, "proposing"},
    {EpisodeStage::Executing, "executing"},
    {EpisodeStage::Distilling, "distilling"},
    {EpisodeStage::Closed, "closed"},
};

// A member of an optional field: present only when the value is a non-null
// string. A present-but-null optional is still absent for our purposes.
std::optional<std::string> optionalString(const json::Value& obj, std::string_view key) {
    const json::Value* v = obj.find(key);
    if (v == nullptr || !v->isString()) return std::nullopt;
    return v->asString();
}

// Read `[{evidence: "..."}, ...]` (TS: SupportEvidence[] / RefutationEvidence[]).
std::vector<std::string> evidenceStrings(const json::Value& obj, std::string_view key) {
    std::vector<std::string> out;
    const json::Value* arr = obj.array(key);
    if (arr == nullptr) return out;
    out.reserve(arr->size());
    for (size_t i = 0; i < arr->size(); ++i) {
        const json::Value& element = arr->at(i);
        if (!element.isObject()) continue;
        const std::string evidence = element.string("evidence");
        if (!evidence.empty()) out.push_back(evidence);
    }
    return out;
}

// Append `s` to `out`, stopping at `limit` characters but still counting every
// byte of the full logical text. This is what lets Execution.output keep an
// honest total size while the model stores only a preview
// (docs/milestones.md §5.1).
void appendCapped(std::string& out, size_t limit, size_t& total, std::string_view s) {
    total += s.size();
    if (out.size() >= limit) return;
    const size_t room = limit - out.size();
    out.append(s.substr(0, room));
}

// Flatten a DomainContent value to text, capped at `limit` characters.
// `totalBytes` receives the untruncated length.
std::string flattenContent(const json::Value& value, size_t limit, size_t& totalBytes) {
    totalBytes = 0;
    std::string out;
    if (value.isString()) {
        appendCapped(out, limit, totalBytes, value.asString());
        return out;
    }
    if (!value.isArray()) return out;
    for (size_t i = 0; i < value.size(); ++i) {
        const json::Value& element = value.at(i);
        // A content block list carries its prose in `text` and `thinking`.
        std::string piece;
        if (element.isString()) {
            piece = element.asString();
        } else if (element.isObject()) {
            const std::string text = element.string("text");
            const std::string thinking = element.string("thinking");
            if (!text.empty()) piece = text;
            else if (!thinking.empty()) piece = thinking;
        }
        if (piece.empty()) continue;
        if (totalBytes > 0 || !out.empty()) appendCapped(out, limit, totalBytes, " ");
        appendCapped(out, limit, totalBytes, piece);
    }
    return out;
}

} // namespace

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

namespace {

struct EventName {
    DomainEventKind kind;
    const char* name;
    DomainEventCategory category;
};

// The authoritative list, in DOMAIN_EVENT_APPLIERS order and grouped by applier.
constexpr EventName kEventNames[] = {
    {DomainEventKind::TaskOpened, "TaskOpened", DomainEventCategory::Task},
    {DomainEventKind::TaskClosed, "TaskClosed", DomainEventCategory::Task},
    {DomainEventKind::TargetDefined, "TargetDefined", DomainEventCategory::Task},
    {DomainEventKind::FocusDeclared, "FocusDeclared", DomainEventCategory::Task},
    {DomainEventKind::TaskOutcomeRecorded, "TaskOutcomeRecorded", DomainEventCategory::Task},
    {DomainEventKind::ProblemFormulationRecorded, "ProblemFormulationRecorded", DomainEventCategory::Formulation},
    {DomainEventKind::ProblemFormulationDeferred, "ProblemFormulationDeferred", DomainEventCategory::Formulation},
    {DomainEventKind::FormulationApproved, "FormulationApproved", DomainEventCategory::Formulation},
    {DomainEventKind::FormulationCorrectionSubmitted, "FormulationCorrectionSubmitted",
     DomainEventCategory::Formulation},
    {DomainEventKind::FormulationCorrectionResolved, "FormulationCorrectionResolved",
     DomainEventCategory::Formulation},
    {DomainEventKind::FormulationApplicabilityRecorded, "FormulationApplicabilityRecorded",
     DomainEventCategory::Formulation},
    {DomainEventKind::FormulationRecheckRecorded, "FormulationRecheckRecorded", DomainEventCategory::Formulation},
    {DomainEventKind::EpisodeOpened, "EpisodeOpened", DomainEventCategory::Episode},
    {DomainEventKind::RoutingDecided, "RoutingDecided", DomainEventCategory::Episode},
    {DomainEventKind::EpisodeBodySelected, "EpisodeBodySelected", DomainEventCategory::Episode},
    {DomainEventKind::EpisodeClosed, "EpisodeClosed", DomainEventCategory::Episode},
    {DomainEventKind::CursorChanged, "CursorChanged", DomainEventCategory::Episode},
    {DomainEventKind::InterventionAdded, "InterventionAdded", DomainEventCategory::Episode},
    {DomainEventKind::ExperimentSelected, "ExperimentSelected", DomainEventCategory::Episode},
    {DomainEventKind::ExperimentSelectionVoided, "ExperimentSelectionVoided", DomainEventCategory::Episode},
    {DomainEventKind::BeliefDeltaApplied, "BeliefDeltaApplied", DomainEventCategory::Loop},
    {DomainEventKind::PlanProduced, "PlanProduced", DomainEventCategory::Loop},
    {DomainEventKind::ExecutionStarted, "ExecutionStarted", DomainEventCategory::Loop},
    {DomainEventKind::ExecutionCompleted, "ExecutionCompleted", DomainEventCategory::Loop},
    {DomainEventKind::DistillationProduced, "DistillationProduced", DomainEventCategory::Loop},
};

constexpr size_t kEventNameCount = sizeof(kEventNames) / sizeof(kEventNames[0]);
static_assert(kEventNameCount == kDomainEventKindCount,
              "kEventNames must list every DomainEventKind (see DOMAIN_EVENT_APPLIERS)");

} // namespace

const char* domainEventKindName(DomainEventKind kind) {
    for (const EventName& e : kEventNames) {
        if (e.kind == kind) return e.name;
    }
    return "Unknown";
}

DomainEventKind domainEventKindFromName(std::string_view name) {
    for (const EventName& e : kEventNames) {
        if (name == e.name) return e.kind;
    }
    return DomainEventKind::Unknown;
}

DomainEventCategory domainEventCategory(DomainEventKind kind) {
    for (const EventName& e : kEventNames) {
        if (e.kind == kind) return e.category;
    }
    return DomainEventCategory::Unknown;
}

// ---------------------------------------------------------------------------
// Enum spellings
// ---------------------------------------------------------------------------

const char* toString(TaskStatus v) {
    switch (v) {
        case TaskStatus::Active: return "active";
        case TaskStatus::Completed: return "completed";
        case TaskStatus::Cancelled: return "cancelled";
        case TaskStatus::Failed: return "failed";
        case TaskStatus::Unknown: break;
    }
    return "unknown";
}

const char* toString(EpisodeStatus v) {
    switch (v) {
        case EpisodeStatus::Active: return "active";
        case EpisodeStatus::Closed: return "closed";
        case EpisodeStatus::Unknown: break;
    }
    return "unknown";
}

const char* toString(EpisodeStage v) {
    for (const StageName& s : kStageNames) {
        if (s.value == v) return s.name;
    }
    return "unknown";
}

const char* toString(EpisodeBodyKind v) {
    switch (v) {
        case EpisodeBodyKind::Pending: return "pending";
        case EpisodeBodyKind::BeliefLoop: return "belief-loop";
        case EpisodeBodyKind::FastPath: return "fast-path";
    }
    return "pending";
}

const char* toString(BeliefDomain v) {
    switch (v) {
        case BeliefDomain::Product: return "product";
        case BeliefDomain::Code: return "code";
        case BeliefDomain::Unknown: break;
    }
    return "unknown";
}

const char* toString(BeliefStatus v) {
    switch (v) {
        case BeliefStatus::Proposed: return "proposed";
        case BeliefStatus::Supported: return "supported";
        case BeliefStatus::Refuted: return "refuted";
        case BeliefStatus::Inconclusive: return "inconclusive";
        case BeliefStatus::Superseded: return "superseded";
    }
    return "proposed";
}

const char* toString(BeliefOperation v) {
    switch (v) {
        case BeliefOperation::Propose: return "propose";
        case BeliefOperation::Support: return "support";
        case BeliefOperation::Refute: return "refute";
        case BeliefOperation::Refine: return "refine";
        case BeliefOperation::Inconclusive: return "inconclusive";
        case BeliefOperation::Retract: return "retract";
        case BeliefOperation::Unknown: break;
    }
    return "unknown";
}

const char* toString(BeliefDeltaProducerPhase v) {
    switch (v) {
        case BeliefDeltaProducerPhase::Propose: return "propose";
        case BeliefDeltaProducerPhase::Distill: return "distill";
        case BeliefDeltaProducerPhase::Unknown: break;
    }
    return "unknown";
}

const char* toString(RoutingDecision v) {
    switch (v) {
        case RoutingDecision::BeliefLoop: return "belief-loop";
        case RoutingDecision::FastPath: return "fast-path";
        case RoutingDecision::Unknown: break;
    }
    return "unknown";
}

const char* toString(RoutingDifficulty v) {
    switch (v) {
        case RoutingDifficulty::Low: return "low";
        case RoutingDifficulty::Medium: return "medium";
        case RoutingDifficulty::High: return "high";
        case RoutingDifficulty::Unknown: break;
    }
    return "unknown";
}

const char* toString(ExecutionStatus v) {
    switch (v) {
        case ExecutionStatus::Running: return "running";
        case ExecutionStatus::Succeeded: return "succeeded";
        case ExecutionStatus::Failed: return "failed";
        case ExecutionStatus::Cancelled: return "cancelled";
        case ExecutionStatus::Unknown: break;
    }
    return "unknown";
}

const char* toString(FormulationCorrectionStatus v) {
    switch (v) {
        case FormulationCorrectionStatus::Pending: return "pending";
        case FormulationCorrectionStatus::Resolved: return "resolved";
        case FormulationCorrectionStatus::Unknown: break;
    }
    return "unknown";
}

const char* toString(FormulationRecheckVerdict v) {
    switch (v) {
        case FormulationRecheckVerdict::Maintained: return "maintained";
        case FormulationRecheckVerdict::Revised: return "revised";
        case FormulationRecheckVerdict::Deferred: return "deferred";
        case FormulationRecheckVerdict::Unknown: break;
    }
    return "unknown";
}

const char* toString(FormulationApplicabilityDecision v) {
    switch (v) {
        case FormulationApplicabilityDecision::CarriesOver: return "carries-over";
        case FormulationApplicabilityDecision::NotApplicable: return "not-applicable";
        case FormulationApplicabilityDecision::NeedsRevalidation: return "needs-revalidation";
        case FormulationApplicabilityDecision::Unknown: break;
    }
    return "unknown";
}

const char* toString(FormulationSourceKind v) {
    switch (v) {
        case FormulationSourceKind::Prompt: return "prompt";
        case FormulationSourceKind::Intervention: return "intervention";
        case FormulationSourceKind::Correction: return "correction";
        case FormulationSourceKind::Execution: return "execution";
        case FormulationSourceKind::Distillation: return "distillation";
        case FormulationSourceKind::Belief: return "belief";
        case FormulationSourceKind::Unknown: break;
    }
    return "unknown";
}

const char* toString(FormulationResumePhase v) {
    switch (v) {
        case FormulationResumePhase::Started: return "started";
        case FormulationResumePhase::Settled: return "settled";
        case FormulationResumePhase::Failed: return "failed";
        case FormulationResumePhase::Unknown: break;
    }
    return "unknown";
}

TaskStatus parseTaskStatus(std::string_view v) {
    if (v == "active") return TaskStatus::Active;
    if (v == "completed") return TaskStatus::Completed;
    if (v == "cancelled") return TaskStatus::Cancelled;
    if (v == "failed") return TaskStatus::Failed;
    return TaskStatus::Unknown;
}

EpisodeStatus parseEpisodeStatus(std::string_view v) {
    if (v == "active") return EpisodeStatus::Active;
    if (v == "closed") return EpisodeStatus::Closed;
    return EpisodeStatus::Unknown;
}

EpisodeStage parseEpisodeStage(std::string_view v) {
    for (const StageName& s : kStageNames) {
        if (v == s.name) return s.value;
    }
    return EpisodeStage::Unknown;
}

// TS: FormulationResumeState["phase"] — runtime state, so this is the one enum on
// the wire whose value can change with a runtime restart alone. An unknown
// spelling stays Unknown and the pane renders "—" rather than guessing.
FormulationResumePhase parseFormulationResumePhase(std::string_view v) {
    if (v == "started") return FormulationResumePhase::Started;
    if (v == "settled") return FormulationResumePhase::Settled;
    if (v == "failed") return FormulationResumePhase::Failed;
    return FormulationResumePhase::Unknown;
}

EpisodeBodyKind parseEpisodeBodyKind(std::string_view v) {
    if (v == "belief-loop") return EpisodeBodyKind::BeliefLoop;
    if (v == "fast-path") return EpisodeBodyKind::FastPath;
    if (v == "pending") return EpisodeBodyKind::Pending;
    return EpisodeBodyKind::Pending;
}

BeliefDomain parseBeliefDomain(std::string_view v) {
    if (v == "product") return BeliefDomain::Product;
    if (v == "code") return BeliefDomain::Code;
    return BeliefDomain::Unknown;
}

BeliefOperation parseBeliefOperation(std::string_view v) {
    if (v == "propose") return BeliefOperation::Propose;
    if (v == "support") return BeliefOperation::Support;
    if (v == "refute") return BeliefOperation::Refute;
    if (v == "refine") return BeliefOperation::Refine;
    if (v == "inconclusive") return BeliefOperation::Inconclusive;
    if (v == "retract") return BeliefOperation::Retract;
    return BeliefOperation::Unknown;
}

BeliefDeltaProducerPhase parseBeliefDeltaProducerPhase(std::string_view v) {
    if (v == "propose") return BeliefDeltaProducerPhase::Propose;
    if (v == "distill") return BeliefDeltaProducerPhase::Distill;
    return BeliefDeltaProducerPhase::Unknown;
}

RoutingDecision parseRoutingDecision(std::string_view v) {
    if (v == "belief-loop") return RoutingDecision::BeliefLoop;
    if (v == "fast-path") return RoutingDecision::FastPath;
    return RoutingDecision::Unknown;
}

RoutingDifficulty parseRoutingDifficulty(std::string_view v) {
    if (v == "low") return RoutingDifficulty::Low;
    if (v == "medium") return RoutingDifficulty::Medium;
    if (v == "high") return RoutingDifficulty::High;
    return RoutingDifficulty::Unknown;
}

ExecutionStatus parseExecutionStatus(std::string_view v) {
    if (v == "running") return ExecutionStatus::Running;
    if (v == "succeeded") return ExecutionStatus::Succeeded;
    if (v == "failed") return ExecutionStatus::Failed;
    if (v == "cancelled") return ExecutionStatus::Cancelled;
    return ExecutionStatus::Unknown;
}

FormulationCorrectionStatus parseFormulationCorrectionStatus(std::string_view v) {
    if (v == "pending") return FormulationCorrectionStatus::Pending;
    if (v == "resolved") return FormulationCorrectionStatus::Resolved;
    return FormulationCorrectionStatus::Unknown;
}

FormulationRecheckVerdict parseFormulationRecheckVerdict(std::string_view v) {
    if (v == "maintained") return FormulationRecheckVerdict::Maintained;
    if (v == "revised") return FormulationRecheckVerdict::Revised;
    if (v == "deferred") return FormulationRecheckVerdict::Deferred;
    return FormulationRecheckVerdict::Unknown;
}

FormulationApplicabilityDecision parseFormulationApplicabilityDecision(std::string_view v) {
    if (v == "carries-over") return FormulationApplicabilityDecision::CarriesOver;
    if (v == "not-applicable") return FormulationApplicabilityDecision::NotApplicable;
    if (v == "needs-revalidation") return FormulationApplicabilityDecision::NeedsRevalidation;
    return FormulationApplicabilityDecision::Unknown;
}

FormulationSourceKind parseFormulationSourceKind(std::string_view v) {
    if (v == "prompt") return FormulationSourceKind::Prompt;
    if (v == "intervention") return FormulationSourceKind::Intervention;
    if (v == "correction") return FormulationSourceKind::Correction;
    if (v == "execution") return FormulationSourceKind::Execution;
    if (v == "distillation") return FormulationSourceKind::Distillation;
    if (v == "belief") return FormulationSourceKind::Belief;
    return FormulationSourceKind::Unknown;
}

// ---------------------------------------------------------------------------
// DomainContent / input summaries
// ---------------------------------------------------------------------------

std::string domainContentText(const json::Value& value) {
    size_t total = 0;
    // No cap for the general case: every DomainContent the GUI renders as prose
    // (a prompt, an intervention, a distillation) is small. `Execution.output`
    // is the one that needs the cap, and readExecutionCompleted applies it.
    return flattenContent(value, static_cast<size_t>(-1), total);
}

std::string summarizeExecutionInput(const json::Value& value) {
    if (value.isString()) return value.asString();
    if (!value.isObject()) return domainContentText(value);
    const std::string command = value.string("command");
    if (!command.empty()) return command;
    const std::string path = value.string("path");
    if (!path.empty()) return path;
    const std::string filePath = value.string("file_path");
    if (!filePath.empty()) return filePath;
    // Fall back to whichever prose the input carries (`text` / `thinking`).
    return domainContentText(value);
}

void readAdvancement(const json::Value& obj, std::optional<std::string>& action,
                     std::optional<std::string>& condition, std::optional<std::string>& next) {
    action.reset();
    condition.reset();
    next.reset();
    const json::Value* a = obj.object("advancement");
    if (a == nullptr) return;
    action = optionalString(*a, "action");
    condition = optionalString(*a, "condition");
    next = optionalString(*a, "next");
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

bool readBelief(const json::Value& v, Belief& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.statement = v.string("statement");
    out.domain = parseBeliefDomain(v.string("domain"));
    out.expectation = v.string("expectation");
    out.evidenceRounds = static_cast<int>(v.integer("evidenceRounds", 0));
    out.skillRefs = v.stringArray("skillRefs");
    out.supportedBy = evidenceStrings(v, "supportedBy");
    out.refutedBy = evidenceStrings(v, "refutedBy");
    out.inconclusiveBy = evidenceStrings(v, "inconclusiveBy");
    out.supersededBy = optionalString(v, "supersededBy");
    out.withdrawn = v.boolean("withdrawn", false);
    return true;
}

std::vector<Belief> readBeliefArray(const json::Value& v) {
    std::vector<Belief> out;
    if (!v.isArray()) return out;
    out.reserve(v.size());
    for (size_t i = 0; i < v.size(); ++i) {
        Belief belief;
        if (readBelief(v.at(i), belief)) out.push_back(std::move(belief));
    }
    return out;
}

bool readFormulationSource(const json::Value& v, FormulationSource& out) {
    if (!v.isObject()) return false;
    out = FormulationSource{};
    out.kind = parseFormulationSourceKind(v.string("kind"));
    switch (out.kind) {
        case FormulationSourceKind::Prompt:
            out.promptId = v.string("promptId");
            break;
        case FormulationSourceKind::Intervention:
            out.interventionId = v.string("interventionId");
            break;
        case FormulationSourceKind::Correction:
            out.correctionId = v.string("correctionId");
            break;
        case FormulationSourceKind::Execution:
            out.executionId = v.string("executionId");
            break;
        case FormulationSourceKind::Distillation:
            out.distillationId = v.string("distillationId");
            break;
        case FormulationSourceKind::Belief:
            // A belief is always cited together with the delta that recorded its
            // state at the time: citing the id alone would read today's state
            // back into a past decision.
            out.beliefId = v.string("beliefId");
            out.beliefDeltaId = v.string("beliefDeltaId");
            break;
        case FormulationSourceKind::Unknown:
            break;
    }
    return true;
}

std::vector<FormulationSource> readFormulationSourceArray(const json::Value& v) {
    std::vector<FormulationSource> out;
    if (!v.isArray()) return out;
    out.reserve(v.size());
    for (size_t i = 0; i < v.size(); ++i) {
        FormulationSource source;
        if (readFormulationSource(v.at(i), source)) out.push_back(std::move(source));
    }
    return out;
}

FormulationAdoption readFormulationAdoption(const json::Value& v) {
    if (!v.isObject()) return FormulationAdoption::unformed();
    const std::string kind = v.string("kind");
    if (kind == "version") {
        const std::string versionId = v.string("versionId");
        if (!versionId.empty()) return FormulationAdoption::version(versionId);
    }
    return FormulationAdoption::unformed();
}

bool readFormulationContent(const json::Value& v, FormulationContent& out) {
    if (!v.isObject()) return false;
    out.interpretation = v.string("interpretation");
    out.alternative = optionalString(v, "alternative");
    out.focus = v.string("focus");
    out.tension = optionalString(v, "tension");
    out.implication = v.string("implication");
    return true;
}

bool readFormulationVersion(const json::Value& v, ProblemFormulationVersion& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.taskId = v.string("taskId");
    out.ordinal = static_cast<uint64_t>(v.integer("ordinal", 0));
    if (v.has("previousVersionId")) out.previousVersionId = v.string("previousVersionId");
    else out.previousVersionId.reset();
    out.recordedAt = v.string("recordedAt");
    out.formedInEpisodeOrdinal = static_cast<uint64_t>(v.integer("formedInEpisodeOrdinal", 0));
    out.origin = v.string("origin");
    const json::Value* content = v.object("content");
    if (content != nullptr) readFormulationContent(*content, out.content);
    out.reason = v.string("reason");
    const json::Value* sources = v.find("sources");
    if (sources != nullptr) out.sources = readFormulationSourceArray(*sources);
    return true;
}

bool readFormulationCorrection(const json::Value& v, FormulationCorrection& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.taskId = v.string("taskId");
    out.targetVersionId = optionalString(v, "targetVersionId");
    const json::Value* original = v.find("original");
    if (original != nullptr) out.original = domainContentText(*original);
    out.receivedAt = v.string("receivedAt");
    out.status = parseFormulationCorrectionStatus(v.string("status"));
    out.response = optionalString(v, "response");
    out.recordedVersionId = optionalString(v, "recordedVersionId");
    return true;
}

bool readApplicabilityEntry(const json::Value& v, FormulationApplicabilityEntry& out) {
    if (!v.isObject()) return false;
    out.beliefId = v.string("beliefId");
    out.decision = parseFormulationApplicabilityDecision(v.string("decision"));
    out.reason = v.string("reason");
    out.revalidatedByDeltaId = optionalString(v, "revalidatedByDeltaId");
    out.stale = v.boolean("stale", false);
    return true;
}

bool readFormulationRecheck(const json::Value& v, FormulationRecheck& out) {
    if (!v.isObject()) return false;
    out.episodeId = v.string("episodeId");
    out.verdict = parseFormulationRecheckVerdict(v.string("verdict"));
    out.reason = v.string("reason");
    out.versionId = optionalString(v, "versionId");
    out.recordedAt = v.string("recordedAt");
    return true;
}

bool readRouting(const json::Value& v, Routing& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.statement = v.string("statement");
    out.decision = parseRoutingDecision(v.string("decision"));
    out.suitabilityProbability = v.number("suitabilityProbability", 0.0);
    out.successProbability = v.number("successProbability", 0.0);
    out.estimatedSteps = static_cast<int>(v.integer("estimatedSteps", 0));
    out.difficulty = parseRoutingDifficulty(v.string("difficulty"));
    out.reason = v.string("reason");
    return true;
}

bool readTaskOutcome(const json::Value& v, TaskOutcome& out) {
    if (!v.isObject()) return false;
    out.result = v.string("result");
    out.evidence = v.string("evidence");
    out.blockers = v.string("blockers");
    return true;
}

bool readInitialPrompt(const json::Value& v, InitialPrompt& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    const json::Value* original = v.find("original");
    if (original != nullptr) out.original = domainContentText(*original);
    const json::Value* effective = v.find("effective");
    if (effective != nullptr) out.effective = domainContentText(*effective);
    return true;
}

bool readTarget(const json::Value& v, Target& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.statement = v.string("statement");
    return true;
}

bool readPlan(const json::Value& v, Plan& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.selectedToExplore = v.stringArray("selectedToExplore");
    out.intent = optionalString(v, "intent");
    readAdvancement(v, out.advancementAction, out.advancementCondition, out.advancementNext);
    const json::Value* adoption = v.find("formulation");
    out.formulation = adoption != nullptr ? readFormulationAdoption(*adoption) : FormulationAdoption::unformed();
    return true;
}

bool readExperimentSelection(const json::Value& v, ExperimentSelectionRecord& out) {
    if (!v.isObject()) return false;
    out.intent = v.string("intent");
    out.beliefIds = v.stringArray("beliefIds");
    readAdvancement(v, out.advancementAction, out.advancementCondition, out.advancementNext);
    const json::Value* adoption = v.find("formulation");
    out.formulation = adoption != nullptr ? readFormulationAdoption(*adoption) : FormulationAdoption::unformed();
    return true;
}

bool readExecutionStarted(const json::Value& v, Execution& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.planId = optionalString(v, "planId");
    out.intention = v.string("intention");
    out.tool = v.string("tool");
    const json::Value* input = v.find("input");
    if (input != nullptr) out.inputSummary = summarizeExecutionInput(*input);
    out.filePath = optionalString(v, "filePath");
    // ExecutionStarted omits output/status/error: the record is created running.
    out.outputPreview.clear();
    out.outputBytes = 0;
    out.status = ExecutionStatus::Running;
    out.error.reset();
    return true;
}

bool readExecutionCompleted(const json::Value& event, Execution& out) {
    const std::string status = event.string("status");
    if (status.empty()) return false;
    const json::Value* output = event.find("output");
    if (output != nullptr) {
        out.outputPreview = flattenContent(*output, kExecutionOutputPreviewChars, out.outputBytes);
    } else {
        out.outputPreview.clear();
        out.outputBytes = 0;
    }
    out.status = parseExecutionStatus(status);
    out.error = optionalString(event, "error");
    return true;
}

bool readDistillation(const json::Value& v, Distillation& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.inputs = v.stringArray("inputs");
    out.contents = v.string("contents");
    out.outputs = v.stringArray("outputs");
    return true;
}

bool readBeliefDelta(const json::Value& v, BeliefDelta& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    out.episodeId = v.string("episodeId");
    out.distillationId = optionalString(v, "distillationId");
    out.producerPhase = parseBeliefDeltaProducerPhase(v.string("producerPhase"));
    out.operation = parseBeliefOperation(v.string("operation"));
    out.sourceBeliefId = optionalString(v, "sourceBeliefId");
    out.resultBeliefId = v.string("resultBeliefId");
    out.beliefId = optionalString(v, "beliefId");
    out.evidence = optionalString(v, "evidence");
    const json::Value* resulting = v.find("resultingBeliefs");
    if (resulting != nullptr) out.resultingBeliefs = readBeliefArray(*resulting);
    return true;
}

bool readIntervention(const json::Value& v, Intervention& out) {
    if (!v.isObject()) return false;
    out.id = v.string("id");
    const json::Value* contents = v.find("contents");
    if (contents != nullptr) out.contents = domainContentText(*contents);
    out.stage = parseEpisodeStage(v.string("stage"));
    out.afterExecution = optionalString(v, "afterExecution");
    out.createdAt = v.string("createdAt");
    return true;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

bool readEpisodeBody(const json::Value& v, EpisodeBody& out) {
    if (!v.isObject()) return false;
    out = EpisodeBody{};
    // The body is discriminated by `kind`; only the matching fields are read.
    out.kind = parseEpisodeBodyKind(v.string("kind"));
    switch (out.kind) {
        case EpisodeBodyKind::BeliefLoop: {
            out.openBeliefsAtStart = v.stringArray("openBeliefsAtStart");
            const json::Value* plan = v.object("plan");
            if (plan != nullptr) {
                Plan parsed;
                if (readPlan(*plan, parsed)) out.plan = std::move(parsed);
            }
            const json::Value* deltas = v.find("beliefDeltas");
            if (deltas != nullptr && deltas->isArray()) {
                for (size_t i = 0; i < deltas->size(); ++i) {
                    BeliefDelta delta;
                    if (readBeliefDelta(deltas->at(i), delta)) out.beliefDeltas.push_back(std::move(delta));
                }
            }
            break;
        }
        case EpisodeBodyKind::FastPath: {
            const json::Value* adoption = v.find("formulation");
            if (adoption != nullptr) out.formulation = readFormulationAdoption(*adoption);
            break;
        }
        case EpisodeBodyKind::Pending:
            break;
    }
    // Shared by both classified kinds.
    const json::Value* trajectory = v.find("trajectory");
    if (trajectory != nullptr && trajectory->isArray()) {
        for (size_t i = 0; i < trajectory->size(); ++i) {
            const json::Value& e = trajectory->at(i);
            Execution execution;
            if (!readExecutionStarted(e, execution)) continue;
            // A snapshot carries the terminal state directly (there is no separate
            // ExecutionCompleted event to replay).
            execution.outputPreview.clear();
            execution.outputBytes = 0;
            const json::Value* output = e.find("output");
            if (output != nullptr) {
                execution.outputPreview = flattenContent(*output, kExecutionOutputPreviewChars, execution.outputBytes);
            }
            execution.status = parseExecutionStatus(e.string("status"));
            execution.error = optionalString(e, "error");
            out.trajectory.push_back(std::move(execution));
        }
    }
    const json::Value* distillation = v.object("distillation");
    if (distillation != nullptr) {
        Distillation parsed;
        if (readDistillation(*distillation, parsed)) out.distillation = std::move(parsed);
    }
    return true;
}

bool readEpisode(const json::Value& v, ExecutionEpisode& out) {
    if (!v.isObject()) return false;
    out = ExecutionEpisode{};
    out.id = v.string("id");
    out.taskId = v.string("taskId");
    out.ordinal = static_cast<uint64_t>(v.integer("ordinal", 0));
    out.status = parseEpisodeStatus(v.string("status"));
    out.stage = parseEpisodeStage(v.string("stage"));
    // A restored session reads its episode start from the snapshot record. An
    // older snapshot has no `startedAt`; an empty string parses to -1, which keeps
    // the episode on the boundary fallback rather than misplacing it.
    out.occurredAtMs = parseIso8601Millis(v.string("startedAt"));
    const json::Value* steering = v.find("steering");
    if (steering != nullptr && steering->isArray()) {
        for (size_t i = 0; i < steering->size(); ++i) {
            Intervention intervention;
            if (readIntervention(steering->at(i), intervention)) out.steering.push_back(std::move(intervention));
        }
    }
    const json::Value* routing = v.object("routing");
    if (routing != nullptr) {
        Routing parsed;
        if (readRouting(*routing, parsed)) out.routing = std::move(parsed);
    }
    const json::Value* selection = v.object("experimentSelection");
    if (selection != nullptr) {
        ExperimentSelectionRecord parsed;
        if (readExperimentSelection(*selection, parsed)) out.experimentSelection = std::move(parsed);
    }
    const json::Value* body = v.object("body");
    if (body != nullptr) readEpisodeBody(*body, out.body);
    return true;
}

bool readTask(const json::Value& v, Task& out) {
    if (!v.isObject()) return false;
    out = Task{};
    out.id = v.string("id");
    out.parentTaskId = optionalString(v, "parentTaskId");
    const json::Value* prompt = v.object("initialPrompt");
    if (prompt != nullptr) readInitialPrompt(*prompt, out.initialPrompt);
    const json::Value* target = v.object("initialTarget");
    if (target != nullptr) {
        Target parsed;
        if (readTarget(*target, parsed)) out.initialTarget = std::move(parsed);
    }
    out.status = parseTaskStatus(v.string("status"));
    out.inheritedBeliefs = v.stringArray("inheritedBeliefs");
    out.introducedBeliefs = v.stringArray("introducedBeliefs");
    const json::Value* episodes = v.find("episodes");
    if (episodes != nullptr && episodes->isArray()) {
        for (size_t i = 0; i < episodes->size(); ++i) {
            ExecutionEpisode episode;
            if (readEpisode(episodes->at(i), episode)) out.episodes.push_back(std::move(episode));
        }
    }
    out.focus = v.stringArray("focus");
    out.focusDeclared = v.boolean("focusDeclared", false);

    const json::Value* review = v.object("formulationReview");
    if (review != nullptr) {
        FormulationReview parsed;
        if (readFormulationReview(*review, parsed)) out.formulationReview = std::move(parsed);
    }

    const json::Value* outcome = v.object("taskOutcome");
    if (outcome != nullptr) {
        TaskOutcome parsed;
        if (readTaskOutcome(*outcome, parsed)) out.taskOutcome = std::move(parsed);
    }

    const json::Value* formulations = v.find("formulations");
    if (formulations != nullptr && formulations->isArray()) {
        for (size_t i = 0; i < formulations->size(); ++i) {
            ProblemFormulationVersion version;
            if (readFormulationVersion(formulations->at(i), version)) {
                out.formulations.push_back(std::move(version));
            }
        }
    }

    const json::Value* deferral = v.object("formulationDeferral");
    if (deferral != nullptr) {
        FormulationDeferral parsed;
        if (readFormulationDeferral(*deferral, parsed)) out.formulationDeferral = std::move(parsed);
    }

    const json::Value* corrections = v.find("formulationCorrections");
    if (corrections != nullptr && corrections->isArray()) {
        for (size_t i = 0; i < corrections->size(); ++i) {
            FormulationCorrection correction;
            if (readFormulationCorrection(corrections->at(i), correction)) {
                out.formulationCorrections.push_back(std::move(correction));
            }
        }
    }

    const json::Value* recheck = v.object("formulationRecheck");
    if (recheck != nullptr) {
        FormulationRecheck parsed;
        if (readFormulationRecheck(*recheck, parsed)) out.formulationRecheck = std::move(parsed);
    }
    return true;
}

bool readFormulationReview(const json::Value& review, FormulationReview& out) {
    if (!review.isObject()) return false;
    out = FormulationReview{};
    out.versionId = review.string("versionId");
    out.responseCorrectionId = optionalString(review, "responseCorrectionId");
    const json::Value* approval = review.object("approval");
    if (approval != nullptr) {
        FormulationApproval a;
        a.versionId = approval->string("versionId");
        a.approvedAt = approval->string("approvedAt");
        out.approval = std::move(a);
    }
    out.focusReviewed = review.boolean("focusReviewed", false);
    out.scopedBeliefIds = review.stringArray("scopedBeliefIds");
    out.introducedAtRevision = static_cast<size_t>(review.integer("introducedAtRevision", 0));
    const json::Value* applicability = review.find("applicability");
    if (applicability != nullptr && applicability->isArray()) {
        for (size_t i = 0; i < applicability->size(); ++i) {
            FormulationApplicabilityEntry entry;
            if (readApplicabilityEntry(applicability->at(i), entry)) {
                out.applicability.push_back(std::move(entry));
            }
        }
    }
    return true;
}

bool readFormulationDeferral(const json::Value& deferral, FormulationDeferral& out) {
    if (!deferral.isObject()) return false;
    out = FormulationDeferral{};
    out.missingInformation = deferral.string("missingInformation");
    out.reason = deferral.string("reason");
    const json::Value* sources = deferral.find("sources");
    if (sources != nullptr) out.sources = readFormulationSourceArray(*sources);
    out.deferredAt = deferral.string("deferredAt");
    out.answeredThroughEpisodeOrdinal =
        static_cast<uint64_t>(deferral.integer("answeredThroughEpisodeOrdinal", 0));
    return true;
}

// TS: FormulationState (the `get_state` response's task-level half)
bool readFormulationState(const json::Value& v, FormulationState& out) {
    if (!v.isObject()) return false;
    out = FormulationState{};
    const json::Value* review = v.object("review");
    if (review != nullptr) {
        FormulationReview parsed;
        if (readFormulationReview(*review, parsed)) out.review = std::move(parsed);
    }
    // `current` and `deferral` are emitted as explicit nulls before the first
    // version / when no deferral is current, so object() — which answers nullptr
    // for a null member — is exactly the right test.
    const json::Value* current = v.object("current");
    if (current != nullptr) {
        ProblemFormulationVersion parsed;
        if (readFormulationVersion(*current, parsed)) out.current = std::move(parsed);
    }
    const json::Value* deferral = v.object("deferral");
    if (deferral != nullptr) {
        FormulationDeferral parsed;
        if (readFormulationDeferral(*deferral, parsed)) out.deferral = std::move(parsed);
    }
    const json::Value* corrections = v.find("corrections");
    if (corrections != nullptr && corrections->isArray()) {
        for (size_t i = 0; i < corrections->size(); ++i) {
            FormulationCorrection correction;
            if (readFormulationCorrection(corrections->at(i), correction)) {
                out.corrections.push_back(std::move(correction));
            }
        }
    }
    out.decisionOwed = v.boolean("decisionOwed", false);
    out.recheckOwed = v.boolean("recheckOwed", false);
    const json::Value* recheck = v.object("recheck");
    if (recheck != nullptr) {
        FormulationRecheck parsed;
        if (readFormulationRecheck(*recheck, parsed)) out.recheck = std::move(parsed);
    }
    out.awaitingResponse = v.boolean("awaitingResponse", false);
    out.approved = v.boolean("approved", false);
    const json::Value* resume = v.object("resume");
    if (resume != nullptr) {
        FormulationResumeState parsed;
        parsed.versionId = resume->string("versionId");
        parsed.phase = parseFormulationResumePhase(resume->string("phase"));
        parsed.reason = optionalString(*resume, "reason");
        out.resume = std::move(parsed);
    }
    out.pendingApplicability = v.stringArray("pendingApplicability");
    out.unrevalidated = v.stringArray("unrevalidated");
    return true;
}

// TS: RpcSessionState (the whole `get_state` response body)
bool readSessionState(const json::Value& v, SessionState& out) {
    if (!v.isObject()) return false;
    out = SessionState{};
    out.sessionId = v.string("sessionId");
    out.sessionFile = v.string("sessionFile");
    out.sessionName = v.string("sessionName");
    out.thinkingLevel = v.string("thinkingLevel");
    out.isStreaming = v.boolean("isStreaming", false);
    out.isCompacting = v.boolean("isCompacting", false);
    // Presence, not truthiness: a runtime that does not report the toggle has not
    // said it is off, and the pane draws a disabled control rather than a lie.
    if (v.find("autoApproveFrame") != nullptr) {
        out.autoApproveFrame = v.boolean("autoApproveFrame", false);
        out.autoApproveKnown = true;
    }
    out.messageCount = static_cast<long>(v.integer("messageCount", 0));
    out.pendingMessageCount = static_cast<long>(v.integer("pendingMessageCount", 0));
    // `formulation: null` is the no-open-task case and stays nullopt; it is not
    // the same as a task whose formulation state is empty.
    const json::Value* formulation = v.object("formulation");
    if (formulation != nullptr) {
        FormulationState parsed;
        if (readFormulationState(*formulation, parsed)) out.formulation = std::move(parsed);
    }
    out.present = true;
    return true;
}

bool readDomainSnapshot(const json::Value& data, AgentSessionSnapshot& out) {
    if (!data.isObject()) return false;
    out = AgentSessionSnapshot{};
    out.id = data.string("sessionId");
    out.activeBranchTasks = data.stringArray("activeBranchTasks");
    const json::Value* tasks = data.find("tasks");
    if (tasks != nullptr && tasks->isArray()) {
        for (size_t i = 0; i < tasks->size(); ++i) {
            Task task;
            if (!readTask(tasks->at(i), task)) continue;
            if (task.id.empty()) continue;
            if (out.tasks.find(task.id) != out.tasks.end()) continue;
            out.taskOrder.push_back(task.id);
            out.tasks.emplace(task.id, std::move(task));
        }
    }
    const json::Value* beliefs = data.find("beliefs");
    if (beliefs != nullptr && beliefs->isArray()) {
        for (size_t i = 0; i < beliefs->size(); ++i) {
            Belief belief;
            if (!readBelief(beliefs->at(i), belief)) continue;
            if (belief.id.empty()) continue;
            if (out.beliefs.find(belief.id) != out.beliefs.end()) continue;
            out.beliefOrder.push_back(belief.id);
            out.beliefs.emplace(belief.id, std::move(belief));
        }
    }
    out.activeBeliefs = data.stringArray("activeBeliefs");
    const json::Value* cursor = data.object("cursor");
    if (cursor != nullptr) {
        AgentSessionCursor parsed;
        parsed.taskId = cursor->string("taskId");
        parsed.episodeId = cursor->string("episodeId");
        parsed.stage = parseEpisodeStage(cursor->string("stage"));
        out.cursor = std::move(parsed);
    }
    return true;
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

DomainParseResult parseDomainEvent(const json::Value& line, DomainEvent& out) {
    out = DomainEvent{};
    if (!line.isObject()) return DomainParseResult::Malformed;
    const std::string type = line.string("type");
    if (type.empty()) return DomainParseResult::Malformed;
    const DomainEventKind kind = domainEventKindFromName(type);
    if (kind == DomainEventKind::Unknown) return DomainParseResult::NotDomainEvent;
    out.kind = kind;
    out.type = type;
    out.eventId = line.string("eventId");
    out.timestamp = line.string("timestamp");
    out.taskId = line.string("taskId");
    out.episodeId = line.string("episodeId");
    out.schemaVersion = static_cast<int>(line.integer("schemaVersion", 0));
    out.json = line;
    return DomainParseResult::Parsed;
}

DomainParseResult parseDomainEvent(std::string_view line, DomainEvent& out, std::string* error) {
    out = DomainEvent{};
    json::Value parsed;
    json::ParseError parseError;
    if (!json::parseLine(line, parsed, &parseError)) {
        if (error != nullptr) {
            *error = parseError.message.empty() ? std::string("invalid JSON") : parseError.message;
        }
        return DomainParseResult::Malformed;
    }
    if (!parsed.isObject()) {
        if (error != nullptr) *error = "a wire line must be a JSON object";
        return DomainParseResult::Malformed;
    }
    const std::string type = parsed.string("type");
    if (type.empty()) {
        if (error != nullptr) *error = "the wire line has no `type`";
        return DomainParseResult::Malformed;
    }
    const DomainEventKind kind = domainEventKindFromName(type);
    if (kind == DomainEventKind::Unknown) return DomainParseResult::NotDomainEvent;
    out.kind = kind;
    out.type = type;
    out.eventId = parsed.string("eventId");
    out.timestamp = parsed.string("timestamp");
    out.taskId = parsed.string("taskId");
    out.episodeId = parsed.string("episodeId");
    out.schemaVersion = static_cast<int>(parsed.integer("schemaVersion", 0));
    // Move rather than copy: a large `output` payload should not be duplicated
    // on the way into the applier.
    out.json = std::move(parsed);
    return DomainParseResult::Parsed;
}

// ---------------------------------------------------------------------------
// Trace rendering
// ---------------------------------------------------------------------------

namespace {

// Days from 1970-01-01 for a civil date (Howard Hinnant's days_from_civil). Kept
// local because the alternative is <chrono>'s calendar support, which is C++20
// but unevenly implemented, and this is fifteen lines of arithmetic with no
// timezone database behind it.
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

bool allDigits(std::string_view s) {
    if (s.empty()) return false;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
    }
    return true;
}

// Truncate to `maxBytes` without splitting a UTF-8 sequence: a Chinese prompt cut
// mid-codepoint would render as a replacement character in the detail column.
std::string ellipsize(const std::string& text, size_t maxBytes) {
    if (text.size() <= maxBytes) return text;
    size_t cut = maxBytes;
    while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80) --cut;
    return text.substr(0, cut) + "\xe2\x80\xa6";  // …
}

// A quoted, length-capped field. Quoted so a blank value is visibly blank rather
// than an empty column, which would read as "no detail recorded".
std::string quoted(const std::string& text) {
    if (text.empty()) return "\"\"";
    return "\"" + ellipsize(text, 90) + "\"";
}

std::string join(const std::vector<std::string>& parts, const char* sep) {
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i != 0) out += sep;
        out += parts[i];
    }
    return out;
}

} // namespace

int64_t parseIso8601Millis(std::string_view text) {
    if (text.empty()) return -1;
    // A bare number is epoch milliseconds; the wire uses this for message
    // timestamps, which come from Date.now().
    if (allDigits(text)) {
        return static_cast<int64_t>(std::strtoll(std::string(text).c_str(), nullptr, 10));
    }
    // YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM) — fixed positions, so this is a scan and
    // not a parser. Anything else is refused rather than guessed at.
    if (text.size() < 20) return -1;
    if (text[4] != '-' || text[7] != '-' || text[10] != 'T' || text[13] != ':' || text[16] != ':') return -1;
    const std::string_view date = text.substr(0, 10);
    if (!allDigits(date.substr(0, 4)) || !allDigits(date.substr(5, 2)) || !allDigits(date.substr(8, 2))) return -1;
    if (!allDigits(text.substr(11, 2)) || !allDigits(text.substr(14, 2)) || !allDigits(text.substr(17, 2))) return -1;

    const int64_t year = std::strtoll(std::string(date.substr(0, 4)).c_str(), nullptr, 10);
    const unsigned month = static_cast<unsigned>(std::strtoul(std::string(text.substr(5, 2)).c_str(), nullptr, 10));
    const unsigned day = static_cast<unsigned>(std::strtoul(std::string(text.substr(8, 2)).c_str(), nullptr, 10));
    const int64_t hour = std::strtoll(std::string(text.substr(11, 2)).c_str(), nullptr, 10);
    const int64_t minute = std::strtoll(std::string(text.substr(14, 2)).c_str(), nullptr, 10);
    const int64_t second = std::strtoll(std::string(text.substr(17, 2)).c_str(), nullptr, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return -1;

    int64_t millis = 0;
    size_t cursor = 19;
    if (cursor < text.size() && text[cursor] == '.') {
        ++cursor;
        int64_t scale = 100;
        while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9') {
            if (scale > 0) {
                millis += static_cast<int64_t>(text[cursor] - '0') * scale;
                scale /= 10;
            }
            ++cursor;
        }
    }
    if (cursor >= text.size()) return -1;

    int64_t offsetSeconds = 0;
    if (text[cursor] == 'Z') {
        if (cursor + 1 != text.size()) return -1;
    } else if (text[cursor] == '+' || text[cursor] == '-') {
        // ±HH:MM
        if (cursor + 6 != text.size() || text[cursor + 3] != ':') return -1;
        if (!allDigits(text.substr(cursor + 1, 2)) || !allDigits(text.substr(cursor + 4, 2))) return -1;
        const int64_t offHour = std::strtoll(std::string(text.substr(cursor + 1, 2)).c_str(), nullptr, 10);
        const int64_t offMinute = std::strtoll(std::string(text.substr(cursor + 4, 2)).c_str(), nullptr, 10);
        offsetSeconds = offHour * 3600 + offMinute * 60;
        if (text[cursor] == '-') offsetSeconds = -offsetSeconds;
    } else {
        return -1;
    }

    const int64_t days = daysFromCivil(year, month, day);
    const int64_t secondsOfDay = hour * 3600 + minute * 60 + second;
    return ((days * 86400) + secondsOfDay - offsetSeconds) * 1000 + millis;
}

std::string describeDomainEvent(const NativeGuiModel& model, const DomainEvent& event) {
    const json::Value& e = event.json;
    auto label = [&model](const std::string& id) { return model.beliefLabel(id); };
    auto labels = [&label](const std::vector<std::string>& ids) {
        std::vector<std::string> out;
        out.reserve(ids.size());
        for (const std::string& id : ids) out.push_back(label(id));
        return join(out, ",");
    };

    switch (event.kind) {
        case DomainEventKind::TaskOpened: {
            const json::Value* prompt = e.object("initialPrompt");
            const std::string text = prompt != nullptr ? prompt->string("effective") : std::string{};
            return "task opened: " + quoted(text);
        }
        case DomainEventKind::TaskClosed:
            return "task closed (" + e.string("status", "unknown") + ")";
        case DomainEventKind::TargetDefined: {
            const json::Value* target = e.object("target");
            return "target: " + quoted(target != nullptr ? target->string("statement") : std::string{});
        }
        case DomainEventKind::FocusDeclared: {
            const std::vector<std::string> ids = e.stringArray("beliefIds");
            return ids.empty() ? std::string("focus declared: (empty)") : "focus declared: " + labels(ids);
        }
        case DomainEventKind::TaskOutcomeRecorded: {
            const json::Value* outcome = e.object("outcome");
            return "outcome: " + quoted(outcome != nullptr ? outcome->string("result") : std::string{});
        }
        case DomainEventKind::ProblemFormulationRecorded: {
            const json::Value* version = e.object("version");
            if (version == nullptr) return "frame recorded";
            const json::Value* content = version->object("content");
            const std::string interpretation =
                content != nullptr ? content->string("interpretation") : std::string{};
            return "Frame v" + std::to_string(version->integer("ordinal", 0)) + " recorded: " +
                   quoted(interpretation);
        }
        case DomainEventKind::ProblemFormulationDeferred: {
            std::string reason = e.string("reason");
            if (reason.empty()) reason = e.string("missingInformation");
            return "frame deferred: " + quoted(reason);
        }
        case DomainEventKind::FormulationApproved:
            return "frame approved: " + e.string("versionId", "?");
        case DomainEventKind::FormulationCorrectionSubmitted: {
            const json::Value* correction = e.object("correction");
            return "correction: " +
                   quoted(correction != nullptr ? correction->string("original") : std::string{});
        }
        case DomainEventKind::FormulationCorrectionResolved: {
            const std::string recorded = e.string("recordedVersionId");
            const std::string correctionId = e.string("correctionId", "?");
            if (!recorded.empty()) return "correction " + correctionId + " resolved as " + recorded;
            return "correction " + correctionId + " resolved";
        }
        case DomainEventKind::FormulationApplicabilityRecorded: {
            const json::Value* raw = e.find("applicability");
            if (raw == nullptr) raw = e.find("entries");
            if (raw == nullptr || !raw->isArray() || raw->size() == 0) return "applicability recorded";
            std::vector<std::string> parts;
            for (size_t i = 0; i < raw->size(); ++i) {
                const json::Value& entry = raw->at(i);
                if (!entry.isObject()) continue;
                parts.push_back(label(entry.string("beliefId")) + " " + entry.string("decision", "?"));
            }
            return "applicability: " + join(parts, ", ");
        }
        case DomainEventKind::FormulationRecheckRecorded: {
            const json::Value* recheck = e.object("recheck");
            if (recheck == nullptr) return "recheck recorded";
            const std::string verdict = recheck->string("verdict", "?");
            const std::string reason = recheck->string("reason");
            const std::string version = recheck->string("versionId");
            std::string line = "recheck (" + verdict + ")";
            if (!version.empty()) line += " as " + version;
            if (!reason.empty()) line += ": " + quoted(reason);
            return line;
        }
        case DomainEventKind::EpisodeOpened:
            return "episode #" + std::to_string(e.integer("ordinal", 0)) + " opened";
        case DomainEventKind::RoutingDecided: {
            const json::Value* routing = e.object("routing");
            if (routing == nullptr) return "routing decided";
            return "routing: " + routing->string("decision", "?") + " (p=" +
                   std::to_string(routing->number("successProbability", 0.0)).substr(0, 4) + ")";
        }
        case DomainEventKind::EpisodeBodySelected: {
            const std::string body = e.string("body", "?");
            const json::Value* adoption = e.object("formulation");
            if (adoption == nullptr) return "body: " + body;
            const std::string version = adoption->string("versionId");
            return "body: " + body + (version.empty() ? " (unformed)" : " under " + version);
        }
        case DomainEventKind::EpisodeClosed:
            return "episode closed";
        case DomainEventKind::CursorChanged:
            return std::string("cursor \xe2\x86\x92 ") + toString(parseEpisodeStage(e.string("stage")));
        case DomainEventKind::InterventionAdded: {
            const json::Value* intervention = e.object("intervention");
            return "intervention: " +
                   quoted(intervention != nullptr ? intervention->string("contents") : std::string{});
        }
        case DomainEventKind::ExperimentSelected: {
            const json::Value* selection = e.object("selection");
            if (selection == nullptr) return "experiment selected";
            const std::vector<std::string> ids = selection->stringArray("beliefIds");
            return "experiment selected: " + quoted(selection->string("intent")) +
                   (ids.empty() ? std::string{} : " on " + labels(ids));
        }
        case DomainEventKind::ExperimentSelectionVoided:
            return "selection voided: " + quoted(e.string("reason"));
        case DomainEventKind::BeliefDeltaApplied: {
            const json::Value* delta = e.object("delta");
            if (delta == nullptr) return "belief delta";
            const std::string operation = delta->string("operation", "?");
            const std::string phase = delta->string("producerPhase", "?");
            const std::string source = delta->string("sourceBeliefId");
            const std::string result = delta->string("resultBeliefId");
            // Two shapes, because they say different things: a delta that reads an
            // existing belief names both sides ("B1 refute -> B4"), while a propose
            // has no source and is the birth of its result.
            std::string line = source.empty()
                                   ? "new " + label(result)
                                   : label(source) + " " + operation + " \xe2\x86\x92 " + label(result);
            line += " (" + phase + ")";
            return line;
        }
        case DomainEventKind::PlanProduced: {
            const json::Value* plan = e.object("plan");
            if (plan == nullptr) return "plan produced";
            const std::vector<std::string> ids = plan->stringArray("selectedToExplore");
            const std::string id = plan->string("id", "?");
            if (ids.empty()) return "Plan " + id + " selects nothing";
            return "Plan " + id + " selects " + labels(ids);
        }
        case DomainEventKind::ExecutionStarted: {
            const json::Value* execution = e.object("execution");
            if (execution == nullptr) return "execution started";
            const std::string summary = summarizeExecutionInput(*execution->find("input"));
            return "exec " + execution->string("id", "?") + ": " + execution->string("tool", "?") +
                   (summary.empty() ? std::string{} : " " + quoted(summary));
        }
        case DomainEventKind::ExecutionCompleted: {
            const std::string status = e.string("status", "?");
            return "exec " + e.string("executionId", "?") + " " + status;
        }
        case DomainEventKind::DistillationProduced: {
            const json::Value* distillation = e.object("distillation");
            if (distillation == nullptr) return "distillation produced";
            const size_t inputs = distillation->array("inputs") != nullptr ? distillation->array("inputs")->size() : 0;
            const size_t outputs =
                distillation->array("outputs") != nullptr ? distillation->array("outputs")->size() : 0;
            return "distillation " + distillation->string("id", "?") + ": " + std::to_string(inputs) +
                   " execution(s) \xe2\x86\x92 " + std::to_string(outputs) + " delta(s)";
        }
        case DomainEventKind::Unknown:
            break;
    }
    // An unrecognized kind still gets a line: the trace is a debugger, and "this
    // event arrived and I have nothing to say about it" is a fact worth showing.
    return event.type.empty() ? std::string("(unknown event)") : event.type;
}

} // namespace pie::gui
