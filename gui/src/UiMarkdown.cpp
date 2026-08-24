// PIE Native GUI - markdown rendering for assistant/session prose.
#include "UiMarkdown.h"

#include <imgui.h>
#include <imgui_markdown.h>

#include "Theme.h"

namespace pie::gui {

std::string replaceEscapedNewlines(const std::string& s) {
    std::string result;
    result.resize(s.size()); // upper bound, we'll shrink after
    std::size_t out = 0;
    for (std::size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '\\' && i + 1 < s.size() && s[i + 1] == 'n') {
            result[out++] = '\n';
            ++i;
        } else {
            result[out++] = s[i];
        }
    }
    result.resize(out);
    return result;
}

void renderMarkdownMessage(const std::string& text) {
    ImGui::MarkdownConfig mdConfig;
    ImFont* font = ImGui::GetIO().Fonts->Fonts.empty()
                       ? nullptr
                       : ImGui::GetIO().Fonts->Fonts[0];
    if (font) {
        for (int i = 0; i < ImGui::MarkdownConfig::NUMHEADINGS; ++i) {
            // Strong emphasis (**__** ) and headings use the last headingFormat
            // slot's font, so route them through the Bold face. Heading levels
            // below the last slot keep the regular (body) font.
            mdConfig.headingFormats[i].font = markdownBoldFont() ? markdownBoldFont() : font;
            mdConfig.headingFormats[i].separator = false;
        }
    }
    // Preserve the real newlines carried in RPC payloads so multiline assistant
    // content is not collapsed into a single blank line.
    mdConfig.formatFlags = ImGuiMarkdownFormatFlags_None;
    mdConfig.codeFont = markdownCodeFont();

    const auto nt = replaceEscapedNewlines(text);
    ImGui::Markdown(nt.c_str(), nt.size(), mdConfig);
}

} // namespace pie::gui
