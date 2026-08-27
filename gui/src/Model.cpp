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
// surrogate pairs are combined by decodeEscapes before encoding, so an isolated
// surrogate is preserved as its original escape instead of yielding invalid
// UTF-8 (the old BMP-only branch encoded D800-DFFF as a lone 3-byte sequence).
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

// Decode JSON escape sequences in a raw (unquoted) string body. The previous
// implementation dropped the leading backslash and blindly appended the escaped
// character, so "\n\n" collapsed to "nn" instead of the two newlines it
// encodes. Decode the standard JSON escapes so message content round-trips.
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
                    // Parse one \uXXXX escape into a code unit.
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
                    i += 4;  // i now at the last hex digit of the first escape.
                    if (first >= 0xD800 && first <= 0xDBFF) {
                        // High surrogate: if a low surrogate \uXXXX follows,
                        // combine into a single code point; otherwise preserve
                        // the high surrogate's escape (invalid UTF-8 otherwise).
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
                        // Isolated low surrogate: preserve its escape.
                        out += '\\'; out += 'u';
                        for (int k = 3; k >= 0; --k) out += body[i - k];
                    } else {
                        appendUtf8(out, first);
                    }
                    break;
                }
                // Unknown escapes keep the backslash rather than silently
                // dropping it, which is closer to the original input.
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

