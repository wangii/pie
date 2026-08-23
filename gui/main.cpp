// Native C++20/ImGui GUI that drives the pie SDK in RPC mode.
//
// On startup it spawns:
//     node <repo>/packages/pie/dist/cli.js -ne --mode rpc
// sends the prompt "hello, how are you today?", and continuously reads JSON
// lines from stdout. Non-"response" AgentSessionEvents are funneled onto a
// thread-safe queue and drained on the ImGui main thread each frame.
//
// "Displaying incoming agent messages" = incremental rebuild: assistant
// content slots are text/thinking/toolCall, each with a contentIndex and a
// *_start/*_delta/*_end lifecycle. *_end carries the authoritative content for
// that slot; deltas are for streaming display only. message_end is the
// authoritative message snapshot; its `content` may be a string or an array,
// so it is type-checked.

#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>
#include <GLFW/glfw3.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>

// POSIX pipe + fork/exec for spawning the SDK child process.
#include <unistd.h>
#include <fcntl.h>

#ifndef PI_CLI
#error "PI_CLI must be defined (absolute path to packages/pie/dist/cli.js)"
#endif

namespace {

// ---------------------------------------------------------------------------
// Minimal JSON value model (parse/substring helpers) - avoids a third-party dep.
// We only need to inspect a handful of known fields of the wire events.
// ---------------------------------------------------------------------------
struct Json {
    // Extremely small JSON subtree for the fields we read. We implement just
    // enough to walk the event shape without a full parser.
    static std::string substr(const std::string& s, size_t a, size_t b) {
        return s.substr(a, b - a);
    }

    // Find the value of the first occurrence of "key": inside s.
    // Returns the raw substring starting after the colon, with the value's
    // surrounding quotes stripped for strings. Caller inspects with helpers.
    static bool find(const std::string& s, const std::string& key, std::string& out) {
        const std::string pat = "\"" + key + "\"";
        size_t p = s.find(pat);
        if (p == std::string::npos) return false;
        size_t colon = s.find(':', p + pat.size());
        if (colon == std::string::npos) return false;
        size_t i = colon + 1;
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
        if (i >= s.size()) return false;
        out = s.substr(i);
        return true;
    }

    static bool isString(const std::string& v) { return v.size() >= 2 && v[0] == '"'; }
    static bool isArray(const std::string& v) { return v.size() >= 1 && v[0] == '['; }
    static bool isObject(const std::string& v) { return v.size() >= 1 && v[0] == '{'; }

