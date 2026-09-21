/**
 * Convert the Lensfun XML lens database into the single JSON file the app loads.
 *
 * Run through build.sh, which passes the submodule's database directory and the
 * output path. The database is machine-generated XML with a flat, regular shape,
 * so it is read with pattern matching rather than a parser dependency.
 *
 * The file is written to be read: one camera per line, one lens per block, one
 * calibration measurement per line, and a `columns` map at the top so the
 * numeric tables describe themselves.
 *
 * Those tables are arrays with a fixed column order:
 *
 * `maker` is the brand: what a person calls it, and what the app lists. Where
 * the camera writes something else into EXIF `Make` — Nikon's SLRs say "Nikon
 * Corporation" where its compacts say "Nikon", and Olympus manages four
 * variants — that literal string is kept alongside as `exifMaker`, since it is
 * what identifies the body in a file.
 *
 *   distortion  [focal, model, c0, c1, c2]
 *                 model 0 = poly3   c0 = k1
 *                 model 1 = poly5   c0 = k1, c1 = k2
 *                 model 2 = ptlens  c0 = a,  c1 = b,  c2 = c
 *   tca         [focal, redB, redC, redV, blueB, blueC, blueV]
 *   vignetting  [focal, aperture, distance, k1, k2, k3]
 */

import fs from "node:fs";
import path from "node:path";

const DISTORTION_POLY3 = 0;
const DISTORTION_POLY5 = 1;
const DISTORTION_PTLENS = 2;

/** Lensfun's default when a lens carries no aspect-ratio element. */
const DEFAULT_ASPECT_RATIO = 1.5;

const XML_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'",
};

function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (match) => XML_ENTITIES[match]);
}

function attributes(tag) {
  const found = Object.create(null);
  for (const [, name, value] of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) {
    found[name] = decodeEntities(value);
  }
  return found;
}

