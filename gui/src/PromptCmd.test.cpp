// Tests for the user prompt serialization and the runtime-client outbound pipe.
// This is headless: it does not require a window, ImGui, or a node subprocess.
// The runtime parses the `prompt` command with Node's strict JSON.parse, so the
// serialized command must be a valid JSON string literal. We validate that here
// with a small strict JSON parser (no node subprocess) and round-trip the
// `message` field byte-for-byte.

#include "PromptCmd.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <sys/types.h>

using pie::gui::serializePromptCommand;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what); ++failures; }
    else std::printf("ok: %s\n", what);
}

// --- minimal strict JSON string handling -------------------------------------
// Decode one JSON string value starting at s[i] (must be '"'). On success sets
// `out` to the decoded bytes, advances i past the closing quote, returns true.
// A raw control byte (<0x20) inside the string is rejected: strict JSON requires
// it be escaped, so this catches an unescaped newline.
static bool jsonString(const std::string& s, std::size_t& i, std::string& out) {
    if (i >= s.size() || s[i] != '"') return false;
    ++i;
    out.clear();
    while (i < s.size()) {
        char c = s[i];
        if (c == '"') { ++i; return true; }
        if (static_cast<unsigned char>(c) < 0x20u) return false;  // raw control char in string
        if (c == '\\') {
            ++i;
            if (i >= s.size()) return false;
            char e = s[i];
            switch (e) {
                case '"':  out += '"'; break;
                case '\\': out += '\\'; break;
                case '/':  out += '/'; break;
                case 'b':  out += '\b'; break;
                case 'f':  out += '\f'; break;
                case 'n':  out += '\n'; break;
                case 'r':  out += '\r'; break;
                case 't':  out += '\t'; break;
                case 'u': {
                    if (i + 4 >= s.size()) return false;
                    unsigned int cp = 0;
                    for (int k = 1; k <= 4; ++k) {
                        char h = s[i + k];
                        cp <<= 4;
                        if (h >= '0' && h <= '9') cp |= (unsigned int)(h - '0');
                        else if (h >= 'a' && h <= 'f') cp |= (unsigned int)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') cp |= (unsigned int)(h - 'A' + 10);
                        else return false;
                    }
                    i += 4;
                    if (cp < 0x80u) {
                        out += static_cast<char>(cp);
                    } else if (cp <= 0x7FFu) {
                        out += static_cast<char>(0xC0u | (cp >> 6));
                        out += static_cast<char>(0x80u | (cp & 0x3Fu));
                    } else if (cp <= 0xFFFFu) {
                        out += static_cast<char>(0xE0u | (cp >> 12));
                        out += static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu));
                        out += static_cast<char>(0x80u | (cp & 0x3Fu));
                    } else {
                        return false;  // surrogate/high code point not emitted by us
                    }
                    break;
                }
                default: return false;
            }
            ++i;
        } else {
            out += c;
            ++i;
        }
    }
    return false;  // unterminated
}

// Parse the serialized command object, extract and decode the "message" value.
// Returns true iff the whole command is consumed as a well-formed object.
static bool cmdMessage(const std::string& cmd, std::string& msg) {
    std::size_t i = 0;
    if (i >= cmd.size() || cmd[i] != '{') return false;
    ++i;
    bool sawMsg = false;
    while (i < cmd.size()) {
        while (i < cmd.size() && (cmd[i] == ' ' || cmd[i] == '\t' || cmd[i] == '\n' || cmd[i] == '\r')) ++i;
        if (i >= cmd.size()) return false;
        if (cmd[i] == '}') { ++i; break; }
        std::string key;
        if (!jsonString(cmd, i, key)) return false;
        while (i < cmd.size() && (cmd[i] == ' ' || cmd[i] == '\t')) ++i;
        if (i >= cmd.size() || cmd[i] != ':') return false;
        ++i;
        while (i < cmd.size() && (cmd[i] == ' ' || cmd[i] == '\t')) ++i;
        if (i >= cmd.size()) return false;
        std::string val;
        if (key == "message") {
            if (!jsonString(cmd, i, val)) return false;
            msg = val;
            sawMsg = true;
        } else if (cmd[i] == '"') {
            if (!jsonString(cmd, i, val)) return false;
        } else {
            std::size_t j = i;
            while (j < cmd.size() && cmd[j] != ',' && cmd[j] != '}') ++j;
            i = j;
        }
        while (i < cmd.size() && (cmd[i] == ' ' || cmd[i] == '\t')) ++i;
        if (i < cmd.size() && cmd[i] == ',') { ++i; continue; }
        if (i < cmd.size() && cmd[i] == '}') { ++i; break; }
        if (i >= cmd.size()) return false;
    }
    while (i < cmd.size() && (cmd[i] == ' ' || cmd[i] == '\t' || cmd[i] == '\n' || cmd[i] == '\r')) ++i;
    return sawMsg && i == cmd.size();
}

