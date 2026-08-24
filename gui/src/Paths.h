// PIE Native GUI - platform path helpers.
//
// Locate the binary directory (so assets copied next to the executable resolve
// regardless of cwd) and derive the Sarasa font path. Kept out of any UI
// component so it can be reused and unit-tested without a window.
#pragma once

#include <string>

namespace pie::gui {

// Directory containing the running pie_gui executable (platform-native API).
std::string executableDirectory();

// Absolute path to the Sarasa Term SC Nerd TTC copied next to the binary.
std::string fontPath();

} // namespace pie::gui
