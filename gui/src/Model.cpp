#include "Model.h"

#include <cctype>
#include <cstddef>
#include <cstring>
#include <string_view>

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

// Encode a code point as UTF-8. Surrogate values must not reach here: JSON
// surrogate pairs are combined by decodeEscapes before encoding.
void appendUtf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

// Decode JSON escape sequences in a raw (unquoted) string body.
std::string decodeEscapes(const std::string& body) {
    std::string out;
    for (size_t i = 0; i < body.size(); ++i) {
        char c = body[i];
        if (c == '\\' && i + 1 < body.size()) {
            char e = body[++i];
            switch (e) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case '"': out += '"'; break;
                case 'u': {
                    auto hex4 = [&](size_t start, unsigned& out4) -> bool {
                        if (start + 4 > body.size()) return false;
                        out4 = 0;
                        for (int k = 0; k < 4; ++k) {
                            char h = body[start + k];
                            int d;
                            if (h >= '0' && h <= '9') d = h - '0';
                            else if (h >= 'a' && h <= 'f') d = h - 'a' + 10;
                            else if (h >= 'A' && h <= 'F') d = h - 'A' + 10;
                            else return false;
                            out4 = out4 * 16 + d;
                        }
                        return true;
                    };
                    unsigned first = 0;
                    if (!hex4(i + 1, first)) { out += '\\'; out += 'u'; break; }
                    i += 4;
                    if (first >= 0xD800 && first <= 0xDBFF) {
                        unsigned second = 0;
                        if (i + 6 < body.size() && body[i + 1] == '\\' && body[i + 2] == 'u' &&
                            hex4(i + 3, second) && second >= 0xDC00 && second <= 0xDFFF) {
                            i += 6;
                            unsigned cp = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
                            appendUtf8(out, cp);
                        } else {
                            out += '\\'; out += 'u';
                            for (int k = 3; k >= 0; --k) out += body[i - k];
                        }
                    } else if (first >= 0xDC00 && first <= 0xDFFF) {
                        out += '\\'; out += 'u';
                        for (int k = 3; k >= 0; --k) out += body[i - k];
                    } else {
                        appendUtf8(out, first);
                    }
                    break;
                }
                default: out += '\\'; out += e; break;
            }
            continue;
        }
        out += c;
    }
    return out;
}

