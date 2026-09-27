#!/usr/bin/env bash
set -euo pipefail

# Dogfood script for the pie2 branch.
#
# Runs pi's CLI with the belief set enabled: the `declare_belief` tool is in the
# active tool set and the live beliefs are appended to the system prompt as a
# [CURRENT BELIEFS] block each turn. The belief set is always on, so no flag is
# needed to experience it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Node strips TypeScript natively; the resolver preloads the tsconfig source
# aliases so `@earendil-works/*` imports resolve to workspace sources.
# --import takes a module specifier, so pass the resolver as a file URL (raw paths break on #, ?, %).
RESOLVER_URL="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$SCRIPT_DIR/packages/pie/src/experimental/source-resolver.ts")"
node --import "$RESOLVER_URL" "$SCRIPT_DIR/packages/pie/src/cli.ts" "$@"