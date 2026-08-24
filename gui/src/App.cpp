// PIE Native GUI - cognitive feedback loop workbench (P0).
//
// Layout: global status bar / frame navigator / user instruction entrance,
// three lanes (BELIEF SET | COGNITIVE PROCESS | EXECUTION), and a bottom
// current-frame summary. Frame # + stage + current item come ONLY from the
// NativeGuiModel cursor, which is set solely by explicit runtime events.
//
// Modes:
//   default   --live: spawns `node <PI_CLI> -ne --mode rpc` and applies its JSONL.
//   --demo    injects the formal DemoEvents.h scripted event stream.
//   --live    explicit; wins if both --demo and --live are supplied.
// GL_SILENCE_DEPRECATION is supplied as an APPLE compile definition in CMake.

#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>
#include <GLFW/glfw3.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>

#include "Model.h"
#include "DemoEvents.h"
#include "InstructionCmd.h"
#include "LayoutMetrics.h"

#ifndef PI_CLI
#error "PI_CLI must be defined (absolute path to packages/pie/dist/cli.js)"
#endif

namespace {

// ---------------------------------------------------------------------------
// Locate the directory containing the running pie_gui executable, so the app can
// load assets that are copied next to the binary regardless of the current
// working directory. Uses the platform-native path API (not cwd).
// ---------------------------------------------------------------------------
std::string executableDirectory() {
    std::error_code ec;
#if defined(_WIN32)
    std::vector<wchar_t> buf(32768);
    DWORD n = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    if (n == 0 || n >= buf.size()) return {};
    std::filesystem::path p(buf.data());
    return std::filesystem::absolute(p).parent_path().string();
#elif defined(__APPLE__)
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buf(size);
    if (_NSGetExecutablePath(buf.data(), &size) != 0) return {};
    std::filesystem::path p = std::filesystem::canonical(buf.data(), ec);
    return (ec ? std::filesystem::path(buf.data()) : p).parent_path().string();
#else
    // Linux/other: /proc/self/exe.
    std::filesystem::path p = std::filesystem::canonical("/proc/self/exe", ec);
    if (ec) return {};
    return p.parent_path().string();
#endif
}

std::string fontPath() {
    return (std::filesystem::path(executableDirectory()) / "SarasaTermSCNerd.ttc").string();
}

// ---------------------------------------------------------------------------
// Colors / small helpers
// ---------------------------------------------------------------------------
const ImVec4 kAccent(0.36f, 0.63f, 0.98f, 1.0f);
const ImVec4 kGreen(0.45f, 0.79f, 0.47f, 1.0f);
const ImVec4 kAmber(0.95f, 0.77f, 0.38f, 1.0f);
const ImVec4 kRed(0.86f, 0.38f, 0.35f, 1.0f);
const ImVec4 kGray(0.62f, 0.62f, 0.62f, 1.0f);

const char* historySymbol(pie::gui::LoopFrame::History h) {
    switch (h) {
        case pie::gui::LoopFrame::History::Closed: return "✓";
        case pie::gui::LoopFrame::History::Unresolved: return "!";
        case pie::gui::LoopFrame::History::Falsified: return "✗";
        case pie::gui::LoopFrame::History::NewBelief: return "+";
        case pie::gui::LoopFrame::History::Revised: return "~";
        case pie::gui::LoopFrame::History::Current: return "●";
    }
    return "";
}

int beliefIdFromLabel(const std::string& label) {
    if (label.empty() || label[0] != 'B') return -1;
    int id = 0;
    for (size_t i = 1; i < label.size(); ++i) {
        if (label[i] < '0' || label[i] > '9') break;
        id = id * 10 + (label[i] - '0');
    }
    return id;
}

std::string beliefLabel(int id) { return "B" + std::to_string(id); }

// ---------------------------------------------------------------------------
// SDK child process (used in --live mode). Same transport as the previous
// build: fork/exec node, JSONL on stdout, commands on stdin.
// ---------------------------------------------------------------------------
struct SdkProcess {
    pid_t pid = -1;
    int inFd = -1;
    int outFd = -1;
    std::atomic<bool> running{false};
};

bool spawnSdk(SdkProcess& sp) {
    int inPipe[2], outPipe[2];
    if (pipe(inPipe) != 0) return false;
    if (pipe(outPipe) != 0) { close(inPipe[0]); close(inPipe[1]); return false; }
    pid_t pid = fork();
    if (pid < 0) return false;
    if (pid == 0) {
        dup2(inPipe[0], STDIN_FILENO);
        dup2(outPipe[1], STDOUT_FILENO);
        close(inPipe[0]); close(inPipe[1]);
        close(outPipe[0]); close(outPipe[1]);
        const char* argv[] = {"node", PI_CLI, "-ne", "--mode", "rpc", nullptr};
        execvp("node", const_cast<char**>(argv));
        _exit(127);
    }
    close(inPipe[0]); close(outPipe[1]);
    sp.pid = pid;
    sp.inFd = inPipe[1];
    sp.outFd = outPipe[0];
    sp.running.store(true);
    return true;
}

void writeCommand(SdkProcess& sp, const std::string& cmd) {
    if (sp.inFd < 0) return;
    std::string line = cmd + "\n";
    ssize_t written = write(sp.inFd, line.data(), line.size());
    // Trace GUI -> RPC on pie_gui's stdout (never on sp.inFd, so the RPC JSONL
    // protocol on stdin is left untouched).
    if (written > 0) {
        std::printf("GUI -> RPC: %s\n", cmd.c_str());
        std::fflush(stdout);
    } else {
        std::printf("GUI -> RPC FAILED: %s\n", cmd.c_str());
        std::fflush(stdout);
    }
}

// serializeInstructionCommand lives in InstructionCmd.h (inline) so it can be
// unit-tested without a node subprocess.

class EventQueue {
public:
    void push(std::string line) { std::lock_guard<std::mutex> lk(m_); q_.push_back(std::move(line)); }
    bool popIfAny(std::string& out) {
        std::lock_guard<std::mutex> lk(m_);
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop_front();
        return true;
    }
private:
    std::mutex m_;
    std::deque<std::string> q_;
};

void readerThread(SdkProcess& sp, EventQueue& q, std::atomic<bool>& stop) {
    std::string buf;
    char chunk[4096];
    while (!stop.load()) {
        ssize_t n = read(sp.outFd, chunk, sizeof(chunk));
        if (n < 0) { if (errno == EINTR) continue; break; }
        if (n == 0) break;
        buf.append(chunk, static_cast<size_t>(n));
        size_t pos;
        while ((pos = buf.find('\n')) != std::string::npos) {
            std::string line = buf.substr(0, pos);
            buf.erase(0, pos + 1);
            if (!line.empty()) {
                // Trace RPC -> GUI on pie_gui's stdout.
                std::printf("RPC -> GUI: %s\n", line.c_str());
                std::fflush(stdout);
                q.push(std::move(line));
            }
        }
    }
    sp.running.store(false);
}

// ---------------------------------------------------------------------------
// Lane rendering
// ---------------------------------------------------------------------------
const pie::gui::LoopFrame* displayedFrame(const pie::gui::NativeGuiModel& m, int viewId) {
    if (viewId >= 0) return m.frameById(viewId);
    return m.activeFrame();
}

void renderStatusBar(const pie::gui::NativeGuiModel& m) {
    const auto& c = m.cursor();
    ImGui::TextUnformatted("PIE");
    ImGui::SameLine();
    ImGui::TextUnformatted(("Session: " + m.session()).c_str());
    ImGui::SameLine();
    ImGui::Separator();

    if (c.valid()) {
        ImGui::TextUnformatted(("Frame #" + std::to_string(c.frameId)).c_str());
        ImGui::SameLine();
        ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
        ImGui::TextUnformatted(pie::gui::frameStageToString(c.stage));
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::Separator();

        if (const auto* f = m.frameById(c.frameId); f && !f->selectedBeliefs.empty()) {
            std::string sel = "Selected: ";
            for (size_t i = 0; i < f->selectedBeliefs.size(); ++i) {
                if (i) sel += ", ";
                sel += beliefLabel(f->selectedBeliefs[i].value);
            }
            ImGui::TextUnformatted(sel.c_str());
            ImGui::SameLine();
            ImGui::Separator();
        }
        // The runtime never provides CursorChanged.item (rpc.md and the runtime
        // emit only frameId+stage), so derive the "current" tool from the active
        // frame's in-flight trajectory instead of a static, never-populated field.
        if (c.stage == pie::gui::FrameStage::EXECUTING) {
            if (const auto* f = m.frameById(c.frameId)) {
                for (const auto& t : f->trajectory) {
                    if (t.status == "running") {
                        ImGui::TextUnformatted(("Current: " + t.id).c_str());
                        break;
                    }
                }
            }
        }
    } else {
        ImGui::TextUnformatted("(no active frame)");
    }

    ImGui::SameLine();
    float avail = ImGui::GetContentRegionAvail().x;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + std::max(0.0f, avail - 120.0f));
    ImGui::PushStyleColor(ImGuiCol_Text, kGray);
    ImGui::TextUnformatted("⌘T  User Instruction");
    ImGui::PopStyleColor();
}

