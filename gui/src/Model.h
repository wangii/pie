// NativeGuiModel: a headless, testable state model of the PIE cognitive
// feedback loop. It is deliberately independent of Dear ImGui so it can be
// unit-tested without a window.
//
// The model consumes an explicit runtime event/state stream (JSONL, one JSON
// object per line). It never infers frame stage, cursor position, or epistemic
// meaning from a generic log: every piece of state is set only by an explicit
// event (FrameOpened, BeliefsSelected, PlanProduced, ToolCalled, ...,
// CursorChanged, FrameClosed, BeliefUpdated). See applyLine().

#pragma once

#include <cstddef>
#include <set>
#include <string>
#include <string_view>
#include <vector>
#include <map>

#include "FileList.h"

namespace pie::gui {

// ---------------------------------------------------------------------------
// IDs / stages
// ---------------------------------------------------------------------------
struct BeliefId {
    int value = -1;
    bool valid() const { return value >= 0; }
};

// The runtime's explicit stage. The GUI never derives this from logs; it only
// reads it from the latest CursorChanged / FrameClosed event.
enum class FrameStage {
    NONE,
    PLANNING,
    EXECUTING,
    DISTILLING,
    PROPOSING,
    CLOSED,
};
const char* frameStageToString(FrameStage s);

// ---------------------------------------------------------------------------
// Belief (a single labeled relation)
// ---------------------------------------------------------------------------
struct Belief {
    BeliefId id;
    std::string lhs;       // e.g. "project"
    std::string relation;  // e.g. "uses"
    std::string rhs;       // e.g. "pytest"
    double confidence = -1.0;
    std::string status;    // open / closed / falsified / revised ...
    // Belief domain (world / routing / framing) from the runtime. Carried on
    // the live BeliefCreated event (propose/route/refine) so the graph can
    // render routing and framing beliefs distinctly.
    std::string domain;
    // Prose assertion (the runtime's belief statement). Populated by the live
    // belief_updated event; lhs/relation/rhs remain for the demo/headless fixture.
    std::string statement;
    std::vector<int> sourceFrames;  // provenance (frame ids)
    // The LoopFrame in which this belief first appeared. This does not make the
    // belief frame-owned: Beliefs remain global, while Graph View uses this
    // explicit provenance only to align the card with its creation row.
    int createdInFrame = -1;
    // The distillation occurrence (label) responsible for the most recent
    // create/update of this belief, when the mutation happened during a
    // DISTILLING stage. Empty when the belief was not produced by distillation
    // (for example planner bookkeeping) or in the demo/headless fixture, which
    // expresses write-backs as explicit ProposalCreated events.
    std::string distillationLabel;
};

// ---------------------------------------------------------------------------
// Frame contents
// ---------------------------------------------------------------------------
struct PlannerOutput {
    std::string id;      // authoritative runtime planId (live); empty in demo/headless
    std::string label;   // "P-128"
    std::string question;
    std::string intent;  // the epistemic intent, not the full prompt
    bool valid() const { return !label.empty(); }
};

struct ToolCall {
    std::string id;          // "E-88"
    std::string tool;        // "read" / "bash"
    std::string command;     // input
    std::string result;      // output
    std::string warning;     // non-fatal diagnostics
    std::string status;      // pending / running / ok / failed
    std::string planId;      // plan occurrence that dispatched this call
    bool expanded = true;    // UI-side expand/collapse
};

struct DistillationOutput {
    std::string label;   // "D-42"
    std::vector<std::string> inputIds;
    std::string unexplained;      // what the prediction could not explain
    std::string interpretation;
    bool valid() const { return !label.empty(); }
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
    RoleFooterSlot planner;       // plan
    RoleFooterSlot distillation;  // distill
    RoleFooterSlot execution;     // execution
    double sessionCost = 0.0;
    bool hasData = false;         // true once at least one session_status event arrived
};

// One proposed belief change. op semantics:
//   '+' create, '~' modify, '-' remove/invalidate, '?' unresolved.
struct Proposal {
    char op = '?';
    std::string belief;      // "B42"
    std::string lhs, relation, rhs;
    std::string detail;      // e.g. "confidence 0.62 -> 0.31"
    // Distillation occurrence that produced this write-back. Empty for a
    // proposal emitted outside distillation (for example planner bookkeeping).
    std::string distillationLabel;
};

// A complete epistemic transaction.
struct LoopFrame {
    int id = -1;
    // Live RPC uses frameId as a task id. Several LoopFrames may therefore
    // share one runtimeTaskId; each explicit entry into propose opens the next
    // LoopFrame for that task. Demo frames leave this as -1.
    int runtimeTaskId = -1;
    FrameStage stage = FrameStage::NONE;
    bool closed = false;
    bool failed = false;

