#!/usr/bin/env bash
# Generate the lens correction profile database from the lensfun submodule
# (src/vendor/lensfun). See README.md for the models and coordinate systems.
#
# Lensfun is a C library plus a database. Only the database is used here: the
# corrections are polynomial evaluations that the app already has the pipeline
# for, so there is nothing to link and nothing to compile. The XML is converted
# once into a single JSON the app loads on demand.
#
# Output (committed, so a plain clone needs no rebuild):
#   lens-database.json, LICENSE
#
# The database is CC BY-SA 3.0. The generated JSON is an adaptation of it and
# carries the same licence — hence LICENSE beside it. The app's own source is a
# separate work and is unaffected.
#
# Re-run after `git submodule update` (needs Node):
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
SUB="../../lensfun"

if [ ! -d "$SUB/data/db" ]; then
  echo "ERROR: $SUB/data/db missing — run: git submodule update --init src/vendor/lensfun" >&2
  exit 1
fi

VERSION="lensfun $(git -C "$SUB" describe --tags --always 2>/dev/null || echo unknown)"

node ./convert.mjs "$SUB/data/db" ./lens-database.json "$VERSION"

cp "$SUB/data/COPYING.CC_BY-SA_3.0" ./LICENSE

# Sanity: the database must parse, carry both tables, and a known lens must come
# back with calibration in the documented column order.
node -e '
  const db = JSON.parse(require("fs").readFileSync("./lens-database.json", "utf8"));
  const fail = (why) => { console.error("self-test failed: " + why); process.exit(1); };
  if (!Array.isArray(db.cameras) || db.cameras.length < 500) fail("camera table too small");
  if (!Array.isArray(db.lenses) || db.lenses.length < 500) fail("lens table too small");
  if (db.distortionModels.join(",") !== "poly3,poly5,ptlens") fail("distortion model order changed");

  const lens = db.lenses.find((entry) => entry.model === "Canon EF-S 10-22mm f/3.5-4.5 USM");
  if (!lens) fail("reference lens missing");
  const wide = lens.distortion.find((row) => row[0] === 10);
  if (!wide || wide[1] !== 2) fail("reference lens should be calibrated with ptlens at 10mm");
  if (Math.abs(wide[2] - 0.01986) > 1e-6) fail("ptlens a coefficient drifted");
  if (!lens.vignetting.some((row) => row[0] === 10 && row[1] === 3.5)) fail("vignetting entry missing");

  const camera = db.cameras.find((entry) => entry.model === "Canon EOS 5D Mark III");
  if (!camera || Math.abs(camera.cropFactor - 1) > 0.01) fail("reference camera missing or wrong crop");

  for (const entry of db.lenses) {
    for (const row of entry.distortion || []) {
      if (row.length !== 5 || !row.every(Number.isFinite)) fail("bad distortion row in " + entry.model);
    }
    for (const row of entry.tca || []) {
      if (row.length !== 7 || !row.every(Number.isFinite)) fail("bad tca row in " + entry.model);
    }
    for (const row of entry.vignetting || []) {
      if (row.length !== 6 || !row.every(Number.isFinite)) fail("bad vignetting row in " + entry.model);
    }
  }
' || { echo "ERROR: lens-database.json self-test failed — upstream schema changed; check convert.mjs" >&2; exit 1; }

echo "built lens-database.json ($VERSION)"
