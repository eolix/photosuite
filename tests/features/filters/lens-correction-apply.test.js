/**
 * Lens Correction warp / CA / vignette goldens.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LENS_EDGE_BLACK,
  LENS_EDGE_EXTENSION,
  LENS_EDGE_TRANSPARENCY,
  LENS_EDGE_WHITE,
  applyChromaticAberration,
  applyLensCorrectionColorEffects,
  applyLensVignette,
  drawLensCorrectionGrid,
  applyProfileVignetting,
  fillLensCorrectionWarpMap,
  fillUncoveredEdges,
  resolveLensCorrectionEdgeMode,
} from "../../../src/features/filters/lens-correction-apply.js";

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * ((i % 7) + 1)) | 0;
  return sum;
}

function solidRgba(width, height, r, g, b, a) {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
    buf[o + 3] = a;
  }
  return buf;
}

function makeLnCrDescriptor(overrides) {
  const descriptor = {
    classID: "LnCr",
    LnIa: { t: "doub", v: 0 },
    LnSi: { t: "doub", v: 100 },
    LnRa: { t: "doub", v: 0 },
    LnVp: { t: "doub", v: 0 },
    LnHp: { t: "doub", v: 0 },
    LnSb: { t: "doub", v: 0 },
    LnSt: { t: "long", v: 50 },
    LnRc: { t: "doub", v: 0 },
    LnGm: { t: "doub", v: 0 },
    LnBy: { t: "doub", v: 0 },
    LnAs: { t: "bool", v: false },
    LnAg: { t: "bool", v: false },
    LnFt: { t: "long", v: LENS_EDGE_TRANSPARENCY },
  };
  if (overrides) {
    for (const key of Object.keys(overrides)) descriptor[key].v = overrides[key];
  }
  return descriptor;
}

/** Alias so the newer cases read the way they are phrased. */
const descriptorWith = makeLnCrDescriptor;

function makeWarpMap(gridWidth, gridHeight) {
  return { gridWidth, gridHeight, map: new Float32Array(gridWidth * gridHeight * 2) };
}

