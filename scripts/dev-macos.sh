#!/bin/sh
# Build and run the desktop app on macOS for development.
#
#   scripts/dev-macos.sh                      # run, empty workspace
#   scripts/dev-macos.sh some/file.psd        # run, opening a file
#   PROFILE=release scripts/dev-macos.sh      # optimised run (no live design tokens)
#   CHECK=1 scripts/dev-macos.sh              # typecheck only, no run (fastest feedback)
#
# Default profile is `devfast` (see Cargo.toml): debug_assertions stay on, so the
# PHOTOSUITE_THEME_FILE live design-token overrides work, while the pixel crates and
# dependencies are optimised enough to be interactive.
#
# The first build of a cold tree compiles the whole dependency graph and takes a while.
# Later builds are incremental.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script targets macOS; on other platforms use cargo directly (docs/development.md)." >&2
  exit 1
fi

command -v cargo >/dev/null 2>&1 || {
  echo "cargo not found. Install Rust: https://rustup.rs" >&2
  exit 1
}

PROFILE=${PROFILE:-devfast}
case "$PROFILE" in
  devfast) PROFILE_FLAG="--profile devfast" ;;
  release) PROFILE_FLAG="--release" ;;
  dev)     PROFILE_FLAG="" ;;
  *)       PROFILE_FLAG="--profile $PROFILE" ;;
esac

# Live design tokens: edit tokens.json while the app runs to retune theme::Tokens with no
# recompile. Only effective in debug_assertions builds, so not with PROFILE=release.
if [ -f tokens.json ]; then
  PHOTOSUITE_THEME_FILE=$ROOT/tokens.json
  export PHOTOSUITE_THEME_FILE
  echo "live design tokens: $PHOTOSUITE_THEME_FILE"
  case "$PROFILE" in
    release) echo "  (ignored: compiled out of release builds)" >&2 ;;
  esac
fi

if [ "${CHECK:-0}" = "1" ]; then
  echo "typechecking workspace ($PROFILE)…"
  # shellcheck disable=SC2086
  exec cargo check --workspace $PROFILE_FLAG
fi

echo "building photosuite ($PROFILE)…"
# shellcheck disable=SC2086
cargo build $PROFILE_FLAG -p photosuite

# Run it from inside a minimal .app bundle: outside one, macOS names the app after the process
# (`photosuite`) in the menu bar, the Dock and the App menu, instead of CFBundleName.
case "$PROFILE" in
  dev) OUT_DIR=debug ;;
  *)   OUT_DIR=$PROFILE ;;
esac
TARGET=${CARGO_TARGET_DIR:-$ROOT/target}
APP=$TARGET/$OUT_DIR/PhotoSuite.app
VERSION=$(awk '/^\[/{p=($0=="[workspace.package]");next} p&&$1=="version"{gsub(/[" ]/,"",$3);print $3;exit}' Cargo.toml)
mkdir -p "$APP/Contents/MacOS"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@SHORT_VERSION@/${VERSION%%-*}/g" -e "s/@BUILD_SHA@/dev/g" \
  packaging/macos/Info.plist.in >"$APP/Contents/Info.plist"
# A hard link, not a copy or symlink: cheap, and the bundle sees its own executable path.
ln -f "$TARGET/$OUT_DIR/photosuite" "$APP/Contents/MacOS/PhotoSuite"
echo "running $APP"
exec "$APP/Contents/MacOS/PhotoSuite" "$@"