// Like doubleVal, but a literal JSON null is treated as the default (-> the
// unknown placeholder) rather than strtod's 0.0. The runtime reports context
// usage tokens/percent as null when unknown, e.g. right after compaction.
double nullableDoubleVal(const std::string& s, const std::string& key, double def = -1.0) {
    std::string raw;
    if (!findKey(s, key, raw)) return def;
    std::string t = trim(raw);
    if (t.empty()) return def;
    if (t[0] == '\"') return doubleVal(s, key, def);  // quoted string value
    if (std::strncmp(t.c_str(), "null", 4) == 0) return def;
    return std::strtod(t.c_str(), nullptr);
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

bool hasLoopCycleContent(const LoopFrame& frame) {
    return !frame.selectedBeliefs.empty() || !frame.plans.empty() || frame.plan.valid() ||
           !frame.trajectory.empty() || !frame.distillations.empty() ||
           frame.distillation.valid() || !frame.proposals.empty();
}

// Extract the raw value (object/array/string/number) for a top-level key.
// Handles nested {}[] and strings. Used to read args/result/content objects
// that the minimal scalar helpers cannot parse.
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

// Join all `"text":"..."` and `"thinking":"..."` string values found within
// a `content` array so the ⌘T pane seeds the assistant's reply with both
// visible text and reasoning blocks (thinking is a separate content field).
std::string extractMessageText(const std::string& line) {
    std::string content;
    if (!rawValue(line, "content", content)) return {};
    std::string out;
    auto extractKey = [&](const std::string& keyLiteral) {
        size_t p = 0;
        while ((p = content.find(keyLiteral, p)) != std::string::npos) {
            p += keyLiteral.size();
            size_t q = p;
            while (q < content.size() && content[q] != '"') {
                if (content[q] == '\\') ++q;
                ++q;
            }
            std::string t = decodeEscapes(content.substr(p, q - p));
            if (!t.empty()) { if (!out.empty()) out += " "; out += t; }
            p = q + 1;
        }
    };
    extractKey("\"text\":\"");
    extractKey("\"thinking\":\"");
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

bool frameMatchesQuery(const LoopFrame& f, std::string_view query) {
    if (query.empty()) return true;
    if (containsFold(std::to_string(f.id), query)) return true;
    if (containsFold(f.summary, query)) return true;
    if (containsFold(f.plan.label, query)) return true;
    if (containsFold(f.plan.question, query)) return true;
    if (containsFold(f.plan.intent, query)) return true;
    for (auto& t : f.trajectory) {
        if (containsFold(t.tool, query)) return true;
        if (containsFold(t.command, query)) return true;
        if (containsFold(t.result, query)) return true;
        if (containsFold(t.status, query)) return true;
    }
    if (containsFold(f.distillation.label, query)) return true;
    for (auto& id : f.distillation.inputIds) if (containsFold(id, query)) return true;
    if (containsFold(f.distillation.unexplained, query)) return true;
    if (containsFold(f.distillation.interpretation, query)) return true;
    for (auto& p : f.proposals) {
        if (containsFold(std::string(1, p.op), query)) return true;
        if (containsFold(p.belief, query)) return true;
        if (containsFold(p.lhs, query)) return true;
        if (containsFold(p.relation, query)) return true;
        if (containsFold(p.rhs, query)) return true;
        if (containsFold(p.detail, query)) return true;
    }
    return false;
}

RpcApplyResult applyRpcLine(NativeGuiModel& model, const std::string& line) {
    if (line.empty() || line[0] != '{') return RpcApplyResult::Error;
    std::string type = str(line, "type");
    if (type.empty()) return RpcApplyResult::Error;

    const LoopFrame* active = model.activeFrame();

    // Benign RPC control events: no model state.
    if (type == "response")
        return RpcApplyResult::Ignored;

    // Bottom-footer telemetry: per-role model + cache hit rate and session cost.
    if (type == "session_status") {
        // roleStatus is the object under the "roleStatus" key; each phase entry is
        // { model: { provider, id, ... }, latestCacheHitRate }. The footer shows the
        // bare model id (provider is intentionally not surfaced).
        auto parseRole = [&](const std::string& roleName) -> RoleFooterSlot {
            RoleFooterSlot slot;
            std::string rawStatus;
            if (rawValue(line, roleName, rawStatus)) {
                slot.cacheHitRate = doubleVal(rawStatus, "latestCacheHitRate", -1.0f);
                std::string rawModel;
                if (rawValue(rawStatus, "model", rawModel)) {
                    // std::string provider = str(rawModel, "provider");
                    std::string id = str(rawModel, "id");
                    if (!id.empty()) slot.model = id;
                }
            }
            return slot;
        };
        Footer f;
        // roleStatus is nested under the top-level "roleStatus" key.
        std::string rawRoleStatus;
        if (rawValue(line, "roleStatus", rawRoleStatus)) {
            f.epistemic = parseRole("epistemic");
            f.planner = parseRole("planner");
            f.distillation = parseRole("distillation");
            f.execution = parseRole("execution");
        }
        // Fall back to reading the phase keys directly off the top-level line when
        // roleStatus is not nested (robustness for a plain session_status payload).
        if (rawRoleStatus.empty()) {
            f.epistemic = parseRole("epistemic");
            f.planner = parseRole("planner");
            f.distillation = parseRole("distillation");
            f.execution = parseRole("execution");
        }
        f.sessionCost = doubleVal(line, "cost", 0.0);
        f.hasData = true;
        model.setFooter(std::move(f));

        // Per-role context length (epistemic vs execution projections).
        // roleUsage is {epistemic: {tokens, contextWindow, percent}, execution: {...}};
        // tokens/percent are null when unknown. The GUI renders an em-dash when a
        // role's tokens are unavailable (negative placeholder).
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
            // The runtime emits no roleUsage when the belief loop is not usable
            // (e.g. after a reload, before new projections exist). Clear any
            // previously cached role context so the status bar does not keep
            // showing a stale context length.
            model.setRoleContext(RoleContextUsagePair{});
        }
        return RpcApplyResult::Applied;
    }

    if (type == "agent_start") {
        // A new turn begins: only block if there is an *open* frame. A frame
        // closed by the previous turn_end must not swallow the new turn's
        // records (it would overwrite the prior frame's plan/distillation,
        // collapsing multiple turns into one node in the Graph View).
        if (active && !active->closed) return RpcApplyResult::Ignored;
        model.openRpcFrame("");
        return RpcApplyResult::Applied;
    }
    if (type == "turn_start") {
        // Same rule as agent_start: ignore only while a frame is still open.
        const LoopFrame* act = model.activeFrame();
        if (act && !act->closed) return RpcApplyResult::Ignored;
        model.openRpcFrame("");
        return RpcApplyResult::Applied;
    }
    if (type == "message_start") {
        std::string role = str(line, "role");
        std::string text = extractMessageText(line);
        // Fast-path distillation custom message: sendCustomMessage emits
        // message_start/message_end with role="custom" and a customType
        // (e.g. "fast_path_distillation"); its content is the distillation
        // summary. Project it into the user prompt pane's incoming-message
        // area (the in-message stream) so it is visible there, rather than
        // fabricating a DistillationOutput (the fast path never emits a
        // DistillationProduced phase event).
        std::string customType = str(line, "customType");
        if (role == "custom" && customType == "fast_path_distillation") {
            // Fast-path distillation summary: surface it in the user prompt
            // pane's incoming-message area (the in-message stream) rather than
            // the distillation lane. The fast path never emits a
            // DistillationProduced phase event, so projecting here keeps the
            // content visible without fabricating a DistillationOutput.
            std::string distText;
            std::string rawContent;
            if (rawValue(line, "content", rawContent)) {
                std::string v = stringValue(rawContent);
                if (!v.empty()) distText = v;
            }
            if (distText.empty()) distText = text;
            model.beginInMessage(distText);
            return RpcApplyResult::Applied;
        }
        // Live in-message for the ⌘T pane is independent of any frame, but the
        // pane should show the assistant's reply, not the user's prompt or the
        // routing/fast-path scaffolding. Seed only on an assistant message; on a
        // user message clear the buffer so the previous reply does not linger.
        if (role == "assistant") {
            model.beginInMessage(text);
        } else if (role == "user") {
            model.beginInMessage("");
        }
        // Frame summary folding only applies when a frame is actually active.
        active = model.activeFrame();
        if (active && !active->closed && !text.empty()) {
            model.appendRpcFrameSummary(active->id, text);
        }
        return RpcApplyResult::Applied;
    }
    if (type == "message_update") {
        // Streaming assistant delta. toJsonEvent remaps message_update to
        // {type, usage, assistantMessageEvent}; append both text and thinking
        // deltas so the ⌘T pane's in-message stream updates incrementally for
        // visible content and reasoning alike. thinking_start flags the live
        // message as being in the thinking phase (the pane renders the
        // accumulated deltas, falling back to a "thinking" placeholder only
        // while the buffer is empty), and thinking_end / text_start clear it.
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
        // If the loop is in the terminal finalReport role, this message_end
        // finalizes the conclusion text. Request the render loop reopen the user
        // prompt pane so the user can view the answer, even if they closed it.
        if (model.finalReportPending()) model.requestAutoOpenPrompt();
        return RpcApplyResult::Applied;
    }
    if (type == "tool_execution_start") {
        active = model.activeFrame();
        if (!active || active->closed) return RpcApplyResult::Ignored;
        std::string args;
        rawValue(line, "args", args);
        std::string tool = str(line, "toolName");
        model.addRpcToolCall(active->id, str(line, "toolCallId"), tool, args);
        // Session file list: read/write/edit tool calls carry a path (or
        // file_path) in args; record it normalized relative to the session cwd.
        if (tool == "read" || tool == "write" || tool == "edit") {
            std::string p = str(args, "path");
            if (p.empty()) p = str(args, "file_path");
            model.recordFileOp(tool, p);
        }
        return RpcApplyResult::Applied;
    }
    if (type == "tool_execution_end") {
        active = model.activeFrame();
        if (!active || active->closed) return RpcApplyResult::Ignored;
        std::string result;
        rawValue(line, "result", result);
        std::string isErr;
        rawValue(line, "isError", isErr);
        model.setRpcToolResult(active->id, str(line, "toolCallId"), result, isErr == "true" ? "failed" : "ok");
        return RpcApplyResult::Applied;
    }
    // Belief-loop phase events (live mode). These carry the epistemic state the
    // demo/headless path produces via applyLine(): the selected belief ids, the
    // planner's plan, the distillation output, and the execution stage. Live mode
    // builds its frame via openRpcFrame (agent_start/turn_start) as a synthetic
    // placeholder; runtime frameId is a task id, so each phase event resolves to
    // the active logical LoopFrame for that task via model.rpcFrame(frameId).
    // Stage comes only from CursorChanged. DistillationProduced consumes its
    // documented label/interpretation and correlates the tool calls collected
    // since the explicit DISTILLING boundary for Graph View edges.
    auto phaseFrame = [&]() -> LoopFrame* {
        return model.rpcFrame(intVal(line, "frameId", model.cursor().frameId));
    };
    if (type == "BeliefsSelected") {
        LoopFrame* p = phaseFrame();
        if (!p) return RpcApplyResult::Ignored;
        std::string raw;
        if (!findKey(line, "beliefs", raw)) return RpcApplyResult::Ignored;
        p->selectedBeliefs = beliefsArray(raw);
        p->selectedBeliefBatches.push_back(p->selectedBeliefs);
        return RpcApplyResult::Applied;
    }
    if (type == "BeliefCreated") {
        // A new belief record from the runtime (declare_belief op propose/refine).
        // Register it so the Belief pane shows it immediately, before any later
        // support/refute/retract emits a BeliefUpdated for the same id. The event
        // carries statement/domain/expectation (no status); a new record is proposed.
        BeliefId id{intVal(line, "beliefId")};
        if (!id.valid()) return RpcApplyResult::Ignored;
        Belief& b = model.upsertBeliefRpc(id);
        b.status = str(line, "status", "proposed");
        b.domain = str(line, "domain", b.domain);
        b.statement = str(line, "statement", b.statement);
        const LoopFrame* current = model.activeFrame();
        if (current && b.createdInFrame < 0) b.createdInFrame = current->id;
        return RpcApplyResult::Applied;
    }
    if (type == "BeliefUpdated") {
        // Register (or update) a belief with its prose statement from the runtime's
        // belief model. The demo/headless path uses lhs/relation/rhs/confidence via
        // applyLine's BeliefUpdated branch; live mode carries the prose statement.
        BeliefId id{intVal(line, "beliefId")};
        if (!id.valid()) return RpcApplyResult::Ignored;
        Belief& b = model.upsertBeliefRpc(id);
        b.status = str(line, "status", b.status);
        b.statement = str(line, "statement", b.statement);
        const LoopFrame* current = model.activeFrame();
        if (current && current->stage == FrameStage::DISTILLING &&
            (b.sourceFrames.empty() || b.sourceFrames.back() != current->id)) {
            b.sourceFrames.push_back(current->id);
        }
        return RpcApplyResult::Applied;
    }
    if (type == "PlanProduced") {
        // Each LoopFrame carries at most one plan: a frame that already holds a
        // plan is closed and a fresh LoopFrame is opened for this new plan.
        LoopFrame* p = model.enterRpcPlanFrame(intVal(line, "frameId", model.cursor().frameId));
        if (!p) return RpcApplyResult::Ignored;
        PlannerOutput po;
        po.id = str(line, "planId");
        po.label = str(line, "label");
        po.question = str(line, "question");
        po.intent = str(line, "intent");
        if (!po.label.empty()) p->plans.push_back(po);
        p->plan = std::move(po);
        return RpcApplyResult::Applied;
    }
    if (type == "DistillationProduced") {
        // Consume the documented rpc.md fields (label, interpretation). The
        // runtime omits inputIds, so correlate the executions bracketed by the
        // explicit phase events; unexplained remains empty. Each LoopFrame carries
        // at most one distillation, so a frame that already holds one is closed
        // and a fresh LoopFrame is opened.
        LoopFrame* p = model.enterRpcDistillFrame(intVal(line, "frameId", model.cursor().frameId));
        if (!p) return RpcApplyResult::Ignored;
        DistillationOutput do_;
        do_.label = str(line, "label");
        do_.interpretation = str(line, "interpretation");
        // Live events omit inputIds. Attribute the execution calls not already
        // consumed by an earlier distillation in this LoopFrame.
        std::set<std::string> consumed;
        for (const DistillationOutput& prior : p->distillations) {
            consumed.insert(prior.inputIds.begin(), prior.inputIds.end());
        }
        for (const ToolCall& call : p->trajectory) {
            if (!call.id.empty() && !consumed.count(call.id)) do_.inputIds.push_back(call.id);
        }
        if (!do_.label.empty()) {
            for (std::size_t i = p->distillationProposalStart; i < p->proposals.size(); ++i) {
                if (p->proposals[i].distillationLabel.empty()) {
                    p->proposals[i].distillationLabel = do_.label;
                }
            }
            p->distillationProposalStart = p->proposals.size();
            // Bind beliefs created/updated during this distillation's DISTILLING
            // stage to this distillation occurrence. The distill mutation events
            // arrive before DistillationProduced and only carry a frame id.
            model.bindDistillationLabel(p->id, do_.label);
            p->distillations.push_back(do_);
        }
        p->distillation = std::move(do_);
        return RpcApplyResult::Applied;
    }
    if (type == "ProposalCreated") {
        LoopFrame* p = phaseFrame();
        if (!p) return RpcApplyResult::Ignored;
        Proposal prop;
        prop.op = charVal(line, "op", '?');
        prop.belief = str(line, "belief");
        prop.lhs = str(line, "lhs");
        prop.relation = str(line, "relation");
        prop.rhs = str(line, "rhs");
        prop.detail = str(line, "detail");
        if (p->stage == FrameStage::DISTILLING && p->distillation.valid()) {
            prop.distillationLabel = p->distillation.label;
        }
        p->proposals.push_back(std::move(prop));
        return RpcApplyResult::Applied;
    }
    if (type == "CursorChanged") {
        // Resolve the runtime task to its active logical LoopFrame, then drive
        // stage/item from this single event. Stage is never
        // inferred from Execution* / Distillation* events (those are not emitted
        // by the runtime).
        const FrameStage st = parseStage(str(line, "stage"));
        const int runtimeTaskId = intVal(line, "frameId", model.cursor().frameId);
        LoopFrame* p = st == FrameStage::PROPOSING
            ? model.enterRpcProposeFrame(runtimeTaskId)
            : model.rpcFrame(runtimeTaskId);
        model.mutableCursor().stage = st;
        model.mutableCursor().item = str(line, "item");
        if (p && st != FrameStage::NONE) {
            p->stage = st;
            if (st == FrameStage::DISTILLING) {
                p->distillationProposalStart = p->proposals.size();
            } else if (st == FrameStage::CLOSED) {
                model.closeRpcFrame(p->id, false);
            }
        }
        // The belief loop enters the terminal finalReport role by emitting a
        // CursorChanged with stage CLOSED. Mark the model so the next message_end
        // (the final conclusion text) can request the auto-reopen of the pane.
        if (st == FrameStage::CLOSED) model.markFinalReportPending();
        return RpcApplyResult::Applied;
    }
    if (type == "turn_end" || type == "agent_settled") {
        active = model.activeFrame();
        if (!active) return RpcApplyResult::Ignored;
        // A belief-loop LoopFrame spans several model turns. Its boundary is an
        // explicit entry into PROPOSING (or CLOSED), not turn_end. Preserve the
        // legacy fallback for plain RPC streams that never supplied a task id.
        if (active->runtimeTaskId < 0) model.closeRpcFrame(active->id, false);
        return RpcApplyResult::Applied;
    }
    return RpcApplyResult::Ignored;
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
    nextRpcFrameId_ = 1000;
    roleContext_ = RoleContextUsagePair{};
    clearFileList();
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
    if (it == beliefById_.end()) return nullptr;
    return &beliefs_[it->second];
}

Belief& NativeGuiModel::upsertBelief(BeliefId id) {
    auto it = beliefById_.find(id.value);
    if (it != beliefById_.end()) return beliefs_[it->second];
    Belief b;
    b.id = id;
    const int idx = static_cast<int>(beliefs_.size());
    beliefs_.push_back(std::move(b));
    beliefById_[id.value] = idx;
    return beliefs_[idx];
}

void NativeGuiModel::bindDistillationLabel(int frameId, const std::string& label) {
    if (label.empty()) return;
    // Bind the distillation occurrence to beliefs created/updated within frameId
    // that have not yet been attributed to a distillation. The distill mutation
    // events (BeliefCreated/BeliefUpdated) arrive before DistillationProduced and
    // only carry a frame id, so we match on provenance here.
    for (Belief& belief : beliefs_) {
        if (!belief.distillationLabel.empty()) continue;
        const bool touchesFrame = belief.createdInFrame == frameId ||
            (!belief.sourceFrames.empty() && belief.sourceFrames.back() == frameId);
        if (touchesFrame) belief.distillationLabel = label;
    }
}

bool NativeGuiModel::isSelectedInCurrentFrame(BeliefId b) const {
    const LoopFrame* f = activeFrame();
    if (!f) return false;
    for (auto s : f->selectedBeliefs) if (s.value == b.value) return true;
    return false;
}

// --- RPC event adapter support -------------------------------------------------

int NativeGuiModel::openRpcFrame(const std::string& summary) {
    int id = nextRpcFrameId_++;
    openFrame(id, summary, "rpc");
    return id;
}

LoopFrame* NativeGuiModel::rpcFrame(int runtimeFrameId) {
    if (runtimeFrameId < 0) return frame(cursor_.frameId);
    // Prefer the active LoopFrame for this runtime task. A task may have several
    // historical LoopFrames, so looking up frames_[runtimeFrameId] first would
    // incorrectly route later cycles back into the first one.
    const int cur = cursor_.frameId;
    if (cur >= 0 && frames_.count(cur)) {
        LoopFrame* current = frame(cur);
        if (!current->closed &&
            (current->runtimeTaskId < 0 || current->runtimeTaskId == runtimeFrameId)) {
            current->runtimeTaskId = runtimeFrameId;
            // Preserve the first loop's historical lookup by runtime task id
            // when the current record is only the synthetic placeholder.
            if (cur != runtimeFrameId && !frames_.count(runtimeFrameId)) {
                LoopFrame f = std::move(frames_[cur]);
                f.id = runtimeFrameId;
                frames_.erase(cur);
                for (int& id : frameOrder_) {
                    if (id == cur) { id = runtimeFrameId; break; }
                }
                for (Belief& belief : beliefs_) {
                    if (belief.createdInFrame == cur) belief.createdInFrame = runtimeFrameId;
                    for (int& sourceFrame : belief.sourceFrames) {
                        if (sourceFrame == cur) sourceFrame = runtimeFrameId;
                    }
                }
                frames_[runtimeFrameId] = std::move(f);
                cursor_.frameId = runtimeFrameId;
                return frame(runtimeFrameId);
            }
            return current;
        }
    }

    // No active frame for this task. Use the runtime id when available, else a
    // synthetic id because an earlier LoopFrame from the same task owns it.
    const int id = frames_.count(runtimeFrameId) ? nextRpcFrameId_++ : runtimeFrameId;
    openFrame(id, "", "rpc");
    LoopFrame* opened = frame(id);
    opened->runtimeTaskId = runtimeFrameId;
    return opened;
}

LoopFrame* NativeGuiModel::enterRpcProposeFrame(int runtimeTaskId) {
    LoopFrame* current = rpcFrame(runtimeTaskId);
    if (!current) return nullptr;

    // Repeated PROPOSING notifications do not split a frame. A transition back
    // into propose after any concrete cycle content does.
    if (!current->closed && current->stage != FrameStage::PROPOSING &&
        hasLoopCycleContent(*current)) {
        closeRpcFrame(current->id, false);
        const int id = nextRpcFrameId_++;
        openFrame(id, "", "rpc");
        current = frame(id);
        current->runtimeTaskId = runtimeTaskId;
    }
    current->stage = FrameStage::PROPOSING;
    cursor_.frameId = current->id;
    cursor_.stage = FrameStage::PROPOSING;
    cursor_.item.clear();
    return current;
}

LoopFrame* NativeGuiModel::enterRpcPlanFrame(int runtimeTaskId) {
    LoopFrame* current = rpcFrame(runtimeTaskId);
    if (!current) return nullptr;
    // A frame that already holds a plan is a complete cycle: close it and open a
    // fresh LoopFrame so each LoopFrame carries at most one plan.
    if (!current->closed && (current->plan.valid() || !current->plans.empty())) {
        closeRpcFrame(current->id, false);
        const int id = nextRpcFrameId_++;
        openFrame(id, "", "rpc");
        current = frame(id);
        current->runtimeTaskId = runtimeTaskId;
    }
    return current;
}

LoopFrame* NativeGuiModel::enterRpcDistillFrame(int runtimeTaskId) {
    LoopFrame* current = rpcFrame(runtimeTaskId);
    if (!current) return nullptr;
    // A frame that already holds a distillation is a complete cycle: close it and
    // open a fresh LoopFrame so each LoopFrame carries at most one distillation.
    if (!current->closed && (current->distillation.valid() || !current->distillations.empty())) {
        closeRpcFrame(current->id, false);
        const int id = nextRpcFrameId_++;
        openFrame(id, "", "rpc");
        current = frame(id);
        current->runtimeTaskId = runtimeTaskId;
    }
    return current;
}

void NativeGuiModel::appendRpcFrameSummary(int id, const std::string& text) {
    if (text.empty()) return;
    LoopFrame* f = frame(id);
    if (!f || f->closed) return;
    if (!f->summary.empty()) f->summary += " ";
    f->summary += text;
}

void NativeGuiModel::addRpcToolCall(int id, const std::string& toolCallId, const std::string& tool, const std::string& command) {
    LoopFrame* f = frame(id);
    if (!f || f->closed) return;
    ToolCall t;
    t.id = toolCallId;
    t.tool = tool;
    t.command = command;
    t.status = "running";
    if (!f->plans.empty()) {
        const PlannerOutput& plan = f->plans.back();
        t.planId = !plan.id.empty() ? plan.id : plan.label;
    } else if (f->plan.valid()) {
        t.planId = !f->plan.id.empty() ? f->plan.id : f->plan.label;
    }
    f->trajectory.push_back(std::move(t));
}

void NativeGuiModel::setRpcToolResult(int id, const std::string& toolCallId, const std::string& result, const std::string& status) {
    LoopFrame* f = frame(id);
    if (!f || f->closed) return;
    for (auto& t : f->trajectory) {
        if (t.id == toolCallId) {
            t.result = result;
            t.status = status;
            break;
        }
    }
}

void NativeGuiModel::closeRpcFrame(int id, bool failed) {
    LoopFrame* f = frame(id);
    if (!f) return;
    f->closed = true;
    if (failed) f->failed = true;
    f->stage = FrameStage::CLOSED;
    f->history = LoopFrame::History::Closed;
    // Keep the cursor pointing at the just-closed frame so the execution lane
    // and summary continue to render its trajectory after the turn ends. The
    // demo/headless path clears the cursor explicitly via its own FrameClosed
    // event, so this retention only affects the live RPC viewer.
}

// ---------------------------------------------------------------------------
// Live in-message stream (⌘T pane)
// ---------------------------------------------------------------------------
void NativeGuiModel::beginInMessage(const std::string& text) {
    // message_start carries the initial authoritative text (may be empty if the
    // turn streams through message_update deltas); seeding here reflects the
    // contentText semantics for the initial content blocks only.
    inMessage_ = text;
}

void NativeGuiModel::appendInMessage(const std::string& delta) {
    inMessage_ += delta;
}

void NativeGuiModel::endInMessage() {
    // Finalize. The buffer already holds the accumulated text; nothing more to
    // do but keep it available for the pane until the next message_start.
}

void NativeGuiModel::setInMessageThinking(bool thinking) {
    inMessageThinking_ = thinking;
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
        f->selectedBeliefBatches.push_back(f->selectedBeliefs);
        return;
    }
    if (type == "PlanProduced") {
        LoopFrame* f = frame(intVal(line, "frameId", cursor_.frameId));
        if (!f) return;
        PlannerOutput plan;
        plan.id = str(line, "planId");
        plan.label = str(line, "label");
        plan.question = str(line, "question");
        plan.intent = str(line, "intent");
        if (plan.valid()) f->plans.push_back(plan);
        f->plan = std::move(plan);
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
        if (!f->plans.empty()) {
            const PlannerOutput& plan = f->plans.back();
            t.planId = !plan.id.empty() ? plan.id : plan.label;
        }
        // Session file list: demo read/write/edit tool calls carry the path in
        // the `command` field; record it normalized relative to the session cwd.
        // Record BEFORE the move: std::move leaves t.tool/t.command moved-from.
        if (t.tool == "read" || t.tool == "write" || t.tool == "edit") {
            recordFileOp(t.tool, t.command);
        }
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
        DistillationOutput distillation;
        distillation.label = str(line, "label");
        distillation.inputIds = [&] {
            std::string raw;
            return findKey(line, "inputIds", raw) ? strArray(raw) : std::vector<std::string>{};
        }();
        distillation.unexplained = str(line, "unexplained");
        distillation.interpretation = str(line, "interpretation");
        if (distillation.valid()) f->distillations.push_back(distillation);
        f->distillation = std::move(distillation);
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
        if (f->distillation.valid()) p.distillationLabel = f->distillation.label;
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
        if (src > 0 && b.createdInFrame < 0) {
            const LoopFrame* source = frame(src);
            const std::string beliefLabel = "B" + std::to_string(id.value);
            if (source) {
                for (const Proposal& proposal : source->proposals) {
                    if (proposal.op == '+' && proposal.belief == beliefLabel) {
                        b.createdInFrame = src;
                        break;
                    }
                }
            }
        }
        return;
    }
    // Unknown event: ignored, model state unchanged.
}

} // namespace pie::gui
