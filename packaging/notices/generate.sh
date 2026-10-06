#!/usr/bin/env bash
# Regenerate THIRD-PARTY-CRATES.md from Cargo.lock: the licences of every Rust crate linked into
# the shipped binaries. Run after changing dependencies. Needs cargo-about
# (`cargo install --locked cargo-about --features cli`) and python3.
#
#   packaging/notices/generate.sh           # rewrite THIRD-PARTY-CRATES.md
#   packaging/notices/generate.sh --check   # fail if it is out of date
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/THIRD-PARTY-CRATES.md"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
(cd "$HERE" && cargo about generate -c about.toml --workspace --locked --fail \
  -m "$ROOT/Cargo.toml" --format json) | python3 "$HERE/render.py" > "$tmp"

if [ "${1:-}" = "--check" ]; then
  if ! cmp -s "$tmp" "$OUT"; then
    echo "THIRD-PARTY-CRATES.md is out of date: run packaging/notices/generate.sh" >&2
    exit 1
  fi
  echo "THIRD-PARTY-CRATES.md is up to date"
else
  chmod 644 "$tmp"
  mv "$tmp" "$OUT"
  trap - EXIT
  echo "wrote $OUT"
fi
