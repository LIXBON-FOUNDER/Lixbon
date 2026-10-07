#!/usr/bin/env bash
# Imprime las viñetas de la sección «## <versión>» de apps/cli/go/CHANGELOG.md.
set -euo pipefail

version="${1:?uso: cli-release-notes.sh <versión>}"
file="$(dirname "$0")/../../apps/cli/go/CHANGELOG.md"

notes=$(awk -v v="$version" '
  { sub(/\r$/, "") }
  $0 == "## " v { on = 1; next }
  /^## / { on = 0 }
  on && /^- / { print }
' "$file")

if [ -z "$notes" ]; then
  echo "apps/cli/go/CHANGELOG.md no tiene una sección «## ${version}» con viñetas («- …»)." >&2
  exit 1
fi
printf '%s\n' "$notes"