std::string stringValue(const std::string& v) {
    if (v.size() < 2 || v[0] != '"') return {};
    size_t q = 1;
    while (q < v.size() && v[q] != '"') {
        if (v[q] == '\\') ++q;
        ++q;
    }
    if (q >= v.size()) return {};
    return decodeEscapes(v.substr(1, q - 1));
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

double nullableDoubleVal(const std::string& s, const std::string& key, double def = -1.0) {
    std::string raw;
    if (!findKey(s, key, raw)) return def;
    std::string t = trim(raw);
    if (t.empty()) return def;
    if (t[0] == '\"') return doubleVal(s, key, def);
    if (std::strncmp(t.c_str(), "null", 4) == 0) return def;
    return std::strtod(t.c_str(), nullptr);
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

std::vector<std::string> strArray(const std::string& v) {
    std::vector<std::string> out;
    for (auto& e : arrayElements(v)) out.push_back(stringValue(e));
    return out;
}

// Read a top-level string-array field (["a","b"]).
std::vector<std::string> strArrayField(const std::string& s, const std::string& key) {
    std::string raw;
    if (!findKey(s, key, raw)) return {};
    return strArray(raw);
}

FrameStage parseStage(const std::string& s) {
    if (s == "routing" || s == "ROUTING") return FrameStage::ROUTING;
    if (s == "planning" || s == "PLANNING") return FrameStage::PLANNING;
    if (s == "executing" || s == "EXECUTING") return FrameStage::EXECUTING;
    if (s == "distilling" || s == "DISTILLING") return FrameStage::DISTILLING;
    if (s == "proposing" || s == "PROPOSING") return FrameStage::PROPOSING;
    if (s == "closed" || s == "CLOSED") return FrameStage::CLOSED;
    return FrameStage::NONE;
}

// Case-insensitive substring test. An empty needle matches anything.
bool containsFold(const std::string& hay, std::string_view needle) {
    if (needle.empty()) return true;
    std::string hl;
    hl.reserve(hay.size());
    for (char c : hay)
        hl.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    std::string nl;
    nl.reserve(needle.size());
    for (char c : needle)
        nl.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    return hl.find(nl) != std::string::npos;
}

// Extract the raw value (object/array/string/number) for a top-level key.
bool rawValue(const std::string& s, const std::string& key, std::string& out) {
    const std::string pat = "\"" + key + "\"";
    size_t p = s.find(pat);
    if (p == std::string::npos) return false;
    size_t colon = s.find(':', p + pat.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
    if (i >= s.size()) return false;
    size_t start = i;
    bool inStr = false;
    int depth = 0;
    for (; i < s.size(); ++i) {
        char c = s[i];
        if (inStr) {
            if (c == '\\') { ++i; continue; }
            if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') inStr = true;
        else if (c == '{' || c == '[') ++depth;
        else if (c == '}' || c == ']') {
            if (depth == 0) { out = trim(s.substr(start, i - start + 1)); return true; }
            --depth;
        } else if (c == ',' && depth == 0) {
            out = trim(s.substr(start, i - start));
            return true;
        }
    }
    out = trim(s.substr(start));
    return true;
}

// Join all `"text":"..."` and `"thinking":"..."` string values found within a
// raw value (string or content array) so tool output / intervention content is
// reduced to a readable single line.
std::string extractTextFromValue(const std::string& raw) {
    std::string t = trim(raw);
    if (t.empty()) return {};
    if (t[0] == '"') return stringValue(t);
    std::string out;
    auto extractKey = [&](const std::string& keyLiteral) {
        size_t p = 0;
        while ((p = t.find(keyLiteral, p)) != std::string::npos) {
            p += keyLiteral.size();
            size_t q = p;
            while (q < t.size() && t[q] != '"') {
                if (t[q] == '\\') ++q;
                ++q;
            }
            std::string v = decodeEscapes(t.substr(p, q - p));
            if (!v.empty()) { if (!out.empty()) out += " "; out += v; }
            p = q + 1;
        }
    };
    extractKey("\"text\":\"");
    extractKey("\"thinking\":\"");
    return out;
}

// Extract a readable tool-input summary from an ExecutionStarted `input` value:
// prefer `command`, then `path`/`file_path`, else the raw text.
std::string inputToSummary(const std::string& raw) {
    std::string t = trim(raw);
    if (t.empty()) return {};
    if (t[0] == '"') return stringValue(t);
    std::string command = str(raw, "command");
    if (!command.empty()) return command;
    std::string path = str(raw, "path");
    if (!path.empty()) return path;
    std::string filePath = str(raw, "file_path");
    if (!filePath.empty()) return filePath;
    return extractTextFromValue(t);
}

// Derive the Belief status from append-only provenance (domain-model.md).
std::string deriveBeliefStatus(const Belief& b) {
    if (b.withdrawn || !b.supersededBy.empty()) return "superseded";
    if (!b.refutedBy.empty()) return "refuted";
    if (!b.supportedBy.empty()) return "supported";
    return "proposed";
}

// Fill a Belief record from a raw JSON belief object. Does not touch `label`
// (set by upsertBelief) or `createdInFrame` (set from the delta's frameId).
void parseBeliefRecord(const std::string& raw, Belief& b) {
    b.id = str(raw, "id", b.id);
    b.statement = str(raw, "statement", b.statement);
    b.domain = str(raw, "domain", b.domain);
    b.expectation = str(raw, "expectation", b.expectation);
    b.evidenceRounds = intVal(raw, "evidenceRounds", b.evidenceRounds);
    b.supersededBy = str(raw, "supersededBy", "");
    b.withdrawn = str(raw, "withdrawn") == "true";
    b.skillRefs = strArrayField(raw, "skillRefs");

    b.supportedBy.clear();
    std::string supRaw;
    if (rawValue(raw, "supportedBy", supRaw)) {
        for (auto& e : arrayElements(supRaw)) {
            std::string ev = str(e, "evidence");
            if (!ev.empty()) b.supportedBy.push_back(ev);
        }
    }
    b.refutedBy.clear();
    std::string refRaw;
    if (rawValue(raw, "refutedBy", refRaw)) {
        for (auto& e : arrayElements(refRaw)) {
            std::string ev = str(e, "evidence");
            if (!ev.empty()) b.refutedBy.push_back(ev);
        }
    }
    b.status = deriveBeliefStatus(b);
}

// Derive the navigator history flag from a frame's belief deltas (display only).
LoopFrame::History deriveHistory(const LoopFrame& f) {
    bool hasAdd = false, hasRevise = false, hasRemove = false;
    for (const BeliefDelta& d : f.beliefDeltas) {
        if (d.operation == "retract") hasRemove = true;
        else if (d.operation == "refine") hasRevise = true;
        else if (d.operation == "propose") hasAdd = true;
    }
    if (hasRemove) return LoopFrame::History::Falsified;
    if (hasAdd && hasRevise) return LoopFrame::History::Revised;
    if (hasAdd) return LoopFrame::History::NewBelief;
    return LoopFrame::History::Closed;
}

} // namespace

const char* frameStageToString(FrameStage s) {
    switch (s) {
        case FrameStage::ROUTING: return "ROUTING";
        case FrameStage::PLANNING: return "PLANNING";
        case FrameStage::EXECUTING: return "EXECUTING";
        case FrameStage::DISTILLING: return "DISTILLING";
        case FrameStage::PROPOSING: return "PROPOSING";
        case FrameStage::CLOSED: return "CLOSED";
        case FrameStage::NONE: break;
    }
    return "NONE";
}

bool frameMatchesQuery(const LoopFrame& f, std::string_view query) {
    if (query.empty()) return true;
    if (containsFold(f.id, query)) return true;
    if (containsFold(f.summary, query)) return true;
    if (containsFold(f.plan.intent, query)) return true;
    for (auto& id : f.plan.selectedToExplore) if (containsFold(id, query)) return true;
    for (auto& t : f.trajectory) {
        if (containsFold(t.tool, query)) return true;
        if (containsFold(t.command, query)) return true;
        if (containsFold(t.result, query)) return true;
        if (containsFold(t.status, query)) return true;
    }
    if (containsFold(f.distillation.contents, query)) return true;
    for (auto& id : f.distillation.inputs) if (containsFold(id, query)) return true;
    for (auto& d : f.beliefDeltas) {
        if (containsFold(d.operation, query)) return true;
        if (containsFold(d.beliefId, query)) return true;
        if (containsFold(d.evidence, query)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Frame / belief / task accessors
// ---------------------------------------------------------------------------
void NativeGuiModel::reset() {
    frames_.clear();
    frameOrder_.clear();
    tasks_.clear();
    taskOrder_.clear();
    activeTaskId_.clear();
    selectedTaskId_.clear();
    beliefById_.clear();
    beliefs_.clear();
    activeBeliefs_.clear();
    pendingDeltas_.clear();
    seenDeltaIds_.clear();
    cursor_ = FrameCursor{};
    nextBeliefOrdinal_ = 0;
    nextPlanOrdinal_ = 0;
    nextDistillOrdinal_ = 0;
    roleContext_ = RoleContextUsagePair{};
    clearFileList();
}

LoopFrame* NativeGuiModel::frame(FrameId id) {
    auto it = frames_.find(id);
    return it == frames_.end() ? nullptr : &it->second;
}
const LoopFrame* NativeGuiModel::frame(FrameId id) const {
    auto it = frames_.find(id);
    return it == frames_.end() ? nullptr : &it->second;
}

const LoopFrame* NativeGuiModel::activeFrame() const {
    return cursor_.frameId.empty() ? nullptr : frame(cursor_.frameId);
}
const LoopFrame* NativeGuiModel::frameById(FrameId id) const { return frame(id); }

std::vector<LoopFrame> NativeGuiModel::frames() const {
    std::vector<LoopFrame> out;
    out.reserve(frameOrder_.size());
    for (const FrameId& id : frameOrder_) {
        auto it = frames_.find(id);
        if (it != frames_.end()) out.push_back(it->second);
    }
    return out;
}

const Task* NativeGuiModel::taskById(TaskId id) const {
    auto it = tasks_.find(id);
    return it == tasks_.end() ? nullptr : &it->second;
}

std::vector<Task> NativeGuiModel::tasks() const {
    std::vector<Task> out;
    out.reserve(taskOrder_.size());
    for (const TaskId& id : taskOrder_) {
        auto it = tasks_.find(id);
        if (it != tasks_.end()) out.push_back(it->second);
    }
    return out;
}

const Task* NativeGuiModel::activeTask() const {
    return activeTaskId_.empty() ? nullptr : taskById(activeTaskId_);
}

const Task* NativeGuiModel::selectedTask() const {
    const TaskId& id = selectedTaskId_.empty() ? activeTaskId_ : selectedTaskId_;
    return taskById(id);
}

const Belief* NativeGuiModel::belief(BeliefId id) const {
    auto it = beliefById_.find(id);
    if (it == beliefById_.end()) return nullptr;
    return &beliefs_[static_cast<size_t>(it->second)];
}

Belief& NativeGuiModel::upsertBelief(const BeliefId& id) {
    auto it = beliefById_.find(id);
    if (it != beliefById_.end()) return beliefs_[static_cast<size_t>(it->second)];
    Belief b;
    b.id = id;
    b.label = "B" + std::to_string(++nextBeliefOrdinal_);
    b.status = "proposed";
    const int idx = static_cast<int>(beliefs_.size());
    beliefs_.push_back(std::move(b));
    beliefById_[id] = idx;
    return beliefs_[static_cast<size_t>(idx)];
}

bool NativeGuiModel::isSelectedInCurrentFrame(const BeliefId& b) const {
    const LoopFrame* f = activeFrame();
    if (!f) return false;
    for (const BeliefId& s : f->plan.selectedToExplore)
        if (s == b) return true;
    return false;
}

std::string NativeGuiModel::beliefLabel(const BeliefId& id) const {
    const Belief* b = belief(id);
    return b && !b->label.empty() ? b->label : id;
}

// ---------------------------------------------------------------------------
// Live in-message stream (':' pane)
// ---------------------------------------------------------------------------
void NativeGuiModel::beginInMessage(const std::string& text) {
    inMessage_ = text;
    inMessageError_ = false;
}
void NativeGuiModel::appendInMessage(const std::string& delta) {
    inMessage_ += delta;
}
void NativeGuiModel::endInMessage() {
    // The buffer already holds the accumulated text; nothing more to do.
}
void NativeGuiModel::setInMessageThinking(bool thinking) {
    inMessageThinking_ = thinking;
}
void NativeGuiModel::setInMessageError(const std::string& message) {
    inMessage_ = message;
    inMessageThinking_ = false;
    inMessageError_ = true;
}

// ---------------------------------------------------------------------------
// Domain event application
// ---------------------------------------------------------------------------
void NativeGuiModel::openTask(TaskId id, TaskId parentTaskId, const std::string& prompt) {
    if (tasks_.count(id)) return;
    Task t;
    t.id = id;
    t.parentTaskId = parentTaskId;
    t.status = "active";
    t.prompt = prompt;
    tasks_[id] = std::move(t);
    taskOrder_.push_back(id);
    activeTaskId_ = id;
    if (selectedTaskId_.empty()) selectedTaskId_ = id;
}

void NativeGuiModel::openFrame(FrameId id, TaskId taskId, uint64_t ordinal, const std::string& openedAt) {
    // Idempotent reopen: a repeated FrameOpened for an already-open frame must
    // not clobber its existing contents (plan, executions, deltas, etc.). Point
    // the cursor at it and preserve what the runtime already gave us.
    if (frames_.count(id)) {
        cursor_.taskId = taskId;
        cursor_.frameId = id;
        cursor_.stage = FrameStage::ROUTING;
        cursor_.item.clear();
        return;
    }
    LoopFrame f;
    f.id = id;
    f.taskId = taskId;
    f.ordinal = ordinal;
    f.openedAt = openedAt;
    f.stage = FrameStage::ROUTING;
    f.history = LoopFrame::History::Current;
    frames_[id] = std::move(f);
    frameOrder_.push_back(id);
    cursor_.taskId = taskId;
    cursor_.frameId = id;
    cursor_.stage = FrameStage::ROUTING;
    cursor_.item.clear();
    auto* task = taskById(taskId);
    if (task) {
        auto& frames = const_cast<std::vector<FrameId>&>(task->frames);
        frames.push_back(id);
    }
    // A new frame supersedes any pending terminal-close signal from a prior
    // mid-loop FrameClosed (only the final close is not followed by FrameOpened).
    finalReportPending_ = false;
}

void NativeGuiModel::closeFrame(FrameId id, bool failed) {
    LoopFrame* f = frame(id);
    if (!f || f->closed) return;
    f->closed = true;
    f->failed = failed;
    f->stage = FrameStage::CLOSED;
    f->history = deriveHistory(*f);
    // A frame close is the belief loop's terminal boundary (finalReport). The
    // flag is cleared on the next FrameOpened, so only the terminal close keeps
    // it until the conclusion message_end.
    finalReportPending_ = true;
}

bool NativeGuiModel::applyDomainLine(const std::string& line) {
    if (line.empty() || line[0] != '{') return false;
    const std::string type = str(line, "type");
    if (type.empty()) return false;

    if (type == "TaskOpened") {
        const std::string taskId = str(line, "taskId");
        const std::string parent = str(line, "parentTaskId");
        if (taskId.empty()) return true;
        openTask(taskId, parent, "");
        auto* task = const_cast<Task*>(taskById(taskId));
        if (task) task->inheritedBeliefs = strArrayField(line, "inheritedBeliefs");
        return true;
    }
    if (type == "TargetDefined") {
        const std::string taskId = str(line, "taskId");
        auto* task = const_cast<Task*>(taskById(taskId));
        std::string targetRaw;
        if (task && rawValue(line, "target", targetRaw)) {
            task->targetStatement = str(targetRaw, "statement");
            if (task->prompt.empty()) task->prompt = task->targetStatement;
        }
        return true;
    }
    if (type == "FrameOpened") {
        const std::string taskId = str(line, "taskId");
        const std::string frameId = str(line, "frameId");
        if (frameId.empty()) return true;
        openFrame(frameId, taskId, static_cast<uint64_t>(intVal(line, "ordinal", 0)), "");
        // Backfill belief-deltas that arrived before this frame was opened, so
        // a belief creation keeps its corresponding Propose node even when the
        // runtime emits the delta out of order.
        if (!pendingDeltas_.empty()) {
            LoopFrame* opened = frame(frameId);
            std::vector<BeliefDelta> remaining;
            for (auto& pd : pendingDeltas_) {
                if (pd.frameId == frameId && opened) opened->beliefDeltas.push_back(std::move(pd));
                else remaining.push_back(std::move(pd));
            }
            pendingDeltas_ = std::move(remaining);
        }
        // Seed the display summary from the task's target statement.
        if (const Task* task = taskById(taskId); task && !task->targetStatement.empty()) {
            frame(frameId)->summary = task->targetStatement;
        }
        return true;
    }
    if (type == "RoutingDecided") {
        LoopFrame* f = frame(str(line, "frameId"));
        std::string routingRaw;
        if (f && rawValue(line, "routing", routingRaw)) {
            f->routingDecision = str(routingRaw, "decision");
            f->routingReason = str(routingRaw, "reason");
        }
        return true;
    }
    if (type == "FrameBodySelected") {
        LoopFrame* f = frame(str(line, "frameId"));
        if (f) {
            f->bodyKind = str(line, "body");
            f->openBeliefsAtStart = strArrayField(line, "openBeliefsAtStart");
        }
        return true;
    }
    if (type == "CursorChanged") {
        const FrameStage st = parseStage(str(line, "stage"));
        cursor_.taskId = str(line, "taskId", cursor_.taskId);
        cursor_.frameId = str(line, "frameId", cursor_.frameId);
        cursor_.stage = st;
        LoopFrame* f = frame(cursor_.frameId);
        if (f && st != FrameStage::NONE) f->stage = st;
        return true;
    }
    if (type == "InterventionAdded") {
        LoopFrame* f = frame(str(line, "frameId"));
        std::string raw;
        if (f && rawValue(line, "intervention", raw)) {
            Intervention iv;
            iv.id = str(raw, "id");
            iv.stage = str(raw, "stage");
            iv.createdAt = str(raw, "createdAt");
            std::string contents;
            if (rawValue(raw, "contents", contents)) iv.contents = extractTextFromValue(contents);
            f->steering.push_back(std::move(iv));
        }
        return true;
    }
    if (type == "BeliefDeltaApplied") {
        const std::string frameId = str(line, "frameId");
        LoopFrame* f = frame(frameId);
        std::string deltaRaw;
        if (!rawValue(line, "delta", deltaRaw)) return true;

        BeliefDelta d;
        d.id = str(deltaRaw, "id");
        // Ignore a replayed mutation (same id) so it cannot create a duplicate
        // Propose node; only dedup when the id is non-empty.
        if (!d.id.empty() && !seenDeltaIds_.insert(d.id).second) return true;
        d.frameId = str(deltaRaw, "frameId", frameId);
        d.distillationId = str(deltaRaw, "distillationId");
        d.operation = str(deltaRaw, "operation");
        d.beliefId = str(deltaRaw, "beliefId");
        d.evidence = str(deltaRaw, "evidence");
        d.evidenceBeliefIds = strArrayField(deltaRaw, "evidenceBeliefIds");

        std::string resultingRaw;
        std::string createdId;
        if (rawValue(deltaRaw, "resultingBeliefs", resultingRaw)) {
            for (auto& e : arrayElements(resultingRaw)) {
                Belief parsed;
                parseBeliefRecord(e, parsed);
                if (parsed.id.empty()) continue;
                if (createdId.empty()) createdId = parsed.id;
                const bool isNew = beliefById_.find(parsed.id) == beliefById_.end();
                Belief& stored = upsertBelief(parsed.id);
                stored.statement = parsed.statement;
                stored.domain = parsed.domain;
                stored.expectation = parsed.expectation;
                stored.evidenceRounds = parsed.evidenceRounds;
                stored.skillRefs = std::move(parsed.skillRefs);
                stored.supportedBy = std::move(parsed.supportedBy);
                stored.refutedBy = std::move(parsed.refutedBy);
                stored.supersededBy = std::move(parsed.supersededBy);
                stored.withdrawn = parsed.withdrawn;
                stored.status = parsed.status;
                if (isNew || stored.createdInFrame.empty()) stored.createdInFrame = frameId;
            }
        }
        // A creation delta names its belief via beliefId; when the runtime omits
        // it but does project a resulting belief, fall back to that id so the
        // Propose node is still emitted and linked.
        if (d.beliefId.empty() && !createdId.empty()) d.beliefId = createdId;
        if (f) f->beliefDeltas.push_back(std::move(d));
        else pendingDeltas_.push_back(std::move(d));
        activeBeliefs_ = strArrayField(line, "activeBeliefs");
        return true;
    }
    if (type == "PlanProduced") {
        LoopFrame* f = frame(str(line, "frameId"));
        std::string planRaw;
        if (f && rawValue(line, "plan", planRaw)) {
            Plan p;
            p.id = str(planRaw, "id");
            p.selectedToExplore = strArrayField(planRaw, "selectedToExplore");
            p.intent = str(planRaw, "intent");
            p.label = "P-" + std::to_string(++nextPlanOrdinal_);
            f->plan = std::move(p);
        }
        return true;
    }
    if (type == "ExecutionStarted") {
        const std::string frameId = str(line, "frameId");
        LoopFrame* f = frame(frameId);
        std::string execRaw;
        if (!f || !rawValue(line, "execution", execRaw)) return true;
        Execution ex;
        ex.id = str(execRaw, "id");
        ex.planId = str(execRaw, "planId");
        ex.tool = str(execRaw, "tool");
        ex.status = "running";
        std::string input;
        if (rawValue(execRaw, "input", input)) ex.command = inputToSummary(input);
        std::string filePath = str(execRaw, "filePath");
        f->trajectory.push_back(std::move(ex));
        // Session file list: read/write/edit tools carry a path (or file_path).
        if (f->trajectory.back().tool == "read" || f->trajectory.back().tool == "write" ||
            f->trajectory.back().tool == "edit") {
            std::string p;
            if (rawValue(execRaw, "input", input)) {
                p = str(input, "path");
                if (p.empty()) p = str(input, "file_path");
            }
            if (p.empty()) p = filePath;
            recordFileOp(f->trajectory.back().tool, p);
        }
        return true;
    }
    if (type == "ExecutionCompleted") {
        const std::string frameId = str(line, "frameId");
        LoopFrame* f = frame(frameId);
        if (!f) return true;
        const std::string execId = str(line, "executionId");
        const std::string status = str(line, "status");
        std::string output;
        rawValue(line, "output", output);
        for (Execution& t : f->trajectory) {
            if (t.id == execId) {
                t.result = extractTextFromValue(output);
                if (status == "succeeded") t.status = "ok";
                else if (status == "cancelled") t.status = "cancelled";
                else t.status = "failed"; // "failed"
                t.warning = str(line, "error");
                break;
            }
        }
        return true;
    }
    if (type == "DistillationProduced") {
        LoopFrame* f = frame(str(line, "frameId"));
        std::string distRaw;
        if (f && rawValue(line, "distillation", distRaw)) {
            Distillation d;
            d.id = str(distRaw, "id");
            d.inputs = strArrayField(distRaw, "inputs");
            d.contents = str(distRaw, "contents");
            d.outputs = strArrayField(distRaw, "outputs");
            d.label = "D-" + std::to_string(++nextDistillOrdinal_);
            f->distillation = std::move(d);
        }
        return true;
    }
    if (type == "FrameClosed") {
        closeFrame(str(line, "frameId"), false);
        return true;
    }
    if (type == "TaskClosed") {
        const std::string taskId = str(line, "taskId");
        auto* task = const_cast<Task*>(taskById(taskId));
        if (task) task->status = str(line, "status", "completed");
        if (taskId == activeTaskId_) {
            activeTaskId_.clear();
            cursor_ = FrameCursor{};
        }
        // Bound the pending-delta buffer: once a task closes its frames will not
        // reopen, so drop any still-unattached deltas rather than leaking them.
        pendingDeltas_.clear();
        return true;
    }
    // Not a domain event.
    return false;
}

void NativeGuiModel::applyLine(const std::string& line) {
    applyDomainLine(line);
}

// ---------------------------------------------------------------------------
// RPC event adapter (live mode)
// ---------------------------------------------------------------------------
RpcApplyResult applyRpcLine(NativeGuiModel& model, const std::string& line) {
    if (line.empty() || line[0] != '{') return RpcApplyResult::Error;
    std::string type = str(line, "type");
    if (type.empty()) return RpcApplyResult::Error;

    // Successful acknowledgements are control events; surface failures in the
    // prompt pane so the user can see why the request was rejected.
    if (type == "response") {
        std::string success;
        if (findKey(line, "success", success) && trim(success).rfind("false", 0) == 0) {
            std::string message = str(line, "error");
            if (message.empty()) message = "RPC request failed";
            model.setInMessageError(message);
        }
        return RpcApplyResult::Ignored;
    }

    // Bottom-footer telemetry: per-role model + cache hit rate and session cost.
    if (type == "session_status") {
        auto parseRole = [&](const std::string& roleName) -> RoleFooterSlot {
            RoleFooterSlot slot;
            std::string rawStatus;
            if (rawValue(line, roleName, rawStatus)) {
                slot.cacheHitRate = doubleVal(rawStatus, "latestCacheHitRate", -1.0f);
                std::string rawModel;
                if (rawValue(rawStatus, "model", rawModel)) {
                    std::string id = str(rawModel, "id");
                    if (!id.empty()) slot.model = id;
                }
            }
            return slot;
        };
        Footer f;
        std::string rawRoleStatus;
        if (rawValue(line, "roleStatus", rawRoleStatus)) {
            f.epistemic = parseRole("epistemic");
            f.planner = parseRole("planner");
            f.distillation = parseRole("distillation");
            f.execution = parseRole("execution");
        }
        if (rawRoleStatus.empty()) {
            f.epistemic = parseRole("epistemic");
            f.planner = parseRole("planner");
            f.distillation = parseRole("distillation");
            f.execution = parseRole("execution");
        }
        f.sessionCost = doubleVal(line, "cost", 0.0);
        f.hasData = true;
        model.setFooter(std::move(f));

        std::string rawRoleUsage;
        if (rawValue(line, "roleUsage", rawRoleUsage)) {
            auto parseUsage = [&](const std::string& role) -> RoleContextUsage {
                RoleContextUsage u;
                std::string raw;
                if (rawValue(rawRoleUsage, role, raw)) {
                    u.tokens = static_cast<long>(nullableDoubleVal(raw, "tokens", -1.0));
                    u.contextWindow = static_cast<long>(nullableDoubleVal(raw, "contextWindow", 0.0));
                    u.percent = nullableDoubleVal(raw, "percent", -1.0);
                }
                return u;
            };
            RoleContextUsagePair rcu;
            rcu.epistemic = parseUsage("epistemic");
            rcu.execution = parseUsage("execution");
            rcu.hasData = true;
            model.setRoleContext(std::move(rcu));
        } else {
            model.setRoleContext(RoleContextUsagePair{});
        }
        return RpcApplyResult::Applied;
    }

    // AgentEvent turn boundaries. The domain events (TaskOpened/FrameOpened/
    // FrameClosed) are authoritative for frame lifecycles; these only mark a
    // model turn and never open or close a belief-loop frame.
    if (type == "agent_start" || type == "turn_start" || type == "turn_end" ||
        type == "agent_settled") {
        return RpcApplyResult::Ignored;
    }

    if (type == "message_start") {
        std::string role = str(line, "role");
        std::string text;
        std::string content;
        if (rawValue(line, "content", content)) text = extractTextFromValue(content);
        else text = extractTextFromValue(line);

        // Fast-path distillation custom message (legacy): its content is the
        // distillation summary. Surface it in the in-message stream rather than
        // fabricating a Distillation occurrence.
        std::string customType = str(line, "customType");
        if (role == "custom" && customType == "fast_path_distillation") {
            std::string distText;
            if (rawValue(line, "content", content)) {
                std::string v = stringValue(content);
                if (!v.empty()) distText = v;
            }
            if (distText.empty()) distText = text;
            model.beginInMessage(distText);
            return RpcApplyResult::Applied;
        }
        // Seed the ':' in-message stream on an assistant message; clear it on a
        // user message so the previous reply does not linger.
        if (role == "assistant") {
            model.beginInMessage(text);
        } else if (role == "user") {
            model.beginInMessage("");
        }
        return RpcApplyResult::Applied;
    }
    if (type == "message_update") {
        std::string evt;
        if (rawValue(line, "assistantMessageEvent", evt)) {
            std::string deltaType = str(evt, "type");
            if (deltaType == "thinking_start") {
                model.setInMessageThinking(true);
                return RpcApplyResult::Applied;
            }
            if (deltaType == "thinking_end" || deltaType == "text_start") {
                model.setInMessageThinking(false);
                return RpcApplyResult::Applied;
            }
            if (deltaType == "text_delta" || deltaType == "thinking_delta") {
                model.appendInMessage(str(evt, "delta"));
                return RpcApplyResult::Applied;
            }
        }
        return RpcApplyResult::Ignored;
    }
    if (type == "message_end") {
        model.endInMessage();
        if (model.finalReportPending()) model.requestAutoOpenPrompt();
        return RpcApplyResult::Applied;
    }

    // Tool call/result telemetry: only feed the session file list here; the
    // execution trajectory is built from the domain ExecutionStarted/Completed
    // events so non-probe tools never appear as execution probes.
    if (type == "tool_execution_start") {
        std::string args;
        rawValue(line, "args", args);
        std::string tool = str(line, "toolName");
        if (tool == "read" || tool == "write" || tool == "edit") {
            std::string p = str(args, "path");
            if (p.empty()) p = str(args, "file_path");
            model.recordFileOp(tool, p);
        }
        return RpcApplyResult::Applied;
    }
    if (type == "tool_execution_end") {
        return RpcApplyResult::Ignored;
    }

    // Domain events (Task/Frame/Belief/Plan/Execution/Distillation lifecycle).
    if (model.applyDomainLine(line)) return RpcApplyResult::Applied;

    return RpcApplyResult::Ignored;
}

} // namespace pie::gui
