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
});

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