void renderNavigator(const pie::gui::NativeGuiModel& m, int& viewId) {
    static char searchBuf[64] = {};
    const auto& frames = m.frames();
    ImGui::AlignTextToFramePadding();
    ImGui::TextUnformatted("Frame Navigator:");
    ImGui::SameLine();
    ImGui::SetNextItemWidth(140.0f);
    ImGui::InputText("##frame_search", searchBuf, sizeof(searchBuf));
    for (const auto& f : frames) {
        if (!pie::gui::frameMatchesQuery(f, searchBuf)) continue;
        bool isView = (viewId == f.id);
        ImGui::PushID(f.id);
        ImGui::PushStyleColor(ImGuiCol_Text, historySymbol(f.history) == std::string("●") ? kAccent : ImGui::GetStyleColorVec4(ImGuiCol_Text));
        if (ImGui::Selectable((std::string("#") + std::to_string(f.id)).c_str(), isView, 0, ImVec2(0, 0))) {
            viewId = f.id;
        }
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::PopID();
    }
    if (viewId >= 0) {
        ImGui::SameLine();
        if (ImGui::SmallButton("back to current")) viewId = -1;
    }
}

void renderBeliefLane(const pie::gui::NativeGuiModel& m, int viewId) {
    const auto* f = displayedFrame(m, viewId);

    std::vector<int> changedIds;
    if (f) {
        for (auto& p : f->proposals) {
            int id = beliefIdFromLabel(p.belief);
            if (id > 0) changedIds.push_back(id);
        }
    }

    ImGui::TextUnformatted("BELIEF SET");
    ImGui::Separator();
    ImGui::BeginChild("belief_scroll", ImVec2(0, 0), false);

    const auto& beliefs = m.beliefs();
    for (const auto& b : beliefs) {
        bool isSel = false;
        if (f) for (auto s : f->selectedBeliefs) if (s.value == b.id.value) { isSel = true; break; }
        bool isChanged = false;
        for (int id : changedIds) if (id == b.id.value) { isChanged = true; break; }

        // Accent bar + row.
        ImVec2 start = ImGui::GetCursorScreenPos();
        ImGui::PushID(b.id.value);
        ImGui::BeginGroup();

        // Content line colored by status (no id/status text): color encodes state.
        if (b.confidence >= 0.0) {
            ImGui::TextDisabled("%.2f", b.confidence);
            ImGui::SameLine();
        }
        ImVec4 c = ImGui::GetStyleColorVec4(ImGuiCol_Text);
        if (b.status == "open") c = kAccent;
        else if (b.status == "closed") c = kGreen;
        else if (b.status == "falsified") c = kRed;
        else if (b.status == "revised") c = kAmber;
        if (isSel) c = kAccent;
        if (isChanged) c = kAmber;
        ImGui::PushStyleColor(ImGuiCol_Text, c);
        // Live mode carries the prose belief statement; the demo/headless fixture
        // uses the structured lhs/relation/rhs. Prefer the statement when present.
        if (!b.statement.empty()) {
            ImGui::TextWrapped("%s", b.statement.c_str());
        } else {
            ImGui::TextUnformatted((b.lhs + " ──" + b.relation + "──> " + b.rhs).c_str());
        }
        ImGui::PopStyleColor();

        // Provenance.
        if (!b.sourceFrames.empty()) {
            std::string src = "source: ";
            for (size_t i = 0; i < b.sourceFrames.size(); ++i) {
                if (i) src += ", ";
                src += "#" + std::to_string(b.sourceFrames[i]);
            }
            ImGui::TextDisabled("%s", src.c_str());
        }

        ImGui::EndGroup();
        ImGui::PopID();

        // Left accent bar for selected beliefs.
        if (isSel) {
            ImVec2 end = ImGui::GetCursorScreenPos();
            ImGui::GetWindowDrawList()->AddRectFilled(
                ImVec2(start.x - 4.0f, start.y),
                ImVec2(start.x - 1.0f, end.y),
                ImGui::GetColorU32(kAccent));
        }
        ImGui::Spacing();
    }
    ImGui::EndChild();
}

