/**
 * form-controls color unpack / swatch hit goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let unpackPackedRgb;
let packRgbChannels;
let hitTestFgBgSwatch;
let SWATCH_HIT_FOREGROUND;
let SWATCH_HIT_BACKGROUND;
let SWATCH_HIT_SWAP;
let SWATCH_HIT_DEFAULTS;
let Button;
let Checkbox;

before(async () => {
  ({
    unpackPackedRgb,
    packRgbChannels,
    hitTestFgBgSwatch,
    SWATCH_HIT_FOREGROUND,
    SWATCH_HIT_BACKGROUND,
    SWATCH_HIT_SWAP,
    SWATCH_HIT_DEFAULTS,
    Button,
    Checkbox
  } = await import("../../../src/ui/widgets/form-controls.js"));
});

describe("ui/widgets/form-controls.js", () => {
  it("unpackPackedRgb / packRgbChannels round-trip", () => {
    const packed = (12 << 16) | (34 << 8) | 56;
    const rgb = unpackPackedRgb(packed);
    assert.deepEqual(rgb, { h: 12, l: 34, O: 56 });
    assert.equal(packRgbChannels(rgb), packed);
  });

  it("hitTestFgBgSwatch regions", () => {
    const canvas = 20;
    const swatch = 10;
    assert.equal(hitTestFgBgSwatch(0, 0, canvas, swatch), SWATCH_HIT_FOREGROUND);
    assert.equal(hitTestFgBgSwatch(19, 19, canvas, swatch), SWATCH_HIT_BACKGROUND);
    assert.equal(hitTestFgBgSwatch(5, 15, canvas, swatch), SWATCH_HIT_SWAP);
    assert.equal(hitTestFgBgSwatch(15, 5, canvas, swatch), SWATCH_HIT_DEFAULTS);
  });

  it("exports Button and Checkbox constructors", () => {
    assert.equal(typeof Button, "function");
    assert.equal(typeof Checkbox, "function");
  });
});
