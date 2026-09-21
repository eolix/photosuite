#!/usr/bin/env bash
# Regenerate pdfjs-codecs.js from Mozilla pdf.js — extracting the pure-JS image
# decoders (jpg/jpx/jbig2) as-is from upstream.
#
# It sparse + partial clones ONLY pdf.js's src/ at a pinned tag (~6 MB, skipping the
# huge test-PDF corpus — a full clone or submodule would be hundreds of MB) into
# src/vendor/pdfjs/ (gitignored), then esbuild-bundles the three decoders into the
# global `PDFJS` (JpegImage / JpxImage / Jbig2Image).
#
# Pinned to v2.16.105: the last pdf.js line where jpg/jpx/jbig2 are all JavaScript
# (v4+ moved JpxImage/Jbig2 to WASM) and the API matches the app's usage
# (getData({…,isSourcePDF}), JpxImage.parse()+.tiles, Jbig2Image.parseChunks()).
# JPEG decode output verified identical to the previous hand-extracted slice.
#
# Output (committed, so a plain clone needs no rebuild): pdfjs-codecs.js, LICENSE
#
# Re-run (needs Node + npx + network):
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
TAG="v2.16.105"
SRC="../../pdfjs"

if [ ! -e "$SRC/.git" ]; then
  rm -rf "$SRC"
  git clone --depth 1 --filter=blob:none --sparse --branch "$TAG" \
    https://github.com/mozilla/pdf.js "$SRC"
  git -C "$SRC" sparse-checkout set src
else
  git -C "$SRC" sparse-checkout set src
fi
echo "pdf.js src at $(git -C "$SRC" describe --tags 2>/dev/null || echo "$TAG")"

# src/shared/compatibility.js only require()s core-js polyfills for legacy browsers;
# it's not decoder code and isn't resolvable/needed here, so blank it out.
: > "$SRC/src/shared/compatibility.js"

cp "$SRC/LICENSE" ./LICENSE

# The PDFJSDev banner makes pdf.js's `typeof PDFJSDev === "undefined" || PDFJSDev.test(...)`
# dev-only guards evaluate false, stripping the assert/debug blocks (a production build).
npx --yes esbuild entry.js --bundle --format=iife --legal-comments=none \
  --banner:js='var PDFJSDev={test:function(){return false}};' > ./pdfjs-codecs.js

node -e 'global.globalThis=global;
  new Function(require("fs").readFileSync("./pdfjs-codecs.js","utf8"))();
  const P=globalThis.PDFJS;
  if(typeof new P.JpegImage().getData!=="function" || typeof new P.JpxImage().parse!=="function"
     || typeof new P.Jbig2Image().parseChunks!=="function"){console.error("self-test failed");process.exit(1);}' \
  || { echo "ERROR: pdfjs-codecs.js self-test failed — pdf.js/esbuild changed; check build.sh" >&2; exit 1; }

echo "built pdfjs-codecs.js (global PDFJS) from pdf.js $TAG"
