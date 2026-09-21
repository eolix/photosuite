/**
 * Golden values for homography (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { Point } from "../../../src/core/math/point.js";
import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { Rect } from "../../../src/core/math/rect.js";
import { composeHomographies, cornersToHomography, drawImageThroughHomography, flipPixelsHoriz, homographyTransformPoint, invert, isAffine, isAxisAligned, isPerspectiveFree, matrix2DToHomography, sampleBilinearFloat, sampleBilinearPixel, sampleBilinearWrap, sampleRadialStrip, toMatrix2D, transformPointsArray, transposePixels, warpImageAffineInner, warpWithAffineParams } from "../../../src/engine/compositing/homography.js";


function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

function round3(values) {
  return values.map((value) => Math.round(value * 1000) / 1000);
}

function round6(values) {
  return values.map((value) => Math.round(value * 1e6) / 1e6);
}

before(async () => {
});

describe("homography", () => {
  it("classifies affine and axis-aligned transforms", () => {
    const { homography } = createCompositing();
    const identity = [1, 0, 0, 0, 1, 0, 0, 0];
    assert.equal(isAffine(identity), true);
    assert.equal(isPerspectiveFree(identity), true);
    assert.equal(isAxisAligned(identity), true);
  });

  it("matrix2D ↔ homography round-trip goldens", () => {
    const { homography } = createCompositing();
    const matrix = new Matrix2D(2, 0, 0, 0, 3, 0);
    const coeffs = matrix2DToHomography(matrix);
    assert.deepEqual(coeffs, [2, 0, 3, 0, 0, 0, 0, 0]);
    const restored = toMatrix2D(coeffs);
    assert.deepEqual([restored.a, restored.c, restored.tx], [2, 0, 3]);
  });

  it("transforms points and inverts affine homographies", () => {
    const { homography } = createCompositing();
    const identity = [1, 0, 0, 0, 1, 0, 0, 0];
    const coords = [10, 20, 30, 40];
    transformPointsArray(identity, coords);
    assert.deepEqual(coords, [10, 20, 30, 40]);

    const scaleTranslate = [2, 0, 10, 0, 2, 20, 0, 0];
    const point = homographyTransformPoint(scaleTranslate, new Point(5, 5));
    assert.deepEqual([point.x, point.y], [20, 30]);
    assert.deepEqual(round3(invert(scaleTranslate)), [0.5, 0, -5, 0, 0.5, -10, 0, 0]);
    assert.deepEqual(composeHomographies([2, 0, 0, 0, 2, 0, 0, 0], [1, 0, 5, 0, 1, 10, 0, 0]), [
      2, 0, 10, 0, 2, 20, 0, 0,
    ]);
  });

  it("cornersToHomography maps a quad into a bounds rect", () => {
    const { homography } = createCompositing();
    const srcCorners = [0, 0, 100, 0, 0, 100, 100, 100];
    const bounds = new Rect(10, 20, 80, 60);
    assert.deepEqual(round6(cornersToHomography(srcCorners, bounds)), [0.75, -1, 12.5, -0, -1, 20, 0, -0.02]);
  });

  it("transposePixels and flipPixelsHoriz goldens", () => {
    const { homography } = createCompositing();
    const src = new Uint8Array(24);
    const dst = new Uint8Array(24);
    for (let pixelIdx = 0; pixelIdx < 6; pixelIdx++) {
      src[pixelIdx * 4] = pixelIdx + 1;
    }
    transposePixels(src, dst, 2, 3);
    assert.deepEqual([...new Uint32Array(dst.buffer)], [1, 3, 5, 2, 4, 6]);

    const srcFlip = new Uint8Array(16);
    const dstFlip = new Uint8Array(16);
    for (let pixelIdx = 0; pixelIdx < 4; pixelIdx++) {
      new Uint32Array(srcFlip.buffer)[pixelIdx] = (pixelIdx + 1) << 24 | pixelIdx;
    }
    flipPixelsHoriz(srcFlip, dstFlip, 2, 2);
    assert.deepEqual([...new Uint32Array(dstFlip.buffer)], [33554433, 16777216, 67108867, 50331650]);
  });

  it("bilinear and wrap sampling goldens", () => {
    const { homography } = createCompositing();
    const srcPixels = new Uint8Array(16);
    const srcBuf32 = new Uint32Array(srcPixels.buffer);
    srcBuf32[0] = 0xff0000ff;
    srcBuf32[1] = 0xff00ff00;
    srcBuf32[2] = 0xffff0000;
    srcBuf32[3] = 0xffffffff;
    const dstPixels = new Uint8Array(4);
    sampleBilinearPixel(0.5, 0.5, srcBuf32, 2, 2, new Uint32Array(dstPixels.buffer), 0, 0);
    assert.equal(new Uint32Array(dstPixels.buffer)[0].toString(16), "ff0000ff");

    const floatRgba = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1]);
    const outRgba = new Float32Array(4);
    sampleBilinearFloat(0.5, 0.5, floatRgba, 2, null, outRgba);
    assert.deepEqual(round3([...outRgba]), [1, 0, 0, 1]);
    assert.ok(Math.abs(sampleBilinearWrap(0.5, 0.5, [1, 2, 3, 4], 2, 2) - 1.000003) < 1e-5);
  });

  const W = 16;
  const H = 16;
  function texturedImage() {
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      rgba[i] = (p * 5) & 255;
      rgba[i + 1] = (p * 9 + 30) & 255;
      rgba[i + 2] = (p * 3 + 80) & 255;
      rgba[i + 3] = 255;
    }
    return rgba;
  }
  function checksum(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum = (sum + buf[i] * (i % 7 + 1)) % 1000003;
    return sum;
  }

  it("drawImage warps a quad (perspective) and an integral translation to goldens", () => {
    const { homography } = createCompositing();
    const hom = cornersToHomography([1, 1, 14, 2, 15, 15, 2, 13], new Rect(0, 0, W, H));
    const perspective = new Uint8Array(W * H * 4);
    drawImageThroughHomography(hom, texturedImage(), W, H, perspective, new Rect(0, 0, W, H), false, false, false);
    assert.equal(checksum(perspective), 2073);

    const translated = new Uint8Array(W * H * 4);
    drawImageThroughHomography([1, 0, 3, 0, 1, 2, 0, 0], texturedImage(), W, H, translated, new Rect(0, 0, W, H), false, false, false);
    assert.equal(checksum(translated), 1788);
  });

  it("warpImageAffineInner fast path (4-wide packing) matches golden", () => {
    const { homography } = createCompositing();
    const bw = 2048;
    const bh = 2048;
    const src = new Uint8Array(bw * bh * 4);
    for (let i = 0; i < src.length; i += 101) src[i] = (i >> 2) & 255;
    const dst = new Uint8Array(bw * bh * 4);
    warpImageAffineInner([1 / bw, 0, 0.1, 0, 1 / bh, 0.05, 0, 0], src, bw, bh, dst, new Rect(0, 0, bw, bh), false, true, true);
    let sampled = 0;
    for (let i = 0; i < dst.length; i += 1409) sampled = (sampled + dst[i]) % 1000003;
    assert.equal(sampled, 12897);
  });

  it("sampleRadialStrip and warpWithAffineParams goldens", () => {
    const { homography } = createCompositing();
    const strip = new Uint8Array(12 * 16 * 4);
    sampleRadialStrip(texturedImage(), W, H, strip, 12, 16, 0.5, 0.5, 1.5, 0.1, 1, 1);
    assert.equal(checksum(strip), 496491);
    assert.deepEqual(Array.from(strip.slice(0, 4)), [168, 230, 232, 255]);

    const warped = new Uint8Array(8 * 8 * 4);
    warpWithAffineParams(texturedImage(), W, W, warped, [8, 8, 0.9, 0.1, 1, 0.05, 0.95, 1]);
    assert.equal(checksum(warped), 167640);
    assert.deepEqual(Array.from(warped.slice(0, 4)), [85, 183, 131, 255]);
  });

  it("precondition guards throw descriptive errors", () => {
    const { homography } = createCompositing();
    assert.throws(
      () => warpImageAffineInner([1, 0, 0, 0, 1, 0, 0, 0], new Uint8Array(4), 1, 1, new Uint8Array(4), new Rect(0, 0, 3, 1), false, true, true),
      /fast path requires dstRect\.width to be a multiple of 4/,
    );
    assert.throws(() => sampleBilinearWrap(0, 0, [], 0, 0), /grid sample index out of range/);
  });
});
