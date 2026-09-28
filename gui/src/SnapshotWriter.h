// SnapshotWriter: the model's replayed state back out as `get_domain_snapshot`.
//
// This exists for two reasons, both from docs/milestones.md §10:
//
//   1. `--dump-snapshot <file>`: capture what the GUI holds, so a bug report can
//      carry the state instead of a screenshot.
//
//   2. It makes the bootstrap's central claim *provable* rather than argued. §5.3
//      says the snapshot and the live stream necessarily overlap, and that the
//      three orders — events alone, snapshot-then-events, snapshot-then-events-
//      replayed — must reach the same terminal state. With a writer, a test can
//      take the state after N events, serialize it, and run the remaining events
//      against it. That is the property the whole buffering design rests on, and
//      it is otherwise only checkable by hand.
//
// FIDELITY, and where it stops. The writer emits exactly the fields the readers
// read, so a dump/reload round-trip is the identity for everything the GUI
// derives. One exception is `Execution.output`: the model holds a
// display-truncated preview plus the true byte count (kExecutionOutputPreviewChars),
// and the snapshot field only carries the preview. So re-reading a dump of a
// truncated output yields the preview as the whole output, and the byte count
// becomes the preview's. A dump is a faithful record of what the GUI holds, not
// of the session file. `dumpModel` prints both numbers, so the difference is
// visible rather than silent.

#pragma once

#include <string>

#include "Model.h"

namespace pie::gui {

// The `data` member of a `get_domain_snapshot` response.
std::string writeDomainSnapshotData(const NativeGuiModel& model);

// The whole response line, exactly as the runtime would emit it — so a fixture
// for a reconnect test IS a recorded transcript, not a hand-rolled imitation.
std::string writeDomainSnapshotLine(const NativeGuiModel& model, const std::string& requestId);

} // namespace pie::gui
