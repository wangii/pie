#include "Json.h"

#include <cmath>
#include <utility>

namespace pie::gui::json {

namespace {

const Value& nullValue() {
    static const Value kNull;
    return kNull;
}

const Array& emptyArray() {
    static const Array kEmpty;
    return kEmpty;
}

const std::string& emptyString() {
    static const std::string kEmpty;
    return kEmpty;
}

// Append one code point to `out` as UTF-8. Lone surrogates (a truncated pair,
// or a `\uD800` written on its own) become U+FFFD rather than a malformed
// sequence: the DOM must never hold bytes that are not valid UTF-8.
void appendUtf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

inline constexpr unsigned kReplacementCodePoint = 0xFFFD;

// 10^k for k in [0, 22]: the largest range where the double is exact, so a
// number whose scale fits here converts with no libm call at all.
constexpr double kPow10[] = {1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,
                             1e8,  1e9,  1e10, 1e11, 1e12, 1e13, 1e14, 1e15,
                             1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};
constexpr int kPow10Count = static_cast<int>(sizeof(kPow10) / sizeof(kPow10[0]));

// Scale `mant` by 10^exp. libm is consulted only outside the
// exactly-representable table range, which no wire event reaches (ordinals,
// probabilities, cache hit rates and token counts all land inside it).
double scaleMantissa(unsigned long long mant, int exp) {
    if (exp == 0) return static_cast<double>(mant);
    const double m = static_cast<double>(mant);
    if (exp > 0) {
        if (exp < kPow10Count) return m * kPow10[exp];
        return m * std::pow(10.0, static_cast<double>(exp));
    }
    const int neg = -exp;
    if (neg < kPow10Count) return m / kPow10[neg];
    return m / std::pow(10.0, static_cast<double>(neg));
}

} // namespace

// ---------------------------------------------------------------------------
// Recursive-descent parser
//
// Defined at namespace scope (not in the anonymous namespace above) because
// Value befriends `pie::gui::json::Parser` to fill its private storage while
// parsing — that friendship is what lets the parsed DOM be immutable to every
// other consumer.
// ---------------------------------------------------------------------------

class Parser {
public:
    Parser(std::string_view text, ParseError* error) : s_(text), err_(error) {}

    bool run(Value& out) {
        Value parsed;
        skipWs();
        if (!parseValue(parsed, 0)) return false;
        skipWs();
        if (pos_ != s_.size()) return fail("trailing content after the top-level value");
        out = std::move(parsed);
        return true;
    }

private:
    std::string_view s_;
    size_t pos_ = 0;
    ParseError* err_ = nullptr;

    bool fail(std::string message) {
        if (err_ != nullptr && err_->message.empty()) {
            err_->offset = pos_;
            err_->message = std::move(message);
        }
        return false;
    }

    bool eof() const { return pos_ >= s_.size(); }
    char peek() const { return pos_ < s_.size() ? s_[pos_] : '\0'; }

