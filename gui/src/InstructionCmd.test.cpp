// Tests for the instruction serialization and the runtime-client outbound pipe.
// This is headless: it does not require a window, ImGui, or a node subprocess.

#include "InstructionCmd.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <sys/types.h>

using pie::gui::serializeInstructionCommand;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what); ++failures; }
    else std::printf("ok: %s\n", what);
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
        std::string s = serializeInstructionCommand("p-ins", "explain current frame");
        check(s == "{\"type\":\"prompt\",\"id\":\"p-ins\",\"message\":\"explain current frame\"}", "normal instruction schema");
    }
    // --- quote escaping ---
    {
        std::string s = serializeInstructionCommand("i2", "say \"hi\"");
        check(s.find("\\\"") != std::string::npos, "double quote is escaped");
        check(s.find("say \\\"hi\\\"") != std::string::npos, "quoted payload preserved");
    }
    // --- backslash escaping ---
    {
        std::string s = serializeInstructionCommand("i3", "a\\b");
        check(s.find("a\\\\b") != std::string::npos, "backslash is escaped");
    }
    // --- newline is left literal but the JSON envelope is intact ---
    {
        std::string s = serializeInstructionCommand("i4", "line1\nline2");
        check(s.find("line1") != std::string::npos && s.find("line2") != std::string::npos, "newline payload retained");
        check(s.find("\"message\":\"") != std::string::npos, "message key present");
        check(s.find("\"type\":\"prompt\"") != std::string::npos, "type key present");
    }

    // --- outbound pipe: bytes actually written reach the read end ---
    {
        int p[2];
        if (pipe(p) != 0) { check(false, "pipe creation"); return 1; }
        std::string cmd = serializeInstructionCommand("p-ins", "stop execution");
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
