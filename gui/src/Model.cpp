#include "Model.h"

#include <cstddef>
#include <cstring>

namespace pie::gui {

// ---------------------------------------------------------------------------
// Minimal JSON helpers (only enough to read the few known fields).
// ---------------------------------------------------------------------------
namespace {

std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t')) --b;
    return s.substr(a, b - a);
}

// Raw substring following the first occurrence of "key": in s.
bool findKey(const std::string& s, const std::string& key, std::string& raw) {
    const std::string pat = "\"" + key + "\"";
    size_t p = s.find(pat);
    if (p == std::string::npos) return false;
    size_t colon = s.find(':', p + pat.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
    if (i >= s.size()) return false;
    raw = trim(s.substr(i));
    return true;
}

std::string stringValue(const std::string& v) {
    if (v.size() < 2 || v[0] != '"') return {};
    std::string out;
    for (size_t i = 1; i < v.size(); ++i) {
        char c = v[i];
        if (c == '\\' && i + 1 < v.size()) { out += v[++i]; continue; }
        if (c == '"') break;
        out += c;
    }
    return out;
}

std::string str(const std::string& s, const std::string& key, const std::string& def = {}) {
    std::string raw;
    if (!findKey(s, key, raw)) return def;
    return stringValue(raw);
}

int intVal(const std::string& s, const std::string& key, int def = -1) {
    std::string raw;
    if (!findKey(s, key, raw)) return def;
    return static_cast<int>(std::strtol(raw.c_str(), nullptr, 10));
}

double doubleVal(const std::string& s, const std::string& key, double def = -1.0) {
    std::string raw;
    if (!findKey(s, key, raw)) return def;
    return std::strtod(raw.c_str(), nullptr);
}

char charVal(const std::string& s, const std::string& key, char def = '?') {
    std::string raw;
    if (!findKey(s, key, raw)) return def;
    if (raw.empty()) return def;
    if (raw[0] == '"') {  // quoted single-char value
        std::string v = stringValue(raw);
        return v.empty() ? def : v[0];
    }
    return raw[0];
}

// Split a top-level array substring "[a,b,c]" into trimmed element substrings.
std::vector<std::string> arrayElements(const std::string& v) {
    std::vector<std::string> out;
    if (v.size() < 2 || v[0] != '[') return out;
    size_t depth = 0;
    bool inStr = false;
    size_t start = 1;
    for (size_t i = 1; i < v.size(); ++i) {
        char c = v[i];
        if (inStr) {
            if (c == '\\') { ++i; continue; }
            if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') inStr = true;
        else if (c == '[' || c == '{') ++depth;
        else if (c == ']' || c == '}') { if (depth == 0) break; --depth; }
        else if (c == ',' && depth == 0) { out.push_back(trim(v.substr(start, i - start))); start = i + 1; }
    }
    if (start < v.size()) {
        std::string last = trim(v.substr(start, v.size() - 1 - start));
        if (!last.empty()) out.push_back(last);
    }
    return out;
}

std::vector<BeliefId> beliefsArray(const std::string& v) {
    std::vector<BeliefId> out;
    for (auto& e : arrayElements(v)) {
        // Element may be quoted or a bare number; strip quotes then parse.
        std::string raw = e;
        if (raw.size() >= 2 && raw.front() == '"' && raw.back() == '"')
            raw = raw.substr(1, raw.size() - 2);
        out.push_back(BeliefId{static_cast<int>(std::strtol(raw.c_str(), nullptr, 10))});
    }
    return out;
}

FrameStage parseStage(const std::string& s) {
    if (s == "PLANNING") return FrameStage::PLANNING;
    if (s == "EXECUTING") return FrameStage::EXECUTING;
    if (s == "DISTILLING") return FrameStage::DISTILLING;
    if (s == "PROPOSING") return FrameStage::PROPOSING;
    if (s == "CLOSED") return FrameStage::CLOSED;
    return FrameStage::NONE;
}

std::vector<std::string> strArray(const std::string& v) {
    std::vector<std::string> out;
    for (auto& e : arrayElements(v)) out.push_back(stringValue(e));
    return out;
}

} // namespace

const char* frameStageToString(FrameStage s) {
    switch (s) {
        case FrameStage::PLANNING: return "PLANNING";
        case FrameStage::EXECUTING: return "EXECUTING";
        case FrameStage::DISTILLING: return "DISTILLING";
        case FrameStage::PROPOSING: return "PROPOSING";
        case FrameStage::CLOSED: return "CLOSED";
        case FrameStage::NONE: break;
    }
    return "NONE";
}

// ---------------------------------------------------------------------------
// Frame / belief accessors
// ---------------------------------------------------------------------------
void NativeGuiModel::reset() {
    frames_.clear();
    frameOrder_.clear();
    beliefById_.clear();
    beliefs_.clear();
    cursor_ = FrameCursor{};
}

LoopFrame* NativeGuiModel::frame(int id) {
    auto it = frames_.find(id);
    return it == frames_.end() ? nullptr : &it->second;
}
const LoopFrame* NativeGuiModel::frame(int id) const {
    auto it = frames_.find(id);
    return it == frames_.end() ? nullptr : &it->second;
}

const LoopFrame* NativeGuiModel::activeFrame() const {
    return cursor_.frameId >= 0 ? frame(cursor_.frameId) : nullptr;
}
const LoopFrame* NativeGuiModel::frameById(int id) const { return frame(id); }

Belief* NativeGuiModel::belief(BeliefId id) {
    auto it = beliefById_.find(id.value);
    return it == beliefById_.end() ? nullptr : &it->second;
}

Belief& NativeGuiModel::upsertBelief(BeliefId id) {
    auto it = beliefById_.find(id.value);
    if (it != beliefById_.end()) return it->second;
    Belief b;
    b.id = id;
    beliefs_.push_back(b);
    return beliefById_[id.value] = std::move(b);
}

bool NativeGuiModel::isSelectedInCurrentFrame(BeliefId b) const {
    const LoopFrame* f = activeFrame();
    if (!f) return false;
    for (auto s : f->selectedBeliefs) if (s.value == b.value) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------
void NativeGuiModel::openFrame(int id, const std::string& summary, const std::string& openedAt) {
    LoopFrame f;
    f.id = id;
    f.summary = summary;
    f.openedAt = openedAt;
    f.stage = FrameStage::PLANNING;
    f.history = LoopFrame::History::Current;
    frames_[id] = std::move(f);
    frameOrder_.push_back(id);
    cursor_.frameId = id;
    cursor_.stage = FrameStage::PLANNING;
    cursor_.item.clear();
}

void NativeGuiModel::applyLine(const std::string& line) {
    if (line.empty()) return;
    if (line[0] != '{') return;  // not a JSON event; ignore

    std::string type = str(line, "type");
    if (type.empty()) return;

    if (type == "FrameOpened") {
        openFrame(intVal(line, "id"), str(line, "summary"), str(line, "opened_at"));
        return;
    }
    if (type == "BeliefsSelected") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        std::string raw;
        if (!findKey(line, "beliefs", raw)) return;
        f->selectedBeliefs = beliefsArray(raw);
        return;
    }
    if (type == "PlanProduced") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        f->plan.label = str(line, "label");
        f->plan.question = str(line, "question");
        f->plan.intent = str(line, "intent");
        return;
    }
    if (type == "ExecutionStarted") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        f->stage = FrameStage::EXECUTING;
        return;
    }
    if (type == "ToolCalled") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        ToolCall t;
        t.id = str(line, "id");
        t.tool = str(line, "tool");
        t.command = str(line, "command");
        t.status = str(line, "status", "pending");
        f->trajectory.push_back(std::move(t));
        return;
    }
    if (type == "ToolReturned") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        std::string id = str(line, "id");
        for (auto& t : f->trajectory) {
            if (t.id == id) {
                t.result = str(line, "result");
                t.warning = str(line, "warning");
                if (t.status.empty() || t.status == "running" || t.status == "pending")
                    t.status = str(line, "status", "ok");
                break;
            }
        }
        return;
    }
    if (type == "ExecutionCompleted") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        f->stage = FrameStage::DISTILLING;
        return;
    }
    if (type == "DistillationStarted") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        f->stage = FrameStage::DISTILLING;
        return;
    }
    if (type == "DistillationProduced") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        f->distillation.label = str(line, "label");
        f->distillation.inputIds = [&] {
            std::string raw;
            return findKey(line, "inputIds", raw) ? strArray(raw) : std::vector<std::string>{};
        }();
        f->distillation.unexplained = str(line, "unexplained");
        f->distillation.interpretation = str(line, "interpretation");
        f->stage = FrameStage::PROPOSING;
        return;
    }
    if (type == "ProposalCreated") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        Proposal p;
        p.op = charVal(line, "op", '?');
        p.belief = str(line, "belief");
        p.lhs = str(line, "lhs");
        p.relation = str(line, "relation");
        p.rhs = str(line, "rhs");
        p.detail = str(line, "detail");
        f->proposals.push_back(std::move(p));
        return;
    }
    if (type == "CursorChanged") {
        cursor_.frameId = intVal(line, "frameId", cursor_.frameId);
        cursor_.stage = parseStage(str(line, "stage"));
        cursor_.item = str(line, "item");
        LoopFrame* f = frame(cursor_.frameId);
        if (f && cursor_.stage != FrameStage::NONE) f->stage = cursor_.stage;
        return;
    }
    if (type == "FrameClosed") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        f->closed = true;
        f->closedAt = str(line, "closed_at");
        std::string st = str(line, "status", "CLOSED");
        f->stage = FrameStage::CLOSED;
        if (st == "FAILED") f->failed = true;
        // If the active frame just closed, there is no active frame until a
        // new one opens (the model never guesses an active frame).
        if (cursor_.frameId == f->id) {
            cursor_.frameId = -1;
            cursor_.stage = FrameStage::NONE;
            cursor_.item.clear();
        }
        // Derive a navigator summary from the frame's proposals (display only).
        if (f->proposals.empty()) {
            f->history = LoopFrame::History::Closed;
        } else {
            bool hasAdd = false, hasRevise = false, hasRemove = false;
            for (auto& p : f->proposals) {
                if (p.op == '+') hasAdd = true;
                else if (p.op == '~') hasRevise = true;
                else if (p.op == '-') hasRemove = true;
            }
            if (hasRemove) f->history = LoopFrame::History::Falsified;
            else if (hasAdd && hasRevise) f->history = LoopFrame::History::Revised;
            else if (hasAdd) f->history = LoopFrame::History::NewBelief;
            else f->history = LoopFrame::History::Closed;
        }
        return;
    }
    if (type == "BeliefUpdated") {
        BeliefId id{intVal(line, "beliefId")};
        if (!id.valid()) return;
        Belief& b = upsertBelief(id);
        b.lhs = str(line, "lhs");
        b.relation = str(line, "relation");
        b.rhs = str(line, "rhs");
        b.confidence = doubleVal(line, "confidence", b.confidence);
        b.status = str(line, "status", b.status);
        int src = intVal(line, "sourceFrame", -1);
        if (src > 0 && (b.sourceFrames.empty() || b.sourceFrames.back() != src))
            b.sourceFrames.push_back(src);
        return;
    }
    // Unknown event: ignored, model state unchanged.
}

} // namespace pie::gui