    void skipWs() {
        while (pos_ < s_.size()) {
            const char c = s_[pos_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++pos_;
            else break;
        }
    }

    bool literal(std::string_view word) {
        if (s_.size() - pos_ < word.size()) return false;
        if (s_.compare(pos_, word.size(), word) != 0) return false;
        pos_ += word.size();
        return true;
    }

    bool parseValue(Value& out, int depth) {
        if (depth > kMaxDepth) return fail("maximum nesting depth exceeded");
        if (eof()) return fail("unexpected end of input");
        switch (peek()) {
            case '{': return parseObject(out, depth);
            case '[': return parseArray(out, depth);
            case '"': {
                std::string text;
                if (!parseString(text)) return false;
                out.kind_ = Kind::String;
                out.string_ = std::move(text);
                return true;
            }
            case 't':
                if (!literal("true")) return fail("invalid literal");
                out.kind_ = Kind::Bool;
                out.bool_ = true;
                return true;
            case 'f':
                if (!literal("false")) return fail("invalid literal");
                out.kind_ = Kind::Bool;
                out.bool_ = false;
                return true;
            case 'n':
                if (!literal("null")) return fail("invalid literal");
                out.kind_ = Kind::Null;
                return true;
            default:
                if (peek() == '-' || (peek() >= '0' && peek() <= '9')) return parseNumber(out);
                return fail("unexpected character");
        }
    }

    bool parseObject(Value& out, int depth) {
        ++pos_;  // '{'
        std::vector<std::string> keys;
        std::vector<Value> members;
        skipWs();
        if (peek() == '}') {
            ++pos_;
            out.kind_ = Kind::Object;
            out.keys_ = std::move(keys);
            out.members_ = std::move(members);
            return true;
        }
        while (true) {
            skipWs();
            if (peek() != '"') return fail("object key must be a string");
            std::string key;
            if (!parseString(key)) return false;
            skipWs();
            if (peek() != ':') return fail("expected ':' after object key");
            ++pos_;
            skipWs();
            Value member;
            if (!parseValue(member, depth + 1)) return false;
            // A duplicated key keeps its first position and takes the last
            // value, matching JSON.parse rather than growing the object.
            bool replaced = false;
            for (size_t i = 0; i < keys.size(); ++i) {
                if (keys[i] == key) {
                    members[i] = std::move(member);
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                keys.push_back(std::move(key));
                members.push_back(std::move(member));
            }
            skipWs();
            const char c = peek();
            if (c == ',') {
                ++pos_;
                continue;
            }
            if (c == '}') {
                ++pos_;
                out.kind_ = Kind::Object;
                out.keys_ = std::move(keys);
                out.members_ = std::move(members);
                return true;
            }
            return fail("expected ',' or '}' in object");
        }
    }

    bool parseArray(Value& out, int depth) {
        ++pos_;  // '['
        Array elements;
        skipWs();
        if (peek() == ']') {
            ++pos_;
            out.kind_ = Kind::Array;
            out.elements_ = std::move(elements);
            return true;
        }
        while (true) {
            skipWs();
            Value element;
            if (!parseValue(element, depth + 1)) return false;
            elements.push_back(std::move(element));
            skipWs();
            const char c = peek();
            if (c == ',') {
                ++pos_;
                continue;
            }
            if (c == ']') {
                ++pos_;
                out.kind_ = Kind::Array;
                out.elements_ = std::move(elements);
                return true;
            }
            return fail("expected ',' or ']' in array");
        }
    }

    bool parseHex4(unsigned& value) {
        if (s_.size() - pos_ < 4) return false;
        unsigned acc = 0;
        for (int i = 0; i < 4; ++i) {
            const char h = s_[pos_ + static_cast<size_t>(i)];
            unsigned digit;
            if (h >= '0' && h <= '9') digit = static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') digit = static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') digit = static_cast<unsigned>(h - 'A' + 10);
            else return false;
            acc = acc * 16 + digit;
        }
        pos_ += 4;
        value = acc;
        return true;
    }

    bool parseString(std::string& out) {
        ++pos_;  // opening quote
        out.clear();
        while (true) {
            if (eof()) return fail("unterminated string");
            const char c = s_[pos_];
            if (c == '"') {
                ++pos_;
                return true;
            }
            if (c == '\\') {
                ++pos_;
                if (eof()) return fail("unterminated escape");
                const char e = s_[pos_++];
                switch (e) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u': {
                        unsigned cp = 0;
                        if (!parseHex4(cp)) return fail("invalid \\u escape");
                        if (cp >= 0xD800 && cp <= 0xDBFF) {
                            // A high surrogate is only meaningful with its low
                            // half; a bare one becomes U+FFFD.
                            bool paired = false;
                            if (pos_ + 1 < s_.size() && s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
                                const size_t save = pos_;
                                pos_ += 2;
                                unsigned low = 0;
                                if (parseHex4(low) && low >= 0xDC00 && low <= 0xDFFF) {
                                    const unsigned combined =
                                        0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                                    appendUtf8(out, combined);
                                    paired = true;
                                } else {
                                    pos_ = save;
                                }
                            }
                            if (!paired) appendUtf8(out, kReplacementCodePoint);
                        } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                            appendUtf8(out, kReplacementCodePoint);
                        } else {
                            appendUtf8(out, cp);
                        }
                        break;
                    }
                    default: return fail("invalid escape sequence");
                }
                continue;
            }
            // A raw control character is not legal JSON; rejecting it keeps the
            // DOM free of bytes a JSON writer would have escaped.
            if (static_cast<unsigned char>(c) < 0x20) return fail("unescaped control character in string");
            out += c;
            ++pos_;
        }
    }

    // JSON number grammar: -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
    // Deliberately strict: no leading '+', no leading zeros, no Infinity/NaN.
    // Manual rather than strtod() because strtod's decimal point is
    // locale-dependent and a GUI must not parse differently under a user locale.
    bool parseNumber(Value& out) {
        bool negative = false;
        if (peek() == '-') {
            negative = true;
            ++pos_;
        }
        if (eof()) return fail("truncated number");
        // Up to 19 significant digits: a double's exact integer range is 2^53,
        // so 19 covers every wire integer; further digits fold into the decimal
        // exponent instead of being silently dropped.
        unsigned long long mant = 0;
        int digits = 0;
        int exp10 = 0;

        if (peek() == '0') {
            ++pos_;
            if (!eof() && peek() >= '0' && peek() <= '9') return fail("leading zero in number");
        } else if (peek() >= '1' && peek() <= '9') {
            while (!eof() && peek() >= '0' && peek() <= '9') {
                if (digits < 19) {
                    mant = mant * 10ULL + static_cast<unsigned long long>(peek() - '0');
                    ++digits;
                } else {
                    ++exp10;
                }
                ++pos_;
            }
        } else {
            return fail("invalid number");
        }

        if (!eof() && peek() == '.') {
            ++pos_;
            const size_t fracStart = pos_;
            while (!eof() && peek() >= '0' && peek() <= '9') {
                if (digits < 19) {
                    mant = mant * 10ULL + static_cast<unsigned long long>(peek() - '0');
                    ++digits;
                    --exp10;
                }
                ++pos_;
            }
            if (pos_ == fracStart) return fail("fractional part has no digits");
        }

        if (!eof() && (peek() == 'e' || peek() == 'E')) {
            ++pos_;
            int expSign = 1;
            if (!eof() && (peek() == '+' || peek() == '-')) {
                if (peek() == '-') expSign = -1;
                ++pos_;
            }
            const size_t expStart = pos_;
            long expVal = 0;
            while (!eof() && peek() >= '0' && peek() <= '9') {
                if (expVal < 100000) expVal = expVal * 10 + (peek() - '0');
                ++pos_;
            }
            if (pos_ == expStart) return fail("exponent has no digits");
            exp10 += static_cast<int>(expSign * expVal);
        }

        double value = scaleMantissa(mant, exp10);
        if (negative) value = -value;
        out.kind_ = Kind::Number;
        out.number_ = value;
        return true;
    }
};

