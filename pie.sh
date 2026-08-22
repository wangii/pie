#!/usr/bin/env bash
set -euo pipefail

# Dogfood script for the pie2 branch.
#
# Runs pi's CLI with the belief set enabled: the `declare_belief` tool is in the
# active tool set and the live beliefs are appended to the system prompt as a
# [CURRENT BELIEFS] block each turn. The belief set is always on, so no flag is
# needed to experience it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/node_modules/.bin/tsx" \
	--tsconfig "$SCRIPT_DIR/tsconfig.json" \
	"$SCRIPT_DIR/packages/pie/src/cli.ts" \
	"$@"
