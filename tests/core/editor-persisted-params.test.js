import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_EDITOR_PREFS,
  EDITOR_PERSISTED_PARAM_MAP,
  applyEditorParamsToPrefs,
  snapshotEditorParamsFromPrefs,
} from "../../src/core/editor-persisted-params.js";

describe("core/editor-persisted-params.js", () => {

  it("skips null editor param values on apply", () => {
    const prefs = { guides: true, showGrid: false };
    applyEditorParamsToPrefs(prefs, { guides: null, grid: true });
    assert.equal(prefs.guides, true);
    assert.equal(prefs.showGrid, true);
  });

  it("persists the GPU preference alongside the view settings", () => {
    // The renderer flag itself is runtime state — an oversized document drops it
    // to CPU for that session. What persists is what the user asked for.
    assert.equal(EDITOR_PERSISTED_PARAM_MAP.gpu, "gpuAcceleration");
    assert.equal(EDITOR_PERSISTED_PARAM_MAP.zws, "zoomWithScrollWheel");
    assert.equal(Object.keys(EDITOR_PERSISTED_PARAM_MAP).length, 12);
  });

  // Every persisted key needs a starting value, or a fresh install writes
  // `undefined` into the settings file on first save.
  it("gives every persisted preference a default", () => {
    for (const prefsKey of Object.values(EDITOR_PERSISTED_PARAM_MAP)) {
      assert.notEqual(DEFAULT_EDITOR_PREFS[prefsKey], undefined, prefsKey + " has no default");
    }
  });
});