// ---------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------

const char* Value::kindName() const {
    switch (kind_) {
        case Kind::Null: return "null";
        case Kind::Bool: return "bool";
        case Kind::Number: return "number";
        case Kind::String: return "string";
        case Kind::Array: return "array";
        case Kind::Object: return "object";
    }
    return "unknown";
}

std::int64_t Value::asInt(std::int64_t def) const {
    if (kind_ != Kind::Number) return def;
    // Truncate toward zero, matching an integer coercion rather than rounding,
    // so a 1.0-valued ordinal and a 1 ordinal agree.
    const double truncated = number_ < 0 ? std::ceil(number_) : std::floor(number_);
    if (truncated > 9.2e18 || truncated < -9.2e18) return def;
    return static_cast<std::int64_t>(truncated);
}

const std::string& Value::asString() const {
    return kind_ == Kind::String ? string_ : emptyString();
}

const Array& Value::asArray() const { return kind_ == Kind::Array ? elements_ : emptyArray(); }

std::vector<std::string> Value::asStringArray() const {
    std::vector<std::string> out;
    if (kind_ != Kind::Array) return out;
    out.reserve(elements_.size());
    for (const Value& element : elements_) {
        if (element.isString()) out.push_back(element.asString());
    }
    return out;
}

size_t Value::size() const { return kind_ == Kind::Array ? elements_.size() : 0; }

