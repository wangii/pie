// PIE Native GUI - SDK child-process transport (RPC runtime client).
//
// Spawns the PI CLI in RPC mode, writes commands to stdin, reads JSONL events
// from stdout into a thread-safe EventQueue, and stops the reader cleanly.
// Non-rendering; used by live mode.
//
// The framing, the JSON parse and the drain budget live in EventQueue.h, which is
// headless and unit-tested. This file is only the part that needs a process: the
// fork/exec, the pipes, and the thread that owns them. §5.3 requires the parse to
// happen on the reader thread rather than the frame thread, because a
// `get_domain_snapshot` line for a long session is megabytes and parsing it inside
// the frame loop stalls the UI for the whole parse.
#pragma once

#include <atomic>
#include <string>

#include "EventQueue.h"

namespace pie::gui {

// SDK child process. Same transport as the previous build: fork/exec node, JSONL
// on stdout, commands on stdin.
struct SdkProcess {
    int pid = -1;
    int inFd = -1;
    int outFd = -1;
    std::atomic<bool> running{false};
};

// Fork/exec `node <PI_CLI> -ne --mode rpc` and wire up stdin/stdout pipes.
bool spawnSdk(SdkProcess& sp);

// Write one command line to the SDK's stdin (appends a newline).
void writeCommand(SdkProcess& sp, const std::string& cmd);

// Reader thread: frame stdout into lines, parse each one, push it to `q`.
//
// Parsing here rather than on the drain side is deliberate (docs/milestones.md
// §5.3). A line that does not parse is still pushed, with `parsed == false`, so
// the frame thread can record it as an issue — a reader that dropped it would
// turn a truncated write into silence.
void readerThread(SdkProcess& sp, EventQueue& q, std::atomic<bool>& stop);

} // namespace pie::gui
