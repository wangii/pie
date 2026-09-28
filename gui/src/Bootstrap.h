// Bootstrap: the connect sequence (docs/milestones.md §5.3).
//
// The runtime's snapshot and its live event stream necessarily overlap. The
// snapshot is computed at the moment the runtime handles `get_domain_snapshot`,
// while the GUI has already received — or is about to receive — events from both
// sides of that moment, and `RpcDomainSnapshot` carries no cursor or event id to
// reconcile them with. So the sequence is fixed:
//
//   connect
//     → write get_domain_snapshot (req_s)
//     → write get_state           (req_t)
//     → phase = Bootstrapping: buffer EVERY inbound line, capped
//     → the snapshot response: applyDomainSnapshot(data), then replay the buffer
//           in arrival order through the same idempotent appliers, phase = Live
//     → the get_state response: applied AFTER the snapshot, always
//     → 5s with no snapshot, or an error response to it:
//           phase = Live, isEventOnly = true
//
// Two rules in that sequence are load-bearing and easy to get wrong:
//
//   1. `get_state` is HELD until the snapshot has been applied. Its
//      `formulation.resume` / `decisionOwed` / `recheckOwed` describe what the
//      runtime is actually doing, and an event-only projection must never
//      overwrite them (§5.3).
//
//   2. The buffer's caps drop the OLDEST lines, never the newest. Everything the
//      appliers do with no record id — cursor, focus, experiment selection,
//      activeBeliefs — is field-level last-write-wins, so the buffer converges
//      with the snapshot only if its TAIL is the part that reaches the snapshot
//      moment. Dropping the tail would rewind the cursor.
//
// The 5s deadline is checked by `tick`, and every entry point takes `nowMs` from
// the caller, so the whole machine is testable without a clock or a sleep.

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "EventQueue.h"
#include "Model.h"

namespace pie::gui {

enum class BootstrapPhase {
    Idle,         // start() has not been called
    Bootstrapping, // commands written, waiting for the snapshot
    Live,          // applying lines as they arrive
};

// What `ingest` did with one line. Returned rather than inferred so a test (and
// the trace panel) can tell "buffered for replay" from "applied now".
enum class BootstrapIngest {
    Applied,   // applied to the model now
    Buffered,  // held for replay once the snapshot lands
    Snapshot,  // the get_domain_snapshot response itself, consumed here
    HeldState, // the get_state response, held until the snapshot is applied
    State,     // the get_state response, applied now (snapshot already in)
};

struct BootstrapLimits {
    // §5.3: 20k lines / 8 MB. The caps bound what a stalled or absent snapshot
    // can cost in memory; the byte count is of the raw lines.
    size_t maxBufferedLines = 20000;
    size_t maxBufferedBytes = 8u * 1024u * 1024u;
    int64_t snapshotTimeoutMs = 5000;
};

class Bootstrap {
public:
    explicit Bootstrap(BootstrapLimits limits = {}) : limits_(limits) {}

    // The two commands to write, in this order: snapshot, then state.
    struct Commands {
        std::string snapshot;
        std::string state;
    };
    // Begin. `nowMs` starts the snapshot deadline.
    Commands start(int64_t nowMs);

    bool started() const { return phase_ != BootstrapPhase::Idle; }

    // One inbound line. `nowMs` is only read on the paths that need it, but it is
    // required so no entry point can silently use a different clock.
    BootstrapIngest ingest(const InboundLine& line, NativeGuiModel& model, int64_t nowMs);
    // Convenience for a caller holding raw text (the replay tool, a test).
    BootstrapIngest ingestRaw(const std::string& line, NativeGuiModel& model, int64_t nowMs);

    // No line arrived: enforce the snapshot deadline. Call once per frame. When
    // the deadline passes with no snapshot the model becomes event-only — it must
    // never block rendering on a runtime that does not answer.
    void tick(NativeGuiModel& model, int64_t nowMs);

    BootstrapPhase phase() const { return phase_; }
    // True when there is no snapshot and the model is a projection of the live
    // stream alone. The status bar says so; an empty panel must not read as fact.
    bool isEventOnly() const { return eventOnly_; }
    bool snapshotApplied() const { return snapshotApplied_; }

    size_t bufferedLines() const { return buffer_.size(); }
    size_t bufferedBytes() const { return bufferedBytes_; }
    // Lines the caps forced out, oldest first. Non-zero means the replay that
    // followed the snapshot may be missing history; the trace panel shows it.
    size_t droppedLines() const { return droppedLines_; }

    const std::string& snapshotRequestId() const { return snapshotId_; }
    const std::string& stateRequestId() const { return stateId_; }

private:
    // Apply a line in arrival order (live, or while flushing the buffer).
    void applyNow(const InboundLine& line, NativeGuiModel& model);
    // Replay the buffer and switch to Live.
    void goLive(NativeGuiModel& model, bool eventOnly);
    void buffer(const InboundLine& line);

    BootstrapLimits limits_;
    BootstrapPhase phase_ = BootstrapPhase::Idle;
    bool eventOnly_ = false;
    bool snapshotApplied_ = false;
    bool stateApplied_ = false;
    std::optional<InboundLine> heldState_;
    std::vector<InboundLine> buffer_;
    size_t bufferedBytes_ = 0;
    size_t droppedLines_ = 0;
    int64_t startedAtMs_ = 0;
    std::string snapshotId_;
    std::string stateId_;
};

} // namespace pie::gui
