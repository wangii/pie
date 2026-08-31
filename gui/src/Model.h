// NativeGuiModel: a headless, testable state model of the PIE cognitive
// feedback loop. It is deliberately independent of Dear ImGui so it can be
// unit-tested without a window.
//
// The model consumes the explicit, versioned domain event stream (JSONL, one
// JSON object per line) defined in packages/pie/docs/domain-model.md. Every
// Task / TaskFrame / Belief identity is a stable opaque string id emitted by
// the runtime; the GUI never remaps ids to numeric indexes and never infers
// frame boundaries, stage, cursor position, or epistemic meaning from generic
// log adjacency. See applyLine() / applyRpcLine().

#pragma once

#include <cstddef>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "FileList.h"

namespace pie::gui {

// ---------------------------------------------------------------------------
// Stable domain ids (opaque strings, emitted verbatim by the runtime)
// ---------------------------------------------------------------------------
using TaskId = std::string;
using FrameId = std::string;
using BeliefId = std::string;
using PlanId = std::string;
using ExecutionId = std::string;
using DistillationId = std::string;
using BeliefDeltaId = std::string;

// The runtime's explicit stage. The GUI never derives this from logs; it only
// reads it from the latest CursorChanged event.
enum class FrameStage {
    NONE,
    ROUTING,
    PROPOSING,
    EXECUTING,
    DISTILLING,
    CLOSED,
};
const char* frameStageToString(FrameStage s);

// ---------------------------------------------------------------------------
// Belief (an immutable domain record; status is derived from provenance)
// ---------------------------------------------------------------------------
struct Belief {
    BeliefId id;
    std::string statement;   // the prose assertion
    std::string domain;      // "product" | "code"
    std::string expectation; // the falsifiable prediction
    int evidenceRounds = 0;
    std::vector<std::string> skillRefs;
    std::vector<std::string> supportedBy; // evidence strings
    std::vector<std::string> refutedBy;   // evidence strings
    std::vector<std::string> inconclusiveBy; // evidence strings that left the belief unsettled
    std::string supersededBy;             // empty when not superseded
    bool withdrawn = false;
    std::string status; // derived: proposed | supported | refuted | inconclusive | superseded
    // Explicit provenance: the frame whose BeliefDeltaApplied introduced this
    // belief. Empty when unknown. Set from the event's frameId, never inferred
    // from event adjacency.
    FrameId createdInFrame;
    // Display-only label ("B<n>" by first-seen order). Never used for correlation.
    std::string label;
};

// ---------------------------------------------------------------------------
// Frame contents
// ---------------------------------------------------------------------------
struct Plan {
    PlanId id;
    std::vector<BeliefId> selectedToExplore; // authoritative selection
    std::string intent;                      // optional epistemic intent
    std::string label;                       // display-only label ("P<n>")
    bool valid() const { return !id.empty(); }
};

struct Execution {
    ExecutionId id;    // the runtime execution/tool-call id
    PlanId planId;     // empty for a fast-path execution
    std::string tool;  // "read" / "bash" / "write" / "edit" / ...
    std::string command; // input summary
    std::string result;  // output summary
    std::string status;  // running | succeeded | failed | cancelled
    std::string warning; // error text when failed
    bool expanded = true; // UI-side expand/collapse
};

struct Distillation {
    DistillationId id;
    std::vector<ExecutionId> inputs;
    std::string contents;                    // interpretation / explanation
    std::vector<BeliefDeltaId> outputs;      // belief-delta ids it produced
    std::string label;                       // display-only label ("D<n>")
    bool valid() const { return !id.empty(); }
};

struct BeliefDelta {
    BeliefDeltaId id;
    FrameId frameId;
    DistillationId distillationId; // empty when not produced by a distillation
    std::string operation;         // propose | support | refute | inconclusive | refine | retract
    BeliefId beliefId;             // target belief
    std::string evidence;
};

struct Intervention {
    std::string id;
    std::string contents;
    std::string stage;
    std::string createdAt;
};

// A single belief-loop-role footer slot: the resolved model and the latest
// cache hit rate (percentage), populated from the runtime's session_status
// RPC telemetry event. Undefined values render as "—".
struct RoleFooterSlot {
    std::string model;           // "provider/id"
    float cacheHitRate = -1.0f;  // percentage, or negative when undefined
};

// Per-role context usage (the "current context length" for one belief-loop
// role), populated from the runtime's session_status "roleUsage" field.
// tokens/percent are negative when the runtime reports null (unknown).
struct RoleContextUsage {
    long tokens = -1;        // estimated context tokens, or negative when unknown
    long contextWindow = 0;  // model context window
    double percent = -1.0;   // percent of window, or negative when unknown
    bool valid() const { return tokens >= 0; }
};

// The two belief-loop roles the status bar shows its context length for:
// epistemic (propose) and execution. Populated from session_status "roleUsage".
struct RoleContextUsagePair {
    RoleContextUsage epistemic;
    RoleContextUsage execution;
    bool hasData = false;  // true once at least one roleUsage event arrived
};

// The bottom footer telemetry: per-role model + cache hit rate for the four
// belief-loop phases, and the accumulated session cost.
struct Footer {
    RoleFooterSlot epistemic;     // propose
    RoleFooterSlot distillation;  // distill
    RoleFooterSlot execution;     // execution
    double sessionCost = 0.0;
    bool hasData = false;         // true once at least one session_status event arrived
};

// A complete epistemic transaction (one TaskFrame).
struct LoopFrame {
    FrameId id;
    TaskId taskId;
    uint64_t ordinal = 0;
    FrameStage stage = FrameStage::NONE;
    bool closed = false;
    bool failed = false;

