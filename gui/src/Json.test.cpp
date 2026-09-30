// Headless unit tests for the JSON DOM (docs/milestones.md M0).
// Run: ./pi_gui_json_test   (returns non-zero on failure).
//
// The fixtures are the shapes this GUI actually reads, not synthetic ones:
//  * a `get_domain_snapshot` RPC response (the nested tasks -> episodes -> body
//    -> trajectory payload that motivated replacing the string scanner), and
//  * bare v7 domain event lines as they appear on the wire (docs/milestones.md
//    §3.1: domain events are NOT wrapped in entry_added/customType).
//
// The first section is the regression that started all of this: `tasks` is an
// array of objects that each carry an `id`, so a first-occurrence string scan
// reads every task's id as the first task's.

#include "Json.h"

#include <cstdio>
#include <string>

using pie::gui::json::ParseError;
using pie::gui::json::Value;

static int failures = 0;

static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// Parse a fixture, failing the run (not asserting) when it does not parse: a
// fixture that will not parse is a test bug, and reporting it as a failed
// expectation would hide which one.
static bool parseFixture(const char* text, Value& out) {
    ParseError err;
    if (pie::gui::json::parse(text, out, &err)) return true;
    std::fprintf(stderr, "FAIL(fixture): %s at offset %zu\n", err.message.c_str(), err.offset);
    ++failures;
    return false;
}

static void expectParseFailure(const char* text, const char* what) {
    Value v;
    ParseError err;
    const bool ok = pie::gui::json::parse(text, v, &err);
    check(!ok, what);
    if (!ok) check(!err.message.empty(), "parse failure carries a message");
}

// A real `get_domain_snapshot` response, trimmed to one task but keeping every
// nesting level the GUI reads.
static const char* kSnapshotResponse = R"JSON(
{
  "type": "response",
  "id": "req_0",
  "command": "get_domain_snapshot",
  "success": true,
  "data": {
    "sessionId": "session-1",
    "activeBranchTasks": ["task-1", "task-2"],
    "tasks": [
      {
        "id": "task-1",
        "initialPrompt": { "id": "prompt-1", "original": "Is pytest available?", "effective": "Is pytest available?" },
        "initialTarget": { "id": "target-1", "statement": "Is pytest available?" },
        "status": "active",
        "inheritedBeliefs": [],
        "introducedBeliefs": ["belief-1", "belief-2"],
        "focus": ["belief-1"],
        "focusDeclared": true,
        "formulations": [
          {
            "id": "formulation-1",
            "taskId": "task-1",
            "ordinal": 1,
            "recordedAt": "2026-01-01T00:00:00.000Z",
            "formedInEpisodeOrdinal": 1,
            "origin": "propose",
            "content": {
              "interpretation": "the runtime may lack a declared dependency",
              "focus": "requirements.txt against the installed environment",
              "tension": "declared and installed disagree",
              "implication": "probe the installed environment directly"
            },
            "reason": "the first probe showed a mismatch",
            "sources": [
              { "kind": "prompt", "promptId": "prompt-1" },
              { "kind": "belief", "beliefId": "belief-2", "beliefDeltaId": "delta-2" }
            ]
          }
        ],
        "formulationCorrections": [],
        "episodes": [
          {
            "id": "episode-1",
            "taskId": "task-1",
            "ordinal": 1,
            "status": "active",
            "stage": "executing",
            "steering": [],
            "routing": {
              "id": "routing-1",
              "statement": "investigation is required",
              "decision": "belief-loop",
              "suitabilityProbability": 0.3,
              "successProbability": 0.9,
              "estimatedSteps": 2,
              "difficulty": "medium",
              "reason": "requires evidence"
            },
            "body": {
              "kind": "belief-loop",
              "openBeliefsAtStart": [],
              "plan": {
                "id": "plan-1",
                "selectedToExplore": ["belief-1", "belief-2"],
                "intent": "verify the declared dependency",
                "formulation": { "kind": "unformed" }
              },
              "trajectory": [
                {
                  "id": "exec-1",
                  "planId": "plan-1",
                  "intention": "Run read",
                  "tool": "read",
                  "input": { "path": "requirements.txt" },
                  "output": "pytest==8.0",
                  "status": "succeeded",
                  "filePath": "requirements.txt"
                }
              ],
              "beliefDeltas": []
            }
          }
        ]
      },
      {
        "id": "task-2",
        "initialPrompt": { "id": "prompt-2", "original": "second", "effective": "second" },
        "status": "active",
        "inheritedBeliefs": ["belief-2"],
        "introducedBeliefs": [],
        "focus": [],
        "focusDeclared": false,
        "formulations": [],
        "formulationCorrections": [],
        "episodes": []
      }
    ],
    "beliefs": [
      {
        "id": "belief-1",
        "statement": "project uses pytest",
        "domain": "code",
        "expectation": "pytest is importable",
        "evidenceRounds": 1,
        "skillRefs": [],
        "supportedBy": [{ "evidence": "requirements declares pytest" }],
        "refutedBy": [],
        "withdrawn": false
      }
    ],
    "activeBeliefs": ["belief-1", "belief-2"],
    "cursor": { "taskId": "task-1", "episodeId": "episode-1", "stage": "executing" }
  }
}
)JSON";

