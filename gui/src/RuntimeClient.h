// PIE Native GUI - SDK child-process transport (RPC runtime client).
//
// Spawns the PI CLI in RPC mode, writes commands to stdin, reads JSONL events
// from stdout into a thread-safe EventQueue, and stops the reader cleanly.
// Non-rendering; used by main in --live mode.
#pragma once

#include <atomic>
#include <deque>
#include <mutex>
#include <string>

namespace pie::gui {

// SDK child process (used in --live mode). Same transport as the previous
// build: fork/exec node, JSONL on stdout, commands on stdin.
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

// Thread-safe FIFO of incoming JSONL lines from the SDK.
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

// Reader thread: append stdout chunks, split on newlines, push lines to `q`.
void readerThread(SdkProcess& sp, EventQueue& q, std::atomic<bool>& stop);

} // namespace pie::gui