    std::vector<BeliefId> selectedBeliefs;
    std::vector<std::vector<BeliefId>> selectedBeliefBatches;
    PlannerOutput plan;
    // A LoopFrame starts at propose and carries at most one plan and one
    // distillation. A second PlanProduced / DistillationProduced closes the
    // frame and opens a fresh one, so the vectors below hold at most one
    // occurrence (kept for the Graph View's one-node-per-occurrence projection,
    // where the single-value `plan` / `distillation` merge into the same node).
    std::vector<PlannerOutput> plans;
    std::vector<ToolCall> trajectory;
    DistillationOutput distillation;
    // Every distillation occurrence emitted for this frame (analogous to plans;
    // at most one after the per-frame split).
    std::vector<DistillationOutput> distillations;
    std::vector<Proposal> proposals;
    // Proposal index captured on entry to DISTILLING. When the explicit
    // DistillationProduced event arrives, only proposals from this point are
    // attributed to that distillation occurrence.
    std::size_t distillationProposalStart = 0;

    std::string summary;     // for frame navigator chips
    std::string openedAt;
    std::string closedAt;

    // Aggregate status used only for display in the navigator.
    enum class History { Closed, Unresolved, Falsified, NewBelief, Revised, Current };
    History history = History::Closed;
};

// P1 frame search: case-insensitive substring test over the frame's display
// fields (id, summary, plan, trajectory, distillation, proposals). An empty
// query matches every frame; a non-matching query returns false.
bool frameMatchesQuery(const LoopFrame& f, std::string_view query);

struct FrameCursor {
    int frameId = -1;
    FrameStage stage = FrameStage::NONE;
    std::string item;  // "E-90" / "D-42" / "P-128" / "B42"
    bool valid() const { return frameId >= 0 && stage != FrameStage::NONE; }
};

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------
class NativeGuiModel {
public:
    // Apply one JSONL event line (the runtime-side contract). Unknown / empty
    // lines are ignored. Only explicit events mutate state.
    void applyLine(const std::string& line);

    void reset();

    // Registry, in first-inserted order (belief list order).
    const std::vector<Belief>& beliefs() const { return beliefs_; }
    // Frame history in open order (frameOrder_ preserves open sequence).
    std::vector<LoopFrame> frames() const {
        std::vector<LoopFrame> out;
        out.reserve(frameOrder_.size());
        for (int id : frameOrder_) out.push_back(frames_.at(id));
        return out;
    }

    // The currently active (open) frame, or nullptr if none.
    const LoopFrame* activeFrame() const;
    // Look up a closed frame for historical inspection.
    const LoopFrame* frameById(int id) const;
    // Mutable access to an open/closed frame, used by the RPC event adapter to
    // populate belief-loop phase state (selected beliefs, plan, distillation).
    LoopFrame* mutableFrame(int id) { return frame(id); }

    // Live RPC task binding. Phase-event frameId is the runtime task id
    // (_taskId, 1-based), not a LoopFrame id. The first frame may rebind its
    // placeholder to that id; later propose cycles keep distinct logical ids
    // while sharing runtimeTaskId. ImGui-free and unit-testable.
    LoopFrame* rpcFrame(int runtimeFrameId);
    // Resolve the runtime task for an incoming plan occurrence. If the current
    // frame already holds a plan (a complete cycle), close it and open a fresh
    // LoopFrame so each LoopFrame carries at most one plan. Returns the frame to
    // write the new plan into.
    LoopFrame* enterRpcPlanFrame(int runtimeFrameId);
    // Resolve the runtime task for an incoming distillation occurrence. If the
    // current frame already holds a distillation, close it and open a fresh
    // LoopFrame so each LoopFrame carries at most one distillation. Returns the
    // frame to write the new distillation into.
    LoopFrame* enterRpcDistillFrame(int runtimeFrameId);
    // Resolve the runtime task and apply the explicit propose boundary. If the
    // current frame already contains a cycle, entering propose closes it and
    // opens a new LoopFrame for the same task.
    LoopFrame* enterRpcProposeFrame(int runtimeTaskId);

    const FrameCursor& cursor() const { return cursor_; }
    // Mutable cursor access, used by the RPC event adapter to update the
    // active-frame cursor from a CursorChanged phase event.
    FrameCursor& mutableCursor() { return cursor_; }

    const std::string& session() const { return session_; }
    void setSession(std::string s) { session_ = std::move(s); }

    // Session-level read/write/edit file list. Each entry is a path normalized
    // relative to the session cwd, deduped by (op, path). Populated from the
    // runtime's tool-call events (live tool_execution_start / demo ToolCalled).
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