describe("features/filters/lens-correction-apply.js", () => {
  it("fillLensCorrectionWarpMap is identity at defaults", () => {
    const descriptor = makeLnCrDescriptor();
    const warpMap = {
      gridWidth: 8,
      gridHeight: 8,
      map: new Float32Array(8 * 8 * 2),
    };
    fillLensCorrectionWarpMap(warpMap, descriptor);
    let maxAbs = 0;
    for (let i = 0; i < warpMap.map.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(warpMap.map[i]));
    }
    assert.ok(maxAbs < 1e-3, "default displacement should be ~0, got " + maxAbs);
  });

  it("fillLensCorrectionWarpMap responds to distortion, scale, angle, perspective", () => {
    const descriptor = makeLnCrDescriptor({
      LnIa: 40,
      LnSi: 120,
      LnRa: 15,
      LnVp: 30,
      LnHp: -20,
    });
    const warpMap = {
      gridWidth: 16,
      gridHeight: 16,
      map: new Float32Array(16 * 16 * 2),
    };
    fillLensCorrectionWarpMap(warpMap, descriptor);
    let sum = 0;
    for (let i = 0; i < warpMap.map.length; i++) sum += Math.abs(warpMap.map[i]);
    assert.ok(sum > 1, "non-default geometry should displace samples");
  });

  it("applyChromaticAberration shifts channels for non-zero fringe", () => {
    const width = 32;
    const height = 32;
    const buf = solidRgba(width, height, 200, 100, 50, 255);
    buf[(8 * width + 24) * 4] = 255;
    buf[(8 * width + 24) * 4 + 1] = 0;
    buf[(8 * width + 24) * 4 + 2] = 0;
    const before = checksum(buf);
    applyChromaticAberration(buf, width, height, 80, -40, 20);
    assert.notEqual(checksum(buf), before);
  });

  it("applyLensVignette darkens edges for negative amount", () => {
    const width = 24;
    const height = 24;
    const buf = solidRgba(width, height, 180, 180, 180, 255);
    applyLensVignette(buf, width, height, -80, 50);
    const center = (12 * width + 12) * 4;
    const corner = 0;
    assert.ok(buf[corner] < buf[center], "corner should be darker than center");
  });

  it("applyLensCorrectionColorEffects is a no-op at defaults", () => {
    const descriptor = makeLnCrDescriptor();
    const buf = solidRgba(16, 16, 40, 80, 120, 255);
    const before = buf.slice(0);
    applyLensCorrectionColorEffects(buf, 16, 16, descriptor);
    assert.deepEqual(Array.from(buf), Array.from(before));
  });

  it("drawLensCorrectionGrid paints visible lines", () => {
    const width = 40;
    const height = 40;
    const buf = solidRgba(width, height, 0, 0, 0, 255);
    drawLensCorrectionGrid(buf, width, height, 10, {
      Rd: { v: 255 },
      Grn: { v: 255 },
      Bl: { v: 255 },
    }, 1);
    assert.ok(buf[0] > 200, "grid line at origin");
    assert.equal(buf[(5 * width + 5) * 4], 0, "off-grid pixel stays dark");
  });

  it("keeps the centre cell finite on a grid that has one", () => {
    // Both the barrel and pincushion ratios are 0/0 at zero radius, and a grid
    // with an odd cell count on both axes puts a cell exactly at the centre.
    for (const [gridWidth, gridHeight] of [[41, 31], [40, 30], [41, 30]]) {
      const warpMap = {
        gridWidth,
        gridHeight,
        map: new Float32Array(gridWidth * gridHeight * 2),
      };
      fillLensCorrectionWarpMap(warpMap, descriptorWith({ LnRa: 5 }));
      for (let i = 0; i < warpMap.map.length; i++) {
        assert.ok(
          Number.isFinite(warpMap.map[i]),
          `grid ${gridWidth}x${gridHeight} produced a non-finite displacement`,
        );
      }
    }
  });

  it("keeps perspective bounded at the slider limits", () => {
    // One projective denominator drives both axes and cannot reach zero, so the
    // frame stays a sane trapezoid instead of collapsing.
    for (const [vertical, horizontal] of [[100, 0], [-100, 0], [99, 0], [100, 100], [-100, -100]]) {
      const warpMap = makeWarpMap(40, 30);
      fillLensCorrectionWarpMap(warpMap, descriptorWith({ LnVp: vertical, LnHp: horizontal }));
      let largest = 0;
      for (let i = 0; i < warpMap.map.length; i++) {
        assert.ok(Number.isFinite(warpMap.map[i]), "displacement went non-finite");
        largest = Math.max(largest, Math.abs(warpMap.map[i]));
      }
      assert.ok(
        largest < 2 * warpMap.gridWidth,
        `LnVp ${vertical} / LnHp ${horizontal} displaced by ${largest.toFixed(1)} cells`,
      );
    }
  });

  it("auto scale pulls the frame back inside, and only when it needs to", () => {
    const reachOf = (fields, autoScale) => {
      const warpMap = makeWarpMap(41, 31);
      fillLensCorrectionWarpMap(warpMap, descriptorWith({ ...fields, LnAs: autoScale }));
      const centreX = 0.5 * (warpMap.gridWidth - 1);
      const centreY = 0.5 * (warpMap.gridHeight - 1);
      let reach = 0;
      for (let row = 0; row < warpMap.gridHeight; row++) {
        for (let col = 0; col < warpMap.gridWidth; col++) {
          const offset = (row * warpMap.gridWidth + col) << 1;
          reach = Math.max(
            reach,
            Math.abs(col + warpMap.map[offset] - centreX) / centreX,
            Math.abs(row + warpMap.map[offset + 1] - centreY) / centreY,
          );
        }
      }
      return reach;
    };
    // Rotation and keystone leave uncovered corners; auto scale removes them.
    for (const fields of [{ LnRa: 10 }, { LnVp: 60 }, { LnSi: 80 }]) {
      assert.ok(reachOf(fields, false) > 1.05, "expected uncovered area with auto scale off");
      assert.ok(Math.abs(reachOf(fields, true) - 1) < 0.02, "auto scale should just cover the frame");
    }
    // Pincushion already samples inside the frame, so there is nothing to do.
    assert.ok(reachOf({ LnIa: 50 }, false) < 1, "pincushion should not uncover anything");
    assert.equal(reachOf({ LnIa: 50 }, true).toFixed(3), reachOf({ LnIa: 50 }, false).toFixed(3));
  });

  it("edge treatment picks the sampler mode and paints the colour fills", () => {
    assert.equal(resolveLensCorrectionEdgeMode(descriptorWith({ LnFt: LENS_EDGE_TRANSPARENCY })), 0);
    assert.equal(resolveLensCorrectionEdgeMode(descriptorWith({ LnFt: LENS_EDGE_EXTENSION })), 1);
    // The colour fills warp transparent, then paint what the warp left behind.
    assert.equal(resolveLensCorrectionEdgeMode(descriptorWith({ LnFt: LENS_EDGE_BLACK })), 0);
    assert.equal(resolveLensCorrectionEdgeMode(descriptorWith({ LnFt: LENS_EDGE_WHITE })), 0);

    const uncovered = () => new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0]);
    const transparent = uncovered();
    fillUncoveredEdges(transparent, descriptorWith({ LnFt: LENS_EDGE_TRANSPARENCY }));
    assert.equal(transparent[7], 0, "transparency should leave the hole alone");

    const black = uncovered();
    fillUncoveredEdges(black, descriptorWith({ LnFt: LENS_EDGE_BLACK }));
    assert.deepEqual(Array.from(black.slice(4)), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(black.slice(0, 4)), [10, 20, 30, 255], "covered pixels are untouched");

    const white = uncovered();
    fillUncoveredEdges(white, descriptorWith({ LnFt: LENS_EDGE_WHITE }));
    assert.deepEqual(Array.from(white.slice(4)), [255, 255, 255, 255]);
  });

  it("places profile coefficients by the frame they were measured on", () => {
    // A barrel-correcting profile measured on APS-C. The same pixel sits further
    // out in the lens's image circle on a larger sensor, so the correction there
    // must be stronger, and weaker on a smaller one.
    const calibrationOn = (imageCropFactor) => ({
      distortion: { model: 2, c0: 0.02, c1: -0.06, c2: 0.05 },
      calibrationCropFactor: 1.6,
      calibrationAspectRatio: 1.5,
      imageCropFactor,
    });
    const displacementFor = (calibration) => {
      const warpMap = makeWarpMap(60, 40);
      fillLensCorrectionWarpMap(
        warpMap, descriptorWith({ LnAg: true }), calibration);
      let largest = 0;
      for (let i = 0; i < warpMap.map.length; i++) {
        largest = Math.max(largest, Math.abs(warpMap.map[i]));
      }
      return largest;
    };
    const onCalibrationBody = displacementFor(calibrationOn(1.6));
    const onFullFrame = displacementFor(calibrationOn(1));
    const onSmallerSensor = displacementFor(calibrationOn(2.7));
    assert.ok(onCalibrationBody > 0, "the profile should do something on its own body");
    assert.ok(onFullFrame > onCalibrationBody, "a larger sensor reaches further into the image circle");
    assert.ok(onSmallerSensor < onCalibrationBody, "a smaller sensor crops into the middle");
  });

  it("leaves the warp alone when the profile switch is off", () => {
    const calibration = {
      distortion: { model: 2, c0: 0.02, c1: -0.06, c2: 0.05 },
      calibrationCropFactor: 1.6, calibrationAspectRatio: 1.5, imageCropFactor: 1.6,
    };
    const warpMap = makeWarpMap(60, 40);
    fillLensCorrectionWarpMap(warpMap, descriptorWith({ LnAg: false }), calibration);
    for (let i = 0; i < warpMap.map.length; i++) {
      assert.ok(Math.abs(warpMap.map[i]) < 1e-6, "no correction should be applied");
    }
  });

  it("caps how far a vignetting profile may brighten the corners", () => {
    // This fit turns negative at radius 1, which is past where it describes the
    // lens; the cap is what keeps that from becoming a wild corner lift.
    const calibration = {
      vignetting: { k1: -2.1271, k2: 2.6641, k3: -1.2836 },
      calibrationCropFactor: 1.6, calibrationAspectRatio: 1.5, imageCropFactor: 1.6,
    };
    const width = 40;
    const height = 30;
    const rgba = new Uint8Array(width * height * 4).fill(60);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    applyProfileVignetting(rgba, width, height, calibration);
    const centre = rgba[((height >> 1) * width + (width >> 1)) * 4];
    const corner = rgba[0];
    assert.ok(Math.abs(centre - 60) <= 1, `centre should be untouched, got ${centre}`);
    assert.ok(corner > centre, "corners should be lifted");
    assert.ok(corner <= 60 * 4 + 1, `corner lift should be capped, got ${corner}`);
  });
});
