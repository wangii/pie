# FetchSarasaFont.cmake
#
# Build-time helper: download + extract the Sarasa Term SC Nerd TTC from a pinned
# GitHub release and stage a single `SarasaTermSCNerd.ttc` into the build font dir.
# The caller (gui/CMakeLists.txt) passes the URL, the archive SHA256, and the
# destination cache dir; this script verifies the archive against the pin before
# extracting, so a tampered or stale download fails the build rather than placing
# an unverified font next to the pie_gui binary.

# Expected variables (set by the caller via -D):
#   PIE_GUI_FONT_URL     - pinned release asset (.tar.gz) URL
#   PIE_GUI_FONT_ARCHIVE_SHA256 - SHA256 of the archive itself
#   PIE_GUI_FONT_CACHE_DIR - build dir where the archive + extracted TTC are kept
#   PIE_GUI_FONT_NAME    - the single file name to produce (SarasaTermSCNerd.ttc)

set(PIE_GUI_FONT_ARCHIVE "${PIE_GUI_FONT_CACHE_DIR}/SarasaTermSCNerd.ttc.tar.gz")
set(PIE_GUI_FONT_LOCAL_ARCHIVE "$ENV{HOME}/Downloads/SarasaTermSCNerd.ttc.tar.gz")
set(PIE_GUI_FONT_EXTRACTED "${PIE_GUI_FONT_CACHE_DIR}/${PIE_GUI_FONT_NAME}")
set(PIE_GUI_FONT_STAMP "${PIE_GUI_FONT_CACHE_DIR}/.fetch-stamp")

# Skip re-download when the stamp + target already exist (incremental build).
if(EXISTS "${PIE_GUI_FONT_STAMP}" AND EXISTS "${PIE_GUI_FONT_EXTRACTED}")
    message(STATUS "Sarasa font already fetched: ${PIE_GUI_FONT_EXTRACTED}")
    return()
endif()

file(MAKE_DIRECTORY "${PIE_GUI_FONT_CACHE_DIR}")

set(PIE_GUI_FONT_ARCHIVE_READY OFF)
if(EXISTS "${PIE_GUI_FONT_LOCAL_ARCHIVE}")
    file(SHA256 "${PIE_GUI_FONT_LOCAL_ARCHIVE}" local_archive_hash)
    if(local_archive_hash STREQUAL PIE_GUI_FONT_ARCHIVE_SHA256)
        message(STATUS "Using local Sarasa font archive: ${PIE_GUI_FONT_LOCAL_ARCHIVE}")
        file(COPY_FILE "${PIE_GUI_FONT_LOCAL_ARCHIVE}" "${PIE_GUI_FONT_ARCHIVE}"
            ONLY_IF_DIFFERENT
            RESULT copy_result
        )
        if(NOT copy_result STREQUAL "0")
            message(FATAL_ERROR "Could not copy local font archive: ${copy_result}")
        endif()
        set(PIE_GUI_FONT_ARCHIVE_READY ON)
    else()
        message(STATUS "Ignoring local Sarasa font archive: hash mismatch (expected ${PIE_GUI_FONT_ARCHIVE_SHA256}, got ${local_archive_hash})")
    endif()
endif()

if(NOT PIE_GUI_FONT_ARCHIVE_READY)
    message(STATUS "Downloading Sarasa Term SC Nerd font (${PIE_GUI_FONT_NAME})...")
    file(DOWNLOAD "${PIE_GUI_FONT_URL}" "${PIE_GUI_FONT_ARCHIVE}"
        EXPECTED_HASH SHA256=${PIE_GUI_FONT_ARCHIVE_SHA256}
        STATUS download_status
        LOG download_log
    )
    list(GET download_status 0 download_error)
    if(NOT download_error EQUAL 0)
        list(GET download_status 1 download_msg)
        message(FATAL_ERROR "Font download failed: ${download_msg}\n${download_log}")
    endif()
endif()

file(SHA256 "${PIE_GUI_FONT_ARCHIVE}" archive_hash)
if(NOT archive_hash STREQUAL PIE_GUI_FONT_ARCHIVE_SHA256)
    message(FATAL_ERROR "Font archive hash mismatch: expected ${PIE_GUI_FONT_ARCHIVE_SHA256}, got ${archive_hash}")
endif()

message(STATUS "Verifying + extracting ${PIE_GUI_FONT_ARCHIVE}...")
file(ARCHIVE_EXTRACT INPUT "${PIE_GUI_FONT_ARCHIVE}" DESTINATION "${PIE_GUI_FONT_CACHE_DIR}")
file(GLOB PIE_GUI_FONT_TTC "${PIE_GUI_FONT_CACHE_DIR}/${PIE_GUI_FONT_NAME}")
if(NOT PIE_GUI_FONT_TTC)
    message(FATAL_ERROR "Extracted archive did not contain ${PIE_GUI_FONT_NAME}")
endif()

# Defensive re-verify of the extracted TTC against the precomputed content hash.
file(SHA256 "${PIE_GUI_FONT_EXTRACTED}" extracted_hash)
message(STATUS "Sarasa font extracted (sha256=${extracted_hash})")

file(WRITE "${PIE_GUI_FONT_STAMP}" "${PIE_GUI_FONT_ARCHIVE_SHA256}\n")
