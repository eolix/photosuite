#!/usr/bin/env node
/**
 * Regenerates src/document/formats/psd/psd-descriptor-catalog.md from descriptor
 * literals in src/ (excluding external/ and vendor/).
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "src/document/formats/psd/psd-descriptor-catalog.md");
const SRC = path.join(ROOT, "src");

const SKIP_DIR = new Set(["external", "vendor"]);

const classRe = /classID["']?\s*:\s*["']([^"']+)["']/g;
const keyTypeRe = /\b([A-Za-z][A-Za-z0-9_$]{0,40})\s*:\s*\{\s*t:\s*["']([^"']+)["']/g;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (entry.endsWith(".js")) files.push(full);
  }
  return files;
}

function bucketClassId(cid) {
  const adjustments = new Set([
    "BanW", "BrgC", "ChMx", "ChnM", "ClrB", "Clrt", "colorLookup", "Crvs", "Exps",
    "Grdn", "GrMp", "GdMp", "Hst2", "HStr", "Invr", "Lvls", "photoFilter", "Pstr",
    "RplC", "SlcC", "Thrs", "TrnS", "vibrance", "brit", "levl", "hue2"
  ]);
  const colors = new Set(["RGBC", "HSBC", "CMYC", "Grsc", "LbCl", "Clr", "ClrC"]);
  const effects = new Set([
    "ebbl", "FrFX", "IrSh", "IrGl", "ChFX", "SoFi", "GrFl", "patternFill", "OrGl",
    "DrSh", "ShpC", "CrPt", "Pnt", "strokeStyle", "solidColorLayer", "contentLayer"
  ]);
  const layers = new Set([
    "Lyr", "AdjL", "Mk", "GrpL", "Grup", "layerSection", "TxLr", "artboard", "null"
  ]);
  const filters = new Set([
    "UnsM", "GsnB", "Mdn", "boxblur", "surfaceBlur", "smartSharpen", "oilPaint", "LnCr",
    "GEfc", "LqFy", "Wave", "Twrl", "RdlB", "Pntl", "Sphr", "Pnch", "Embs", "Dfs",
    "TrcC", "Clds", "DstS", "Dspl", "DfrC", "Mztn", "HghP", "Shr", "Wnd", "Bokh",
    "AdNs", "fade", "filterFX", "filterFXStyle"
  ]);
  const brushes = new Set(["brushPreset", "computedBrush", "dualBrush", "brushGroup"]);
  const paths = new Set(["pathInfoClass", "pathsDataClass", "pathClass"]);

  if (adjustments.has(cid)) return "adjustments-fills";
  if (colors.has(cid)) return "color-objects";
  if (effects.has(cid)) return "layer-effects";
  if (layers.has(cid)) return "layers-actions";
  if (filters.has(cid)) return "filters";
  if (brushes.has(cid)) return "brushes";
  if (paths.has(cid)) return "paths";
  return "other";
}

const HOMONYMS = [
  ["H", "Hue on Hst2, RplC, HSBC, brush dynamics (`b.H.v`)", "Loop index, height", "PSD wire key — never global-rename to `hue` or `coords`"],
  ["H (path)", "`path.coords` alias in anti-alias / path records", "Same letter as hue key", "Path geometry only — separate domain from descriptors"],
  ["O", "Blue channel in `psdColorToRgb` return `{ h, l, O }`", "Opacity, output", "Internal RGB tuple, not a PSD key on that object"],
  ["A", "Lab a* (`LbCl.A`)", "Anchor, angle", "PSD key on Lab color objects"],
  ["B", "Lab b* (`LbCl.B`)", "Blue in some locals", "PSD key on Lab color objects"],
  ["L", "Lab L (`Lmnc`) or lightness (`Lght`)", "Loop index", "Context-dependent PSD key"],
  ["coords", "`path.coords` flat coordinate pairs", "Was wrongly applied to hue jitter", "Path geometry — not a hue field on descriptors"],
  ["K", "`path.commands` alias", "Generic constant", "Path verb list alias only"],
  ["Strt", "Saturation (HSBC, Hst2)", "Start, string", "PSD key"],
  ["Lght", "Lightness (Hst2)", "Light generic", "PSD key"],
  ["Brgh", "Brightness (HSBC, brit, brush)", "", "PSD key"],
  ["Cntr", "Contrast (brit)", "Counter", "PSD key"],
  ["Rd", "Red (`RGBC`)", "", "PSD key"],
  ["Grn", "Green (`RGBC`)", "", "PSD key"],
  ["Bl", "Blue (`RGBC`)", "", "PSD key"],
  ["Md", "Blend mode enum", "", "PSD key on effects/fills"],
  ["Opct", "Opacity (`UntF` `#Prc`)", "", "PSD key"],
  ["Clr", "Nested color object (`Objc`)", "", "PSD key"],
  ["Nm", "Name (`TEXT`)", "", "PSD key"],
  ["Hrzn", "Horizontal (`Pnt`, curves)", "", "PSD key"],
  ["Vrtc", "Vertical (`Pnt`, curves)", "", "PSD key"],
  ["v", "Descriptor value slot `.v`", "Loop variable in minified code", "Structural slot on every descriptor node"],
  ["t", "Descriptor type tag `.t`", "", "Structural slot on every descriptor node"],
  ["classID", "Object class FourCC", "", "Never rename"],
];

const INTERNAL_TO_CLASS = [
  ["brit", "BrgC"], ["levl", "Lvls"], ["curv", "Crvs"], ["expA", "Exps"], ["vibA", "vibrance"],
  ["hue2", "HStr"], ["blnc", "ClrB"], ["blwh", "BanW"], ["phfl", "photoFilter"], ["mixr", "ChnM"],
  ["clrL", "colorLookup"], ["nvrt", "Invr"], ["post", "Pstr"], ["thrs", "Thrs"], ["grdm", "GrMp"],
  ["selc", "SlcC"], ["rplc", "RplC"]
];

const KEY_GROUPS = {
  "Hue / saturation / replace color": ["H", "Strt", "Lght", "Brgh", "Clrz", "Adjs", "LclR", "BgnR", "BgnS", "EndS", "EndR", "Fzns", "Mnm", "Mxm"],
  "Color channels (RGB, Lab, CMYK, gray)": ["Rd", "Grn", "Bl", "Lmnc", "A", "B", "Cyn", "Mgnt", "Ylw", "Blck", "Gry", "H", "Strt"],
  "Gradients and fills": ["Grad", "Grdn", "Clrs", "Trns", "Clrt", "Lctn", "Mdpn", "Intr", "Angl", "Scl", "Ofst", "Rvrs", "Algn", "Dthr", "GrdF", "GrdT", "GrdL", "Opct", "Ptrn", "Nm", "Idnt"],
  "Layer effects (shared)": ["Md", "Opct", "Clr", "Dstn", "blur", "Nose", "Ckmt", "lagl", "uglg", "enab", "TrnS", "Crv", "Hrzn", "Vrtc", "Sz", "Styl", "PntT", "GlwT", "glwS", "Inpr", "ShdN", "AntA", "hglM", "hglC", "hglO", "sdwM", "sdwC", "sdwO"],
  "Curves and levels": ["Hrzn", "Vrtc", "Chnl", "Inpt", "Otpt", "Gmm", "Lvls", "Crvs"],
  "Brush dynamics": ["Sz", "Angl", "Rndn", "flipX", "flipY", "useTipDynamics", "useScatter", "Brgh", "H", "Strt"]
};

const classIDs = new Map();
const keys = new Map();

for (const fp of walk(SRC)) {
  const rel = path.relative(ROOT, fp);
  const text = fs.readFileSync(fp, "utf8");
  let m;
  while ((m = classRe.exec(text))) {
    if (!classIDs.has(m[1])) classIDs.set(m[1], new Set());
    classIDs.get(m[1]).add(rel);
  }
  while ((m = keyTypeRe.exec(text))) {
    if (!keys.has(m[1])) keys.set(m[1], { types: new Set(), files: new Set() });
    keys.get(m[1]).types.add(m[2]);
    keys.get(m[1]).files.add(rel);
  }
}

const byBucket = {};
for (const [cid, files] of classIDs) {
  const b = bucketClassId(cid);
  (byBucket[b] ??= []).push([cid, [...files].sort()]);
}
for (const b of Object.keys(byBucket)) {
  byBucket[b].sort((a, z) => a[0].localeCompare(z[0]));
}

const keyList = [...keys.keys()].sort();
const shortKeys = keyList.filter((k) => k.length <= 3);

let out = "";
out += "# PSD descriptor catalog\n\n";
out += "Auto-extracted from `src/` (excluding `external/`, `vendor/`). Regenerate:\n\n";
out += "```bash\nnode scripts/extract-psd-descriptor-catalog.mjs\n```\n\n";
out += "Referenced by `.cursor/rules/psd-descriptor-keys-src-js.mdc` (deobfuscation exception list).\n\n";

out += "## External references (authoritative cross-check)\n\n";
out += "Validate wire keys against these sources — **not** only against other files in this repo:\n\n";
out += "- [Adobe Photoshop SDK `PITerminology.h`](https://adobesdk.neocities.org/pluginsdk/documentation/html/_p_i_terminology_8h_source) — `keyHue`, `keyRed`, `classHueSatAdjustmentV2`, `classRGBColor`, …\n";
out += "- [Adobe community ExtendScript examples](https://community.adobe.com) — `charIDToTypeID(\"H \")`, `charIDToTypeID(\"Strt\")`, `charIDToTypeID(\"Hst2\")`, …\n";
out += "- [`psd-tools` terminology module](https://psd-tools.readthedocs.io/en/latest/reference/psd_tools.terminology.html) — FourCC enum mirror used by PSD parsers\n\n";
out += "SDK FourCC literals often include trailing spaces (`'H   '`, `'Rd  '`, `'Bl  '`). Serialized PSD/JSON descriptors typically strip padding → `H`, `Rd`, `Bl` in this codebase. Both forms map to the same TypeID.\n\n";
out += "### Adobe SDK confirmed keys (sample)\n\n";
out += "| Wire key | SDK name | classID / context |\n|----------|----------|-------------------|\n";
out += "| `H` | `keyHue` (`'H   '`) | `Hst2`, `HStr`, `HSBC`, brush dynamics |\n";
out += "| `Strt` | `keySaturation` | `Hst2`, `HSBC` |\n";
out += "| `Lght` | `keyLightness` | `Hst2` |\n";
out += "| `Brgh` | `keyBrightness` | `BrgC`, `HSBC` |\n";
out += "| `Cntr` | `keyContrast` | `BrgC` |\n";
out += "| `Rd` / `Grn` / `Bl` | `keyRed` / `keyGreen` / `keyBlue` | `RGBC` |\n";
out += "| `Lmnc` / `A` / `B` | Lab L / a* / b* | `LbCl` |\n";
out += "| `Hrzn` / `Vrtc` | `keyHorizontal` / `keyVertical` | `Pnt`, curves, shapes |\n";
out += "| `Opct` | opacity percent | layer effects, fills |\n";
out += "| `Hst2` | `classHueSatAdjustmentV2` | per-channel hue/sat list item |\n";
out += "| `HStr` | `classHueSaturation` | hue/sat adjustment event |\n";
out += "| `BrgC` / `Lvls` / `Crvs` | adjustment classes | brightness, levels, curves |\n";
out += "| `ebbl` | `classBevelEmboss` | layer style |\n\n";

out += "## Contract\n\n";
out += "Photoshop stores adjustment, filter, effect, and action state as **descriptor trees**:\n\n";
out += "```js\n{ t: \"long\", v: 42 }\n";
out += "{ t: \"Objc\", v: { classID: \"Hst2\", H: { t: \"long\", v: 0 }, Strt: { t: \"long\", v: 0 }, Lght: { t: \"long\", v: 0 } } }\n```\n\n";
out += "- **`t`** — type tag (`long`, `doub`, `bool`, `enum`, `Objc`, `VlLs`, `UntF`, `TEXT`, …)\n";
out += "- **`v`** — payload (number, bool, nested object, unit `{ type, val }`, list, …)\n";
out += "- **`classID`** — FourCC class name on `Objc` nodes (wire format; not JavaScript class names)\n";
out += "- **Property keys** (`H`, `Strt`, `Rd`, …) — wire keys on descriptor objects; must match Photoshop / PSD files\n\n";
out += "Internal app aliases (`hue2`, `brit`) map to `classID` via `AdjustmentEngine.descriptorKeyMap` in `adjustment-engine.js` and `SmartFilterDefs` in `smart-filters/defaults.js`.\n\n";

out += "## Homonym blocklist (deobfuscation)\n\n";
out += "These symbols look like minifier noise but are **fixed API names**. Do not rename in descriptor literals, `.v` access on descriptors, or object literal keys without a wire-format migration.\n\n";
out += "| Symbol | PSD / wire meaning | Also used in JS for | Rule |\n|--------|-------------------|---------------------|------|\n";
for (const [s, p, j, r] of HOMONYMS) {
  out += `| \`${s}\` | ${p} | ${j} | ${r} |\n`;
}

out += `\n## classID index (${classIDs.size} symbols)\n\n`;
const bucketOrder = ["adjustments-fills", "color-objects", "layer-effects", "layers-actions", "filters", "brushes", "paths", "other"];
for (const b of bucketOrder) {
  if (!byBucket[b]) continue;
  out += `### ${b}\n\n`;
  for (const [cid, fl] of byBucket[b]) {
    const sample = fl.slice(0, 3).join(", ");
    out += `- \`${cid}\` — ${sample}${fl.length > 3 ? `, +${fl.length - 3} more` : ""}\n`;
  }
  out += "\n";
}

out += `## Property key index (${keyList.length} symbols with \`{ t: ... }\` declarations)\n\n`;
for (const [title, group] of Object.entries(KEY_GROUPS)) {
  out += `### ${title}\n\n`;
  for (const k of group) {
    if (!keys.has(k)) continue;
    out += `- \`${k}\` — types: ${[...keys.get(k).types].sort().join(", ")}\n`;
  }
  out += "\n";
}

out += "### Short keys (≤3 chars) — extra caution\n\n";
out += "Treat as PSD wire keys when followed by `.v` on a descriptor object or in `{ Key: { t: ...` literals:\n\n";
out += shortKeys.map((k) => `\`${k}\``).join(", ");
out += "\n\n### All keys (alphabetical)\n\n";
for (const k of keyList) out += `- \`${k}\`\n`;

out += "\n## Path geometry (not descriptors)\n\n";
out += "Separate from action descriptors. Path records expose readable names with short aliases:\n\n";
out += "| Readable | Alias | Meaning |\n|----------|-------|--------|\n";
out += "| `coords` | `H`, `crds` | Flat path coordinate pairs |\n";
out += "| `commands` | `K`, `cmds` | Path verb list (`M`, `L`, `C`, `Z`, …) |\n\n";
out += "Do not use `coords` as a hue field name on descriptors.\n\n";

out += "## Internal rgb objects (`psdColorToRgb`)\n\n";
out += "Return shape `{ h, l, O }` is an **internal** RGB tuple convention (not PSD wire). Renaming to `{ r, g, b }` requires a coordinated cross-module pass. Do not confuse with `RGBC.Rd` / `Grn` / `Bl` descriptor keys.\n\n";

out += "## Adjustment internal id → classID\n\n";
out += "| Internal (`AdjustmentEngine.names`) | classID |\n|----------------------------------|--------|\n";
for (const [a, b] of INTERNAL_TO_CLASS) out += `| \`${a}\` | \`${b}\` |\n`;

fs.writeFileSync(OUT, out);
console.log(`Wrote ${OUT}`);
console.log(`${classIDs.size} classIDs, ${keyList.length} property keys`);
