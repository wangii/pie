// DomainEvents: the v7 agent-session domain event vocabulary and its wire
// parsing.
//
// Two jobs, kept apart from the fold in Model.cpp:
//   * recognize which domain event a JSONL line is and pull out the correlation
//     ids every event carries (kind, eventId, timestamp, taskId, episodeId,
//     schemaVersion), and
//   * read each event's payload into the v7 mirror structs.
//
// The event NAMES and payload shapes come from
// `packages/pie/src/core/agent-session-domain.ts` (`DOMAIN_EVENT_APPLIERS` is
// the authoritative list of the 25 types).
//
// WIRE SHAPE (docs/milestones.md §3.1) — this was once got wrong, so it is
// stated here: domain events are NOT wrapped in `entry_added`/`customType` on
// the wire. The real path is
//
//   BeliefLoopController.recordDomainEvent(event)
//     ├─ appendAgentSessionDomainEvent(...)  → disk: {schemaVersion, event} + customType
//     └─ this.host._emit(event)              → live stream: the BARE event
//
// `toJsonEvent(event)` passes anything that is not `message_update` through
// unchanged, and `AgentSessionEvent ⊇ AgentSessionDomainEvent`. So a wire line
// is one flat object whose top-level `type` IS the event name:
//
//   {"type":"EpisodeOpened","schemaVersion":7,"eventId":"event-…", …}
//
// The {schemaVersion, event} wrapper and `customType:
// "pie.agent-session-domain-event"` exist only in the on-disk session entry. The
// adapter therefore never unwraps anything and never inspects customType.

#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include "Json.h"
#include "Model.h"

namespace pie::gui {

// TS: AgentSessionDomainEvent["type"] — exactly the keys of DOMAIN_EVENT_APPLIERS.
// Grouped the way the appliers group them (task / formulation / episode / loop).
enum class DomainEventKind {
    Unknown,

    // --- task (applyTaskEvent) ---
    TaskOpened,
    TaskClosed,
    TargetDefined,
    FocusDeclared,
    TaskOutcomeRecorded,

    // --- formulation (applyFormulationEvent) ---
    ProblemFormulationRecorded,
    ProblemFormulationDeferred,
    FormulationApproved,
    FormulationCorrectionSubmitted,
    FormulationCorrectionResolved,
    FormulationApplicabilityRecorded,
    FormulationRecheckRecorded,

    // --- episode (applyEpisodeEvent) ---
    EpisodeOpened,
    RoutingDecided,
    EpisodeBodySelected,
    EpisodeClosed,
    CursorChanged,
    InterventionAdded,
    ExperimentSelected,
    ExperimentSelectionVoided,