// Bare v7 domain event lines, exactly as they appear on the wire.
static const char* kEpisodeOpened =
    R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"event-1","timestamp":"2026-01-01T00:00:00.000Z","taskId":"task-1","episodeId":"episode-1","ordinal":1})";

static const char* kBeliefDeltaApplied =
    R"({"type":"BeliefDeltaApplied","schemaVersion":7,"eventId":"event-2","timestamp":"2026-01-01T00:00:01.000Z","taskId":"task-1","episodeId":"episode-1","delta":{"id":"delta-1","episodeId":"episode-1","producerPhase":"propose","operation":"propose","resultBeliefId":"belief-1","resultingBeliefs":[{"id":"belief-1","statement":"project uses pytest","domain":"code","expectation":"pytest is importable","evidenceRounds":1,"skillRefs":[],"supportedBy":[],"refutedBy":[],"withdrawn":false}]},"activeBeliefs":["belief-1"]})";

static const char* kPlanProduced =
    R"({"type":"PlanProduced","schemaVersion":7,"eventId":"event-3","timestamp":"2026-01-01T00:00:02.000Z","taskId":"task-1","episodeId":"episode-1","plan":{"id":"plan-1","selectedToExplore":["belief-1"],"intent":"verify the declared dependency","advancement":{"action":"probe the runtime","condition":"the file is present","next":"read it"},"formulation":{"kind":"version","versionId":"formulation-1"}}})";

// The `session_status` telemetry line: thin, and with a null cache-hit rate.
static const char* kSessionStatus =
    R"({"type":"session_status","roleStatus":{"epistemic":{"model":{"provider":"anthropic","id":"claude-sonnet-5"},"latestCacheHitRate":0.62},"distillation":{"model":{"provider":"anthropic","id":"claude-haiku-4-5-20251001"},"latestCacheHitRate":null},"execution":{"model":{"provider":"anthropic","id":"claude-sonnet-5"},"latestCacheHitRate":0.5}},"roleUsage":{"epistemic":{"tokens":12000,"contextWindow":200000,"percent":6},"execution":{"tokens":null,"contextWindow":null,"percent":null}},"cost":0.0123})";

