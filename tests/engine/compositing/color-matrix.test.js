import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { buildChannelMatrix, clampToByte, colorMatrixDeterminant, colorScaleMatrix, colorTranslationMatrix, from3x3, invertColorMatrix, multiplyColorMatrices, multiplyVec4, rgbToXyz, to3x3, transformInterleaved, transformPlanarRgb, transposeColorMatrix } from "../../../src/engine/compositing/color-matrix.js";


before(async () => {
});

describe("engine/compositing/color-matrix.js clamp and builders", () => {
  it("clamp8 rounds and clamps to byte range", () => {
    assert.equal(clampToByte(254.6), 255);
    assert.equal(clampToByte(-1), 0);
    assert.equal(clampToByte(300), 255);
  });

  it("translation and scale build affine matrices", () => {
    assert.deepEqual(colorTranslationMatrix(10, 20, 30), [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1]);
    assert.deepEqual(colorScaleMatrix(2, 3, 4), [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]);
  });

  it("buildChannelMatrix selects one channel or scales RGB", () => {
    assert.deepEqual(buildChannelMatrix([0, 1, 0]), [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(
      buildChannelMatrix([0.5, 0.5, 0.5]),
      [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1],
    );
  });
});

describe("engine/compositing/color-matrix.js matrix algebra", () => {
  it("multiplyVec4 applies a scale matrix", () => {
    const scaled = multiplyVec4(colorScaleMatrix(2, 2, 2), [1, 2, 3, 1]);
    assert.deepEqual(scaled.map((value) => Math.round(value * 100) / 100), [2, 4, 6, 1]);
  });

  it("invert and multiply compose transforms", () => {
    const inverted = invertColorMatrix(colorTranslationMatrix(0, 0, 0));
    assert.deepEqual([inverted[0], inverted[5], inverted[10], inverted[15]], [1, 1, 1, 1]);
    const product = multiplyColorMatrices(colorScaleMatrix(2, 2, 2), colorTranslationMatrix(1, 1, 1));
    assert.deepEqual(product.slice(0, 4).map((value) => Math.round(value * 100) / 100), [2, 0, 0, 2]);
  });

  it("determinant and to3x3 expose 3×3 views", () => {
    assert.equal(Math.round(colorMatrixDeterminant(colorScaleMatrix(2, 2, 2))), 8);
    assert.deepEqual(to3x3(colorScaleMatrix(1, 2, 3)), [1, 0, 0, 0, 2, 0, 0, 0, 3]);
  });

  it("from3x3 embeds a 3\u00d73 into a 4\u00d74 affine (WebGL/camera consumers)", () => {
    assert.deepEqual(
      from3x3([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 0, 0, 0, 1],
    );
  });

  it("transpose swaps rows and columns (WebGL uniformMatrix4fv consumers)", () => {
    assert.deepEqual(
      transposeColorMatrix([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      [1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16],
    );
  });
});

describe("engine/compositing/color-matrix.js pixel transforms", () => {
  it("transform scales planar h/l/O buffers", () => {
    const src = { h: new Uint8Array([100]), l: new Uint8Array([150]), O: new Uint8Array([200]) };
    const dst = { h: new Uint8Array(1), l: new Uint8Array(1), O: new Uint8Array(1) };
    transformPlanarRgb(src, dst, colorScaleMatrix(0.5, 0.5, 0.5));
    assert.deepEqual([dst.h[0], dst.l[0], dst.O[0]], [50, 75, 100]);
  });

  it("transformInterleaved scales RGBA bytes in place", () => {
    const rgba = new Uint8Array([100, 150, 200, 255]);
    const out = new Uint8Array(4);
    transformInterleaved(rgba, out, colorScaleMatrix(0.5, 0.5, 0.5));
    assert.deepEqual(Array.from(out), [50, 75, 100, 0]);
  });
});

describe("engine/compositing/color-matrix.js registration", () => {
  it("registerColorMatrix wires XYZ profile matrices after install", () => {
    assert.equal(rgbToXyz.length, 16);
    assert.deepEqual(
      rgbToXyz.slice(0, 3).map((value) => Math.round(value * 10000) / 10000),
      [0.4361, 0.3851, 0.1431],
    );

    const src = { h: new Uint8Array([200]), l: new Uint8Array([100]), O: new Uint8Array([50]) };
    const dst = { h: new Uint8Array(1), l: new Uint8Array(1), O: new Uint8Array(1) };
    transformPlanarRgb(src, dst, colorTranslationMatrix(5, 0, 0));
    assert.deepEqual([dst.h[0], dst.l[0], dst.O[0]], [255, 100, 50]);
  });
});
