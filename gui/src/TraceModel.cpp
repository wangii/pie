#include "TraceModel.h"

#include <cstdio>

namespace pie::gui {

namespace {

// The role a slot in `session_status.roleStatus` answers for. A stage with no
// slot (routing, finalReport) leaves both the model and the cache at "—": the
// absence is the runtime's, and inventing the propose model for a routing row
// would make the pane state something nobody measured.
const RoleFooterSlot* roleSlotFor(const TraceEntry& status, DispatchRole role) {
    switch (role) {
        case DispatchRole::Propose: return &status.epistemic;
        case DispatchRole::Distill: return &status.distillation;
        case DispatchRole::Execution: return &status.execution;
        case DispatchRole::Routing:
        case DispatchRole::FinalReport:
        case DispatchRole::Unknown: return nullptr;
    }
    return nullptr;
}

TraceTurn turnFrom(const TraceEntry& entry) {
    TraceTurn turn;
    turn.model = entry.model;
    turn.provider = entry.provider;
    turn.thinkingLevel = entry.thinkingLevel;
    turn.startedAt = entry.at;
    turn.endedAt = entry.endedAt;
    turn.stopReason = entry.stopReason;
    turn.errorMessage = entry.errorMessage;
    turn.usage = entry.usage;
    turn.ended = entry.ended;
    if (entry.atMs >= 0 && entry.endedAtMs >= 0 && entry.endedAtMs >= entry.atMs) {
        turn.durationMs = entry.endedAtMs - entry.atMs;
    }
    return turn;
}

// Apply the role slots in force to a row: everything the row can say about the
// role's configured model and its cache rate comes from here, and a slot the
// stage has no answer for leaves the column empty rather than guessing.
void applyRoleSlots(TraceRow& row, const TraceEntry& status) {
    const RoleFooterSlot* slot = roleSlotFor(status, row.role);
    if (slot == nullptr) return;
    row.roleModel = slot->model;
    if (slot->cacheHitRate >= 0.0f) {
        row.cacheHitRate = slot->cacheHitRate;
        row.cacheFromTurnUsage = false;
    }
}

// Fill in everything that depends on the turn(s) a row collected. Called once the
// row is complete, so a late `message_end` cannot leave a half-filled row.
void finalizeRow(TraceRow& row, const SessionState& session) {
    // The detail column prefers the first DOMAIN event of the window over the
    // cursor move that opened it: the move is already the role column, and
    // repeating it would spend the column on nothing. A window that contains only
    // its own opening — a closed episode, say — falls back to that, because "this
    // is all that happened" beats a blank.
    if (row.detail.empty() && !row.details.empty()) row.detail = row.details.front();

    row.turnCount = row.turns.size();
    if (row.turns.empty()) return;

    const TraceTurn& first = row.turns.front();
    row.dispatchedModel = first.model;
    row.dispatchedProvider = first.provider;
    row.status = first.errorMessage.empty() ? first.stopReason : first.errorMessage;

    // The comparison is only meaningful between two values that exist, and both
    // sides are the same field (`model.id`) — the session_status slot and the
    // message both carry it — so this is not an id-vs-label comparison.
    row.modelComparisonKnown = !row.dispatchedModel.empty() && !row.roleModel.empty();
    row.modelDiffersFromRole = row.modelComparisonKnown && row.dispatchedModel != row.roleModel;

    // A per-role thinking level is configured in pie but never emitted (§3.6), so
    // the turn's own field is the only per-dispatch source and the session value
    // is the honest fallback. Which one is shown is recorded, because the pane
    // labels it.
    if (!first.thinkingLevel.empty()) {
        row.thinkingLevel = first.thinkingLevel;
        row.thinkingFromTurn = true;
    } else if (session.present && !session.thinkingLevel.empty()) {
        row.thinkingLevel = session.thinkingLevel;
        row.thinkingFromTurn = false;
    }

    // The telemetry's rate is the runtime's own per-role latest value; the derived
    // one is this turn's. Prefer the runtime's, and fall back to the derivation
    // §7.3 sanctions — agreeing by construction, because TurnUsage::cacheHitRate
    // uses the same formula.
    if (row.cacheHitRate < 0.0f) {
        const float derived = first.usage.cacheHitRate();
        if (derived >= 0.0f) {
            row.cacheHitRate = derived;
            row.cacheFromTurnUsage = true;
        }
    }

    // The window's wall-clock span: the first turn's start to the last turn's end,
    // which collapses to one turn's duration when there is only one.
    if (first.durationMs >= 0) {
        const TraceTurn& last = row.turns.back();
        if (row.turns.size() == 1) {
            row.durationMs = first.durationMs;
        } else if (last.durationMs >= 0) {
            row.durationMs = first.durationMs + last.durationMs;
        } else {
            row.durationMs = first.durationMs;
        }
    }
}

} // namespace

const char* dispatchRoleName(DispatchRole role) {
    switch (role) {
        case DispatchRole::Routing: return "routing";
        case DispatchRole::Propose: return "propose";
        case DispatchRole::Execution: return "execution";
        case DispatchRole::Distill: return "distill";
        case DispatchRole::FinalReport: return "finalReport";
        case DispatchRole::Unknown: return "unknown";
    }
    return "unknown";
}

DispatchRole dispatchRoleForStage(EpisodeStage stage) {
    switch (stage) {
        case EpisodeStage::Routing: return DispatchRole::Routing;
        case EpisodeStage::Proposing: return DispatchRole::Propose;
        case EpisodeStage::Executing: return DispatchRole::Execution;
        case EpisodeStage::Distilling: return DispatchRole::Distill;
        case EpisodeStage::Closed: return DispatchRole::FinalReport;
        case EpisodeStage::Unknown: return DispatchRole::Unknown;
    }
    return DispatchRole::Unknown;
}

std::string formatTraceDuration(int64_t durationMs) {
    if (durationMs < 0) return "\xe2\x80\x94";  // em-dash
    if (durationMs < 1000) return std::to_string(durationMs) + "ms";
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.1fs", static_cast<double>(durationMs) / 1000.0);
    return buf;
}

std::string formatTraceCache(float hitRate, bool fromTurnUsage) {
    if (hitRate < 0.0f) return "\xe2\x80\x94";
    char buf[32];
    // The mark is part of the value, not decoration: "62%*" says the number was
    // computed from this turn's usage rather than read from the runtime.
    std::snprintf(buf, sizeof(buf), "%.0f%%%s", static_cast<double>(hitRate),
                  fromTurnUsage ? "*" : "");
    return buf;
}

int traceDisplayWidth(const std::string& text) {
    int width = 0;
    for (size_t i = 0; i < text.size();) {
        const unsigned char c = static_cast<unsigned char>(text[i]);
        size_t advance = 1;
        unsigned int codepoint = c;
        if ((c & 0xE0) == 0xC0) {
            advance = 2;
            codepoint = c & 0x1Fu;
        } else if ((c & 0xF0) == 0xE0) {
            advance = 3;
            codepoint = c & 0x0Fu;
        } else if ((c & 0xF8) == 0xF0) {
            advance = 4;
            codepoint = c & 0x07u;
        }
        for (size_t k = 1; k < advance && i + k < text.size(); ++k) {
            codepoint = (codepoint << 6) | (static_cast<unsigned char>(text[i + k]) & 0x3Fu);
        }
        i += advance;
        // The ranges a monospaced terminal font draws double-width. A combining
        // mark or an emoji is counted as one, which is the same approximation the
        // font's own cell model makes.
        const bool wide = (codepoint >= 0x1100 && codepoint <= 0x115F) ||
                          (codepoint >= 0x2E80 && codepoint <= 0xA4CF) ||
                          (codepoint >= 0xAC00 && codepoint <= 0xD7A3) ||
                          (codepoint >= 0xF900 && codepoint <= 0xFAFF) ||
                          (codepoint >= 0xFE30 && codepoint <= 0xFE6F) ||
                          (codepoint >= 0xFF00 && codepoint <= 0xFF60) ||
                          (codepoint >= 0xFFE0 && codepoint <= 0xFFE6) ||
                          (codepoint >= 0x20000 && codepoint <= 0x3FFFD);
        width += wide ? 2 : 1;
    }
    return width;
}

std::string traceCell(const std::string& text, int width) {
    if (width <= 0) return {};
    const int w = traceDisplayWidth(text);
    if (w == width) return text;
    if (w < width) return text + std::string(static_cast<size_t>(width - w), ' ');

    std::string out;
    int used = 0;
    for (size_t i = 0; i < text.size();) {
        const unsigned char c = static_cast<unsigned char>(text[i]);
        size_t advance = 1;
        if ((c & 0xE0) == 0xC0) advance = 2;
        else if ((c & 0xF0) == 0xE0) advance = 3;
        else if ((c & 0xF8) == 0xF0) advance = 4;
        const std::string glyph = text.substr(i, advance);
        const int glyphWidth = traceDisplayWidth(glyph);
        // A wide glyph that does not fit is dropped whole: half a glyph would be
        // an invalid string, and one cell of overflow would misalign the row.
        if (used + glyphWidth > width) break;
        out += glyph;
        used += glyphWidth;
        i += advance;
    }
    return out;
}

TraceModel buildDispatchTrace(const NativeGuiModel& model) {
    TraceModel out;
    out.issues = model.issues();

    // The role slots in force, carried forward. `session_status` is emitted after
    // every event, so this is what a row reads for the role's model — and a row
    // opened before the first status has none, which renders as "—" rather than
    // as the propose model it will resolve to a moment later.
    TraceEntry currentStatus;
    bool haveStatus = false;

    const SessionState& session = model.sessionState();
    // The window currently being filled. Nothing outside this function needs it,
    // so it is an index here rather than a `finalized` flag on the row.
    size_t open = static_cast<size_t>(-1);

    auto closeWindow = [&out, &session, &open]() {
        if (open == static_cast<size_t>(-1)) return;
        finalizeRow(out.rows[open], session);
        open = static_cast<size_t>(-1);
    };
    auto openWindow = [&out, &currentStatus, &haveStatus, &open](const TraceEntry& entry) {
        TraceRow row;
        row.stage = entry.stage;
        row.role = dispatchRoleForStage(entry.stage);
        row.taskId = entry.taskId;
        row.episodeId = entry.episodeId;
        if (haveStatus) applyRoleSlots(row, currentStatus);
        out.rows.push_back(std::move(row));
        open = out.rows.size() - 1;
    };

    for (const TraceEntry& entry : model.trace()) {
        switch (entry.kind) {
            case TraceEntry::Kind::Status: {
                currentStatus = entry;
                haveStatus = true;
                out.hasTelemetry = true;
                // A status arriving inside an open window describes the role
                // resolution in force during it, so it lands on that row too —
                // last-write-wins, the same rule the registry fields use.
                if (open != static_cast<size_t>(-1)) applyRoleSlots(out.rows[open], entry);
                break;
            }
            case TraceEntry::Kind::Turn: {
                out.hasTelemetry = true;
                // A turn with no window open is a dispatch the cursor had not been
                // moved for. It is still a dispatch, so it opens a row of its own
                // rather than being dropped: the stage it carries is the cursor's
                // own at the time, which may be Unknown, and an unknown role
                // renders "—".
                if (open == static_cast<size_t>(-1)) openWindow(entry);
                out.rows[open].turns.push_back(turnFrom(entry));
                break;
            }
            case TraceEntry::Kind::Domain: {
                TraceEventRow eventRow;
                eventRow.type = entry.type;
                eventRow.text = entry.text;
                eventRow.at = entry.at;
                eventRow.taskId = entry.taskId;
                eventRow.episodeId = entry.episodeId;
                out.events.push_back(std::move(eventRow));

                if (entry.stage != EpisodeStage::Unknown) {
                    // The cursor moved: the previous window is complete, and the
                    // event that moved it belongs to the new one.
                    closeWindow();
                    openWindow(entry);
                }
                if (open != static_cast<size_t>(-1)) {
                    TraceRow& row = out.rows[open];
                    // The opening cursor move is kept in `details` but never takes
                    // the detail column: the role column already says which stage
                    // this row is, so spending the column on the move itself would
                    // say it twice.
                    if (row.detail.empty() && entry.stage == EpisodeStage::Unknown) row.detail = entry.text;
                    row.details.push_back(entry.text);
                }
                break;
            }
        }
    }
    closeWindow();

    // The fast-path marker and the body kind come from the replayed episode, not
    // from the telemetry: whether a round had a Plan is a domain fact, so it is
    // read where every other domain fact is read.
    for (TraceRow& row : out.rows) {
        const ExecutionEpisode* episode = model.episode(row.taskId, row.episodeId);
        if (episode != nullptr && episode->body.kind == EpisodeBodyKind::FastPath) row.fastPath = true;
    }
    return out;
}

} // namespace pie::gui