const Value& Value::at(size_t index) const {
    if (kind_ != Kind::Array || index >= elements_.size()) return nullValue();
    return elements_[index];
}

size_t Value::memberCount() const { return kind_ == Kind::Object ? keys_.size() : 0; }

std::string_view Value::memberKey(size_t index) const {
    if (kind_ != Kind::Object || index >= keys_.size()) return std::string_view{};
    return keys_[index];
}

const Value& Value::memberValue(size_t index) const {
    if (kind_ != Kind::Object || index >= members_.size()) return nullValue();
    return members_[index];
}

const Value* Value::find(std::string_view key) const {
    if (kind_ != Kind::Object) return nullptr;
    const Value* found = nullptr;
    // Last occurrence wins; the parser already collapses duplicates, but a
    // defensively-built object may not have.
    for (size_t i = 0; i < keys_.size(); ++i) {
        if (keys_[i] == key) found = &members_[i];
    }
    return found;
}

bool Value::has(std::string_view key) const {
    const Value* v = find(key);
    return v != nullptr && !v->isNull();
}

std::string Value::string(std::string_view key, std::string def) const {
    const Value* v = find(key);
    if (v == nullptr || !v->isString()) return def;
    return v->asString();
}

double Value::number(std::string_view key, double def) const {
    const Value* v = find(key);
    if (v == nullptr || !v->isNumber()) return def;
    return v->asNumber(def);
}

std::int64_t Value::integer(std::string_view key, std::int64_t def) const {
    const Value* v = find(key);
    if (v == nullptr || !v->isNumber()) return def;
    return v->asInt(def);
}

bool Value::boolean(std::string_view key, bool def) const {
    const Value* v = find(key);
    if (v == nullptr || !v->isBool()) return def;
    return v->asBool(def);
}

const Value* Value::object(std::string_view key) const {
    const Value* v = find(key);
    return (v != nullptr && v->isObject()) ? v : nullptr;
}

const Value* Value::array(std::string_view key) const {
    const Value* v = find(key);
    return (v != nullptr && v->isArray()) ? v : nullptr;
}

std::vector<std::string> Value::stringArray(std::string_view key) const {
    const Value* v = find(key);
    return v == nullptr ? std::vector<std::string>{} : v->asStringArray();
}

std::vector<const Value*> Value::objectArray(std::string_view key) const {
    std::vector<const Value*> out;
    const Value* v = find(key);
    if (v == nullptr || !v->isArray()) return out;
    out.reserve(v->elements_.size());
    for (const Value& element : v->elements_) {
        if (element.isObject()) out.push_back(&element);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

bool parse(std::string_view text, Value& out, ParseError* error) {
    if (error != nullptr) *error = ParseError{};
    Parser parser(text, error);
    Value parsed;
    if (!parser.run(parsed)) {
        out = Value();
        return false;
    }
    out = std::move(parsed);
    return true;
}

bool parseLine(std::string_view line, Value& out, ParseError* error) {
    // Strip a UTF-8 BOM: a transcript written by another tool can carry one, and
    // those three bytes are not JSON whitespace.
    if (line.size() >= 3 && static_cast<unsigned char>(line[0]) == 0xEF &&
        static_cast<unsigned char>(line[1]) == 0xBB && static_cast<unsigned char>(line[2]) == 0xBF) {
        line.remove_prefix(3);
    }
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.remove_suffix(1);
    return parse(line, out, error);
}

} // namespace pie::gui::json
