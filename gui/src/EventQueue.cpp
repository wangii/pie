#include "EventQueue.h"

namespace pie::gui {

InboundLine parseInboundLine(std::string raw) {
    InboundLine line;
    line.raw = std::move(raw);
    // parseLine tolerates a BOM and a trailing CRLF; the framer already removed
    // the terminator, so this is belt and braces for a transcript read from disk.
    line.parsed = json::parseLine(line.raw, line.value, nullptr);
    return line;
}

size_t EventQueue::drain(std::vector<InboundLine>& out, size_t maxLines, int64_t budgetMs,
                         const std::function<int64_t()>& nowMs) {
    size_t taken = 0;
    int64_t startedAt = 0;
    std::lock_guard<std::mutex> lk(m_);
    while (taken < maxLines && !q_.empty()) {
        // The clock is consulted once per line, and only after the first: a
        // single line is always delivered even if the budget is already gone,
        // so a slow frame cannot starve the stream permanently.
        if (taken > 0 && budgetMs > 0 && nowMs() - startedAt >= budgetMs) break;
        if (taken == 0) startedAt = nowMs();
        out.push_back(std::move(q_.front()));
        q_.pop_front();
        ++taken;
    }
    return taken;
}

} // namespace pie::gui
