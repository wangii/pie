// Instruction command serialization, extracted as a pure inline function so it
// can be unit-tested without spawning a node subprocess. The wire schema is a
// stable JSON object: {"type":"instruction","id":<uuid>,"message":<msg>}.
// Only `"` and `\` need escaping inside a JSON string value (LF/CR/other are
// permitted literally but harmless; we do minimal correct escaping here).

#pragma once

#include <string>

namespace pie::gui {

inline std::string serializeInstructionCommand(const std::string& uuid, const std::string& message) {
    std::string escaped;
    escaped.reserve(message.size() + 16);
    for (char c : message) {
        if (c == '"' || c == '\\') escaped += '\\';
        escaped += c;
    }
    return "{\"type\":\"instruction\",\"id\":\"" + uuid +
           "\",\"message\":\"" + escaped + "\"}";
}

} // namespace pie::gui
