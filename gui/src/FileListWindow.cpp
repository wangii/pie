// PIE Native GUI - floating session file-list window (⌘F / Ctrl-F).
#include "FileListWindow.h"

#include <algorithm>

#include <imgui.h>

namespace pie::gui {

void renderFileList(bool& open, const pie::gui::NativeGuiModel& m) {
    if (!open) return;

    // Close on Escape before rendering so the focus model stays sane.
    if (ImGui::IsKeyPressed(ImGuiKey_Escape, false)) { open = false; return; }

    // Centered, undecorated overlay mirroring the user-prompt palette geometry.
    const ImVec2 d = ImGui::GetIO().DisplaySize;
    const ImVec2 winSize(d.x * 0.5f, d.y * 0.5f);
    const ImVec2 winPos((d.x - winSize.x) * 0.5f, (d.y - winSize.y) * 0.5f);
    ImGui::SetNextWindowSize(winSize, ImGuiCond_Always);
    ImGui::SetNextWindowPos(winPos, ImGuiCond_Always);
    bool close = false;
    const ImGuiWindowFlags flags = ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                                   ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse;
    if (ImGui::Begin("File List", &close, flags)) {
        const auto& files = m.fileList();
        if (files.empty()) {
            ImGui::TextDisabled("(no read/write/edit files in this session yet)");
        } else {
            ImGui::BeginChild("file_list_scroll", ImVec2(0, 0), true);
            // Group by operation for readability: read / write / edit.
            static const char* kOps[] = {"read", "write", "edit"};
            for (const char* op : kOps) {
                bool headerShown = false;
                for (const auto& fe : files) {
                    if (fe.op != op) continue;
                    if (!headerShown) {
                        ImGui::Separator();
                        ImGui::TextColored(ImVec4(0.6f, 0.75f, 0.95f, 1.0f), "%s:", op);
                        headerShown = true;
                    }
                    ImGui::TextUnformatted(fe.path.c_str());
                }
            }
            ImGui::EndChild();
        }
    }
    ImGui::End();

    if (close) open = false;
    ImGui::SetNextFrameWantCaptureKeyboard(true);
}

} // namespace pie::gui
