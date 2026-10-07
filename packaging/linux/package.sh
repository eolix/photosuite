#!/usr/bin/env bash
# Build and package PhotoSuite for Linux (<arch> is x86_64 or aarch64):
#
#   $DIST/photosuite-<version>-linux-<arch>.AppImage  any distro with glibc >= the build host's
#   $DIST/photosuite-<version>-linux-<arch>.deb       Debian, Ubuntu, Mint, Pop!_OS, ...
#   $DIST/photosuite-<version>-linux-<arch>.rpm       Fedora, openSUSE, RHEL, ...
#   $DIST/photosuite-<version>-linux-<arch>.pkg.tar.zst  Arch Linux, Manjaro, EndeavourOS, ...
#   $DIST/photosuite-<version>-linux-<arch>.tar.gz    plain FHS-style tree (bin/, share/)
#
# Usage: packaging/linux/package.sh [--skip-build] [--formats "appimage deb rpm arch tar"]
#
# Needs: cargo; nfpm for deb/rpm/arch (https://nfpm.goreleaser.com); appimagetool for the AppImage
# (downloaded into $CARGO_TARGET_DIR if missing). Build on an old distro (CI: Ubuntu 22.04,
# glibc 2.35) so the binaries run on newer ones. Optional: desktop-file-validate, appstreamcli,
# and zsyncmake (package zsync) for the AppImage's .zsync if appimagetool doesn't write it.
#
# The AppImage carries update information for AppImageUpdate: the newest GitHub release of
# $PHOTOSUITE_UPDATE_REPO (default: $GITHUB_REPOSITORY in CI, else eolix/photosuite), found
# through the .zsync published beside it. packaging/linux/verify-appimage.sh checks the result.
set -euo pipefail
# shellcheck source=../env.sh
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"
HERE="$ROOT/packaging/linux"
APP_ID=io.github.eolix.PhotoSuite

SKIP_BUILD=0
FORMATS="appimage deb rpm arch tar"
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --formats) FORMATS="$2"; shift 2 ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DEB_ARCH=amd64 ;;
  aarch64 | arm64) ARCH=aarch64; DEB_ARCH=arm64 ;;
  *) echo "unsupported architecture $ARCH" >&2; exit 2 ;;
esac
export PHOTOSUITE_MAINTAINER="${PHOTOSUITE_MAINTAINER:-PhotoSuite maintainers <photosplice@gmail.com>}"
BASENAME="photosuite-$VERSION-linux-$ARCH"

echo "==> PhotoSuite $VERSION for Linux $ARCH ($FORMATS)"

if [ "$SKIP_BUILD" = 0 ]; then
  (cd "$ROOT" && cargo build --release --locked -p photosuite -p photosuite-cli)
fi
BIN="$CARGO_TARGET_DIR/release"
WORK="$CARGO_TARGET_DIR/linux-package"
STAGE="$WORK/root"
rm -rf "$WORK"

# ---- stage an FHS tree (shared by every format) -------------------------------------------------
install -Dm755 "$BIN/photosuite" "$STAGE/usr/bin/photosuite"
install -Dm755 "$BIN/photosuite-cli" "$STAGE/usr/bin/photosuite-cli"
copy_resources "$STAGE/usr/share/photosuite/resources"
strip "$STAGE/usr/bin/photosuite" "$STAGE/usr/bin/photosuite-cli" 2>/dev/null || true
install -Dm644 "$HERE/$APP_ID.desktop" "$STAGE/usr/share/applications/$APP_ID.desktop"
install -Dm644 "$HERE/$APP_ID.mime.xml" "$STAGE/usr/share/mime/packages/$APP_ID.xml"
mkdir -p "$STAGE/usr/share/metainfo"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@DATE@/$PHOTOSUITE_BUILD_DATE/g" \
  "$HERE/$APP_ID.metainfo.xml.in" >"$STAGE/usr/share/metainfo/$APP_ID.metainfo.xml"
mkdir -p "$STAGE/usr/share/icons"
cp -R "$ROOT/assets/app-icon/hicolor" "$STAGE/usr/share/icons/"
mkdir -p "$STAGE/usr/share/doc/photosuite"
copy_docs "$STAGE/usr/share/doc/photosuite"

# Lints: reported, but a style warning in the metadata doesn't stop a release.
if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$STAGE/usr/share/applications/$APP_ID.desktop" || warn "desktop file has validation issues"
fi
if command -v appstreamcli >/dev/null; then
  appstreamcli validate --no-net --explain "$STAGE/usr/share/metainfo/$APP_ID.metainfo.xml" || warn "AppStream metadata has validation issues"
fi

