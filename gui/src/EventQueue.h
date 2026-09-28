// EventQueue: the inbound half of the RPC transport, with no process handling.
//
// Split out of RuntimeClient so it can be unit-tested headlessly and so the
// parse can happen off the render thread. RuntimeClient keeps the fork/exec and
// the reader thread; this file owns the framing, the parse, and the drain
// budget (docs/milestones.md §5.3).
//
// Why the parse moves to the reader thread: `get_domain_snapshot` for a long
// session is a multi-megabyte line. Parsing it inside the frame loop stalls the
// UI for the whole parse, while the reader thread has nothing else to do. The
// main thread then drains a queue of already-parsed values under a budget.
//
// Why the framing is its own type: a read() returns whatever the pipe had, so a
// chunk boundary lands mid-line routinely — a 4 KB read of an 8 MB snapshot ends
// in the middle of a JSON string. Treating each chunk as a line loses data
// silently, which is the failure mode that is hardest to notice.

#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "Json.h"

namespace pie::gui {

// Per-frame drain budget (docs/milestones.md §5.3): at most this many lines, and
// stop once this many milliseconds have been spent, so a backlog can never cost
// a frame. The remainder waits for the next frame; the queue has no lossy cap of
// its own, because dropping live events is not something a replay may do.
inline constexpr size_t kDrainMaxLines = 48;
inline constexpr int64_t kDrainBudgetMs = 4;

// One inbound stdout line, parsed on the reader thread.
//
// `raw` is kept because two consumers need the original text: the trace panel's
// raw-detail row, and `applyRpcLine`, which needs the exact bytes to re-derive
// nothing — it reads the DOM — but does keep the string for issue reports. The
// DOM is the authoritative form; `parsed` false means the line was not JSON at
// all (a stray banner on stdout, a truncated write), which is an issue and not
// a crash.
struct InboundLine {
    std::string raw;
    json::Value value;
    bool parsed = false;

    // The line's top-level `type`, or "" when absent/unparsed.
    std::string type() const {
        return parsed && value.isObject() ? value.string("type") : std::string{};
    }
    bool isObject() const { return parsed && value.isObject(); }
};

// Split a byte stream into lines without assuming a chunk is a line.
class LineFramer {
public:
    // Emit every line completed by `chunk`, plus whatever the held partial tail
    // now completes. `emit` is called with each complete line, without its
    // terminator; a blank line is emitted as an empty string.
    template <class Emit>
    void feed(std::string_view chunk, Emit&& emit) {
        size_t start = 0;
        while (true) {
            const size_t nl = chunk.find('\n', start);
            if (nl == std::string_view::npos) break;
            std::string line(pending_);
            line.append(chunk.substr(start, nl - start));
            pending_.clear();
            stripCr(line);
            emit(std::move(line));
            start = nl + 1;
        }
        if (start < chunk.size()) pending_.append(chunk.substr(start));
    }

    // Emit a held partial line at EOF: a final line with no trailing newline is
    // still a line. Returns false when nothing was held.
    template <class Emit>
    bool flush(Emit&& emit) {
        if (pending_.empty()) return false;
        std::string line = std::move(pending_);
        pending_.clear();
        stripCr(line);
        emit(std::move(line));
        return true;
    }

    // Bytes of a partial line currently held. Exposed so a reader can report a
    // stream that ended mid-line rather than pretending it ended cleanly.
    size_t pendingBytes() const { return pending_.size(); }
    bool hasPending() const { return !pending_.empty(); }

private:
    static void stripCr(std::string& line) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
    }

    std::string pending_;
};

// Parse one framed line. A parse failure is not fatal: `parsed` stays false and
// the caller records an issue.
InboundLine parseInboundLine(std::string raw);

// Thread-safe FIFO of parsed lines, written by the reader thread and drained by
// the frame loop.
class EventQueue {
public:
    void push(InboundLine line) {
        std::lock_guard<std::mutex> lk(m_);
        q_.push_back(std::move(line));
    }

    bool popIfAny(InboundLine& out) {
        std::lock_guard<std::mutex> lk(m_);
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop_front();
        return true;
    }

    // Drain under a budget, oldest first. Stops at `maxLines` or as soon as
    // `nowMs()` reports that `budgetMs` have elapsed since the first pop — so a
    // backlog is spread across frames instead of stalling one. Returns the number
    // appended to `out` (which is not cleared).
    //
    // `nowMs` is injected rather than read from a clock so the budget is
    // testable without sleeping.
    size_t drain(std::vector<InboundLine>& out, size_t maxLines, int64_t budgetMs,
                 const std::function<int64_t()>& nowMs);

    size_t size() const {
        std::lock_guard<std::mutex> lk(m_);
        return q_.size();
    }

private:
    mutable std::mutex m_;
    std::deque<InboundLine> q_;
};

} // namespace pie::gui
