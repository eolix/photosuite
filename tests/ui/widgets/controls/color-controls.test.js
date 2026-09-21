/**
 * color-controls pack/clamp / swatch default goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let packRgbChannels;
let unpackPackedRgb;
let clampByte;
let clampUnit;
let DEFAULT_SWATCH_COLORS;
let ColorSwatchGrid;
let ColorSampleWidget;
let ColorWheel;
let CropConstraintWidget;

before(async () => {
  ({
    packRgbChannels,
    unpackPackedRgb,
    clampByte,
    clampUnit,
    DEFAULT_SWATCH_COLORS,
    ColorSwatchGrid,
    ColorSampleWidget,
    ColorWheel,
    CropConstraintWidget
  } = await import("../../../../src/ui/widgets/controls/color-controls.js"));
});

describe("ui/widgets/controls/color-controls.js", () => {
  it("packRgbChannels / unpackPackedRgb round-trip", () => {
    assert.equal(packRgbChannels(255, 128, 0), 16744448);
    assert.deepEqual(unpackPackedRgb(0xff8000), { h: 255, l: 128, O: 0 });
    assert.deepEqual(unpackPackedRgb(packRgbChannels(12, 34, 56)), { h: 12, l: 34, O: 56 });
  });

  it("clampByte / clampUnit goldens", () => {
    assert.equal(clampByte(-1), 0);
    assert.equal(clampByte(300), 255);
    assert.equal(clampUnit(1.5), 1);
    assert.equal(clampUnit(-0.2), 0);
  });

  it("DEFAULT_SWATCH_COLORS golden head", () => {
    assert.deepEqual(DEFAULT_SWATCH_COLORS.slice(0, 3), [16711680, 65280, 255]);
    assert.equal(DEFAULT_SWATCH_COLORS.length, 9);
  });

  it("exports constructors", () => {
    assert.equal(typeof ColorSwatchGrid, "function");
    assert.equal(typeof ColorSampleWidget, "function");
    assert.equal(typeof ColorWheel, "function");
    assert.equal(typeof CropConstraintWidget, "function");
  });
});