int main() {
    // ---------------------------------------------------------------------
    // REGRESSION: an array of objects that share a key name. A first-occurrence
    // string scan cannot tell these apart; the DOM must.
    // ---------------------------------------------------------------------
    {
        Value root;
        if (parseFixture(R"({"tasks":[{"id":"task-1"},{"id":"task-2"},{"id":"task-3"}]})", root)) {
            const Value* tasks = root.array("tasks");
            check(tasks != nullptr, "tasks is an array");
            check(tasks != nullptr && tasks->size() == 3, "tasks holds three entries");
            if (tasks != nullptr) {
                check(tasks->at(0).string("id") == "task-1", "tasks[0].id is task-1");
                check(tasks->at(1).string("id") == "task-2", "tasks[1].id is task-2, not a shadowed task-1");
                check(tasks->at(2).string("id") == "task-3", "tasks[2].id is task-3");
            }
        }
    }

    // ---------------------------------------------------------------------
    // Scalars and kind readers
    // ---------------------------------------------------------------------
    {
        Value v;
        if (parseFixture(R"({"n":null,"t":true,"f":false,"i":42,"neg":-7,"frac":0.5,"s":"hi"})", v)) {
            check(v.isObject(), "object kind");
            check(v.find("n") != nullptr && v.find("n")->isNull(), "null member is Null kind");
            check(v.boolean("t") && !v.boolean("f"), "bool members");
            check(v.integer("i") == 42, "integer member");
            check(v.integer("neg") == -7, "negative integer member");
            check(v.number("frac") == 0.5, "fractional member");
            check(v.string("s") == "hi", "string member");
            // "present but null" is distinct from "absent".
            check(!v.has("n"), "a null member is not 'has'");
            check(v.find("n") != nullptr, "a null member is still found");
            check(!v.has("missing"), "an absent member is not 'has'");
            check(v.find("missing") == nullptr, "an absent member is not found");
            // Wrong-kind readers degrade to the supplied default.
            check(v.string("i", "fallback") == "fallback", "string() on a number falls back");
            check(v.integer("s", -1) == -1, "integer() on a string falls back");
            check(v.boolean("s", true), "boolean() on a string falls back");
            check(v.array("i") == nullptr, "array() on a number is null");
            check(v.object("i") == nullptr, "object() on a number is null");
            check(v.kindName() != nullptr, "kindName is non-null");
        }
    }

    // ---------------------------------------------------------------------
    // Numbers: strict grammar, and exact integers across the wire's range
    // ---------------------------------------------------------------------
    {
        Value v;
        if (parseFixture(R"({"a":1e3,"b":-1.5e-3,"c":0,"d":1234567890123,"e":1.0,"f":0.1})", v)) {
            check(v.number("a") == 1000.0, "positive exponent");
            check(v.number("b") == -0.0015, "negative exponent and sign");
            check(v.number("c") == 0.0, "zero");
            check(v.integer("d") == 1234567890123LL, "13-digit integer is exact");
            check(v.integer("e") == 1, "1.0 truncates to 1");
            check(v.number("f") > 0.0999 && v.number("f") < 0.1001, "0.1 parses to ~0.1");
        }
        expectParseFailure("01", "leading zero is rejected");
        expectParseFailure("+1", "leading plus is rejected");
        expectParseFailure("1.", "a trailing decimal point is rejected");
        expectParseFailure(".5", "a bare leading decimal point is rejected");
        expectParseFailure("1e", "an empty exponent is rejected");
        expectParseFailure("Infinity", "Infinity is rejected");
        expectParseFailure("NaN", "NaN is rejected");
    }

    // ---------------------------------------------------------------------
    // Strings: escapes, unicode, surrogate pairs, and the strictness that keeps
    // the DOM free of bytes a JSON writer would have escaped
    // ---------------------------------------------------------------------
    {
        Value v;
        if (parseFixture(R"({"esc":"a\nb\tc\"d\\e\/f","uni":"\u4e2d\u6587","emoji":"\ud83d\ude00","lone":"\ud800"})", v)) {
            check(v.string("esc") == "a\nb\tc\"d\\e/f", "standard escapes decode");
            check(v.string("uni") == "\xe4\xb8\xad\xe6\x96\x87", "\\u escapes encode to UTF-8");
            check(v.string("emoji") == "\xf0\x9f\x98\x80", "a surrogate pair combines to one code point");
            // A lone high surrogate is not valid text; U+FFFD keeps the DOM valid UTF-8.
            check(v.string("lone") == "\xef\xbf\xbd", "a lone surrogate becomes U+FFFD");
        }
        expectParseFailure("\"unterminated", "an unterminated string is rejected");
        expectParseFailure("\"a\nb\"", "a raw newline inside a string is rejected");
        expectParseFailure("\"\\q\"", "an unknown escape is rejected");
    }

    // ---------------------------------------------------------------------
    // Objects and arrays: nesting, ordering, duplicate keys, array element kinds
    // ---------------------------------------------------------------------
    {
        Value v;
        if (parseFixture(R"({"outer":{"inner":{"deep":"value"}},"list":[1,"two",null,{"k":"v"},[3]],"dup":1,"dup":2})", v)) {
            check(v.object("outer") != nullptr && v.object("outer")->object("inner") != nullptr,
                  "nested objects resolve level by level");
            check(v.object("outer")->object("inner")->string("deep") == "value", "deeply nested string");
            const Value* list = v.array("list");
            check(list != nullptr && list->size() == 5, "array holds five elements");
            if (list != nullptr) {
                check(list->at(0).isNumber() && list->at(0).asInt() == 1, "array[0] is a number");
                check(list->at(1).isString() && list->at(1).asString() == "two", "array[1] is a string");
                check(list->at(2).isNull(), "array[2] is null");
                check(list->at(3).isObject() && list->at(3).string("k") == "v", "array[3] is an object");
                check(list->at(4).isArray() && list->at(4).size() == 1, "array[4] is a nested array");
                // Out of range yields a Null value rather than reading past the end.
                check(list->at(99).isNull(), "out-of-range index yields Null");
            }
            check(v.integer("dup") == 2, "a duplicated key takes the last value");
            check(v.memberCount() == 3, "a duplicated key keeps one position");
            // Mixed-kind string arrays skip the non-strings.
            const Value* mixed = v.array("list");
            check(mixed != nullptr && mixed->asStringArray().size() == 1, "asStringArray skips non-strings");
        }
    }

    // ---------------------------------------------------------------------
    // Depth cap: 256 nesting levels parse, 257 fail instead of exhausting the
    // stack.
    // ---------------------------------------------------------------------
    {
        std::string deep;
        for (int i = 0; i < 256; ++i) deep += "[";
        for (int i = 0; i < 256; ++i) deep += "]";
        Value v;
        check(pie::gui::json::parse(deep, v, nullptr), "256 nested arrays parse");

        std::string tooDeep;
        for (int i = 0; i < 300; ++i) tooDeep += "[";
        for (int i = 0; i < 300; ++i) tooDeep += "]";
        ParseError err;
        check(!pie::gui::json::parse(tooDeep, v, &err), "300 nested arrays are rejected");
        check(!err.message.empty(), "depth failure carries a message");
    }

    // ---------------------------------------------------------------------
    // Malformed input never throws and never aborts; it reports and stops.
    // ---------------------------------------------------------------------
    {
        expectParseFailure("", "empty input is rejected");
        expectParseFailure("   ", "whitespace-only input is rejected");
        expectParseFailure("{\"a\":1", "a truncated object is rejected");
        expectParseFailure("{\"a\"1}", "a missing colon is rejected");
        expectParseFailure("{a:1}", "an unquoted key is rejected");
        expectParseFailure("[1,2", "a truncated array is rejected");
        expectParseFailure("[1,]", "a trailing comma is rejected");
        expectParseFailure("{\"a\":1}{\"b\":2}", "trailing content is rejected");
        expectParseFailure("not json", "an unrecognized literal is rejected");

        // A failure leaves the output Null rather than half-populated.
        Value v;  // Null to begin with
        pie::gui::json::parse("{bad", v, nullptr);
        check(v.isNull(), "a failed parse leaves the output Null");

        // A failure preserves only the FIRST error, so the message names the
        // actual cause rather than a downstream symptom.
        Value w;
        ParseError err;
        pie::gui::json::parse("[1,2,", w, &err);
        check(!err.message.empty() && err.offset > 0, "the error offset points into the input");
    }

    // ---------------------------------------------------------------------
    // parseLine: BOM and CRLF tolerance for a piped JSONL stream
    // ---------------------------------------------------------------------
    {
        Value v;
        check(pie::gui::json::parseLine("\xef\xbb\xbf{\"a\":1}", v, nullptr), "a leading BOM is tolerated");
        check(v.integer("a") == 1, "BOM line value");
        check(pie::gui::json::parseLine("{\"a\":2}\r\n", v, nullptr), "a trailing CRLF is tolerated");
        check(v.integer("a") == 2, "CRLF line value");
        check(pie::gui::json::parseLine("  {\"a\":3}  ", v, nullptr), "surrounding spaces are tolerated");
        check(v.integer("a") == 3, "padded line value");
        check(!pie::gui::json::parseLine("", v, nullptr), "an empty line is not a value");
    }

    // ---------------------------------------------------------------------
    // The real snapshot payload: tasks -> episodes -> body -> trajectory, with
    // two tasks present so the shadowing bug would show.
    // ---------------------------------------------------------------------
    {
        Value root;
        if (parseFixture(kSnapshotResponse, root)) {
            check(root.string("type") == "response", "response type");
            check(root.string("command") == "get_domain_snapshot", "snapshot command");
            check(root.boolean("success"), "response success");

            const Value* data = root.object("data");
            check(data != nullptr, "response carries data");
            if (data != nullptr) {
                check(data->string("sessionId") == "session-1", "session id");
                check(data->stringArray("activeBranchTasks").size() == 2, "two active branch tasks");

                const Value* tasks = data->array("tasks");
                check(tasks != nullptr && tasks->size() == 2, "two tasks in the snapshot");
                if (tasks != nullptr) {
                    // This is the payoff: the second task's id is its own.
                    check(tasks->at(0).string("id") == "task-1", "snapshot task[0].id");
                    check(tasks->at(1).string("id") == "task-2", "snapshot task[1].id is not shadowed");
                    check(tasks->at(1).has("initialTarget") == false, "an omitted optional field reads as absent");
                    check(tasks->at(1).boolean("focusDeclared") == false, "focusDeclared false");

                    const Value* episodes = tasks->at(0).array("episodes");
                    check(episodes != nullptr && episodes->size() == 1, "task-1 has one episode");
                    if (episodes != nullptr) {
                        const Value& episode = episodes->at(0);
                        check(episode.string("id") == "episode-1", "episode id");
                        check(episode.string("stage") == "executing", "episode stage");
                        check(episode.integer("ordinal") == 1, "episode ordinal");
                        check(episode.object("routing") != nullptr, "episode carries routing");
                        check(episode.object("routing")->string("decision") == "belief-loop", "routing decision");

                        const Value* body = episode.object("body");
                        check(body != nullptr && body->string("kind") == "belief-loop", "belief-loop body");
                        if (body != nullptr) {
                            const Value* plan = body->object("plan");
                            check(plan != nullptr && plan->string("id") == "plan-1", "plan id");
                            check(plan != nullptr && plan->stringArray("selectedToExplore").size() == 2,
                                  "plan selects two beliefs");
                            // FormulationAdoption: `unformed` is a recorded fact,
                            // not a missing field.
                            check(plan != nullptr && plan->object("formulation") != nullptr &&
                                      plan->object("formulation")->string("kind") == "unformed",
                                  "plan adoption is an explicit unformed record");
                            const Value* trajectory = body->array("trajectory");
                            check(trajectory != nullptr && trajectory->size() == 1, "one execution");
                            if (trajectory != nullptr) {
                                const Value& exec = trajectory->at(0);
                                check(exec.string("tool") == "read", "execution tool");
                                check(exec.string("status") == "succeeded", "execution status");
                                // `input` is arbitrary JSON, not a string.
                                check(exec.object("input") != nullptr &&
                                          exec.object("input")->string("path") == "requirements.txt",
                                      "execution input is a structured object");
                            }
                        }
                    }

                    // The formulation history and its sources.
                    const Value* formulations = tasks->at(0).array("formulations");
                    check(formulations != nullptr && formulations->size() == 1, "one formulation version");
                    if (formulations != nullptr) {
                        const Value& version = formulations->at(0);
                        check(version.integer("ordinal") == 1, "formulation ordinal");
                        check(version.integer("formedInEpisodeOrdinal") == 1,
                              "the formation boundary survives the snapshot");
                        check(version.has("previousVersionId") == false,
                              "the first version names no predecessor");
                        check(version.object("content") != nullptr &&
                                  version.object("content")->has("tension"),
                              "an optional formulation field is present");
                        const auto sources = version.objectArray("sources");
                        check(sources.size() == 2, "two formulation sources");
                        if (sources.size() == 2) {
                            check(sources[0]->string("kind") == "prompt", "prompt source");
                            check(sources[1]->string("kind") == "belief", "belief source");
                            // A belief source is always cited with its delta.
                            check(sources[1]->string("beliefDeltaId") == "delta-2", "belief source carries its delta");
                        }
                    }
                }

                const Value* beliefs = data->array("beliefs");
                check(beliefs != nullptr && beliefs->size() == 1, "one belief record");
                if (beliefs != nullptr) {
                    const Value& belief = beliefs->at(0);
                    check(belief.string("domain") == "code", "belief domain");
                    check(belief.has("inconclusiveBy") == false, "an omitted evidence list is absent");
                    const auto supported = belief.objectArray("supportedBy");
                    check(supported.size() == 1 && supported[0]->string("evidence") == "requirements declares pytest",
                          "support evidence read as an object array");
                }

                const Value* cursor = data->object("cursor");
                check(cursor != nullptr && cursor->string("episodeId") == "episode-1", "cursor episode id");
                check(cursor != nullptr && cursor->string("stage") == "executing", "cursor stage");
            }
        }
    }

    // ---------------------------------------------------------------------
    // Real domain event lines (§3.1: bare on the wire, top-level `type`)
    // ---------------------------------------------------------------------
    {
        Value ev;
        if (parseFixture(kEpisodeOpened, ev)) {
            check(ev.string("type") == "EpisodeOpened", "event type is the top-level name");
            check(ev.integer("schemaVersion") == 7, "schema version is 7");
            check(ev.string("eventId") == "event-1", "eventId is the dedup key");
            check(ev.string("taskId") == "task-1", "task correlation");
            check(ev.string("episodeId") == "episode-1", "episode correlation");
            check(ev.has("event") == false, "the wire event is not wrapped in an `event` member");
            check(ev.has("customType") == false, "the wire event carries no customType");
        }
        if (parseFixture(kBeliefDeltaApplied, ev)) {
            check(ev.string("type") == "BeliefDeltaApplied", "delta event type");
            const Value* delta = ev.object("delta");
            check(delta != nullptr && delta->string("id") == "delta-1", "delta id");
            check(delta != nullptr && delta->string("producerPhase") == "propose", "delta producer phase");
            check(delta != nullptr && delta->string("operation") == "propose", "delta operation");
            check(delta != nullptr && delta->has("distillationId") == false,
                  "a propose-phase delta names no distillation");
            check(ev.stringArray("activeBeliefs").size() == 1, "activeBeliefs is a string array");
            if (delta != nullptr) {
                const auto resulting = delta->objectArray("resultingBeliefs");
                check(resulting.size() == 1, "one resulting belief record");
                if (resulting.size() == 1) {
                    check(resulting[0]->string("id") == "belief-1", "resulting belief id");
                    check(resulting[0]->boolean("withdrawn") == false, "withdrawn flag");
                    check(resulting[0]->integer("evidenceRounds") == 1, "evidence rounds");
                }
            }
        }
        if (parseFixture(kPlanProduced, ev)) {
            const Value* plan = ev.object("plan");
            check(plan != nullptr, "plan object");
            if (plan != nullptr) {
                const Value* advancement = plan->object("advancement");
                check(advancement != nullptr && advancement->string("action") == "probe the runtime",
                      "advancement action");
                check(advancement != nullptr && advancement->has("condition") && advancement->has("next"),
                      "advancement states condition and next together");
                const Value* formulation = plan->object("formulation");
                check(formulation != nullptr && formulation->string("kind") == "version",
                      "plan adoption names a version");
                check(formulation != nullptr && formulation->string("versionId") == "formulation-1",
                      "plan adoption version id");
            }
        }
    }

    // ---------------------------------------------------------------------
    // session_status: the thin telemetry the trace panel must read honestly.
    // `latestCacheHitRate` may be null while `tokens` may be null too — both
    // mean "unknown", and neither may be read as zero.
    // ---------------------------------------------------------------------
    {
        Value ev;
        if (parseFixture(kSessionStatus, ev)) {
            const Value* roleStatus = ev.object("roleStatus");
            check(roleStatus != nullptr, "roleStatus object");
            if (roleStatus != nullptr) {
                const Value* epistemic = roleStatus->object("epistemic");
                check(epistemic != nullptr && epistemic->number("latestCacheHitRate", -1.0) == 0.62,
                      "epistemic cache hit rate");
                check(epistemic != nullptr && epistemic->object("model") != nullptr &&
                          epistemic->object("model")->string("id") == "claude-sonnet-5",
                      "epistemic role model");
                const Value* distillation = roleStatus->object("distillation");
                // Null is not zero: the reader's default is what says "unknown".
                check(distillation != nullptr && distillation->find("latestCacheHitRate") != nullptr &&
                          distillation->find("latestCacheHitRate")->isNull(),
                      "a null cache hit rate is present and null");
                check(distillation->number("latestCacheHitRate", -1.0) == -1.0,
                      "a null cache hit rate reads as the unknown default");
            }
            const Value* roleUsage = ev.object("roleUsage");
            check(roleUsage != nullptr, "roleUsage object");
            if (roleUsage != nullptr) {
                check(roleUsage->object("epistemic")->integer("tokens", -1) == 12000, "epistemic token count");
                check(roleUsage->object("execution")->integer("tokens", -1) == -1,
                      "a null token count reads as unknown");
            }
            check(ev.number("cost", -1.0) == 0.0123, "session cost");
        }
    }

    // ---------------------------------------------------------------------
    // A multi-megabyte output field parses in one piece (the Execution.output
    // shape the model truncates for display).
    // ---------------------------------------------------------------------
    {
        std::string big = R"({"type":"ExecutionCompleted","output":")";
        big.append(200000, 'x');
        big += R"(","status":"succeeded"})";
        Value v;
        check(pie::gui::json::parse(big, v, nullptr), "a 200 KB output field parses");
        check(v.string("output").size() == 200000, "the large output is read whole");
        check(v.string("status") == "succeeded", "a field after the large output still reads");
    }

    // ---------------------------------------------------------------------
    // Non-object roots: field readers answer with their default rather than
    // pretending to find something.
    // ---------------------------------------------------------------------
    {
        Value v;
        if (parseFixture(R"([1,2,3])", v)) {
            check(v.isArray(), "array root");
            check(v.find("anything") == nullptr, "find on an array is null");
            check(v.string("anything", "d") == "d", "string on an array falls back");
            check(v.memberCount() == 0, "memberCount on an array is 0");
            check(v.at(1).asInt() == 2, "array element as int");
        }
        if (parseFixture(R"("just a string")", v)) {
            check(v.isString(), "string root");
            check(v.asString() == "just a string", "string root value");
            check(v.size() == 0, "size on a string is 0");
            check(v.asArray().empty(), "asArray on a string is empty");
        }
        if (parseFixture(R"(null)", v)) {
            check(v.isNull(), "null root");
            check(v.asString().empty(), "asString on null is empty");
            check(v.asStringArray().empty(), "asStringArray on null is empty");
        }
        if (parseFixture(R"(true)", v)) {
            check(v.isBool() && v.asBool(), "bool root");
        }
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