void renderCognitiveLane(const pie::gui::NativeGuiModel& m, int viewId) {
    const auto* f = displayedFrame(m, viewId);
    ImGui::TextUnformatted("COGNITIVE PROCESS");
    ImGui::Separator();
    ImGui::BeginChild("cog_scroll", ImVec2(0, 0), false);
    if (!f) { ImGui::TextDisabled("(no frame)"); ImGui::EndChild(); return; }

    // PLAN
    ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
    ImGui::TextUnformatted("PLAN");
    ImGui::PopStyleColor();
    if (f->plan.valid()) {
        ImGui::TextUnformatted(("Intent " + f->plan.label).c_str());
        if (!f->selectedBeliefs.empty()) {
            std::string sel = "Selected: ";
            for (size_t i = 0; i < f->selectedBeliefs.size(); ++i) {
                if (i) sel += ", ";
                sel += beliefLabel(f->selectedBeliefs[i].value);
            }
            ImGui::TextDisabled("%s", sel.c_str());
        }
        ImGui::TextUnformatted(("Q: " + f->plan.question).c_str());
        ImGui::TextWrapped(("Intent: " + f->plan.intent).c_str());
    } else {
        ImGui::TextDisabled("(no plan yet)");
    }

    ImGui::Spacing();
    ImGui::Separator();

    // DISTILLATION
    ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
    ImGui::TextUnformatted("DISTILLATION");
    ImGui::PopStyleColor();
    if (f->distillation.valid()) {
        ImGui::TextUnformatted(("D-42 " + f->distillation.label).c_str());
        ImGui::TextUnformatted("Input:");
        for (auto& id : f->distillation.inputIds) {
            ImGui::BulletText("%s", id.c_str());
        }
        if (!f->distillation.unexplained.empty())
            ImGui::TextWrapped(("Unexplained: " + f->distillation.unexplained).c_str());
        if (!f->distillation.interpretation.empty())
            ImGui::TextWrapped(("Interpretation: " + f->distillation.interpretation).c_str());
    } else {
        ImGui::TextDisabled("(no distillation yet)");
    }

    ImGui::Spacing();
    ImGui::Separator();

    // PROPOSALS
    ImGui::PushStyleColor(ImGuiCol_Text, kGreen);
    ImGui::TextUnformatted("PROPOSALS");
    ImGui::PopStyleColor();
    if (!f->proposals.empty()) {
        for (auto& p : f->proposals) {
            ImVec4 c = kGray;
            if (p.op == '+') c = kGreen;
            else if (p.op == '~') c = kAmber;
            else if (p.op == '-') c = kRed;
            ImGui::PushStyleColor(ImGuiCol_Text, c);
            std::string line = std::string(1, p.op) + " " + p.belief;
            ImGui::TextUnformatted(line.c_str());
            ImGui::PopStyleColor();
            if (!p.relation.empty())
                ImGui::TextDisabled("  %s ──%s──> %s", p.lhs.c_str(), p.relation.c_str(), p.rhs.c_str());
            if (!p.detail.empty())
                ImGui::TextDisabled("  %s", p.detail.c_str());
        }
    } else {
        ImGui::TextDisabled("(no proposals yet)");
    }

    ImGui::EndChild();
}