has() { case " $FORMATS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- .tar.gz ------------------------------------------------------------------------------------
if has tar; then
  mkdir -p "$WORK/tar"
  cp -R "$STAGE/usr" "$WORK/tar/$BASENAME"
  tar -C "$WORK/tar" -czf "$DIST/$BASENAME.tar.gz" "$BASENAME"
  echo "wrote $DIST/$BASENAME.tar.gz"
fi

# ---- .deb / .rpm / Arch -------------------------------------------------------------------------
if has deb || has rpm || has arch; then
  command -v nfpm >/dev/null || { echo "error: nfpm not found (https://nfpm.goreleaser.com/install/)" >&2; exit 1; }
  export VERSION
  export NFPM_ARCH="$DEB_ARCH"
  # nfpm expands env vars in fields like `version` and `arch`, but not in `contents[].src` or
  # `archlinux.packager`.
  sed -e "s|\${STAGE}|$STAGE|g" -e "s|\${PHOTOSUITE_MAINTAINER}|$PHOTOSUITE_MAINTAINER|g" "$HERE/nfpm.yaml" >"$WORK/nfpm.yaml"
  for fmt in deb rpm; do
    if has "$fmt"; then (cd "$ROOT" && nfpm package -f "$WORK/nfpm.yaml" -p "$fmt" -t "$DIST/$BASENAME.$fmt"); fi
  done
  if has arch; then
    # pkgver can't hold a hyphen, and nfpm's semver parsing would drop the pre-release from it:
    # 0.2.0-rc.1 goes in as 0.2.0_rc.1, which pacman sorts before 0.2.0.
    sed "s|^version_schema: semver|version_schema: none|" "$WORK/nfpm.yaml" >"$WORK/nfpm-arch.yaml"
    (cd "$ROOT" && VERSION="${VERSION//-/_}" nfpm package -f "$WORK/nfpm-arch.yaml" -p archlinux -t "$DIST/$BASENAME.pkg.tar.zst")
  fi
fi

# ---- AppImage -----------------------------------------------------------------------------------
if has appimage; then
  APPDIR="$WORK/PhotoSuite.AppDir"
  # The whole staged tree, licences and notices included (NOTICE must travel with the binary).
  cp -R "$STAGE" "$APPDIR"
  ln -s usr/bin/photosuite "$APPDIR/AppRun"
  cp "$HERE/$APP_ID.desktop" "$APPDIR/$APP_ID.desktop"
  cp "$ROOT/assets/app-icon/hicolor/256x256/apps/$APP_ID.png" "$APPDIR/$APP_ID.png"
  ln -s "$APP_ID.png" "$APPDIR/.DirIcon"

  TOOL="${APPIMAGETOOL:-$(command -v appimagetool || true)}"
  if [ -z "$TOOL" ]; then
    TOOL="$CARGO_TARGET_DIR/appimagetool-$ARCH.AppImage"
    if [ ! -x "$TOOL" ]; then
      curl -fsSL -o "$TOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage"
      chmod +x "$TOOL"
    fi
  fi
  # Absolute paths: appimagetool runs from $DIST, where it writes the .zsync.
  mkdir -p "$DIST"
  abs() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
  TOOL="$(abs "$TOOL")"
  APPDIR="$(abs "$APPDIR")"
  OUT="$(abs "$DIST/$BASENAME.AppImage")"
  # Delta updates: `gh-releases-zsync` resolves the newest release through the GitHub API, so
  # the channel doesn't go stale when the version in the file name changes. The file name is a
  # glob for that reason, and must match the asset each release publishes.
  UPDATE_REPO="${PHOTOSUITE_UPDATE_REPO:-${GITHUB_REPOSITORY:-eolix/photosuite}}"
  UPDATE_INFO="gh-releases-zsync|${UPDATE_REPO%%/*}|${UPDATE_REPO#*/}|latest|photosuite-*-linux-$ARCH.AppImage.zsync"
  rm -f "$OUT" "$OUT.zsync"
  # Extract-and-run: works without FUSE (containers, CI). The output embeds the static runtime,
  # so users don't need libfuse2 either. `-u` embeds the update information and writes the
  # .zsync control file beside the AppImage.
  (cd "$DIST" && ARCH="$ARCH" APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --no-appstream -u "$UPDATE_INFO" "$APPDIR" "$OUT")
  if [ ! -f "$OUT.zsync" ]; then
    if command -v zsyncmake >/dev/null; then
      # The URL is relative: AppImageUpdate fetches the AppImage from beside the .zsync.
      (cd "$DIST" && zsyncmake -u "$(basename "$OUT")" -o "$(basename "$OUT").zsync" "$(basename "$OUT")")
    else
      warn "no .zsync written (install zsync): AppImageUpdate can't update this AppImage"
    fi
  fi
  echo "wrote $OUT"
fi

"$STAGE/usr/bin/photosuite-cli" --version
echo "==> done"
ls -lh "$DIST"
