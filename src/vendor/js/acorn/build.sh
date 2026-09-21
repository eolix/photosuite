#!/usr/bin/env bash
# Generate the browser bundle for the acorn submodule (src/vendor/acorn, pinned 3.1.0).
#
# Acorn 3.x ships its source as ES modules under src/ and builds dist/acorn.js with an
# ancient Babel-5/browserify toolchain that no longer runs on modern Node. We bundle the
# same source with esbuild into an IIFE that exposes the global `acorn`. Output is
# verified AST-identical to acorn's own 3.1.0 dist.
#
# Output (committed, so a plain clone needs no rebuild): acorn.js, LICENSE
#
# Re-run after `git submodule update` (needs Node + npx):
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
SUB="../../acorn"

npx --yes esbuild "$SUB/src/index.js" \
  --bundle --format=iife --global-name=acorn --legal-comments=none \
  > ./acorn.js

cp "$SUB/LICENSE" ./LICENSE

# Sanity: the global must parse and report version 3.1.0.
node -e '
  const fs=require("fs");
  const acorn=new Function(fs.readFileSync("./acorn.js","utf8")+"\nreturn acorn;")();
  const ast=acorn.parse("var x=1+2;");
  if(acorn.version!=="3.1.0" || ast.type!=="Program"){console.error("self-test failed");process.exit(1);}
' || { echo "ERROR: acorn.js self-test failed — upstream/esbuild changed; check build.sh" >&2; exit 1; }

echo "built acorn.js (global 'acorn' $(node -e 'process.stdout.write(new Function(require("fs").readFileSync("./acorn.js","utf8")+"\nreturn acorn.version;")())'))"
