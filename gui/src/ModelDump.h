// ModelDump: a stable text rendering of the derived model.
//
// This exists for `--replay <jsonl>` (docs/milestones.md M3), which runs a real
// session transcript through the same bootstrap and appliers the live GUI uses
// and prints what came out. §10 names the JSON parser's correctness against real
// payloads as the highest risk in the plan, and a transcript is the only fixture
// that has the shapes a hand-written one lacks.
//
// It is a *tested* artifact, not a debug printf: Bootstrap.test.cpp asserts on
// these lines, so the dump is where the derived values (belief labels, status
// precedence, closed-episode immutability) become checkable end to end.
//
// The format is line-oriented and stable on purpose. It is not a wire format and
// nothing parses it back.

#pragma once

#include <string>

#include "Model.h"
#include "TraceModel.h"

namespace pie::gui {

// Render the whole model. Deterministic for a given state: every ordering comes
// from record order, never from a map iteration or a clock.
std::string dumpModel(const NativeGuiModel& model);

// Render one task's subtree. Exposed separately because the replay tool's
// `--task <id>` narrows the output for a long session.
std::string dumpTask(const NativeGuiModel& model, const Task& task);

// Render the dispatch trace (M7): the rows the trace pane would show, each
// column labelled with the source it came from, plus the ReplayIssue table. The
// trace is session-scoped telemetry rather than replayed state, so it is its own
// section instead of a field on a task.
std::string dumpTrace(const NativeGuiModel& model);

} // namespace pie::gui