    std::string routingDecision; // "belief-loop" | "fast-path" | "" (pending)
    std::string routingReason;
    std::string bodyKind;        // "belief-loop" | "fast-path" | "" (pending)
    std::vector<BeliefId> openBeliefsAtStart;

    Plan plan;                            // at most one per frame
    std::vector<Execution> trajectory;
    Distillation distillation;            // at most one per frame
    std::vector<BeliefDelta> beliefDeltas;
    std::vector<Intervention> steering;

    std::string summary;     // for frame navigator chips (display-only)
    std::string openedAt;
    std::string closedAt;

    // Aggregate status used only for display in the navigator.
    enum class History { Closed, Unresolved, Falsified, NewBelief, Revised, Current };
    History history = History::Closed;
};

// One user Task: the ordered projection of TaskFrames on the selected branch.
struct Task {
    TaskId id;
    TaskId parentTaskId;   // empty when none
    std::string status;    // active | completed | cancelled | failed
    std::string prompt;    // effective initial prompt (text)
    std::string targetStatement; // immutable user outcome
    std::vector<BeliefId> inheritedBeliefs;
    std::vector<BeliefId> introducedBeliefs;
    std::vector<FrameId> frames; // ordered
};

// P1 frame search: case-insensitive substring test over the frame's display
// fields (id, summary, plan, trajectory, distillation, belief deltas). An empty
// query matches every frame; a non-matching query returns false.
bool frameMatchesQuery(const LoopFrame& f, std::string_view query);

struct FrameCursor {
    TaskId taskId;
    FrameId frameId;
    FrameStage stage = FrameStage::NONE;
    std::string item;  // execution id / plan id / belief id / distillation id
    bool valid() const { return !frameId.empty() && stage != FrameStage::NONE; }
};

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------
class NativeGuiModel {
public:
    // Apply one JSONL domain event line. Unknown / empty lines are ignored.
    // Only explicit events mutate state.
    void applyLine(const std::string& line);

    // Apply a single domain event (the shared business vocabulary from
    // packages/pie/docs/domain-model.md). Returns true when `line` was one of
    // the recognized domain event types. Used by applyLine() and by the live
    // RPC adapter (applyRpcLine).
    bool applyDomainLine(const std::string& line);

    void reset();

    // Belief registry, in first-inserted order (belief list order).
    const std::vector<Belief>& beliefs() const { return beliefs_; }
    const Belief* belief(BeliefId id) const;

    // Frame history in open order.
    std::vector<LoopFrame> frames() const;
    // The currently active (open) frame, or nullptr if none.
    const LoopFrame* activeFrame() const;
    // Look up a frame (open or closed) by its stable id.
    const LoopFrame* frameById(FrameId id) const;

    // Task projection on the active branch, in open order.
    std::vector<Task> tasks() const;
    const Task* taskById(TaskId id) const;
    // The currently active task, or nullptr if none.
    const Task* activeTask() const;
    // The one Task the Text/Graph views select. Defaults to the active task.
    const Task* selectedTask() const;

    const FrameCursor& cursor() const { return cursor_; }
    // Mutable cursor access, used by the event adapter to update the
    // active-frame cursor from a CursorChanged domain event.
    FrameCursor& mutableCursor() { return cursor_; }

    const std::string& session() const { return session_; }
    void setSession(std::string s) { session_ = std::move(s); }

    // Session-level read/write/edit file list (unchanged). See FileList.h.
    void recordFileOp(const std::string& op, const std::string& rawPath) {
        if (rawPath.empty()) return;
        std::string display = normalizeDisplayPath(session_, rawPath);
        std::string key = op + "\n" + display;
        if (fileOpSeen_.insert(key).second) {
            fileList_.push_back(FileEntry{display, op});
        }
    }
    const std::vector<FileEntry>& fileList() const { return fileList_; }
    void clearFileList() {
        fileList_.clear();
        fileOpSeen_.clear();
    }

