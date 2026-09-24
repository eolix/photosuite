#!/usr/bin/env node
// Static gate on the format registry's late-bound wiring. Three checks:
//
// 1. Every `codecLoaders.X` a codec reaches for is something startup installs:
//    either the eager bag in `main.js` or a `LOADER_IMPORTS` entry. A name in
//    neither is `undefined` at the moment the codec runs, and the codec is the
//    only code path that touches it — so the throw lands on whoever opens or
//    saves that one format, long after every test has passed.
// 2. Every loader a `LOADER_IMPORTS` entry promises is actually exported by the
//    module it imports. Installing `module[name]` silently writes `undefined`.
// 3. Every format id whose codec needs a lazily imported loader has its own
//    `LOADER_IMPORTS` entry. `hasFormatLoaders` answers "nothing to fetch" for
//    an id it does not know, so a missing entry does not defer the open — it
//    decodes immediately with a loader that was never imported.
// 4. Every `LOADER_IMPORTS` key is an id the registry can actually produce. A
//    key for an id nothing detects is dead weight that reads as coverage.
// 5. Every id `detectFormat` can return goes somewhere: a codec, a preset
//    parser, a branch in the open path, or `DETECT_ONLY_FORMAT_NAMES`. An id in
//    none of those is recognised by the detector and then reported as unknown.
//
// Usage: node scripts/verify-format-wiring.mjs
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");
const FORMATS = path.join(SRC, "document/formats");
const REGISTRY = path.join(FORMATS, "registry");
const issues = [];

const read = (p) => fs.readFileSync(p, "utf8");

// Comments hold `codecLoaders.X` in prose (`{@link codecLoaders.SVGLoader…}`),
// so every scan below runs over blanked source. `stripComments` keeps string
// bodies, for the reads that need the module path a table literal spells out;
// `stripCommentsAndStrings` blanks those too, for the reads that scan code.
function blank(src, keepStrings) {
  let out = "";
  let mode = null;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const pair = src.slice(i, i + 2);
    if (mode == null) {
      if (pair === "//") { mode = "line"; out += "  "; i += 2; continue; }
      if (pair === "/*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") {
        if (keepStrings) { out += c; i++; continue; }
        mode = c; out += " "; i++; continue;
      }
      out += c; i++; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = null; out += "\n"; } else out += " "; i++; continue; }
    if (mode === "block") {
      if (pair === "*/") { mode = null; out += "  "; i += 2; } else { out += c === "\n" ? "\n" : " "; i++; }
      continue;
    }
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === mode) { mode = null; out += " "; i++; continue; }
    out += c === "\n" ? "\n" : " ";
    i++;
  }
  return out;
}

const stripComments = (src) => blank(src, true);
const stripCommentsAndStrings = (src) => blank(src, false);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** The `{ VectorPageExporter, … }` bag `main.js` hands `installLoaders`. */
function eagerLoaderNames() {
  const src = stripComments(read(path.join(SRC, "main.js")));
  const bag = src.match(/function buildFileFormatLoaderBag\(\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\};/);
  if (bag == null) {
    issues.push("main.js: could not find buildFileFormatLoaderBag — this gate cannot see what startup installs");
    return new Set();
  }
  return new Set(bag[1].split(",").map((part) => part.trim().split(":")[0].trim()).filter(Boolean));
}

/** `LOADER_IMPORTS`: format id → { loaders, module path }. */
function lazyLoaderEntries() {
  const file = path.join(REGISTRY, "format-loader-imports.js");
  const src = stripComments(read(file));
  const table = src.match(/const LOADER_IMPORTS = \{([\s\S]*?)\n\};/);
  if (table == null) {
    issues.push("format-loader-imports.js: could not find LOADER_IMPORTS");
    return new Map();
  }
  const entries = new Map();
  const rowRe = /([A-Za-z0-9_]+):\s*\{\s*loaders:\s*\[([^\]]*)\][\s\S]*?import\("([^"]+)"\)/g;
  for (const row of table[1].matchAll(rowRe)) {
    entries.set(row[1], {
      loaders: row[2].split(",").map((n) => n.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
      module: path.resolve(REGISTRY, row[3]),
    });
  }
  return entries;
}

/** Format id → the codec module that decodes it, from `file-format-registry.js`. */
function formatCodecModules() {
  const file = path.join(REGISTRY, "file-format-registry.js");
  const src = stripComments(read(file));
  const codecModule = new Map();
  for (const imp of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\.\/codecs\/[^"]+)"/g)) {
    const resolved = path.resolve(REGISTRY, imp[2]);
    for (const part of imp[1].split(",")) {
      const name = part.trim();
      if (name) codecModule.set(name, resolved);
    }
  }
  const byFormat = new Map();
  for (const row of src.matchAll(/\["([A-Z0-9]+)",\s*([A-Za-z0-9_]+)\]/g)) {
    const module = codecModule.get(row[2]);
    if (module) byFormat.set(row[1].toLowerCase(), { codec: row[2], module });
  }
  return byFormat;
}

