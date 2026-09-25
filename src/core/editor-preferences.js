/**
 * Every editor preference, declared once.
 *
 * A preference is one entry: the name the app reads it by, the short key it
 * persists under in `settings.json`, and the value a fresh install starts with.
 * The defaults object, the settings-file snapshot, the reload path and the
 * Preferences dialog's rows are all derived from this list — so adding a
 * preference is one entry here plus one row in the dialog's section table, and
 * nothing can be half-added: a pref with no default, or one that never reaches
 * disk, is not expressible.
 *
 * `normalize` is the place for a rule about what a value may be, so it holds
 * wherever the value is written rather than only where the widget that edits it
 * happens to live.
 */

/** Unit dropdowns count percent as index 4; see UNIT_NAMES. */
const PERCENT_UNIT_INDEX = 4;

/**
 * @typedef {object} EditorPreference
 * @property {string} key Name on `appData.prefs`.
 * @property {string} storeKey Key inside the persisted `eparams` object.
 * @property {boolean|number} defaultValue Value a fresh install starts with.
 * @property {(value: *, prefs: object) => *} [normalize] Constraint on the value.
 */

/** @type {ReadonlyArray<EditorPreference>} */
export const EDITOR_PREFERENCES = Object.freeze([
  { key: "guides", storeKey: "guides", defaultValue: true },
  { key: "showGrid", storeKey: "grid", defaultValue: false },
  { key: "gridType", storeKey: "gtype", defaultValue: 0 },
  {
    key: "gridSize",
    storeKey: "gsize",
    defaultValue: 20,
    // A gap in pixels or millimetres is a whole number of them; as a percentage
    // of the canvas it is not.
    normalize: function (value, prefs) {
      return prefs.gridUnits == PERCENT_UNIT_INDEX ? value : Math.round(value);
    },
  },
  { key: "gridUnits", storeKey: "gunits", defaultValue: 0 },
  { key: "AppWindow", storeKey: "runits", defaultValue: 0 },
  { key: "showSelectionEdges", storeKey: "sels", defaultValue: true },
  { key: "paths", storeKey: "paths", defaultValue: true },
  { key: "showPixelGrid", storeKey: "pgrid", defaultValue: true },
  { key: "slices", storeKey: "slices", defaultValue: true },
  { key: "gpuAcceleration", storeKey: "gpu", defaultValue: true },
  { key: "zoomWithScrollWheel", storeKey: "zws", defaultValue: false },
]);

/** @type {Readonly<Record<string, EditorPreference>>} */
export const EDITOR_PREFERENCES_BY_KEY = Object.freeze(
  Object.fromEntries(EDITOR_PREFERENCES.map((preference) => [preference.key, preference])),
);

/**
 * Persisted key → `appData.prefs` key, for reading a settings file written by
 * an earlier run.
 * @type {Readonly<Record<string, string>>}
 */
export const EDITOR_PERSISTED_PARAM_MAP = Object.freeze(
  Object.fromEntries(EDITOR_PREFERENCES.map((preference) => [preference.storeKey, preference.key])),
);

/**
 * What every `appData.prefs` key starts as, and what Preferences → Reset puts
 * back.
 * @type {Readonly<Record<string, boolean|number>>}
 */
export const DEFAULT_EDITOR_PREFS = Object.freeze(
  Object.fromEntries(EDITOR_PREFERENCES.map((preference) => [preference.key, preference.defaultValue])),
);

/** A writable copy of {@link DEFAULT_EDITOR_PREFS}. */
export function createDefaultEditorPrefs() {
  return Object.assign({}, DEFAULT_EDITOR_PREFS);
}

/**
 * The value of one preference, falling back to its default.
 *
 * A key missing from `prefs` is the normal case for a preference added after
 * the settings file on disk was written, so reading through this is what keeps
 * an upgrade from showing a control as empty or off.
 *
 * @param {Record<string, unknown>} prefs
 * @param {string} prefKey
 */
export function readPrefValue(prefs, prefKey) {
  const value = prefs == null ? null : prefs[prefKey];
  if (value != null) return value;
  const preference = EDITOR_PREFERENCES_BY_KEY[prefKey];
  return preference == null ? null : preference.defaultValue;
}

/**
 * Apply every preference's `normalize` rule to `prefs`, in place.
 * @param {Record<string, unknown>} prefs
 * @returns {Record<string, unknown>} the same object
 */
export function normalizeEditorPrefs(prefs) {
  for (let prefIdx = 0; prefIdx < EDITOR_PREFERENCES.length; prefIdx++) {
    const preference = EDITOR_PREFERENCES[prefIdx];
    if (preference.normalize == null || prefs[preference.key] == null) continue;
    prefs[preference.key] = preference.normalize(prefs[preference.key], prefs);
  }
  return prefs;
}

/**
 * The `eparams` object written to the settings file.
 * @param {Record<string, unknown>} prefs
 */
export function snapshotEditorParamsFromPrefs(prefs) {
  const snapshot = {};
  for (let prefIdx = 0; prefIdx < EDITOR_PREFERENCES.length; prefIdx++) {
    const preference = EDITOR_PREFERENCES[prefIdx];
    snapshot[preference.storeKey] = prefs[preference.key];
  }
  return snapshot;
}

/**
 * Read an `eparams` object back into `prefs`, in place. A key the file does not
 * carry keeps the value already there — which is how a settings file written
 * before a preference existed still loads.
 *
 * @param {Record<string, unknown>} prefs
 * @param {Record<string, unknown>} editorParams
 */
export function applyEditorParamsToPrefs(prefs, editorParams) {
  for (let prefIdx = 0; prefIdx < EDITOR_PREFERENCES.length; prefIdx++) {
    const preference = EDITOR_PREFERENCES[prefIdx];
    const storedValue = editorParams[preference.storeKey];
    if (storedValue != null) prefs[preference.key] = storedValue;
  }
  normalizeEditorPrefs(prefs);
}
