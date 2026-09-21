import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let VectorPageBuilder;
let LayerEffectDefs;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/formats/registry/file-format-registry.js");
  ({ LayerEffectDefs } = await import("../../../src/document/formats/psd/effect-defs.js"));
  ({ VectorPageBuilder } = await import("../../../src/document/formats/vector-page-builder.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/vector-page-builder.js", () => {
  it("constructs with default state", () => {
    const builder = new VectorPageBuilder({}, new Matrix2D, false);
    assert.equal(builder.pageCount, 0);
    assert.equal(builder.pageFilter, -1);
    assert.equal(builder.clipPathKey, null);
    assert.deepEqual([builder.cursor.x, builder.cursor.y], [0, 0]);
  });

  it("psdToBlendMode maps PSD codes back to PDF blend names", () => {
    assert.equal(VectorPageBuilder.psdToBlendMode("norm"), "/Normal");
    assert.equal(VectorPageBuilder.psdToBlendMode("mul "), "/Multiply");
    assert.equal(VectorPageBuilder.psdToBlendMode("scrn"), "/Screen");
    assert.equal(VectorPageBuilder.psdToBlendMode("lum "), "/Luminosity");
    assert.equal(VectorPageBuilder.psdToBlendMode("nope"), undefined);
  });

  it("rgbFractionsToColorDesc scales 0..1 fractions into an RGBC descriptor", () => {
    const desc = VectorPageBuilder.rgbFractionsToColorDesc([1, 0.5, 0]);
    assert.equal(desc.classID, "RGBC");
    assert.equal(desc.Rd.v, 255);
    assert.equal(desc.Grn.v, 127.5);
    assert.equal(desc.Bl.v, 0);
  });

  it("applyStrokeStyleFromPathState enables stroke with clamped width and dash", () => {
    const strokeStyle = JSON.parse(JSON.stringify(LayerEffectDefs.StrokeStyleDefs.default));
    const pathState = { mlimit: 4, dash: [], doff: 0, ljoin: 0, lcap: 0, lwidth: 0.01, ctm: [1, 0, 0, 1, 0, 0] };
    VectorPageBuilder.applyStrokeStyleFromPathState(strokeStyle, pathState, 1, { classID: "RGBC" });
    assert.equal(strokeStyle.strokeEnabled.v, true);
    assert.equal(strokeStyle.strokeStyleLineWidth.v.val, 0.4);
    assert.equal(strokeStyle.strokeStyleContent.v.Clr.v.classID, "RGBC");
  });
});
