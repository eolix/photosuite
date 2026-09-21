/**
 * Golden values for raw-functions (compositing — RAW pipeline).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { copyBuffer } from "../../../src/engine/compositing/buffer-utils.js";
import { BAYER_PATTERNS, applyExposureCurve, applyHighlightCurve, applyShadowCurve, computeEncryptionKeys, decodeSigmaRaw, decryptNikonData, estimateIlluminant, getBlackLevel, getPixelRange, getWhiteLevel, interpolateColorMatrix, lookupCameraBySize, lookupFormatEntry, orientationMatrix, rationalsToFloats, unpackPixels } from "../../../src/engine/compositing/raw-functions.js";
import { CAMERA_DATABASE } from "../../../src/engine/compositing/raw-camera-db.js";
import { planckianLocusFromChromaticity } from "../../../src/engine/compositing/color-temperature.js";

installBrowserGlobals();

describe("engine/compositing/raw-functions.js", () => {
  it("rationalsToFloats, bayerPatterns, lookupCameraBySize", () => {
    assert.deepEqual(rationalsToFloats([[1, 2], [3, 4], [5, 0]]), [0.5, 0.75, 0]);
    assert.deepEqual(BAYER_PATTERNS, [
      [2, 1, 1, 0],
      [0, 1, 1, 2],
      [1, 0, 2, 1],
      [1, 2, 0, 1],
    ]);
    const entry = CAMERA_DATABASE["gitup git2"];
    assert.deepEqual(lookupCameraBySize((entry[4] * entry[5] * 16) / 8), ["gitup git2", 16]);
  });

  it("orientationMatrix for EXIF orientations 2/3/5/6/8", () => {
    assert.deepEqual(orientationMatrix(2, 100, 50), [100, 50, -1, 0, 99, 0, 1, 0]);
    assert.deepEqual(orientationMatrix(3, 10, 20), [10, 20, -1, 0, 9, 0, -1, 19]);
    assert.deepEqual(orientationMatrix(5, 10, 20), [20, 10, 0, 1, 0, 1, 0, 0]);
    assert.deepEqual(orientationMatrix(6, 100, 50), [50, 100, 0, 1, 0, -1, 0, 49]);
    assert.deepEqual(orientationMatrix(8, 100, 50), [50, 100, 0, -1, 99, 1, 0, 0]);
  });

  it("black / white / range levels", () => {
    assert.equal(getBlackLevel({ t50714: [1024, 1024, 1024, 1024] }), 1024);
    assert.equal(getBlackLevel({ t50714: [100], t50715: [[10, 2]] }), 105);
    assert.equal(getBlackLevel({ t50714: [100], t50716: [[5, 1]] }), 105);
    assert.equal(getWhiteLevel({ t50717: [15000], t258: [14] }), 15000);
    assert.equal(getWhiteLevel({ t50717: [20000], t50712: new Uint16Array([0, 100, 5000]) }), 5000);
    assert.equal(getPixelRange({ t50714: [100], t50717: [1100] }), 1000);
  });

  it("curveAdjustments match captured midtone samples", () => {
    assert.equal(applyExposureCurve(0.5, 0.5), 0.5065698925177899);
    assert.equal(applyExposureCurve(0.5, -0.5), 0.5265546018890437);
    assert.equal(applyHighlightCurve(0.7, 0.3), 0.7567673365300356);
    assert.equal(applyShadowCurve(0.3, -0.4), 0.22980260844913017);
  });

  it("Nikon crypto helpers and format table lookup", () => {
    assert.deepEqual(lookupFormatEntry(151, new Uint8Array([0x30, 0x31, 0x30, 0x32, 0, 0, 0, 0])), [
      151, "0102", 0, 1, null,
    ]);
    assert.deepEqual(computeEncryptionKeys({ t29: ["12345"], t167: [0x11223344] }), [71, 239, 96]);
    const plain = new Uint32Array(2);
    decryptNikonData(new Uint32Array([0xAABBCCDD, 0x11223344]), plain, 2, 12345);
    assert.deepEqual(Array.from(plain), [1149427099, 2561570537]);
  });

  it("unpackPixels reads packed 8-bit pairs", () => {
    const out = new Uint16Array(4);
    unpackPixels({ data: new Uint8Array([10, 20, 30, 40]), t258: [8], isLE: true }, out);
    assert.deepEqual(Array.from(out), [10, 20, 30, 40]);
  });

  it("interpolateColorMatrix and planckian / illuminant estimate", () => {
    assert.deepEqual(
      interpolateColorMatrix(
        [1, 0, 0, 0, 1, 0, 0, 0, 1],
        [2, 0, 0, 0, 2, 0, 0, 0, 2],
        2500,
        6500,
        4500,
      ),
      [
        1.7222222222222223, 0, 0,
        0, 1.7222222222222223, 0,
        0, 0, 1.7222222222222223,
      ],
    );
    const planck = planckianLocusFromChromaticity({ x: 0.3127, y: 0.329 });
    assert.equal(planck.correlatedColorTemp, 6503.70718479529);
    assert.equal(planck.tintBias, 9.7699901214048);
    const est = estimateIlluminant({
      t50721: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      t50723: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      t50728: [0.5, 1, 0.7],
      t50778: [17],
    });
    assert.deepEqual(est, { x: 0.22727272727272727, y: 0.45454545454545453 });
  });

  it("decodeSigmaRaw builds orientation-tagged meta for GitUp GIT2 size", () => {
    const entry = CAMERA_DATABASE["gitup git2"];
    const bytes = new ArrayBuffer((entry[4] * entry[5] * 16) / 8);
    const meta = decodeSigmaRaw(bytes);
    assert.equal(meta.orientation, 1);
    assert.equal(meta.width, 4608);
    assert.equal(meta.height, 3456);
    assert.equal(meta.t50714[0], 3200);
    assert.deepEqual(meta.t33422, BAYER_PATTERNS[1]);
  });
});
