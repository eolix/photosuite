/**
 * Which module carries the parser for each file format, and how to fetch it.
 *
 * A parser is only worth loading when someone opens that kind of file: the
 * nine here are eleven thousand lines between them, and a session that only
 * touches PSDs should never pay for the CorelDRAW reader. Each entry names the
 * loaders its module installs and imports it on demand.
 *
 * `ensureFormatLoaders` reports whether the parser was already there, so the
 * open path can tell "ready to decode now" from "come back when this lands".
 */

import { codecLoaders, installCodecLoaders } from "./registry-helpers.js";

/**
 * Format id → the loaders it decodes with, and the import that provides them.
 * A format whose parser ships in the initial bundle is absent from this map.
 */
const LOADER_IMPORTS = {
  psd: { loaders: ["PSDParser"], load: () => import("../psd/psd-parser.js") },
  psb: { loaders: ["PSDParser"], load: () => import("../psd/psd-parser.js") },
  sketch: { loaders: ["SketchLoader"], load: () => import("../sketch-format.js") },
  xd: { loaders: ["XDLoader"], load: () => import("../xd-format.js") },
  fig: { loaders: ["FigmaLoader"], load: () => import("../fig-format.js") },
  xcf: { loaders: ["XCFParser"], load: () => import("../xcf-format.js") },
  fpng: { loaders: ["FpngLoader"], load: () => import("../fpng-format.js") },
  ai: { loaders: ["AiFormatLoader"], load: () => import("../ai-format.js") },
  cdr: { loaders: ["CdrLoader"], load: () => import("../cdr-format.js") },
  // `.afphoto`, `.afdesign` and `.afpub` all detect as `af` — one entry covers them.
  af: { loaders: ["AffinityLoader"], load: () => import("../af-format.js") },
  svg: { loaders: ["SVGLoader"], load: () => import("../svg-format.js") },
};

/** In-flight imports, so two files of the same format share one fetch. */
const pendingImports = new Map();

/** True when every loader this format decodes with is already installed. */
export function hasFormatLoaders(formatId) {
  const entry = LOADER_IMPORTS[String(formatId).toLowerCase()];
  if (entry == null) return true;
  return entry.loaders.every((name) => codecLoaders[name] != null);
}

/**
 * Make sure the parser for `formatId` is installed.
 * @returns {Promise<void>} resolves once the loaders are in `codecLoaders`
 */
export function ensureFormatLoaders(formatId) {
  const key = String(formatId).toLowerCase();
  const entry = LOADER_IMPORTS[key];
  if (entry == null || hasFormatLoaders(key)) return Promise.resolve();

  let pending = pendingImports.get(key);
  if (pending == null) {
    pending = entry
      .load()
      .then((module) => {
        const installed = {};
        for (const name of entry.loaders) installed[name] = module[name];
        installCodecLoaders(installed);
      })
      .finally(() => {
        pendingImports.delete(key);
      });
    pendingImports.set(key, pending);
  }
  return pending;
}

/** Every format whose parser is fetched on demand — for diagnostics and tests. */
export function lazyFormatIds() {
  return Object.keys(LOADER_IMPORTS).sort();
}
