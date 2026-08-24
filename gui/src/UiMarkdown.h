// PIE Native GUI - markdown rendering for assistant/session prose.
//
// Renders a plain string as Markdown inside the current ImGui cursor position.
// Owns the escape-newline helper and reads the markdown font resources from the
// Theme module (loaded by main). No model coupling beyond taking the text.
#pragma once

#include <string>

namespace pie::gui {

// Expand escaped "\\n" sequences into real newlines (RPC payloads carry them).
std::string replaceEscapedNewlines(const std::string& s);

// Render an assistant message as Markdown in the current ImGui cursor position.
void renderMarkdownMessage(const std::string& text);

} // namespace pie::gui
