import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let FpngLoader;
let argbToRgbaFractions;
let getLayerField;
let FIREWORKS_BLEND_MODE_BY_CODE;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  const mod = await import("../../../src/document/formats/fpng-format.js");
  FpngLoader = mod.FpngLoader;
  argbToRgbaFractions = mod.argbToRgbaFractions;
  getLayerField = mod.getLayerField;
  FIREWORKS_BLEND_MODE_BY_CODE = mod.FIREWORKS_BLEND_MODE_BY_CODE;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/fpng-format.js", () => {

  it("argbToRgbaFractions unpacks ARGB bytes", () => {
    assert.deepEqual(argbToRgbaFractions(0xff804020), [1, 128 / 255, 64 / 255, 32 / 255]);
    assert.deepEqual(argbToRgbaFractions(0x00000000), [0, 0, 0, 0]);
  });

  it("getLayerField returns scalar or indexed array entry", () => {
    assert.equal(getLayerField({ FON: "Helvetica" }, "FON", 0), "Helvetica");
    assert.equal(getLayerField({ FON: ["A", "B"] }, "FON", 1), "B");
  });

  it("FIREWORKS_BLEND_MODE_BY_CODE maps known Fireworks blend codes", () => {
    assert.equal(FIREWORKS_BLEND_MODE_BY_CODE["2"], "mul ");
    assert.equal(FIREWORKS_BLEND_MODE_BY_CODE["30"], "norm");
    assert.equal(FIREWORKS_BLEND_MODE_BY_CODE["41"], "vLit");
  });
});
