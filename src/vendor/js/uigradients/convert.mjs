#!/usr/bin/env node
// Converts the vendored uiGradients data snapshot (gradients.json, MIT
// licensed, see LICENSE/README.md in this folder) into
// src/resources/libraries/extra_gradients.grd.
//
// Invoked by build.sh; re-run after bumping the pin in README.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installBrowserGlobals } from "../../../../tests/helpers/stub-browser-globals.js";
installBrowserGlobals();

const { GradientFile } = await import("../../../features/gradient/gradient-file.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const SRC_JSON = path.join(__dirname, "gradients.json");
const OUT_FILE = path.join(ROOT, "src/resources/libraries/extra_gradients.grd");

/** Full-precision location range PSD gradient stops are laid out over. */
const LOCATION_RANGE = 4096;

function hexToRgbDoubles(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function buildColorStop(hex, location) {
  const { r, g, b } = hexToRgbDoubles(hex);
  return {
    t: "Objc",
    v: {
      classID: "Clrt",
      Clr: {
        t: "Objc",
        v: {
          classID: "RGBC",
          Rd: { t: "doub", v: r },
          Grn: { t: "doub", v: g },
          Bl: { t: "doub", v: b },
        },
      },
      Type: { t: "enum", v: { Clry: "UsrS" } },
      Lctn: { t: "long", v: location },
      Mdpn: { t: "long", v: 50 },
    },
  };
}

function buildOpacityStop(location) {
  return {
    t: "Objc",
    v: {
      classID: "TrnS",
      Opct: { t: "UntF", v: { type: "#Prc", val: 100 } },
      Lctn: { t: "long", v: location },
      Mdpn: { t: "long", v: 50 },
    },
  };
}

function uiGradientToDescriptor(entry) {
  const colorCount = entry.colors.length;
  const colorStops = entry.colors.map((hex, idx) =>
    buildColorStop(hex, Math.round((idx * LOCATION_RANGE) / (colorCount - 1))),
  );
  return {
    classID: "Grdn",
    Nm: { t: "TEXT", v: entry.name },
    GrdF: { t: "enum", v: { GrdF: "CstS" } },
    Intr: { t: "doub", v: LOCATION_RANGE },
    Clrs: { t: "VlLs", v: colorStops },
    Trns: { t: "VlLs", v: [buildOpacityStop(0), buildOpacityStop(LOCATION_RANGE)] },
  };
}

const entries = JSON.parse(fs.readFileSync(SRC_JSON, "utf8"));
const gradients = entries.filter((entry) => entry.colors.length >= 2).map(uiGradientToDescriptor);
console.log(`Built ${gradients.length} gradients (of ${entries.length} source entries).`);

const bytes = Buffer.from(GradientFile.serialize(gradients));
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, bytes);
console.log(`Wrote ${OUT_FILE} (${bytes.length} bytes).`);

const reparsed = GradientFile.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
console.log(`Round-trip parsed ${reparsed.length} gradients.`);
if (reparsed.length !== gradients.length) {
  console.error("MISMATCH between built and reparsed gradient counts!");
  process.exitCode = 1;
}
