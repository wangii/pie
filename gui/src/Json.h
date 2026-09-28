// Json: a small, dependency-free JSON DOM for the PIE native GUI.
//
// Why hand-written rather than vendored: gui/ must stay buildable offline (no
// new FetchContent — the same reason `imgui-node-editor` was rejected), and the
// shapes this GUI actually reads are few enough that tests written against them
// are worth more than a library's generality. See `docs/milestones.md` §5.1.
//
// The previous model layer scanned raw strings for the first `"key"` occurrence
// (Model.cpp's findKey), which is position-agnostic and therefore wrong for
// nested payloads: `tasks:[{id:"a"},{id:"b"}]` read every task's id as "a". A
// structured parser removes that whole class of bug.
//
// Discipline (docs/milestones.md §5.1):
//   * Parsing NEVER throws and NEVER aborts. Any malformed input returns false
//     with a ParseError; a caller degrades to a ReplayIssue, which is the wire
//     boundary's price for "the GUI only replays, it never infers".
//   * Depth is capped at kMaxDepth so a pathological payload cannot exhaust the
//     stack (the parser is recursive descent).
//   * The DOM is read-only once parsed. There is no construction and no mutation
//     API: a Value is a parse product, so a consumer cannot edit the event it is
//     projecting and nothing can build one by hand and get the ordering wrong.

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace pie::gui::json {

class Value;
class Parser;

// A JSON array. `std::vector<Value>` on an incomplete `Value` is exactly the
// case the standard blesses for std::vector, so this alias is well-formed here
// and Value can own one directly.
using Array = std::vector<Value>;

enum class Kind {
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
};

// Parse recursion cap. A JSONL event line is never close to this; it exists so
// hostile or corrupted input fails instead of running the stack out.
inline constexpr int kMaxDepth = 256;

// A parse failure. `offset` is the byte offset in the input where parsing gave
// up, so a fixture author can find it.
struct ParseError {
    size_t offset = 0;
    std::string message;
};

class Value {
public:
    Value() = default;  // Null
    Value(const Value&) = default;
    Value(Value&&) = default;
    Value& operator=(const Value&) = default;
    Value& operator=(Value&&) = default;
    ~Value() = default;

    Kind kind() const { return kind_; }
    bool isNull() const { return kind_ == Kind::Null; }
    bool isBool() const { return kind_ == Kind::Bool; }
    bool isNumber() const { return kind_ == Kind::Number; }
    bool isString() const { return kind_ == Kind::String; }
    bool isArray() const { return kind_ == Kind::Array; }
    bool isObject() const { return kind_ == Kind::Object; }

    const char* kindName() const;

    // ---------------------------------------------------------------------
    // Scalar readers. `as*` return the supplied default when the kind does not
    // match, so a wrong-shaped field degrades to "absent" instead of crashing.
    // ---------------------------------------------------------------------
    bool asBool(bool def = false) const { return kind_ == Kind::Bool ? bool_ : def; }
    double asNumber(double def = 0.0) const { return kind_ == Kind::Number ? number_ : def; }
    // Truncates toward zero; returns `def` when this is not a number or is out
    // of int64 range.
    std::int64_t asInt(std::int64_t def = 0) const;
    // Empty when this is not a string.
    const std::string& asString() const;
    // Empty when this is not an array.
    const Array& asArray() const;
    // Every element read as a string; non-string elements are skipped and a
    // non-array yields an empty vector.
    std::vector<std::string> asStringArray() const;

    // ---------------------------------------------------------------------
    // Array access
    // ---------------------------------------------------------------------
    // Array length, or 0 when this is not an array.
    size_t size() const;
    // Element by index; a Null value when out of range or not an array.
    const Value& at(size_t index) const;

    // ---------------------------------------------------------------------
    // Object access
    // ---------------------------------------------------------------------
    // Number of members, or 0 when this is not an object.
    size_t memberCount() const;
    // Member key / value by position. Empty key and Null value when out of
    // range. Wire order is preserved, so iteration is deterministic.
    std::string_view memberKey(size_t index) const;
    const Value& memberValue(size_t index) const;

    // Member lookup by key. nullptr when absent or when this is not an object.
    // On a duplicated key the last occurrence wins, matching JSON.parse.
    const Value* find(std::string_view key) const;
    // True when the member is present and not JSON null. This is what separates
    // "absent" from "present and null" for optional wire fields.
    bool has(std::string_view key) const;

    // ---------------------------------------------------------------------
    // Field readers for objects. Each returns `def` when the member is absent
    // or is not of the requested kind, so an applier reads
    // `event.string("episodeId")` and gets "" rather than a half-filled struct.
    // ---------------------------------------------------------------------
    std::string string(std::string_view key, std::string def = {}) const;
    double number(std::string_view key, double def = 0.0) const;
    std::int64_t integer(std::string_view key, std::int64_t def = 0) const;
    bool boolean(std::string_view key, bool def = false) const;
    // nullptr when the member is absent or of another kind.
    const Value* object(std::string_view key) const;
    const Value* array(std::string_view key) const;
    // String-array field (["a","b"]); empty when absent or not an array.
    std::vector<std::string> stringArray(std::string_view key) const;
    // Array-of-objects field (the shape of `resultingBeliefs`, `trajectory`,
    // `sources`): borrowed pointers into this value, empty when absent.
    std::vector<const Value*> objectArray(std::string_view key) const;

private:
    friend class Parser;

    Kind kind_ = Kind::Null;
    bool bool_ = false;
    double number_ = 0.0;
    std::string string_;
    Array elements_;                 // Array elements
    std::vector<std::string> keys_;  // Object member names, in wire order
    std::vector<Value> members_;     // Object member values, parallel to keys_
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Parse one complete JSON text. Surrounding whitespace is allowed; trailing
// non-whitespace content is an error, because a JSONL line must be exactly one
// value. On success `out` holds the value and `error` is untouched. On failure
// `out` is left as Null and `error` (when non-null) describes the first problem.
bool parse(std::string_view text, Value& out, ParseError* error = nullptr);

// Parse a JSONL event line: identical to parse() except that a leading UTF-8
// BOM and a trailing newline / CRLF from a piped stream are tolerated.
bool parseLine(std::string_view line, Value& out, ParseError* error = nullptr);

} // namespace pie::gui::json