    // Bottom footer telemetry (per-role model/cache hit rate + session cost), set
    // by the RPC adapter from the runtime's session_status event.
    const Footer& footer() const { return footer_; }
    void setFooter(Footer f) { footer_ = std::move(f); }

    // Per-role context usage (epistemic + execution "current context length"),
    // set by the RPC adapter from the runtime's session_status roleUsage field.
    const RoleContextUsagePair& roleContext() const { return roleContext_; }
    void setRoleContext(RoleContextUsagePair r) { roleContext_ = std::move(r); }

    // Determine whether a belief is selected in the active frame.
    bool isSelectedInCurrentFrame(BeliefId b) const;

    // RPC event adapter support (live mode). These build a real frame from the
    // runtime event stream without inventing Belief/Proposal data.
    int openRpcFrame(const std::string& summary);
    void appendRpcFrameSummary(int id, const std::string& text);
    void addRpcToolCall(int id, const std::string& toolCallId, const std::string& tool, const std::string& command);
    void setRpcToolResult(int id, const std::string& toolCallId, const std::string& result, const std::string& status);
    void closeRpcFrame(int id, bool failed);
    // Register (or update) a belief from the live belief_updated phase event.
    // Public wrapper around the private upsertBelief so the RPC adapter can
    // populate the belief lane without accessing the private registry directly.
    Belief& upsertBeliefRpc(BeliefId id) { return upsertBelief(id); }
    // Attribute the distillation occurrence (`label`) to beliefs created/updated
    // within `frameId` (createdInFrame == frameId, or provenance ends at frameId)
    // that are not yet bound to a distillation. Called from the RPC adapter when
    // DistillationProduced arrives, since the distill mutation events only carry a
    // frame id and arrive before the label.
    void bindDistillationLabel(int frameId, const std::string& label);

    // Live in-message stream (the assistant's streaming reply shown in the
    // ⌘T user prompt palette). Populated by the RPC event adapter from
    // message_start / message_update / message_end. ImGui-free so it can be
    // unit-tested without a window.
    void beginInMessage(const std::string& text);
    void appendInMessage(const std::string& delta);
    void endInMessage();
    const std::string& inMessage() const { return inMessage_; }
    // True while the live assistant message is in the thinking phase (a
    // thinking_start was received and no thinking_end/text_end closed it yet).
    bool inMessageThinking() const { return inMessageThinking_; }
    void setInMessageThinking(bool thinking);

    // Auto-reopen the user prompt pane when the belief loop reaches the
    // terminal finalReport role and its conclusion message ends. The RPC adapter
    // marks a pending state on CursorChanged(stage=CLOSED) (which only the
    // finalReport transition emits) and requests the reopen on the following
    // message_end. Consumed once by the render loop, which owns promptOpen.
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
    void openFrame(int id, const std::string& summary, const std::string& openedAt);
    LoopFrame* frame(int id);
    const LoopFrame* frame(int id) const;
    Belief* belief(BeliefId id);
    Belief& upsertBelief(BeliefId id);

    std::map<int, LoopFrame> frames_;
    std::vector<int> frameOrder_;  // open order
    // id -> index into beliefs_ (the single source of truth for a belief's
    // content). Keeping the canonical Belief in the vector means beliefs() and
    // the beliefById_ index always agree; mutating through belief()/upsertBelief()
    // updates the same object the viewer iterates.
    std::map<int, int> beliefById_;
    std::vector<Belief> beliefs_;  // first-inserted order
    std::vector<FileEntry> fileList_;     // session read/write/edit files (insertion order)
    std::set<std::string> fileOpSeen_;    // (op, display-path) dedup set
    FrameCursor cursor_;
    std::string session_;
    int nextRpcFrameId_ = 1000;  // auto-increment id for frames opened by the RPC adapter
    std::string inMessage_;      // live streaming assistant reply for the ⌘T pane
    bool inMessageThinking_ = false;  // live message is in the thinking phase
    // finalReport auto-reopen: true while the belief loop is in the terminal
    // finalReport role (set on CursorChanged CLOSED) until its message_end arrives.
    bool finalReportPending_ = false;
    bool autoOpenPrompt_ = false;  // request flag, consumed by the render loop
    Footer footer_;                     // bottom footer telemetry (session_status)
    RoleContextUsagePair roleContext_;  // per-role context length (session_status roleUsage)
};

// RPC event adapter (live mode). Consumes one runtime JSONL line (an
// AgentSessionEvent or an RpcResponse ack) and updates the model. Returns
// Applied if the line produced a model change, Ignored if it was a benign
// non-model event, or Error if the line could not be interpreted.
enum class RpcApplyResult { Applied, Ignored, Error };
RpcApplyResult applyRpcLine(NativeGuiModel& model, const std::string& line);

} // namespace pie::gui