    // Extract a quoted string value's payload (unquoted). Assumes v begins with '"'.
    static std::string stringValue(const std::string& v) {
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

    // Split an array value "[a,b,c]" into top-level element substrings,
    // respecting nesting of strings/objects/arrays with balanced brackets.
    static std::vector<std::string> arrayElements(const std::string& v) {
        std::vector<std::string> out;
        if (!isArray(v)) return out;
        size_t depth = 0;
        bool inStr = false;
        size_t start = 1; // skip '['
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
            else if (c == ',' && depth == 0) { out.push_back(v.substr(start, i - start)); start = i + 1; }
        }
        out.push_back(v.substr(start, v.size() - 1 - start));
        return out;
    }
};

// ---------------------------------------------------------------------------
// Thread-safe queue of streamed event lines, drained on the ImGui main thread.
// ---------------------------------------------------------------------------
struct Event {
    std::string line;   // raw JSON line
};

class EventQueue {
public:
    void push(std::string line) {
        std::lock_guard<std::mutex> lk(m_);
        q_.push_back(std::move(line));
    }
    bool popIfAny(std::string& out) {
        std::lock_guard<std::mutex> lk(m_);
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop_front();
        return true;
    }
    void clear() {
        std::lock_guard<std::mutex> lk(m_);
        q_.clear();
    }
private:
    std::mutex m_;
    std::deque<std::string> q_;
};

// ---------------------------------------------------------------------------
// The SDK child process: spawned via fork/exec with two pipes.
// ---------------------------------------------------------------------------
struct SdkProcess {
    pid_t pid = -1;
    int inFd = -1;   // child stdin (we write commands here)
    int outFd = -1;  // child stdout (we read JSON lines here)
    std::atomic<bool> running{false};
};

bool spawnSdk(SdkProcess& sp) {
    int inPipe[2], outPipe[2];
    if (pipe(inPipe) != 0) return false;
    if (pipe(outPipe) != 0) { close(inPipe[0]); close(inPipe[1]); return false; }

    pid_t pid = fork();
    if (pid < 0) return false;

    if (pid == 0) {
        // Child: wire pipes to stdin/stdout, exec node cli.js -ne --mode rpc.
        dup2(inPipe[0], STDIN_FILENO);
        dup2(outPipe[1], STDOUT_FILENO);
        close(inPipe[0]); close(inPipe[1]);
        close(outPipe[0]); close(outPipe[1]);

        // Let stderr go to the parent's stderr for diagnostics.
        const char* argv[] = {"node", PI_CLI, "-ne", "--mode", "rpc", nullptr};
        execvp("node", const_cast<char**>(argv));
        _exit(127);
    }

    // Parent.
    close(inPipe[0]);
    close(outPipe[1]);
    sp.pid = pid;
    sp.inFd = inPipe[1];
    sp.outFd = outPipe[0];
    sp.running.store(true);
    return true;
}

void writeCommand(SdkProcess& sp, const std::string& cmd) {
    if (sp.inFd < 0) return;
    std::string line = cmd + "\n";
    (void)!write(sp.inFd, line.data(), line.size());
}

// Background reader thread: reads bytes, splits on '\n' (LF only), and pushes
// non-empty lines onto the queue. The immediate RPC "response" acknowledgment
// lines are also on stdout; the GUI chooses to render only AgentSessionEvent
// lines (type != "response"), but all lines are queued as raw text.
void readerThread(SdkProcess& sp, EventQueue& q, std::atomic<bool>& stop) {
    std::string buf;
    char chunk[4096];
    while (!stop.load()) {
        ssize_t n = read(sp.outFd, chunk, sizeof(chunk));
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (n == 0) break; // EOF
        buf.append(chunk, static_cast<size_t>(n));
        size_t pos;
        while ((pos = buf.find('\n')) != std::string::npos) {
            std::string line = buf.substr(0, pos);
            buf.erase(0, pos + 1);
            if (!line.empty()) q.push(std::move(line));
        }
    }
    sp.running.store(false);
}

// ---------------------------------------------------------------------------
// Render a single queued event into the ImGui window. This is where we
// interpret the wire shape: only AgentSessionEvent lines (type != "response")
// are rendered as incoming messages.
// ---------------------------------------------------------------------------
// Render a single queued AgentSessionEvent JSON line. Every non-response event
// gets a non-empty representation:
//   message_update's assistantMessageEvent:
//     *_start  -> "type@contentIndex" (no payload yet)
//     *_delta  -> "type@contentIndex: delta"
//     *_end    -> authoritative content (text/thinking/toolCall)
//   message_start/message_end -> role + content snapshot
//   anything else -> structured title + raw JSON fallback
// RPC `response` acks are intentionally excluded (not an agent message).
void renderEventLine(const std::string& line, int index) {
    std::string type;
    std::string t;
    if (Json::find(line, "type", type) && Json::isString(type)) {
        t = Json::stringValue(type);
        if (t == "response") return; // command ack - not an incoming message
    }
    if (t.empty()) t = "event";

    ImGui::PushID(index);

    // Determine role, if any (message_start / message_end).
    std::string role;
    if (Json::find(line, "role", role) && Json::isString(role)) {
        role = Json::stringValue(role);
    }

    // Pretty prefix: type + role.
    std::string head = "[event] " + t;
    if (!role.empty()) head += " (" + role + ")";
    ImGui::Text("%s", head.c_str());

    // Track whether we rendered any substantive payload below, to decide on the
    // raw-JSON fallback for unknown/empty events.
    bool renderedPayload = false;

    // For message_start/message_end, show the authoritative content snapshot.
    std::string content;
    if (Json::find(line, "content", content) && (Json::isString(content) || Json::isArray(content))) {
        if (Json::isString(content)) {
            std::string s = Json::stringValue(content);
            if (!s.empty()) {
                ImGui::SameLine();
                ImGui::TextWrapped("%s", s.c_str());
                renderedPayload = true;
            }
        } else if (Json::isArray(content)) {
            auto els = Json::arrayElements(content);
            for (size_t i = 0; i < els.size(); ++i) {
                std::string etype, txt;
                if (Json::find(els[i], "type", etype) && Json::isString(etype)) {
                    etype = Json::stringValue(etype);
                }
                if (Json::find(els[i], "text", txt) && Json::isString(txt)) {
                    txt = Json::stringValue(txt);
                } else if (Json::find(els[i], "thinking", txt) && Json::isString(txt)) {
                    txt = Json::stringValue(txt);
                }
                if (!etype.empty() && !txt.empty()) {
                    ImGui::TextWrapped("  (%s) %s", etype.c_str(), txt.c_str());
                    renderedPayload = true;
                }
            }
        }
    }

    // For message_update, the payload lives in assistantMessageEvent with a
    // *_start / *_delta / *_end lifecycle. Handle all three uniformly.
    if (t == "message_update") {
        std::string ame;
        if (Json::find(line, "assistantMessageEvent", ame)) {
            std::string amt;
            if (Json::find(ame, "type", amt) && Json::isString(amt)) {
                amt = Json::stringValue(amt);
            }
            std::string idx;
            if (Json::find(ame, "contentIndex", idx)) {
                idx = Json::stringValue(idx); // numeric string stays as-is
            }
            std::string label = amt;
            if (!idx.empty()) label += "@" + idx;

            // Prefer `delta` (streaming), else authoritative content fields.
            std::string delta;
            if (Json::find(ame, "delta", delta) && Json::isString(delta)) {
                delta = Json::stringValue(delta);
            }
            if (!delta.empty()) {
                ImGui::TextWrapped("  [%s] %s", label.c_str(), delta.c_str());
                renderedPayload = true;
            } else {
                // *_end events carry authoritative content under `content`,
                // `thinking`, or `toolCall` (an object with `arguments`).
                std::string endVal;
                if (Json::find(ame, "content", endVal) && Json::isString(endVal)) {
                    endVal = Json::stringValue(endVal);
                } else if (Json::find(ame, "thinking", endVal) && Json::isString(endVal)) {
                    endVal = Json::stringValue(endVal);
                } else if (Json::find(ame, "toolCall", endVal)) {
                    endVal = Json::stringValue(endVal);
                }
                if (!endVal.empty()) {
                    ImGui::TextWrapped("  [%s] %s", label.c_str(), endVal.c_str());
                    renderedPayload = true;
                } else {
                    // *_start has only contentIndex: show the bare slot marker.
                    if (!label.empty() && label.find('@') != std::string::npos) {
                        ImGui::TextWrapped("  [%s] (streaming start)", label.c_str());
                        renderedPayload = true;
                    }
                }
            }
        }
    }

    // Raw JSON fallback for any event we did not structurally summarize.
    // This guarantees every non-response event is visibly present.
    if (!renderedPayload) {
        ImGui::TextWrapped("  raw: %s", line.c_str());
    }

    ImGui::PopID();
}

} // namespace

