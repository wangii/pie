#include "Bootstrap.h"

#include <utility>

#include "DomainEvents.h"
#include "PromptCmd.h"

namespace pie::gui {

namespace {

// The `command` a `response` line answers. The runtime always emits it, but a
// response that omitted it can still be recognised by the request id we chose,
// so both are consulted.
std::string answeredCommand(const InboundLine& line) {
    if (!line.isObject()) return {};
    const std::string command = line.value.string("command");
    if (!command.empty()) return command;
    return {};
}

bool crashedSnapshotResponse(const InboundLine& line, const std::string& snapshotId) {
    if (!line.isObject()) return false;
    if (line.value.string("type") != "response") return false;
    if (line.value.boolean("success", true)) return false;
    const std::string command = answeredCommand(line);
    if (command == "get_domain_snapshot") return true;
    return command.empty() && line.value.string("id") == snapshotId;
}

bool isSnapshotResponse(const InboundLine& line, const std::string& snapshotId) {
    if (!line.isObject()) return false;
    if (line.value.string("type") != "response") return false;
    const std::string command = answeredCommand(line);
    if (command == "get_domain_snapshot") return true;
    return command.empty() && line.value.string("id") == snapshotId;
}

bool isStateResponse(const InboundLine& line, const std::string& stateId) {
    if (!line.isObject()) return false;
    if (line.value.string("type") != "response") return false;
    const std::string command = answeredCommand(line);
    if (command == "get_state") return true;
    return command.empty() && line.value.string("id") == stateId;
}

} // namespace

Bootstrap::Commands Bootstrap::start(int64_t nowMs) {
    snapshotId_ = nextPromptId();
    stateId_ = nextPromptId();
    startedAtMs_ = nowMs;
    phase_ = BootstrapPhase::Bootstrapping;
    Commands commands;
    commands.snapshot = serializeGetSnapshotCommand(snapshotId_);
    commands.state = serializeGetStateCommand(stateId_);
    return commands;
}

void Bootstrap::buffer(const InboundLine& line) {
    buffer_.push_back(line);
    bufferedBytes_ += line.raw.size();
    // Drop the OLDEST lines. See the header: last-write-wins fields converge only
    // when the tail of the buffer reaches the snapshot moment.
    while (buffer_.size() > limits_.maxBufferedLines ||
           (bufferedBytes_ > limits_.maxBufferedBytes && buffer_.size() > 1)) {
        bufferedBytes_ -= buffer_.front().raw.size();
        buffer_.erase(buffer_.begin());
        ++droppedLines_;
    }
}

void Bootstrap::applyNow(const InboundLine& line, NativeGuiModel& model) {
    if (!line.parsed) {
        // A line that is not JSON cannot be an event. Record it: a truncated
        // write or a stray banner on stdout is worth seeing, not swallowing.
        model.recordIssue("<unparsed>", std::string{}, "inbound line is not valid JSON");
        return;
    }
    applyRpcLine(model, line.value);
}

void Bootstrap::goLive(NativeGuiModel& model, bool eventOnly) {
    if (eventOnly) {
        // The buffer still holds everything that arrived while the snapshot was
        // outstanding; an event-only model is exactly that buffer replayed.
        eventOnly_ = true;
        model.setEventOnly(true);
    }
    phase_ = BootstrapPhase::Live;
    std::vector<InboundLine> replay;
    replay.swap(buffer_);
    bufferedBytes_ = 0;
    for (const InboundLine& line : replay) applyNow(line, model);
    if (heldState_.has_value()) {
        InboundLine state = std::move(*heldState_);
        heldState_.reset();
        if (state.parsed) {
            SessionState sessionState;
            const json::Value* data = state.value.object("data");
            if (data != nullptr && readSessionState(*data, sessionState)) {
                model.applySessionState(std::move(sessionState));
                stateApplied_ = true;
            }
        }
    }
}

BootstrapIngest Bootstrap::ingest(const InboundLine& line, NativeGuiModel& model, int64_t nowMs) {
    if (phase_ == BootstrapPhase::Idle) start(nowMs);
    (void)nowMs;

    if (isSnapshotResponse(line, snapshotId_)) {
        if (crashedSnapshotResponse(line, snapshotId_)) {
            // The runtime answered, and the answer was "no". Waiting out the
            // deadline would only delay the same conclusion by five seconds.
            goLive(model, /*eventOnly=*/true);
            return BootstrapIngest::Snapshot;
        }
        const json::Value* data = line.value.object("data");
        AgentSessionSnapshot snapshot;
        if (data != nullptr && readDomainSnapshot(*data, snapshot)) {
            // Integral replacement, then the buffer replays on top of it through
            // the same idempotent appliers. This is the whole point of buffering.
            model.applyDomainSnapshot(snapshot);
            snapshotApplied_ = true;
            goLive(model, /*eventOnly=*/false);
        } else {
            // A response we cannot read is the same situation as no response:
            // degrade rather than render a half-applied snapshot.
            goLive(model, /*eventOnly=*/true);
        }
        return BootstrapIngest::Snapshot;
    }

    if (isStateResponse(line, stateId_)) {
        if (phase_ == BootstrapPhase::Bootstrapping) {
            // Held, not applied: the snapshot has not been applied yet, and this
            // is the one payload that must win over an event-only projection.
            heldState_ = line;
            return BootstrapIngest::HeldState;
        }
        SessionState sessionState;
        const json::Value* data = line.value.object("data");
        if (data != nullptr && readSessionState(*data, sessionState)) {
            model.applySessionState(std::move(sessionState));
            stateApplied_ = true;
        }
        return BootstrapIngest::State;
    }

    if (phase_ == BootstrapPhase::Bootstrapping) {
        buffer(line);
        return BootstrapIngest::Buffered;
    }
    applyNow(line, model);
    return BootstrapIngest::Applied;
}

BootstrapIngest Bootstrap::ingestRaw(const std::string& line, NativeGuiModel& model, int64_t nowMs) {
    return ingest(parseInboundLine(line), model, nowMs);
}

void Bootstrap::tick(NativeGuiModel& model, int64_t nowMs) {
    if (phase_ != BootstrapPhase::Bootstrapping) return;
    if (nowMs - startedAtMs_ < limits_.snapshotTimeoutMs) return;
    goLive(model, /*eventOnly=*/true);
}

} // namespace pie::gui
