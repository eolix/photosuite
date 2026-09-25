/**
 * The preference registry: one declaration per preference, everything else
 * derived from it. These tests hold that derivation together — a preference
 * that reaches the dialog but not the settings file, or the settings file but
 * not the defaults, is the failure mode the single table exists to rule out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_EDITOR_PREFS,
  EDITOR_PERSISTED_PARAM_MAP,
  EDITOR_PREFERENCES,
  EDITOR_PREFERENCES_BY_KEY,
  applyEditorParamsToPrefs,
  createDefaultEditorPrefs,
  normalizeEditorPrefs,
  readPrefValue,
  snapshotEditorParamsFromPrefs,
} from "../../src/core/editor-preferences.js";

describe("core/editor-preferences.js", () => {
  it("declares every preference once, with a key, a store key and a default", () => {
    const keys = EDITOR_PREFERENCES.map((preference) => preference.key);
    const storeKeys = EDITOR_PREFERENCES.map((preference) => preference.storeKey);
    assert.equal(new Set(keys).size, keys.length, "a preference key is declared twice");
    assert.equal(new Set(storeKeys).size, storeKeys.length, "a store key is used twice");
    for (const preference of EDITOR_PREFERENCES) {
      assert.equal(typeof preference.key, "string");
      assert.equal(typeof preference.storeKey, "string");
      assert.notEqual(preference.defaultValue, undefined, preference.key + " has no default");
    }
  });

  it("derives the defaults, the lookup and the persisted map from that one list", () => {
    assert.deepEqual(Object.keys(DEFAULT_EDITOR_PREFS), EDITOR_PREFERENCES.map((p) => p.key));
    assert.deepEqual(Object.keys(EDITOR_PREFERENCES_BY_KEY), Object.keys(DEFAULT_EDITOR_PREFS));
    assert.deepEqual(
      Object.keys(EDITOR_PERSISTED_PARAM_MAP),
      EDITOR_PREFERENCES.map((p) => p.storeKey),
    );
    assert.equal(EDITOR_PERSISTED_PARAM_MAP.gpu, "gpuAcceleration");
    assert.equal(EDITOR_PERSISTED_PARAM_MAP.zws, "zoomWithScrollWheel");
  });

  it("createDefaultEditorPrefs hands back a writable copy", () => {
    const prefs = createDefaultEditorPrefs();
    prefs.guides = !prefs.guides;
    assert.notEqual(prefs.guides, DEFAULT_EDITOR_PREFS.guides, "the frozen defaults were edited");
  });

  // A settings file written before a preference existed has no value for it,
  // which is the normal case after an update — the control shows the default,
  // not nothing.
  it("readPrefValue falls back to the default for a missing value", () => {
    assert.equal(readPrefValue({ gpuAcceleration: false }, "gpuAcceleration"), false);
    assert.equal(readPrefValue({}, "gpuAcceleration"), true);
    assert.equal(readPrefValue({}, "zoomWithScrollWheel"), false);
    assert.equal(readPrefValue(null, "guides"), true);
    assert.equal(readPrefValue({}, "notAPreference"), null);
  });

  // The rule lives with the preference, so it holds on the way in from disk as
  // well as on the way out of the dialog.
  it("normalizeEditorPrefs rounds a grid gap unless it is a percentage", () => {
    assert.equal(normalizeEditorPrefs({ gridSize: 12.7, gridUnits: 0 }).gridSize, 13);
    assert.equal(normalizeEditorPrefs({ gridSize: 12.7, gridUnits: 4 }).gridSize, 12.7);
    assert.deepEqual(normalizeEditorPrefs({ guides: true }), { guides: true });
  });

  it("snapshots and reloads every preference by its store key", () => {
    const prefs = createDefaultEditorPrefs();
    prefs.guides = false;
    prefs.gridSize = 33;
    prefs.zoomWithScrollWheel = true;
    const snapshot = snapshotEditorParamsFromPrefs(prefs);
    assert.deepEqual(Object.keys(snapshot), EDITOR_PREFERENCES.map((p) => p.storeKey));
    assert.equal(snapshot.guides, false);
    assert.equal(snapshot.gsize, 33);
    assert.equal(snapshot.zws, true);

    const reloaded = createDefaultEditorPrefs();
    applyEditorParamsToPrefs(reloaded, snapshot);
    assert.deepEqual(reloaded, prefs);
  });

  it("skips null editor param values on apply", () => {
    const prefs = { guides: true, showGrid: false };
    applyEditorParamsToPrefs(prefs, { guides: null, grid: true });
    assert.equal(prefs.guides, true);
    assert.equal(prefs.showGrid, true);
  });

  it("normalises what it reads back from disk", () => {
    const prefs = createDefaultEditorPrefs();
    applyEditorParamsToPrefs(prefs, { gsize: 8.4, gunits: 0 });
    assert.equal(prefs.gridSize, 8);
  });
});