int main(int, char**) {
    glfwSetErrorCallback([](int error, const char* desc) {
        std::fprintf(stderr, "GLFW error %d: %s\n", error, desc);
    });
    if (!glfwInit()) return 1;

#if defined(__APPLE__)
    const char* glslVersion = "#version 150";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 2);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
#else
    const char* glslVersion = "#version 130";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);
#endif

    GLFWwindow* window = glfwCreateWindow(1440, 900, "pi GUI", nullptr, nullptr);
    if (!window) { glfwTerminate(); return 1; }
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::GetIO().ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    ImGui::StyleColorsDark();
    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init(glslVersion);

    // Spawn the SDK and begin listening.
    SdkProcess sdk;
    if (!spawnSdk(sdk)) {
        std::fprintf(stderr, "Failed to spawn SDK child\n");
        ImGui_ImplOpenGL3_Shutdown();
        ImGui_ImplGlfw_Shutdown();
        ImGui::DestroyContext();
        glfwDestroyWindow(window);
        glfwTerminate();
        return 1;
    }

    EventQueue queue;
    std::atomic<bool> stopReader{false};
    std::thread reader(readerThread, std::ref(sdk), std::ref(queue), std::ref(stopReader));

    // Send the example prompt.
    writeCommand(sdk, "{\"type\":\"prompt\",\"id\":\"p1\",\"message\":\"hello, how are you today?\"}");

    // Persistent history: every swallowed (non-response) event line is appended
    // here and re-rendered each frame, so the display accumulates ALL incoming
    // messages rather than only the ones that arrived on a given frame.
    std::vector<std::string> eventHistory;
    int displayCount = 0;

    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        ImGui::Begin("Incoming Agent Messages");
        ImGui::Text("SDK spawned as PID %ld; historical event lines: %d", (long)sdk.pid, displayCount);
        ImGui::Separator();

        // Drain the background queue on the main thread (single consumer) and
        // store every non-response line into the persistent history.
        std::string line;
        while (queue.popIfAny(line)) {
            eventHistory.push_back(std::move(line));
            ++displayCount;
        }

        // Render the full accumulated history inside a scrollable child region,
        // auto-scrolling to the newest entry when new events arrive.
        ImGui::BeginChild("messages_scroll", ImVec2(0, 0), true);
        for (int i = 0; i < (int)eventHistory.size(); ++i) {
            renderEventLine(eventHistory[i], i);
        }
        ImGui::EndChild();

        ImGui::End();

        ImGui::Render();
        int displayWidth = 0, displayHeight = 0;
        glfwGetFramebufferSize(window, &displayWidth, &displayHeight);
        glViewport(0, 0, displayWidth, displayHeight);
        glClearColor(0.055f, 0.065f, 0.08f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        glfwSwapBuffers(window);
    }

    // Shutdown: stop the reader, close pipes, kill child, release ImGui/GLFW.
    stopReader.store(true);
    if (sdk.inFd >= 0) close(sdk.inFd);
    if (sdk.outFd >= 0) close(sdk.outFd);
    if (sdk.pid > 0) { kill(sdk.pid, SIGTERM); waitpid(sdk.pid, nullptr, 0); }
    if (reader.joinable()) reader.join();

    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
}