    // Bottom footer telemetry (per-role model/cache hit rate + session cost).
    const Footer& footer() const { return footer_; }
    void setFooter(Footer f) { footer_ = std::move(f); }

    // Per-role context usage (epistemic + execution "current context length").
    const RoleContextUsagePair& roleContext() const { return roleContext_; }
    void setRoleContext(RoleContextUsagePair r) { roleContext_ = std::move(r); }

    // Determine whether a belief is selected (in the active frame's plan).
    bool isSelectedInCurrentFrame(const BeliefId& b) const;

    // Display label for a belief id: the stored "B<n>" label, or the raw id when
    // the belief is unknown. Presentation only; never used for correlation.
    std::string beliefLabel(const BeliefId& id) const;

    // Register (or update) a belief record. Returns a reference to the canonical
    // entry so the event adapter can populate a freshly-applied belief record.
    Belief& upsertBelief(const BeliefId& id);

    // Live in-message stream (the assistant's streaming reply shown in the
    // ':' user prompt palette). Populated by the event adapter from
    // message_start / message_update / message_end. ImGui-free.
    void beginInMessage(const std::string& text);
    void appendInMessage(const std::string& delta);
    void endInMessage();
    const std::string& inMessage() const { return inMessage_; }
    bool inMessageThinking() const { return inMessageThinking_; }
    bool inMessageError() const { return inMessageError_; }
    void setInMessageThinking(bool thinking);
    void setInMessageError(const std::string& message);

    // Auto-reopen the user prompt pane when the belief loop reaches the
    // terminal finalReport role and its conclusion message ends. Marked on
    // CursorChanged(stage="closed") (which only the finalReport transition
    // emits); consumed once by the render loop, which owns promptOpen.
    void markFinalReportPending() { finalReportPending_ = true; }
    bool finalReportPending() const { return finalReportPending_; }
    void requestAutoOpenPrompt() {
        autoOpenPrompt_ = true;
        finalReportPending_ = false;
    }
    bool consumeAutoOpenPrompt() {
        bool v = autoOpenPrompt_;
        autoOpenPrompt_ = false;
        return v;
    }

private:
    void openFrame(FrameId id, TaskId taskId, uint64_t ordinal, const std::string& openedAt);
    LoopFrame* frame(FrameId id);
    const LoopFrame* frame(FrameId id) const;
    void closeFrame(FrameId id, bool failed);
    void openTask(TaskId id, TaskId parentTaskId, const std::string& prompt);

    std::map<FrameId, LoopFrame> frames_;
    std::vector<FrameId> frameOrder_; // open order
    std::map<TaskId, Task> tasks_;
    std::vector<TaskId> taskOrder_;   // open order
    TaskId activeTaskId_;
    TaskId selectedTaskId_;           // explicit user selection ("" = follow active)
    // id -> index into beliefs_ (the single source of truth for a belief's
    // content). Keeping the canonical Belief in the vector means beliefs() and
    // the beliefById_ index always agree.
    std::map<BeliefId, int> beliefById_;
    std::vector<Belief> beliefs_;         // first-inserted order
    std::vector<BeliefId> activeBeliefs_; // active branch working set
    // Belief-deltas that arrived before their frame was opened. Held here so a
    // belief creation is not lost when the BeliefDeltaApplied precedes the
    // FrameOpened; flushed into the frame on FrameOpened (a bounded buffer,
    // drained on FrameOpened and cleared on reset / task close).
    std::vector<BeliefDelta> pendingDeltas_;
    // Belief-delta ids already processed, so a replayed BeliefDeltaApplied (same
    // mutation id) does not produce a duplicate Propose node.
    std::set<std::string> seenDeltaIds_;
    std::vector<FileEntry> fileList_;     // session read/write/edit files (insertion order)
    std::set<std::string> fileOpSeen_;    // (op, display-path) dedup set
    FrameCursor cursor_;
    std::string session_;
    int nextBeliefOrdinal_ = 0;  // display-label ordinal (B<n>)
    int nextPlanOrdinal_ = 0;    // display-label ordinal (P<n>)
    int nextDistillOrdinal_ = 0; // display-label ordinal (D<n>)
    std::string inMessage_;       // live streaming assistant reply for the ':' pane
    bool inMessageThinking_ = false;
    bool inMessageError_ = false;
    bool finalReportPending_ = false;
    bool autoOpenPrompt_ = false;
    Footer footer_;
    RoleContextUsagePair roleContext_;
};

// RPC event adapter (live mode). Consumes one runtime JSONL line (a domain
// event, an AgentEvent, or an RpcResponse ack) and updates the model. Returns
// Applied if the line produced a model change, Ignored if it was a benign
// non-model event, or Error if the line could not be interpreted.
enum class RpcApplyResult { Applied, Ignored, Error };
RpcApplyResult applyRpcLine(NativeGuiModel& model, const std::string& line);

} // namespace pie::gui