void renderExecutionLane(const pie::gui::NativeGuiModel& m, int viewId) {
    const auto* f = displayedFrame(m, viewId);
    const auto& cur = m.cursor();
    ImGui::TextUnformatted("EXECUTION");
    if (f && f->closed) { ImGui::SameLine(); ImGui::TextDisabled("(closed)"); }
    ImGui::Separator();
    ImGui::BeginChild("exec_scroll", ImVec2(0, 0), false);
    if (!f) { ImGui::TextDisabled("(no frame)"); ImGui::EndChild(); return; }
    if (f->trajectory.empty()) { ImGui::TextDisabled("(no execution steps)"); ImGui::EndChild(); return; }

    for (auto& t : f->trajectory) {
        // The runtime never provides CursorChanged.item, so a tool is "current"
        // when it is in flight (status == running) during the EXECUTING stage.
        bool isCurrent = (cur.valid() && cur.stage == pie::gui::FrameStage::EXECUTING && t.status == "running");
        std::string statusSym = "○";
        if (t.status == "ok") statusSym = "✓";
        else if (t.status == "running") statusSym = "●";
        else if (t.status == "failed") statusSym = "✗";
        else if (t.status == "pending") statusSym = "○";

        std::string label = std::string(statusSym) + " " + t.id + "  " + t.tool + ": " + t.command;
        if (isCurrent) {
            ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
            label += "   CURRENT";
        }

        ImGui::PushID(t.id.c_str());
        if (ImGui::TreeNode(label.c_str())) {
            if (isCurrent) ImGui::PopStyleColor();
            ImGui::TextUnformatted(("tool:   " + t.tool).c_str());
            ImGui::TextWrapped(("command: " + t.command).c_str());
            ImGui::TextWrapped(("result:  " + t.result).c_str());
            if (!t.warning.empty()) {
                ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
                ImGui::TextWrapped(("WARNING: " + t.warning).c_str());
                ImGui::PopStyleColor();
            }
            ImGui::TextDisabled("status: %s", t.status.c_str());
            ImGui::TreePop();
            ImGui::PopID();
            continue;
        }
        if (isCurrent) ImGui::PopStyleColor();
        ImGui::PopID();
    }
    ImGui::EndChild();
}

