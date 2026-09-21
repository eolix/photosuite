/**
 * Golden I/O for built-in brush + swatch preset seeders.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ensureDefaultBrushPresets;
let ensureDefaultSwatchPresets;
let getSwatchPresetStore;

before(async () => {
  ({
    ensureDefaultBrushPresets,
    ensureDefaultSwatchPresets,
    getSwatchPresetStore,
  } = await import("../../../src/ui/config/default-presets.js"));
});

describe("ui/config/default-presets.js", () => {
  it("ensureDefaultBrushPresets seeds five round brushes and activates Soft Round", () => {
    const brushStore = { list: [], activeBrushPreset: null };
    assert.equal(ensureDefaultBrushPresets(brushStore), true);
    assert.deepEqual(
      brushStore.list.map((entry) => entry.v.Nm.v),
      ["Soft Round", "Hard Round", "Medium Round", "Large Soft", "Small Hard"]
    );
    assert.deepEqual(
      brushStore.list.map((entry) => entry.v.Brsh.v.diameter.v.val),
      [15, 15, 30, 60, 5]
    );
    assert.deepEqual(
      brushStore.list.map((entry) => entry.v.Brsh.v.Hrdn.v.val),
      [0, 100, 50, 25, 100]
    );
    assert.equal(brushStore.activeBrushPreset.Nm.v, "Soft Round");
    assert.equal(ensureDefaultBrushPresets(brushStore), false);
  });

  it("ensureDefaultBrushPresets is a no-op when the list is already populated", () => {
    const brushStore = { list: [{ t: "Objc", v: { Nm: { v: "Custom" } } }], activeBrushPreset: null };
    assert.equal(ensureDefaultBrushPresets(brushStore), false);
    assert.equal(brushStore.list.length, 1);
  });

  it("getSwatchPresetStore creates swatchPresets on appData", () => {
    const appData = {};
    const store = getSwatchPresetStore(appData);
    assert.equal(store, appData.swatchPresets);
    assert.deepEqual(store, []);
    assert.deepEqual(getSwatchPresetStore(null), []);
  });

  it("ensureDefaultSwatchPresets inserts Default folder with 24 colors", () => {
    const swatchStore = [];
    assert.equal(ensureDefaultSwatchPresets(swatchStore), true);
    assert.equal(swatchStore[0][0], "Default");
    assert.equal(swatchStore[0][3], true);
    assert.equal(swatchStore[0][2].length, 24);
    assert.deepEqual(swatchStore[0][2][0], [
      "Black",
      { h: 0, l: 0, O: 0, name: "Black" },
      null,
    ]);
    assert.deepEqual(swatchStore[0][2][swatchStore[0][2].length - 1], [
      "Navy",
      { h: 0, l: 0, O: 128, name: "Navy" },
      null,
    ]);
    assert.equal(ensureDefaultSwatchPresets(swatchStore), false);
  });
});
