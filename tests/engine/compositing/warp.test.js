/**
 * Golden values for warp.js imageWarp / layerWarp (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { meshControlPointsFromRect } from "../../../src/engine/compositing/image-renderer.js";
import { applyWarp, sampleDisplacementField, applyPerspectiveScale, calcArcCosOffset, calcArcSinOffset, computeWarpGrid, defaultWarpDescriptor, getWarpControlPoints, isIdentityWarp, pointsToCustomEnvelope } from "../../../src/engine/compositing/warp.js";

installBrowserGlobals();

let Rect;

before(async () => {
  ({ Rect } = await import("../../../src/core/math/rect.js"));
});

describe("engine/compositing/warp.js imageWarp", () => {
  it("sampleDisplacementField bilinear XY", () => {
    const field = new Float64Array([0, 0, 2, 0, 0, 2, 2, 2]);
    const out = new Float64Array(2);
    sampleDisplacementField(field, 2, 2, 1.0, 1.0, out);
    assert.deepEqual(
      Array.from(out).map((v) => +v.toFixed(10)),
      [1.000002, 1.000002],
    );
    sampleDisplacementField(field, 2, 2, 1.75, 1.25, out);
    assert.deepEqual(
      Array.from(out).map((v) => +v.toFixed(6)),
      [2, 1.500002],
    );
  });

  it("applyWarp identity and region shift", () => {
    const src = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      src[i * 4] = i * 10;
      src[i * 4 + 1] = 50;
      src[i * 4 + 2] = 100;
      src[i * 4 + 3] = 255;
    }
    const dst = new Uint8ClampedArray(src.length);
    applyWarp(src, dst, 4, 4, null, new Float64Array(4 * 4 * 2), 4, 4, 0);
    assert.deepEqual(Array.from(dst.slice(0, 8)), [0, 50, 100, 255, 10, 50, 100, 255]);

    const shiftField = new Float64Array(4 * 4 * 2);
    for (let i = 0; i < 16; i++) {
      shiftField[i * 2] = 1;
      shiftField[i * 2 + 1] = 0;
    }
    const dst2 = new Uint8ClampedArray(src.length);
    applyWarp(src, dst2, 4, 4, new Rect(1, 1, 2, 2), shiftField, 4, 4, 0);
    assert.deepEqual(Array.from(new Uint32Array(dst2.buffer)).slice(0, 8), [
      0, 0, 0, 0, 0, 4284756540, 4284756550, 0,
    ]);
  });
});

describe("engine/compositing/warp.js layerWarp", () => {
  it("defaultWarpDescriptor / isIdentity / arc offsets", () => {
    const desc = defaultWarpDescriptor(new Rect(10, 20, 100, 50));
    assert.equal(desc.warpStyle.v.warpStyle, "warpNone");
    assert.equal(desc.bounds.v.Left.v.val, 10);
    assert.equal(desc.bounds.v.Btom.v.val, 70);
    assert.equal(isIdentityWarp(desc), true);
    assert.equal(calcArcCosOffset(0.5), 1.1666666666666665);
    assert.equal(+calcArcSinOffset(0.5, Math.sqrt(0.75)).toFixed(6), 0.481125);
  });

  it("computeWarpGrid none / arc / fisheye", () => {
    const none = computeWarpGrid(new Rect(0, 0, 90, 60), "warpNone", true, 0, 0, 0);
    assert.equal(none.length, 32);
    assert.deepEqual(none.slice(0, 4), [0, 0, 30, 0]);
    assert.deepEqual(none.slice(-4), [60, 60, 90, 60]);

    const arc = computeWarpGrid(new Rect(0, 0, 90, 60), "warpArc", true, 0.5, 0, 0)
      .map((v) => +v.toFixed(4));
    assert.deepEqual(arc, [
      -42.4264, 17.5736, 5.8579, -30.7107, 84.1421, -30.7107, 132.4264, 17.5736, -28.2843, 31.7157,
      12.1895, -8.7581, 77.8105, -8.7581, 118.2843, 31.7157, -14.1421, 45.8579, 18.5212, 13.1946,
      71.4788, 13.1946, 104.1421, 45.8579, 0, 60, 24.8528, 35.1472, 65.1472, 35.1472, 90, 60,
    ]);

    const arcV = computeWarpGrid(
      new Rect(0, 0, 90, 60),
      "warpArc",
      false,
      0.4,
      0.1,
      0.2,
    );
    assert.equal(
      arcV.reduce((sum, v) => sum + Math.round(v * 1000), 0),
      1165086,
    );

    assert.deepEqual(
      computeWarpGrid(new Rect(0, 0, 90, 60), "warpFisheye", true, 0.3, 0, 0)
        .map((v) => +v.toFixed(4)),
      [
        0, 0, 30, 0, 60, 0, 90, 0, 0, 20, 12, 8, 78, 8, 90, 20, 0, 40, 12, 52, 78, 52, 90, 40, 0, 60,
        30, 60, 60, 60, 90, 60,
      ],
    );
  });

  it("applyPerspectiveScale and custom envelope identity", () => {
    const coords = meshControlPointsFromRect(0, 0, 90, 60);
    applyPerspectiveScale(coords, new Rect(0, 0, 90, 60), 0.2, 0.1);
    assert.deepEqual(
      coords.map((v) => +v.toFixed(4)).slice(0, 8),
      [3.6, 6, 31.4, 2, 58.4, -2, 84.6, -6],
    );

    const custom = defaultWarpDescriptor(new Rect(0, 0, 30, 30));
    const undeformed = computeWarpGrid(
      new Rect(0, 0, 30, 30),
      "warpNone",
      true,
      0,
      0,
      0,
    );
    pointsToCustomEnvelope(undeformed, custom);
    assert.equal(isIdentityWarp(custom), true);
    assert.deepEqual(getWarpControlPoints(custom, null).slice(0, 4), [0, 0, 10, 0]);
  });
});
