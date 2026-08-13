// Evaluated before the shared CLI dependency graph so config can distinguish
// the dedicated Pie executable even when npm invokes it through a `pie` symlink.
(globalThis as Record<symbol, unknown>)[Symbol.for("pie.application.entry")] = true;
