// System font discovery (Tauri) and the in-memory font catalog store used by
// FontRegistry and font UI widgets.

let activeFontCatalog = null;

// Embedded script coverage fonts (app: assets). subsetMask bits match
// FontRegistry script-fallback table indices (bit = 1 << index):
// Latin-1=0, LatinExtA=1, Greek=2, Cyrillic=3, Hebrew=4, Arabic=5, ...
const EMBEDDED_SCRIPT_FONT_ROWS = [
  "DejaVu Sans,Regular,DejaVuSans,63,0,app:fonts/script/DejaVuSans.ttf",
  "Droid Sans Fallback,Regular,DroidSansFallback,128,0,app:fonts/script/DroidSansFallback.ttf",
  "Noto Serif Tibetan,Regular,NotoSerifTibetan-Regular,256,0,app:fonts/script/NotoSerifTibetan.ttf",
  "Noto Sans Devanagari,Regular,NotoSansDevanagari-Regular,512,0,app:fonts/script/NotoSansDevanagari.ttf",
  "Noto Sans Thai,Regular,NotoSansThai-Regular,1024,0,app:fonts/script/NotoSansThai.ttf",
  "Noto Sans Khmer,Regular,NotoSansKhmer-Regular,2048,0,app:fonts/script/NotoSansKhmer.ttf",
];

// Treat system fonts as supporting all script bands until per-font coverage exists.
const SYSTEM_FONT_SUBSET_MASK = 0x1fff;

function isUsableCatalog(catalog) {
  return catalog && Array.isArray(catalog.list) && Array.isArray(catalog.cats);
}

/**
 * Active catalog, or a fresh empty System placeholder before fonts load.
 * @returns {{ subsetNames: string[], cats: string[], list: string[], hasSpriteSheet: boolean }}
 */
export function getFontCatalog() {
  if (isUsableCatalog(activeFontCatalog)) return activeFontCatalog;
  return { subsetNames: [], cats: ["System"], list: [], hasSpriteSheet: false };
}

/**
 * Replace the active catalog and notify FontRegistry / UI to rebuild look-ups.
 * @param {object} catalog
 */
export function setFontCatalog(catalog) {
  activeFontCatalog = catalog;
  try {
    window.dispatchEvent(new window.Event("photosuite:fontcatalog-changed"));
  } catch (_) {}
}

/**
 * Build a PostScript-style face name when the OS entry omits one.
 * @param {string} family
 * @param {string} style
 * @returns {string}
 */
export function toPostScriptFallbackName(family, style) {
  return (family + "-" + style).replace(/\s+/g, "");
}

async function listSystemFontsViaTauri() {
  return await window.__TAURI__.core.invoke("list_system_fonts");
}

async function readFileBytesViaTauri(path) {
  const arr = await window.__TAURI__.core.invoke("read_file_bytes", { path });
  if (arr instanceof ArrayBuffer) return new Uint8Array(arr);
  if (arr instanceof Uint8Array) return arr;
  if (Array.isArray(arr)) return Uint8Array.from(arr);
  if (arr && arr.buffer) return new Uint8Array(arr.buffer);
  throw new Error("Unexpected read_file result type");
}

function normalizeSystemFontStyle(style) {
  if (style === "Italic") return "Italic";
  if (style === "Oblique") return "Oblique";
  return "Regular";
}

function normalizePostScriptName(family, style, postscriptName) {
  const rawPostScript = postscriptName || toPostScriptFallbackName(family, style);
  return String(rawPostScript).replace(/ /g, "-");
}

/**
 * Build a FontRegistry-compatible catalog from Tauri list_system_fonts entries.
 * Each list row is CSV: family, style, postScriptName, subsetMask, catIndex, fileKey.
 * FontRegistry expands each CSV into a 6-tuple for look-up maps.
 * @param {object[]} entries
 * @returns {{ subsetNames: string[], cats: string[], list: string[], hasSpriteSheet: boolean }}
 */
export function buildFontCatalogFromSystemFonts(entries) {
  const subsetNames = [];
  const cats = ["System"];
  const list = [];
  for (const entry of entries) {
    const family = entry?.family;
    const path = entry?.path;
    if (!family || !path) continue;
    const style = normalizeSystemFontStyle(entry?.style);
    const postScript = normalizePostScriptName(family, style, entry?.postscript_name);
    const fileKey = "sys:" + path;
    list.push([family, style, postScript, SYSTEM_FONT_SUBSET_MASK, 0, fileKey].join(","));
  }
  return { subsetNames, cats, list, hasSpriteSheet: false };
}

function dispatchFontLifecycleEvent(eventName, detail) {
  try {
    window.dispatchEvent(new window.CustomEvent(eventName, { detail }));
  } catch (_) {}
}

/**
 * Discover system fonts in Tauri and install them as the default catalog.
 * @returns {Promise<boolean>}
 */
export async function initSystemFontsAsDefault() {

  dispatchFontLifecycleEvent("photosuite:font-loading", { key: "catalog" });

  try {
    const entries = await listSystemFontsViaTauri();
    const catalog = buildFontCatalogFromSystemFonts(entries || []);
    if (!catalog.list || catalog.list.length === 0) {
      console.warn("PhotoSuite: no system fonts discovered (no file paths)");
      return false;
    }
    catalog.list.push(...EMBEDDED_SCRIPT_FONT_ROWS);
    setFontCatalog(catalog);
    console.info("PhotoSuite: system fonts loaded", { count: catalog.list.length });
    return true;
  } catch (error) {
    console.warn("PhotoSuite: system font init failed", error);
    return false;
  } finally {
    // Always emit loaded so the UI loading bar can close even when discovery fails.
    // When setFontCatalog ran, FontRegistry already converted catalog-changed into
    // font-loaded; an extra loaded event is absorbed by Math.max(0, ...).
    dispatchFontLifecycleEvent("photosuite:font-loaded", { key: "catalog" });
  }
}

/**
 * Read font file bytes from disk through the Tauri read_file_bytes command.
 * @param {string} path
 * @returns {Promise<Uint8Array>}
 */
export async function loadSystemFontBytes(path) {
  return await readFileBytesViaTauri(path);
}
