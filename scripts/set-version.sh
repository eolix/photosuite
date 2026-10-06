#!/usr/bin/env bash
# Set the application version everywhere it is defined.
#
#   scripts/set-version.sh 1.0.0         # set it
#   scripts/set-version.sh 1.0.0-rc.1    # pre-releases are fine
#   scripts/set-version.sh               # print the current version
#
# There is one source of truth: `version` under [workspace.package] in Cargo.toml. Every crate
# inherits it (`version.workspace = true`), the build reads it into build_info::VERSION, and the
# packaging scripts derive theirs from it (packaging/env.sh). Cargo.lock records it for each
# workspace crate, so it is refreshed for those crates only; no dependency is upgraded.
#
# Nothing is committed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

current() {
  awk '/^\[workspace\.package\]/ {p=1; next} /^\[/ {p=0} p && /^version *=/ {gsub(/[" ]/, "", $3); print $3; exit}' Cargo.toml
}

if [ $# -eq 0 ]; then
  current
  exit 0
fi

new="$1"
if ! printf '%s' "$new" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "error: '$new' is not a version like 1.2.3 or 1.2.3-rc.1" >&2
  exit 1
fi
old="$(current)"
if [ -z "$old" ]; then
  echo "error: no version under [workspace.package] in Cargo.toml" >&2
  exit 1
fi
if [ "$old" = "$new" ]; then
  echo "already $new"
  exit 0
fi

# Only the line inside [workspace.package]; dependency versions elsewhere are left alone.
awk -v new="$new" '
  /^\[workspace\.package\]/ {p=1; print; next}
  /^\[/ {p=0}
  p && /^version *=/ && !done {print "version = \"" new "\""; done=1; next}
  {print}
' Cargo.toml > Cargo.toml.tmp && mv Cargo.toml.tmp Cargo.toml

# Refresh the workspace crates' entries in Cargo.lock without touching anything else.
cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace >/dev/null

echo "version $old -> $(current)"
git --no-pager diff --stat -- Cargo.toml Cargo.lock 2>/dev/null || true
