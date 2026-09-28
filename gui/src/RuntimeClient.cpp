// PIE Native GUI - SDK child-process transport (RPC runtime client).
#include "RuntimeClient.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string_view>

#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PI_CLI
#error "PI_CLI must be defined (absolute path to packages/pie/dist/cli.js)"
#endif

namespace pie::gui {

bool spawnSdk(SdkProcess& sp) {
    int inPipe[2], outPipe[2];
    if (pipe(inPipe) != 0) return false;
    if (pipe(outPipe) != 0) { close(inPipe[0]); close(inPipe[1]); return false; }
    int pid = fork();
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
        // std::printf("GUI -> RPC: %s\n", cmd.c_str());
        // std::fflush(stdout);
    } else {
        std::printf("GUI -> RPC FAILED: %s\n", cmd.c_str());
        std::fflush(stdout);
    }
}

void readerThread(SdkProcess& sp, EventQueue& q, std::atomic<bool>& stop) {
    LineFramer framer;
    char chunk[4096];
    // One line is parsed here, on this thread: the frame loop never sees a
    // multi-megabyte snapshot as work it has to do (§5.3).
    auto push = [&q](std::string line) {
        if (line.empty()) return;
        q.push(parseInboundLine(std::move(line)));
    };
    while (!stop.load()) {
        ssize_t n = read(sp.outFd, chunk, sizeof(chunk));
        if (n < 0) { if (errno == EINTR) continue; break; }
        if (n == 0) break;
        framer.feed(std::string_view(chunk, static_cast<size_t>(n)), push);
    }
    // A final line with no trailing newline is still a line — a stream that ended
    // mid-write would otherwise lose the last event without a trace.
    framer.flush(push);
    sp.running.store(false);
}

} // namespace pie::gui
