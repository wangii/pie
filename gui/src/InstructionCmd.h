// Instruction command serialization, extracted as a pure inline function so it
// can be unit-tested without spawning a node subprocess. The GUI sends user
// instructions to the RPC as a `prompt` command (the only recognized RpcCommand
// that carries a free text message). Wire schema:
//   {"type":"prompt","id":<uuid>,"message":<msg>}
// The runtime parses the command with Node's strict JSON.parse, so the message
// value must be a valid JSON string literal. Escaping only `"` and `\` is not
// enough: a literal newline (or other control byte) inside the string would
// make the whole line invalid JSON and the prompt is rejected. Every control
// character (U+0000..U+001F) is therefore escaped, with short escapes for the
// common ones (`\b \t \n \f \r`).

#pragma once

#include <cstdio>
#include <string>

namespace pie::gui {

inline std::string serializeInstructionCommand(const std::string& uuid, const std::string& message) {
    std::string escaped;
    escaped.reserve(message.size() + 16);
    for (char c : message) {
        switch (c) {
            case '"':  escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\b': escaped += "\\b"; break;
            case '\t': escaped += "\\t"; break;
            case '\n': escaped += "\\n"; break;
            case '\f': escaped += "\\f"; break;
            case '\r': escaped += "\\r"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20u) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned int>(static_cast<unsigned char>(c)));
                    escaped += buf;
                } else {
                    escaped += c;
                }
        }
    }
    return "{\"type\":\"prompt\",\"id\":\"" + uuid +
           "\",\"message\":\"" + escaped + "\"}";
}

} // namespace pie::gui
