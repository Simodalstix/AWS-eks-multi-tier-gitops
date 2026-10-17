#!/bin/bash
# Builds docs/study/index.html from docs/adr, runbooks and docs/notes.
# Conventions: docs/notes/README.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "node (18 or later) is required." >&2; exit 1; }

exec node "$SCRIPT_DIR/build-study.mjs" "$@"
