# gui/tests/fixtures

Recorded RPC transcripts, used by `pie_gui_replay --replay <file>` and by the
CTest targets that point at them.

## `demo-session.jsonl`

The built-in scripted v7 stream (`src/DemoEvents.h`), one JSON event per line, as
it would arrive on stdout from `node <PI_CLI> -ne --mode rpc`. Regenerate it from
the source rather than editing it by hand:

```bash
cd gui && cmake --build --preset debug
./build/debug/pie_gui_replay --demo-lines > tests/fixtures/demo-session.jsonl
```

A transcript is a *path*, not just data: this file exercises the reader's framing
(chunk boundaries, a trailing newline, a line that is not valid JSON) in a way the
in-memory `--demo` stream cannot.

## Adding a real transcript

The highest-value fixture is a real session, because a hand-written one shares its
mental model with the parser it is meant to catch (docs/milestones.md §10). To
capture one:

```bash
node packages/pie/dist/cli.js -ne --mode rpc > session.jsonl   # then drive it
./build/debug/pie_gui_replay --replay session.jsonl
./build/debug/pie_gui_replay --replay session.jsonl --dump-snapshot state.jsonl
```

`--dump-snapshot` writes a `get_domain_snapshot` response line for the final state,
so `state.jsonl` can be replayed on its own to check that a snapshot and the event
stream it came from agree.

Transcripts can be large and can quote prompts and tool output. Check what is in a
file before committing it.