    // --- loop (applyLoopEvent) ---
    BeliefDeltaApplied,
    PlanProduced,
    ExecutionStarted,
    ExecutionCompleted,
    DistillationProduced,
};

// TS: Object.keys(DOMAIN_EVENT_APPLIERS).length
inline constexpr size_t kDomainEventKindCount = 25;

// The wire name, or "Unknown".
const char* domainEventKindName(DomainEventKind kind);
// The kind for a wire name, or Unknown when the name is not a domain event.
DomainEventKind domainEventKindFromName(std::string_view name);

// The applier category that owns a kind (TS: the DOMAIN_EVENT_APPLIERS table).
// The fold switches on this so moving an event between categories is one edit.
enum class DomainEventCategory { Unknown, Task, Formulation, Episode, Loop };
DomainEventCategory domainEventCategory(DomainEventKind kind);

// A parsed wire event: the kind, the correlation ids every event carries, and
// the event object itself. The appliers read payload fields off `json`, so a new
// optional field needs no struct change and no second parse.
struct DomainEvent {
    DomainEventKind kind = DomainEventKind::Unknown;
    std::string type;       // verbatim wire name
    std::string eventId;    // TS: DomainEventBase.eventId — the idempotence key
    std::string timestamp;
    std::string taskId;     // TS: TaskEventBase.taskId (empty for a malformed line)
    std::string episodeId;  // TS: EpisodeEventBase.episodeId (empty when task-level)
    int schemaVersion = 0;
    json::Value json;       // the event object, owned
};

// The outcome of reading one line.
enum class DomainParseResult {
    // A recognized domain event; `out` is filled.
    Parsed,
    // Well-formed JSON that is not a domain event (message_start, session_status,
    // an RPC response, …). The caller routes it elsewhere.
    NotDomainEvent,
    // Not JSON, or JSON that is not an object / has no `type`.
    Malformed,
};

// Parse one JSONL line. On Parsed, `out.json` owns the event object. `error`
// receives a human-readable reason for Malformed.
DomainParseResult parseDomainEvent(std::string_view line, DomainEvent& out, std::string* error = nullptr);
// Same, from an already-parsed line (the reader thread parses once and the main
// thread drains json::Value, per docs/milestones.md §5.3).
DomainParseResult parseDomainEvent(const json::Value& line, DomainEvent& out);

// ---------------------------------------------------------------------------
// Enum readers (TS: the string-literal unions). Each maps an unrecognized string
// to the `Unknown` member rather than guessing.
// ---------------------------------------------------------------------------
TaskStatus parseTaskStatus(std::string_view v);
EpisodeStatus parseEpisodeStatus(std::string_view v);
EpisodeStage parseEpisodeStage(std::string_view v);
EpisodeBodyKind parseEpisodeBodyKind(std::string_view v);
BeliefDomain parseBeliefDomain(std::string_view v);
BeliefOperation parseBeliefOperation(std::string_view v);
BeliefDeltaProducerPhase parseBeliefDeltaProducerPhase(std::string_view v);
RoutingDecision parseRoutingDecision(std::string_view v);
RoutingDifficulty parseRoutingDifficulty(std::string_view v);
ExecutionStatus parseExecutionStatus(std::string_view v);
FormulationCorrectionStatus parseFormulationCorrectionStatus(std::string_view v);
FormulationRecheckVerdict parseFormulationRecheckVerdict(std::string_view v);
FormulationApplicabilityDecision parseFormulationApplicabilityDecision(std::string_view v);
FormulationSourceKind parseFormulationSourceKind(std::string_view v);

// ---------------------------------------------------------------------------
// Payload readers.
//
// Each returns false when the value is not an object (a malformed payload); the
// applier then records a ReplayIssue and no-ops. Individual fields are read
// leniently: a missing optional is absent, a missing required field is empty,
// and the contract-level checks live in the fold, not here.
// ---------------------------------------------------------------------------

// TS: DomainContent = string | JsonValue[] — flattened to readable text. The
// array form (an assistant content block list) is reduced to its text and
// thinking parts, joined by a space.
std::string domainContentText(const json::Value& value);
// TS: Execution.input (JsonValue) — a one-line summary preferring `command`,
// then `path`/`file_path`, else the flattened text.
std::string summarizeExecutionInput(const json::Value& value);
// TS: AdvancementIntent — `action` is required, `condition`/`next` come as a
// pair (the tool refuses half an intention).
void readAdvancement(const json::Value& obj, std::optional<std::string>& action,
                     std::optional<std::string>& condition, std::optional<std::string>& next);

// TS: Belief
bool readBelief(const json::Value& v, Belief& out);
// TS: Belief[]
std::vector<Belief> readBeliefArray(const json::Value& v);

// TS: FormulationSource / FormulationSource[]
bool readFormulationSource(const json::Value& v, FormulationSource& out);
std::vector<FormulationSource> readFormulationSourceArray(const json::Value& v);
// TS: FormulationAdoption — an absent value stays `unformed` (the honest record
// for "no version had been formed").
FormulationAdoption readFormulationAdoption(const json::Value& v);

// TS: FormulationContent
bool readFormulationContent(const json::Value& v, FormulationContent& out);
// TS: ProblemFormulationVersion
bool readFormulationVersion(const json::Value& v, ProblemFormulationVersion& out);
// TS: FormulationCorrection
bool readFormulationCorrection(const json::Value& v, FormulationCorrection& out);
// TS: FormulationApplicabilityEntry
bool readApplicabilityEntry(const json::Value& v, FormulationApplicabilityEntry& out);
// TS: FormulationRecheck
bool readFormulationRecheck(const json::Value& v, FormulationRecheck& out);
// TS: FormulationReview — shared by readTask's `formulationReview` member and
// FormulationState's `review`.
bool readFormulationReview(const json::Value& v, FormulationReview& out);
// TS: FormulationDeferral — shared by readTask and FormulationState.
bool readFormulationDeferral(const json::Value& v, FormulationDeferral& out);

// TS: Routing
bool readRouting(const json::Value& v, Routing& out);
// TS: TaskOutcome
bool readTaskOutcome(const json::Value& v, TaskOutcome& out);
// TS: InitialPrompt
bool readInitialPrompt(const json::Value& v, InitialPrompt& out);
// TS: Target
bool readTarget(const json::Value& v, Target& out);

// TS: Plan
bool readPlan(const json::Value& v, Plan& out);
// TS: ExperimentSelectionRecord
bool readExperimentSelection(const json::Value& v, ExperimentSelectionRecord& out);

// TS: ExecutionStarted's `execution` = Omit<Execution, "output"|"status"|"error">
bool readExecutionStarted(const json::Value& v, Execution& out);
// TS: ExecutionCompleted — applies output/status/error onto the started record.
bool readExecutionCompleted(const json::Value& event, Execution& out);

// TS: Distillation
bool readDistillation(const json::Value& v, Distillation& out);
// TS: BeliefDelta
bool readBeliefDelta(const json::Value& v, BeliefDelta& out);
// TS: Intervention
bool readIntervention(const json::Value& v, Intervention& out);

// ---------------------------------------------------------------------------
// Snapshot reader (TS: RpcDomainSnapshot from `get_domain_snapshot`)
//
// Note the wire difference from the in-memory type: the maps arrive as ARRAYS
// (`tasks: Task[]`, `beliefs: Belief[]`), because the RPC handler spreads the
// Map's values. Record order is therefore the array order.
// ---------------------------------------------------------------------------
bool readDomainSnapshot(const json::Value& data, AgentSessionSnapshot& out);
// TS: Task
bool readTask(const json::Value& v, Task& out);
// TS: ExecutionEpisode
bool readEpisode(const json::Value& v, ExecutionEpisode& out);
// TS: EpisodeBody
bool readEpisodeBody(const json::Value& v, EpisodeBody& out);

// ---------------------------------------------------------------------------
// Session-state reader (TS: RpcSessionState from `get_state`)
//
// Runtime state, not replayed domain state: the same JSON that a `get_state`
// response carries. See the SessionState comment in Model.h for why the GUI
// carries it separately rather than deriving it.
// ---------------------------------------------------------------------------
bool readSessionState(const json::Value& v, SessionState& out);
// TS: FormulationState — the task-level half of the above, also reachable
// directly for tests and for a future `formulation`-only response.
bool readFormulationState(const json::Value& v, FormulationState& out);

// ---------------------------------------------------------------------------
// Trace rendering (docs/milestones.md §7.3)
// ---------------------------------------------------------------------------

// Epoch milliseconds for the wire's ISO-8601 timestamps (`DomainEventBase.timestamp`,
// `message_start.timestamp`), or -1 when the text is not a timestamp this reader
// understands. A number is accepted directly (some RPC timestamps are epoch ms).
// Never throws and never assumes a timezone: only `Z` and an explicit `±HH:MM`
// offset are accepted, because a bare local time cannot be ordered against
// another machine's.
int64_t parseIso8601Millis(std::string_view text);

// One-line rendering of a domain event for the trace's detail column. Reads the
// event's OWN fields through the same DOM the appliers use: a field the event
// does not carry is left out of the line rather than guessed from a neighbouring
// event, and a belief id is rendered through `model.beliefLabel` so the line
// says "B4" the way every other pane does.
//
// Call it AFTER applying the event: the delta that introduces a belief is what
// gives that belief its label, and describing first would print a raw id.
std::string describeDomainEvent(const NativeGuiModel& model, const DomainEvent& event);

} // namespace pie::gui