/** Body of `function name(...) { … }`, by brace matching. */
function functionBody(src, name) {
  const head = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (head == null) return "";
  let i = src.indexOf("{", head.index);
  if (i < 0) return "";
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** The `codecLoaders.X` names a codec's own encode/decode reach for. */
function loadersUsedByCodec(moduleSrc, codecName) {
  const used = new Set();
  const assignRe = new RegExp(`${codecName}\\.(?:encode|decode)\\s*=\\s*([A-Za-z0-9_]+)\\s*;`, "g");
  for (const assign of moduleSrc.matchAll(assignRe)) {
    const body = functionBody(moduleSrc, assign[1]);
    for (const hit of body.matchAll(/codecLoaders\.([A-Za-z0-9_]+)/g)) used.add(hit[1]);
    // A codec's entry point often builds its parser through a local helper.
    for (const call of body.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)) {
      const helper = functionBody(moduleSrc, call[1]);
      for (const hit of helper.matchAll(/codecLoaders\.([A-Za-z0-9_]+)/g)) used.add(hit[1]);
    }
  }
  return used;
}

const eager = eagerLoaderNames();
const lazy = lazyLoaderEntries();
const lazyNames = new Set([...lazy.values()].flatMap((entry) => entry.loaders));
const installed = new Set([...eager, ...lazyNames]);

// 1. Nothing reaches for a loader no one installs.
for (const file of walk(SRC)) {
  if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
  const src = stripCommentsAndStrings(read(file));
  for (const hit of src.matchAll(/codecLoaders\.([A-Za-z0-9_]+)/g)) {
    const name = hit[1];
    if (installed.has(name)) continue;
    const line = src.slice(0, hit.index).split("\n").length;
    issues.push(
      `${path.relative(SRC, file)}:${line}: reads \`codecLoaders.${name}\`, which neither main.js ` +
        `nor LOADER_IMPORTS installs — it is \`undefined\` when this line runs`,
    );
  }
}

// 2. Every promised loader is really exported by the module that promises it.
for (const [formatId, entry] of lazy) {
  if (!fs.existsSync(entry.module)) {
    issues.push(`LOADER_IMPORTS.${formatId}: imports ${path.relative(SRC, entry.module)}, which does not exist`);
    continue;
  }
  const moduleSrc = stripCommentsAndStrings(read(entry.module));
  const exported = new Set();
  for (const block of moduleSrc.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(",")) {
      const name = part.trim();
      if (name) exported.add(name.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const decl of moduleSrc.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
    exported.add(decl[1]);
  }
  for (const loader of entry.loaders) {
    if (!exported.has(loader)) {
      issues.push(
        `LOADER_IMPORTS.${formatId}: promises \`${loader}\`, but ` +
          `${path.relative(SRC, entry.module)} does not export it — installing it writes \`undefined\``,
      );
    }
  }
}

// 3. A format whose codec needs a lazy loader must have an entry of its own.
for (const [formatId, { codec, module }] of formatCodecModules()) {
  const moduleSrc = stripCommentsAndStrings(read(module));
  const entry = lazy.get(formatId);
  for (const loader of loadersUsedByCodec(moduleSrc, codec)) {
    if (eager.has(loader)) continue;
    if (!lazyNames.has(loader)) continue; // already reported by check 1
    if (entry && entry.loaders.includes(loader)) continue;
    issues.push(
      `${formatId}: ${codec} decodes with \`${loader}\`, which is imported on demand, but ` +
        `LOADER_IMPORTS has no "${formatId}" entry naming it — the open never waits for the parser`,
    );
  }
}

// 4. No entry for a format id the registry cannot produce.
const knownFormatIds = new Set(formatCodecModules().keys());
for (const formatId of lazy.keys()) {
  if (knownFormatIds.has(formatId)) continue;
  issues.push(
    `LOADER_IMPORTS.${formatId}: no codec is registered under "${formatId}", so nothing ever asks ` +
      `for this entry — detection reports a different id for those files`,
  );
}

// 5. Nothing the detector recognises falls through to "unknown file format".
{
  const helpersSrc = stripComments(read(path.join(REGISTRY, "registry-helpers.js")));
  const detected = new Set([...helpersSrc.matchAll(/formatId = "([a-z0-9]+)"/g)].map((m) => m[1]));
  const detectOnly = helpersSrc.match(/DETECT_ONLY_FORMAT_NAMES = \{([\s\S]*?)\n\};/);
  const handled = new Set(knownFormatIds);
  if (detectOnly == null) issues.push("registry-helpers.js: could not find DETECT_ONLY_FORMAT_NAMES");
  else for (const row of detectOnly[1].matchAll(/^\s*([a-z0-9]+):/gm)) handled.add(row[1]);
  // Presets and the open path's own branches claim the rest.
  const popupSrc = stripComments(read(path.join(SRC, "ui/config/popup-types.js")));
  for (const row of popupSrc.matchAll(/extension:\s*"([a-z0-9]+)"/g)) handled.add(row[1]);
  const loaderSrc = stripComments(read(path.join(SRC, "ui/shell/file-loader.js")));
  for (const row of loaderSrc.matchAll(/formatId\s*[!=]=+\s*"([a-z0-9]+)"/g)) handled.add(row[1]);
  for (const formatId of detected) {
    if (handled.has(formatId)) continue;
    issues.push(
      `detectFormat returns "${formatId}", which no codec, preset parser, open-path branch or ` +
        `DETECT_ONLY_FORMAT_NAMES entry claims — the open reports it as an unknown file format`,
    );
  }
}

if (issues.length) {
  console.error("FORMAT WIRING:\n" + issues.join("\n"));
  process.exit(1);
}
console.log(
  `format wiring: OK (${installed.size} loaders, all installed, exported, and reachable for the formats that need them)`,
);