void renderSummary(const pie::gui::NativeGuiModel& m, int viewId) {
    const auto* f = displayedFrame(m, viewId);
    ImGui::TextUnformatted("CURRENT FRAME");
    ImGui::SameLine();
    if (f) ImGui::TextDisabled("#%d", f->id);
    ImGui::Separator();
    if (!f) { ImGui::TextDisabled("(no frame)"); return; }

    // B42 + B47 -> intent -> N steps -> distillation -> {proposals}
    std::string sel;
    for (size_t i = 0; i < f->selectedBeliefs.size(); ++i) {
        if (i) sel += " + ";
        sel += beliefLabel(f->selectedBeliefs[i].value);
    }
    if (sel.empty()) sel = "(none)";
    std::string line = sel + "  →  ";
    line += f->plan.valid() ? f->plan.intent : "(planning)";
    line += "  →  ";
    line += std::to_string(f->trajectory.size()) + " execution step(s)";
    line += "  →  ";
    line += f->distillation.valid() ? (f->distillation.unexplained.empty() ? "distilled" : f->distillation.unexplained) : "(pending)";
    if (!f->proposals.empty()) {
        line += "  →  {";
        for (size_t i = 0; i < f->proposals.size(); ++i) {
            if (i) line += ", ";
            line += std::string(1, f->proposals[i].op) + f->proposals[i].belief;
        }
        line += "}";
    }
    ImGui::TextWrapped("%s", line.c_str());
}

