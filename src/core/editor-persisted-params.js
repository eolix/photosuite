/**
 * Single source of truth for `eparams` persistence:
 * persisted store keys ↔ live `appData.prefs` property names.
 */

/** @type {Readonly<Record<string, string>>} */
export const EDITOR_PERSISTED_PARAM_MAP = Object.freeze({
  guides: "guides",
  grid: "showGrid",
  gsize: "gridSize",
  gunits: "gridUnits",
  gtype: "gridType",
  runits: "AppWindow",
  sels: "showSelectionEdges",
  paths: "paths",
  pgrid: "showPixelGrid",
  slices: "slices",
  gpu: "gpuAcceleration",
  zws: "zoomWithScrollWheel",
});

/**
 * What every `appData.prefs` key starts as: the state a fresh install has, and
 * what Preferences → Reset puts back. Kept beside the persistence map so the
 * two lists cannot drift apart.
 *
 * @type {Readonly<Record<string, boolean|number>>}
 */
export const DEFAULT_EDITOR_PREFS = Object.freeze({
  guides: true,
  showGrid: false,
  showSelectionEdges: true,
  paths: true,
  showPixelGrid: true,
  slices: true,
  gridSize: 20,
  gridUnits: 0,
  gridType: 0,
  AppWindow: 0,
  gpuAcceleration: true,
  zoomWithScrollWheel: false,
});

/** A writable copy of {@link DEFAULT_EDITOR_PREFS}. */
export function createDefaultEditorPrefs() {
  return Object.assign({}, DEFAULT_EDITOR_PREFS);
}

/** @param {Record<string, unknown>} prefs */
export function snapshotEditorParamsFromPrefs(prefs) {
  const snapshot = {};
  for (const persistedKey of Object.keys(EDITOR_PERSISTED_PARAM_MAP)) {
    const prefsKey = EDITOR_PERSISTED_PARAM_MAP[persistedKey];
    snapshot[persistedKey] = prefs[prefsKey];
  }
  return snapshot;
}

/**
 * @param {Record<string, unknown>} prefs
 * @param {Record<string, unknown>} editorParams
 */
export function applyEditorParamsToPrefs(prefs, editorParams) {
  for (const persistedKey of Object.keys(EDITOR_PERSISTED_PARAM_MAP)) {
    const prefsKey = EDITOR_PERSISTED_PARAM_MAP[persistedKey];
    if (editorParams[persistedKey] != null) {
      prefs[prefsKey] = editorParams[persistedKey];
    }
  }
}
