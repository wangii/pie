// PIE Native GUI - platform path helpers.
#include "Paths.h"

#include <filesystem>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

namespace pie::gui {

std::string executableDirectory() {
    std::error_code ec;
#if defined(_WIN32)
    std::vector<wchar_t> buf(32768);
    DWORD n = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    if (n == 0 || n >= buf.size()) return {};
    std::filesystem::path p(buf.data());
    return std::filesystem::absolute(p).parent_path().string();
#elif defined(__APPLE__)
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buf(size);
    if (_NSGetExecutablePath(buf.data(), &size) != 0) return {};
    std::filesystem::path p = std::filesystem::canonical(buf.data(), ec);
    return (ec ? std::filesystem::path(buf.data()) : p).parent_path().string();
#else
    // Linux/other: /proc/self/exe.
    std::filesystem::path p = std::filesystem::canonical("/proc/self/exe", ec);
    if (ec) return {};
    return p.parent_path().string();
#endif
}

std::string fontPath() {
    return (std::filesystem::path(executableDirectory()) / "SarasaTermSCNerd.ttc").string();
}

} // namespace pie::gui