using InstructionSender = std::function<void(const std::string&)>;

// Render the instruction palette as a standalone floating window (not docked
// into the main workspace). It no longer reserves layout space; the caller only
// toggles `open` via the cmd/cmd-T shortcut.
void renderInstructionPalette(bool& open, const pie::gui::NativeGuiModel& m, bool canSend, InstructionSender send) {
    if (!open) return;

    static bool focusOnce = true;
    static char buf[256] = {};

    ImGui::SetNextWindowSize(ImVec2(520, 0), ImGuiCond_Appearing);
    ImGui::SetNextWindowPos(ImVec2(120, 120), ImGuiCond_Appearing);
    bool close = false;
    if (ImGui::Begin("User Instruction", &close, ImGuiWindowFlags_NoCollapse)) {
        // Keep focus on the input box once opened.
        if (focusOnce) { ImGui::SetKeyboardFocusHere(); focusOnce = false; }

        ImGui::TextUnformatted(">");
        ImGui::SameLine();
        ImGui::SetNextItemWidth(-1.0f);
        bool submit = ImGui::InputText("##instruction", buf, sizeof(buf), ImGuiInputTextFlags_EnterReturnsTrue);

        // Live in-message (the assistant's streaming reply). Rendered below the
        // input box in a scrollable container that auto-scrolls to the bottom as
        // it grows. Only live mode feeds message_start/message_update/message_end;
        // in demo mode this stays empty.
        ImGui::TextDisabled("In-Message");
        ImGui::Separator();
        ImGui::BeginChild("in_message", ImVec2(0, 140), true);
        static size_t lastInMsgLen = 0;
        if (!m.inMessage().empty()) {
            ImGui::TextWrapped("%s", m.inMessage().c_str());
        } else {
            ImGui::TextDisabled("(waiting for a live message...)");
        }
        // Auto-scroll to bottom whenever new content arrived. SetScrollHereY
        // scrolls the current cursor line to the desired fraction (1.0 = bottom)
        // of the child window.
        if (m.inMessage().size() != lastInMsgLen) {
            ImGui::SetScrollHereY(1.0f);
        }
        lastInMsgLen = m.inMessage().size();
        ImGui::EndChild();
        ImGui::Spacing();

        if (submit) {
            std::string instr(buf);
            // Always clear the input on Enter, then attempt to submit to rpc.
            buf[0] = '\0';
            if (canSend && send && !instr.empty()) {
                send(instr);  // reverse path: instruction -> runtime client
            } else {
                // demo / non-live: no runtime client, so show a disabled state.
                ImGui::PushStyleColor(ImGuiCol_Text, kGray);
                ImGui::TextDisabled("(not sent: not connected to a runtime client)");
                ImGui::PopStyleColor();
            }
        }
    }
    ImGui::End();

    if (close || ImGui::IsKeyPressed(ImGuiKey_Escape, false)) { open = false; focusOnce = true; }
    ImGui::SetNextFrameWantCaptureKeyboard(true);
}

} // namespace