function number(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Element text. The entry with no `lang` attribute is the canonical name and is
 * what a camera writes into EXIF; `lang` entries are display names for the
 * Lensfun UI. Only the English one is kept, as a secondary match candidate —
 * the other translations cannot appear in a file's metadata, and several of
 * them ("festes Objektiv") are generic enough to match the wrong lens.
 */
function readNames(block, tagName) {
  const canonical = [];
  const aliases = [];
  for (const [, tag, text] of block.matchAll(
    new RegExp(`<${tagName}([^>]*)>([^<]*)</${tagName}>`, "g"),
  )) {
    const name = decodeEntities(text).trim();
    if (!name) continue;
    if (!/\blang\s*=/.test(tag)) canonical.push(name);
    else if (/\blang\s*=\s*"en"/.test(tag)) aliases.push(name);
  }
  return { name: canonical[0] || aliases[0] || "", aliases };
}

function readCameras(source) {
  const cameras = [];
  for (const [, block] of source.matchAll(/<camera>([\s\S]*?)<\/camera>/g)) {
    const model = readNames(block, "model");
    const maker = readNames(block, "maker");
    const mount = readNames(block, "mount");
    const cropFactor = readNames(block, "cropfactor");
    if (!model.name) continue;
    const brand = maker.aliases[0] || maker.name;
    const camera = {
      maker: brand,
      model: model.name,
      mount: mount.name,
      cropFactor: number(cropFactor.name, 1),
    };
    if (maker.name !== brand) camera.exifMaker = maker.name;
    if (model.aliases.length) camera.aliases = model.aliases;
    cameras.push(camera);
  }
  return cameras;
}

function readDistortion(calibration) {
  const rows = [];
  for (const [, tag] of calibration.matchAll(/<distortion([^/>]*)\/?>/g)) {
    const found = attributes(tag);
    const focal = number(found.focal, 0);
    if (!focal) continue;
    if (found.model === "poly3") {
      rows.push([focal, DISTORTION_POLY3, number(found.k1, 0), 0, 0]);
    } else if (found.model === "poly5") {
      rows.push([focal, DISTORTION_POLY5, number(found.k1, 0), number(found.k2, 0), 0]);
    } else if (found.model === "ptlens") {
      rows.push([
        focal, DISTORTION_PTLENS,
        number(found.a, 0), number(found.b, 0), number(found.c, 0),
      ]);
    }
  }
  return rows;
}

function readTca(calibration) {
  const rows = [];
  for (const [, tag] of calibration.matchAll(/<tca([^/>]*)\/?>/g)) {
    const found = attributes(tag);
    const focal = number(found.focal, 0);
    if (!focal) continue;
    if (found.model === "linear") {
      // Linear TCA scales each channel radially, which is the cubic model with
      // only its leading term, so both collapse into one set of columns.
      rows.push([focal, 0, 0, number(found.kr, 1), 0, 0, number(found.kb, 1)]);
    } else if (found.model === "poly3") {
      rows.push([
        focal,
        number(found.br, 0), number(found.cr, 0), number(found.vr, 1),
        number(found.bb, 0), number(found.cb, 0), number(found.vb, 1),
      ]);
    }
  }
  return rows;
}

function readVignetting(calibration) {
  const rows = [];
  for (const [, tag] of calibration.matchAll(/<vignetting([^/>]*)\/?>/g)) {
    const found = attributes(tag);
    if (found.model !== "pa") continue;
    const focal = number(found.focal, 0);
    if (!focal) continue;
    rows.push([
      focal, number(found.aperture, 0), number(found.distance, 0),
      number(found.k1, 0), number(found.k2, 0), number(found.k3, 0),
    ]);
  }
  return rows;
}

function readLenses(source) {
  const lenses = [];
  for (const [, block] of source.matchAll(/<lens>([\s\S]*?)<\/lens>/g)) {
    const model = readNames(block, "model");
    if (!model.name) continue;
    const calibrationMatch = block.match(/<calibration>([\s\S]*?)<\/calibration>/);
    const calibration = calibrationMatch ? calibrationMatch[1] : "";
    const distortion = readDistortion(calibration);
    const tca = readTca(calibration);
    const vignetting = readVignetting(calibration);
    // A lens with no measurements of any kind has nothing to correct with.
    if (!distortion.length && !tca.length && !vignetting.length) continue;
    const lensMaker = readNames(block, "maker");
    const lensBrand = lensMaker.aliases[0] || lensMaker.name;
    const lens = {
      maker: lensBrand,
      model: model.name,
      mount: readNames(block, "mount").name,
      cropFactor: number(readNames(block, "cropfactor").name, 1),
      aspectRatio: number(readNames(block, "aspect-ratio").name, DEFAULT_ASPECT_RATIO),
    };
    if (lensMaker.name !== lensBrand) lens.exifMaker = lensMaker.name;
    if (model.aliases.length) lens.aliases = model.aliases;
    if (distortion.length) lens.distortion = distortion;
    if (tca.length) lens.tca = tca;
    if (vignetting.length) lens.vignetting = vignetting;
    lenses.push(lens);
  }
  return lenses;
}

/**
 * Write the database so it reads as a document rather than one long line.
 *
 * Indenting every value would put each coefficient on its own line and grow the
 * file several times over for no gain — a measurement is only meaningful as a
 * whole row. So rows, short string lists and camera records stay inline, and
 * everything above them is indented.
 */
function serializeDatabase(database) {
  const lines = ["{"];
  const entries = Object.entries(database);
  entries.forEach(([key, value], index) => {
    const comma = index === entries.length - 1 ? "" : ",";
    if (key === "cameras") lines.push(`  ${JSON.stringify(key)}: [`, ...inlineList(value, 4), `  ]${comma}`);
    else if (key === "lenses") lines.push(`  ${JSON.stringify(key)}: [`, ...lensBlocks(value), `  ]${comma}`);
    else if (key === "columns") lines.push(`  ${JSON.stringify(key)}: {`, ...columnLines(value), `  }${comma}`);
    else if (Array.isArray(value)) lines.push(`  ${JSON.stringify(key)}: ${inlineArray(value)}${comma}`);
    else lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** `[a, b, c]` — JSON's own output omits the spaces and reads as a blob. */
function inlineArray(values) {
  return "[" + values.map((value) => JSON.stringify(value)).join(", ") + "]";
}

/** `{"key": value, …}` on one line, for records short enough to scan. */
function inlineRecord(record) {
  const fields = Object.entries(record).map(
    ([key, value]) => `${JSON.stringify(key)}: ` +
      (Array.isArray(value) ? inlineArray(value) : JSON.stringify(value)),
  );
  return "{" + fields.join(", ") + "}";
}

function columnLines(columns) {
  const names = Object.keys(columns);
  return names.map((name, index) =>
    `    ${JSON.stringify(name)}: ${inlineArray(columns[name])}` +
    (index === names.length - 1 ? "" : ","));
}

function inlineList(items, indent) {
  const pad = " ".repeat(indent);
  return items.map((item, index) => {
    const text = Array.isArray(item) ? inlineArray(item) : inlineRecord(item);
    return pad + text + (index === items.length - 1 ? "" : ",");
  });
}

function lensBlocks(lenses) {
  const lines = [];
  lenses.forEach((lens, lensIndex) => {
    lines.push("    {");
    const fields = Object.entries(lens);
    fields.forEach(([key, value], index) => {
      const comma = index === fields.length - 1 ? "" : ",";
      if (Array.isArray(value) && Array.isArray(value[0])) {
        lines.push(`      ${JSON.stringify(key)}: [`, ...inlineList(value, 8), `      ]${comma}`);
      } else {
        lines.push(`      ${JSON.stringify(key)}: ` +
          (Array.isArray(value) ? inlineArray(value) : JSON.stringify(value)) + comma);
      }
    });
    lines.push(`    }${lensIndex === lenses.length - 1 ? "" : ","}`);
  });
  return lines;
}

const [databaseDir, outputPath, sourceVersion] = process.argv.slice(2);
if (!databaseDir || !outputPath) {
  console.error("usage: convert.mjs <lensfun/data/db> <output.json> [version]");
  process.exit(1);
}

const cameras = [];
const lenses = [];
const xmlFiles = fs.readdirSync(databaseDir).filter((name) => name.endsWith(".xml")).sort();
for (const name of xmlFiles) {
  const source = fs.readFileSync(path.join(databaseDir, name), "utf8");
  cameras.push(...readCameras(source));
  lenses.push(...readLenses(source));
}

/**
 * Collapse a maker's registered company name onto the brand it trades as.
 *
 * Most entries carry the short form as an alias, but a few name only the
 * company — "Ricoh imaging company, ltd." sitting beside plain "Ricoh" — which
 * would split one brand across two rows of the picker. Where a brand the
 * database attests elsewhere begins the longer name on a word boundary, the two
 * are the same maker. The full string stays as `exifMaker`: it is what the body
 * writes into a file, so it is still what a photo has to be matched against.
 */
function collapseMakersOntoBrands(entryLists) {
  const brands = new Set();
  for (const entries of entryLists) for (const entry of entries) brands.add(entry.maker);
  // Shortest first, so a maker collapses onto the plainest brand that fits.
  const candidates = Array.from(brands).sort((left, right) => left.length - right.length);
  for (const entries of entryLists) {
    for (const entry of entries) {
      const full = entry.maker;
      const brand = candidates.find((candidate) =>
        candidate.length < full.length &&
        full.toLowerCase().startsWith(candidate.toLowerCase()) &&
        /[\s,]/.test(full.charAt(candidate.length)));
      if (!brand) continue;
      if (!entry.exifMaker) entry.exifMaker = full;
      entry.maker = brand;
    }
  }
}

collapseMakersOntoBrands([cameras, lenses]);

// A stable order keeps the committed file's diff readable when the submodule moves.
cameras.sort((a, b) => (a.maker + a.model).localeCompare(b.maker + b.model));
lenses.sort((a, b) => (a.maker + a.model).localeCompare(b.maker + b.model));

const database = {
  generatedFrom: sourceVersion || "lensfun",
  license: "CC BY-SA 3.0 — see LICENSE",
  distortionModels: ["poly3", "poly5", "ptlens"],
  columns: {
    distortion: ["focal", "model", "c0", "c1", "c2"],
    tca: ["focal", "redB", "redC", "redV", "blueB", "blueC", "blueV"],
    vignetting: ["focal", "aperture", "distance", "k1", "k2", "k3"],
  },
  cameras,
  lenses,
};

fs.writeFileSync(outputPath, serializeDatabase(database));
const bytes = fs.statSync(outputPath).size;
console.log(
  `  ${xmlFiles.length} files -> ${cameras.length} cameras, ${lenses.length} calibrated lenses` +
  ` (${(bytes / 1048576).toFixed(2)} MB)`,
);
