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

#include <string>
#include <string_view>
#include <vector>
#include <map>

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
    // Prose assertion (the runtime's belief statement). Populated by the live
    // belief_updated event; lhs/relation/rhs remain for the demo/headless fixture.
    std::string statement;
    std::vector<int> sourceFrames;  // provenance (frame ids)
};

// ---------------------------------------------------------------------------
// Frame contents
// ---------------------------------------------------------------------------
struct PlannerOutput {
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
    bool expanded = true;    // UI-side expand/collapse
};

struct DistillationOutput {
    std::string label;   // "D-42"
    std::vector<std::string> inputIds;
    std::string unexplained;      // what the prediction could not explain
    std::string interpretation;
    bool valid() const { return !label.empty(); }
};

// One proposed belief change. op semantics:
//   '+' create, '~' modify, '-' remove/invalidate, '?' unresolved.
struct Proposal {
    char op = '?';
    std::string belief;      // "B42"
    std::string lhs, relation, rhs;
    std::string detail;      // e.g. "confidence 0.62 -> 0.31"
};

// A complete epistemic transaction.
struct LoopFrame {
    int id = -1;
    FrameStage stage = FrameStage::NONE;
    bool closed = false;
    bool failed = false;

    std::vector<BeliefId> selectedBeliefs;
    PlannerOutput plan;
    std::vector<ToolCall> trajectory;
    DistillationOutput distillation;
    std::vector<Proposal> proposals;

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

    // Live RPC frame binding. The runtime's belief-loop phase events carry the
    // authoritative frame id (_taskId, 1-based). The RPC adapter opens a
    // placeholder frame on agent_start/turn_start under a synthetic id (1000+);
    // this resolves a runtime frame id to a frame, rebinding (renaming) the
    // current placeholder frame to the runtime id on first arrival so every later
    // phase event for the same task hits the same frame. ImGui-free, unit-testable.
    LoopFrame* rpcFrame(int runtimeFrameId);

    const FrameCursor& cursor() const { return cursor_; }
    // Mutable cursor access, used by the RPC event adapter to update the
    // active-frame cursor from a CursorChanged phase event.
    FrameCursor& mutableCursor() { return cursor_; }

    const std::string& session() const { return session_; }
    void setSession(std::string s) { session_ = std::move(s); }

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

    // Live in-message stream (the assistant's streaming reply shown in the
    // ⌘T instruction palette). Populated by the RPC event adapter from
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
    FrameCursor cursor_;
    std::string session_;
    int nextRpcFrameId_ = 1000;  // auto-increment id for frames opened by the RPC adapter
    std::string inMessage_;      // live streaming assistant reply for the ⌘T pane
    bool inMessageThinking_ = false;  // live message is in the thinking phase
};

// RPC event adapter (live mode). Consumes one runtime JSONL line (an
// AgentSessionEvent or an RpcResponse ack) and updates the model. Returns
// Applied if the line produced a model change, Ignored if it was a benign
// non-model event, or Error if the line could not be interpreted.
enum class RpcApplyResult { Applied, Ignored, Error };
RpcApplyResult applyRpcLine(NativeGuiModel& model, const std::string& line);

} // namespace pie::gui