// Minimal replica of the runtime client's writeCommand: writes cmd + '\n' to
// a pipe fd. Verified against a real pipe fd so the bytes actually reach it.
static void writeToFd(int fd, const std::string& cmd) {
    std::string line = cmd + "\n";
    (void)!write(fd, line.data(), line.size());
}

int main() {
    // --- schema shape (normal) ---
    {
        std::string s = serializePromptCommand("req_0", "explain current frame");
        check(s == "{\"type\":\"prompt\",\"id\":\"req_0\",\"message\":\"explain current frame\",\"streamingBehavior\":\"steer\"}", "normal prompt schema");
        std::string msg;
        check(cmdMessage(s, msg) && msg == "explain current frame", "normal command is strict JSON and message round-trips");
    }
    // --- unique per-send id ---
    {
        check(pie::gui::nextPromptId() != pie::gui::nextPromptId(), "nextPromptId yields a unique id per call");
    }
    // --- quote escaping ---
    {
        std::string msg = "say \"hi\"";
        std::string s = serializePromptCommand("i2", msg);
        std::string decoded;
        check(cmdMessage(s, decoded) && decoded == msg, "double quote escaped and round-trips");
    }
    // --- backslash escaping ---
    {
        std::string msg = "a\\b";
        std::string s = serializePromptCommand("i3", msg);
        std::string decoded;
        check(cmdMessage(s, decoded) && decoded == msg, "backslash escaped and round-trips");
    }
    // --- newline/control characters are escaped into valid JSON ---
    {
        std::string msg = "line1\nline2\r\t\b\f\x01end";
        std::string s = serializePromptCommand("i4", msg);
        bool noRawCtrl = true;
        for (char c : s) if (static_cast<unsigned char>(c) < 0x20u) { noRawCtrl = false; break; }
        check(noRawCtrl, "no raw control byte in serialized command");
        std::string decoded;
        check(cmdMessage(s, decoded), "escaped multiline command is strict JSON");
        check(decoded == msg, "message round-trips byte-for-byte after escape");
    }
    // --- long multiline prompt is not truncated (growable storage) ---
    {
        std::string msg;
        for (int i = 0; i < 80; ++i) msg += "line " + std::to_string(i) + " 内容\n";
        check(msg.size() > 1024, "multiline prompt exceeds a 1024-byte buffer");
        std::string s = serializePromptCommand("p-long", msg);
        std::string decoded;
        check(cmdMessage(s, decoded), "long multiline command is strict JSON");
        check(decoded == msg, "long multiline message round-trips byte-for-byte");
        check(s.size() > msg.size(), "serialized command grew with payload");
    }

    // --- outbound pipe: bytes actually written reach the read end ---
    {
        int p[2];
        if (pipe(p) != 0) { check(false, "pipe creation"); return 1; }
        std::string cmd = serializePromptCommand("req_9", "stop execution");
        writeToFd(p[1], cmd);
        close(p[1]);
        char buf[128] = {};
        ssize_t n = read(p[0], buf, sizeof(buf) - 1);
        close(p[0]);
        std::string got(buf, buf + (n > 0 ? n : 0));
        check(got == cmd + "\n", "writeCommand bytes reach the pipe (outbound write)");
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