int main(int argc, char** argv) {
    // Default: --live (spawn the RPC child). Pass --demo to opt into the
    // formal DemoEvents.h fixture instead. --live is explicit and wins if both
    // flags are supplied.
    bool live = true;
    bool demo = false;
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--live") { live = true; demo = false; }
        else if (std::string(argv[i]) == "--demo") { demo = true; live = false; }
    }

    glfwSetErrorCallback([](int e, const char* d) { std::fprintf(stderr, "GLFW error %d: %s\n", e, d); });
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

    int winW = 1440, winH = 900;
    if (const char* sz = std::getenv("PI_GUI_SIZE")) {
        // PI_GUI_SIZE="<width>x<height>" overrides the default window size.
        if (std::sscanf(sz, "%dx%d", &winW, &winH) == 2) {
            winW = std::max(320, winW);
            winH = std::max(160, winH);
        }
    }
    GLFWwindow* window = glfwCreateWindow(winW, winH, "PIE Native GUI", nullptr, nullptr);
    if (!window) { glfwTerminate(); return 1; }
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);
    // Enforce a minimum window size matching the layout formula so the status
    // bar, navigator, lanes, and summary always fit the work area without
    // overlap. The bounds come from the single source of truth in
    // LayoutMetrics.h so code, tests, and docs cannot drift. The instruction
    // palette is a floating window and does not participate in this layout.
    glfwSetWindowSizeLimits(window,
                            static_cast<unsigned int>(pie::gui::kMinWindowWidth),
                            static_cast<unsigned int>(pie::gui::kMinWindowHeight),
                            GLFW_DONT_CARE, GLFW_DONT_CARE);



    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::GetIO().ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    ImGui::StyleColorsDark();

    // Load the Sarasa Term SC Nerd TTC as the single global font. The asset is a
    // TrueType Collection (10 faces); FreeType (IMGUI_ENABLE_FREETYPE) must be
    // enabled to decode it. We select the Regular face and cover CJK ranges so
    // every component uses the same font without per-component PushFont.
    ImGuiIO& io = ImGui::GetIO();
    const std::string ttcPath = fontPath();
    // Select the Regular face (fc-scan index 7) of the Sarasa Term SC Nerd
    // collection. font_no 0 is Bold, so an explicit FontNo is required for a
    // regular-weight default.
    ImFontConfig fontCfg;
    fontCfg.FontNo = 7;  // Sarasa Term SC Nerd Regular
    ImFont* font = io.Fonts->AddFontFromFileTTF(ttcPath.c_str(), 18.0f, &fontCfg, io.Fonts->GetGlyphRangesChineseFull());
    if (font == nullptr) {
        // FreeType is required for a TTC; fall back to the default font and warn.
        std::fprintf(stderr, "WARNING: failed to load %s; using default font. TTC requires FreeType.\n", ttcPath.c_str());
    }
    // Do NOT call io.Fonts->Build() here. The vendored ImGui v1.92.5 OpenGL3
    // backend sets ImGuiBackendFlags_RendererHasTextures in ImGui_ImplOpenGL3_Init
    // (called below) and manages the font atlas lazily during ImGui::NewFrame().
    // Calling Build() before that flag is set preloads all glyphs on the legacy
    // path, then NewFrame() asserts in ImFontAtlasUpdateNewFrame
    // ("Called ImFontAtlas::Build() before ImGuiBackendFlags_RendererHasTextures
    // got set!"). If the font above failed to load, ImFontAtlasBuildMain falls
    // back to AddFontDefault() automatically, so no explicit Build() is needed.

    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init(glslVersion);

    pie::gui::NativeGuiModel model;
    model.setSession("repo-analysis");

    SdkProcess sdk;
    EventQueue queue;
    std::atomic<bool> stopReader{false};
    std::thread reader;

    // Startup modes:
    //   default --live -> spawn the RPC child; the ⌘T pane drives the session and
    //     the runtime emits message_start/message_update/message_end on
    //     submission. Input is always sendable in live mode.
    //   --demo -> inject the formal DemoEvents.h fixture (full event stream).
    //   --demo --live together -> live wins (spawn RPC).
    if (live) {
        if (!spawnSdk(sdk)) {
            std::fprintf(stderr, "Failed to spawn SDK child\n");
            ImGui_ImplOpenGL3_Shutdown(); ImGui_ImplGlfw_Shutdown(); ImGui::DestroyContext();
            glfwDestroyWindow(window); glfwTerminate();
            return 1;
        }
        reader = std::thread(readerThread, std::ref(sdk), std::ref(queue), std::ref(stopReader));
        // No hardcoded prompt: the user drives the session via the ⌘T pane input.
    } else if (demo) {
        for (auto& line : pie::gui::demoEvents()) model.applyLine(line);
    }
    // else: default empty model.

    int viewId = -1;
    bool instructionOpen = false;

    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        if (live) {
            std::string line;
            while (queue.popIfAny(line)) pie::gui::applyRpcLine(model, line);
        }

        auto& io = ImGui::GetIO();
        if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_T, false))
            instructionOpen = !instructionOpen;

        // Main window fills the viewport.
        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(io.DisplaySize);
        ImGui::Begin("PIE Native GUI", nullptr,
                     ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                     ImGuiWindowFlags_NoScrollbar);

        float winW = io.DisplaySize.x;
        float winH = io.DisplaySize.y;
        float pad = 8.0f;

        // Derive vertical sizes from the frame height and font metrics so that
        // the layout tracks font scale instead of hardcoding pixel constants.
        float rowH = ImGui::GetFrameHeightWithSpacing();
        pie::gui::LayoutMetrics lm = pie::gui::computeLayout(io.DisplaySize.x, winH, rowH);
        float headerH = lm.headerH;   // status bar
        float navH = lm.navH;         // frame navigator
        float summaryH = lm.summaryH; // current-frame summary
        const float minLaneH = lm.minLaneH;
        const float minLaneW = lm.minLaneW;
        float laneH = lm.laneH;

        ImGui::BeginChild("top", ImVec2(0, headerH), false);
        renderStatusBar(model);
        ImGui::EndChild();

        ImGui::BeginChild("nav", ImVec2(0, navH), false);
        renderNavigator(model, viewId);
        ImGui::EndChild();

        // Floating instruction window (cmd/cmd-T), independent of the main layout.
        renderInstructionPalette(instructionOpen, model, live,
                                 [&sdk](const std::string& msg) {
                                     // live mode: send the instruction to the runtime client.
                                     writeCommand(sdk, pie::gui::serializeInstructionCommand("p-ins", msg));
                                 });

        ImGui::BeginChild("lanes", ImVec2(0, laneH), false);
        float availW = std::max(0.0f, winW - pad * 2);
        // Minimum lane width prevents the three lanes from collapsing; when the
        // window is too narrow the lane widths are clamped and the middle/right
        // lanes fall back to the available width.
        float leftW = availW * 0.27f;
        float midW = availW * 0.36f;
        float rightW = std::max(0.0f, availW - leftW - midW);
        if (availW < minLaneW * 3) {
            // Too narrow for three side-by-side lanes: stack them vertically
            // inside the scrollable region instead of overlapping.
            ImGui::BeginChild("left", ImVec2(0, 0), true);
            renderBeliefLane(model, viewId);
            ImGui::EndChild();
            ImGui::Spacing();
            ImGui::BeginChild("mid", ImVec2(0, 0), true);
            renderCognitiveLane(model, viewId);
            ImGui::EndChild();
            ImGui::Spacing();
            ImGui::BeginChild("right", ImVec2(0, 0), true);
            renderExecutionLane(model, viewId);
            ImGui::EndChild();
        } else {
            ImGui::BeginChild("left", ImVec2(leftW, 0), true);
            renderBeliefLane(model, viewId);
            ImGui::EndChild();
            ImGui::SameLine();
            ImGui::BeginChild("mid", ImVec2(midW, 0), true);
            renderCognitiveLane(model, viewId);
            ImGui::EndChild();
            ImGui::SameLine();
            ImGui::BeginChild("right", ImVec2(rightW, 0), true);
            renderExecutionLane(model, viewId);
            ImGui::EndChild();
        }
        ImGui::EndChild();

        ImGui::BeginChild("summary", ImVec2(0, summaryH), false);
        renderSummary(model, viewId);
        ImGui::EndChild();

        ImGui::End();

        ImGui::Render();
        int dw = 0, dh = 0;
        glfwGetFramebufferSize(window, &dw, &dh);
        glViewport(0, 0, dw, dh);
        glClearColor(0.055f, 0.065f, 0.08f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        glfwSwapBuffers(window);
    }

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
