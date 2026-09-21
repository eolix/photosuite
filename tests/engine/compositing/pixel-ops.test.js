/**
 * Golden values for pixel-ops (compositing).
 * Golden values covering the module's public behaviour.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { allocBuffer, downsampleHalfChannel, downsampleTwoThirdsChannel } from "../../../src/engine/compositing/buffer-utils.js";
import { applyColorCurves, applyLookupTable, interpolateEdge, blitChannelToBuffer, computeContentBoundsRgba, computeHistogram, contentBoundsChannel, copyChannel, copyChannelToAlpha, copyChannelsWithClip, copyPixels, downscaleBlockAverage, hasNonOpaquePixels, hitTestChannel, isBufferUniform, mulDiv255, multiplyAlphaByAlpha, multiplyMaskByRegion, premultiplyAlpha, renderMaskBoundaryOverlay, renderMaskFillOverlay, resampleDown, resampleDownChannel, round, scaleBuffer, traceChannelBoundary, unpremultiplyAlpha, upscaleBlockRepeat } from "../../../src/engine/compositing/pixel-ops.js";

installBrowserGlobals();


function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

before(async () => {
});

describe("engine/compositing/pixel-ops.js registration smoke", () => {
  it("exports the pixel ops and the upscale helpers", () => {
    assert.equal(typeof hasNonOpaquePixels, "function");
    assert.equal(typeof downsampleHalfChannel, "function");
    assert.equal(typeof mulDiv255, "function");
    assert.equal(typeof interpolateEdge, "function");
  });
});

describe("engine/compositing/pixel-ops.js alpha scan", () => {
  it("hasNonOpaquePixels samples strided alpha bytes", () => {
    const opaque = new Uint8Array(16);
    for (let off = 3; off < 16; off += 4) {
      opaque[off] = 255;
    }
    assert.equal(hasNonOpaquePixels(opaque), false);

    const soft = new Uint8Array(32);
    for (let off = 3; off < 32; off += 4) {
      soft[off] = 255;
    }
    soft[3] = 200;
    assert.equal(hasNonOpaquePixels(soft), true);
  });
});

describe("engine/compositing/pixel-ops.js channel downsample", () => {
  it("downsampleHalfChannel averages 2x2 blocks with +2 bias", () => {
    const channel = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
    const result = downsampleHalfChannel(channel, new Rect(0, 0, 4, 4));
    assert.deepEqual(Array.from(result.buffer), [35, 55, 115, 135]);
    assert.equal(result.rect.width, 2);
    assert.equal(result.rect.height, 2);
  });

  it("downsampleTwoThirdsChannel returns geometry-only when channel is null", () => {
    const result = downsampleTwoThirdsChannel(null, new Rect(0, 0, 6, 6));
    assert.equal(result.rect.width, 4);
    assert.equal(result.rect.height, 4);
    assert.equal(result.buffer, undefined);
  });

  it("resampleDownChannel chains half steps at scale 0.5", () => {
    const channel = new Uint8Array(9);
    for (let idx = 0; idx < 9; idx++) {
      channel[idx] = (idx + 1) * 10;
    }
    const result = resampleDownChannel(channel, new Rect(0, 0, 3, 3), 0.5);
    assert.deepEqual(Array.from(result.buffer), [30, 0, 0, 0]);
    assert.equal(result.rect.width, 1);
    assert.equal(result.rect.height, 1);
  });
});

describe("engine/compositing/pixel-ops.js scalar helpers", () => {
  it("mulDiv255 matches integer multiply-divide-by-255", () => {
    assert.deepEqual(
      [0, 1, 255, 256, 65025].map((value) => mulDiv255(value)),
      [0, 0, 1, 1, 255],
    );
  });

  it("isBufferUniform detects uniform and non-uniform buffers", () => {
    assert.equal(isBufferUniform(new Uint8Array([7, 7, 7]), 7), true);
    assert.equal(isBufferUniform(new Uint8Array([7, 8, 7]), 7), false);
  });

  it("round thresholds channel values to 0 or 255", () => {
    const defaultThreshold = new Uint8Array([0, 127, 128, 255]);
    round(defaultThreshold);
    assert.deepEqual(Array.from(defaultThreshold), [0, 0, 255, 255]);

    const customThreshold = new Uint8Array([50, 100, 150]);
    round(customThreshold, 100);
    assert.deepEqual(Array.from(customThreshold), [0, 255, 255]);
  });

  it("scaleBuffer multiplies and rounds in place", () => {
    const buffer = new Uint8Array([10, 20, 30]);
    scaleBuffer(buffer, 1.5);
    assert.deepEqual(Array.from(buffer), [15, 30, 45]);
  });
});

describe("engine/compositing/pixel-ops.js alpha premultiply", () => {
  it("premultiplyAlpha scales RGB by alpha", () => {
    const rgba = new Uint8Array([100, 150, 200, 128]);
    premultiplyAlpha(rgba);
    assert.deepEqual(Array.from(rgba), [50, 75, 100, 128]);
  });

  it("unpremultiplyAlpha restores RGB from premultiplied values", () => {
    const rgba = new Uint8Array([50, 100, 150, 128]);
    unpremultiplyAlpha(rgba);
    assert.deepEqual(Array.from(rgba), [100, 199, 43, 128]);
  });
});

describe("engine/compositing/pixel-ops.js histogram and LUT", () => {
  it("computeHistogram accumulates alpha-weighted channel counts", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const [combined, histR, histG, histB, pixelCount, alphaSumNorm] = computeHistogram(rgba);
    assert.equal(combined[255], 2);
    assert.equal(combined[0], 4);
    assert.equal(histR[255], 1);
    assert.equal(histG[255], 1);
    assert.equal(histB[255], 0);
    assert.equal(pixelCount, 2);
    assert.equal(alphaSumNorm, 2);
  });

  it("applyLookupTable remaps each byte through lut", () => {
    const lut = new Uint8Array(256);
    for (let idx = 0; idx < 256; idx++) {
      lut[idx] = 255 - idx;
    }
    const rgba = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    applyLookupTable(rgba, lut);
    assert.deepEqual(Array.from(new Uint32Array(rgba.buffer)), [3621907445, 2948187085]);
  });
});

describe("engine/compositing/pixel-ops.js bounds and copy", () => {
  it("contentBoundsChannel trims empty border rows and columns", () => {
    const channel = new Uint8Array(16);
    channel[5] = 1;
    channel[10] = 1;
    const bounds = contentBoundsChannel(channel, new Rect(0, 0, 4, 4));
    assert.equal(bounds.x, 1);
    assert.equal(bounds.y, 1);
    assert.equal(bounds.width, 2);
    assert.equal(bounds.height, 2);
  });

  it("copyChannel copies intersecting region with offset", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const dst = new Uint8Array(9);
    copyChannel(src, new Rect(0, 0, 3, 3), dst, new Rect(1, 1, 3, 3));
    assert.deepEqual(Array.from(dst), [5, 6, 0, 8, 9, 0, 0, 0, 0]);
  });
});

describe("engine/compositing/pixel-ops.js clip/overlap ops", () => {
  it("copyPixels copies a clipped 32-bit region", () => {
    const src = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 3) & 255;
    const dst = new Uint8Array(4 * 4 * 4);
    copyPixels(src, new Rect(0, 0, 4, 4), dst, new Rect(1, 1, 4, 4), new Rect(2, 2, 2, 2));
    assert.deepEqual(
      Array.from(new Uint32Array(dst.buffer)),
      [0, 0, 0, 0, 0, 2172550008, 2374666116, 0, 0, 2981014440, 3183130548, 0, 0, 0, 0, 0],
    );
  });

  it("copyChannelToAlpha writes a channel into the alpha byte over an offset overlap", () => {
    const channel = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const dst = new Uint8Array(3 * 3 * 4);
    copyChannelToAlpha(channel, new Rect(0, 0, 3, 3), dst, new Rect(1, 1, 3, 3));
    assert.deepEqual(
      Array.from(dst),
      [0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
  });

  it("multiplyMaskByRegion scales a destination mask over the overlap", () => {
    const mask = new Uint8Array([255, 128, 64, 255, 128, 64, 255, 128, 64]);
    const dst = new Uint8Array(9).fill(200);
    multiplyMaskByRegion(mask, new Rect(0, 0, 3, 3), dst, new Rect(1, 1, 3, 3));
    assert.deepEqual(Array.from(dst), [100, 50, 200, 100, 50, 200, 200, 200, 200]);
  });

  it("multiplyAlphaByAlpha multiplies destination alpha by source alpha", () => {
    const src = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < src.length; i++) src[i] = i % 4 === 3 ? 128 : 100;
    const dst = new Uint8Array(2 * 2 * 4).fill(255);
    multiplyAlphaByAlpha(src, new Rect(0, 0, 2, 2), dst, new Rect(0, 0, 2, 2));
    assert.deepEqual(Array.from(dst), [255, 255, 255, 128, 255, 255, 255, 128, 255, 255, 255, 128, 255, 255, 255, 128]);
  });

  it("copyChannelsWithClip copies all four planar channels (w/h/l/O)", () => {
    const plane = (base) => new Uint8Array([base, base + 1, base + 2, base + 3]);
    const src = { w: plane(10), h: plane(20), l: plane(30), O: plane(40) };
    const dst = { w: new Uint8Array(4), h: new Uint8Array(4), l: new Uint8Array(4), O: new Uint8Array(4) };
    copyChannelsWithClip(src, new Rect(0, 0, 2, 2), dst, new Rect(0, 0, 2, 2));
    assert.deepEqual(Array.from(dst.w), [10, 11, 12, 13]);
    assert.deepEqual(Array.from(dst.h), [20, 21, 22, 23]);
    assert.deepEqual(Array.from(dst.l), [30, 31, 32, 33]);
    assert.deepEqual(Array.from(dst.O), [40, 41, 42, 43]);
  });

  it("computeContentBoundsRgba trims to the transparent-sentinel bounds", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    const set = (x, y, r, g, b, a) => {
      const i = (y * 4 + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    };
    set(1, 1, 10, 20, 30, 255);
    set(2, 2, 40, 50, 60, 255);
    const bounds = computeContentBoundsRgba(rgba, new Rect(0, 0, 4, 4), 2, null);
    assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [1, 1, 2, 2]);
  });

  it("resampleDown halves an opaque RGBA buffer via the box path", () => {
    const src = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < src.length; i++) src[i] = i % 4 === 3 ? 255 : (i * 5) & 255;
    const result = resampleDown(src, new Rect(0, 0, 4, 4), 0.5);
    assert.equal(result.rect.width, 2);
    assert.equal(result.rect.height, 2);
    assert.deepEqual(
      Array.from(result.buffer),
      [50, 55, 60, 255, 90, 95, 100, 255, 146, 151, 156, 255, 122, 127, 132, 255],
    );
  });
});

describe("engine/compositing/pixel-ops.js color curves", () => {
  const curveImage = () => {
    const rgba = new Uint8Array(2 * 2 * 4);
    for (let p = 0; p < 4; p++) {
      const i = p * 4;
      rgba[i] = p * 40;
      rgba[i + 1] = p * 50;
      rgba[i + 2] = p * 60;
      rgba[i + 3] = 255;
    }
    return rgba;
  };

  it("applyColorCurves plain per-channel mapping", () => {
    const curve = new Uint8Array(256);
    for (let i = 0; i < 256; i++) curve[i] = (i * i) >> 8;
    const dst = new Uint8Array(16);
    applyColorCurves(curveImage(), dst, curve, curve, curve, false, false);
    assert.deepEqual(Array.from(dst), [0, 0, 0, 255, 6, 9, 14, 255, 25, 39, 56, 255, 56, 87, 126, 255]);
  });

  it("applyColorCurves luma mode drives all channels from luminance", () => {
    const curve = new Uint8Array(256);
    for (let i = 0; i < 256; i++) curve[i] = 255 - i;
    const dst = new Uint8Array(16);
    applyColorCurves(curveImage(), dst, curve, curve, curve, true, false);
    assert.deepEqual(Array.from(dst), [255, 255, 255, 255, 207, 207, 207, 255, 159, 159, 159, 255, 111, 111, 111, 255]);
  });

  it("applyColorCurves preserve-luma rescales toward source luminance", () => {
    const curve = new Uint8Array(256);
    for (let i = 0; i < 256; i++) curve[i] = (i * 3) & 255;
    const dst = new Uint8Array(16);
    applyColorCurves(curveImage(), dst, curve, curve, curve, false, true);
    assert.deepEqual(Array.from(dst), [0, 0, 0, 255, 40, 50, 60, 255, 211, 38, 91, 255, 100, 188, 27, 255]);
  });
});

describe("engine/compositing/pixel-ops.js hit test", () => {
  it("hitTestChannel compares channel value to 128 threshold", () => {
    const channel = new Uint8Array([200, 0, 0, 100]);
    assert.equal(hitTestChannel({ x: 0.5, y: 0.5 }, channel, new Rect(0, 0, 2, 2)), true);
    assert.equal(hitTestChannel({ x: 1.5, y: 1.5 }, channel, new Rect(0, 0, 2, 2)), false);
    assert.equal(hitTestChannel({ x: 5, y: 5 }, channel, new Rect(0, 0, 2, 2)), false);
  });
});

describe("engine/compositing/pixel-ops.js upscale utils", () => {
  it("interpolateEdge linearly interpolates or averages at edges", () => {
    assert.equal(interpolateEdge(0, 50, 100, 0, 100), 50);
    assert.equal(interpolateEdge(0, 150, 100, 0, 100), 100);
  });
});

describe("engine/compositing/pixel-ops.js scaleInterp block resample", () => {
  it("upscaleBlockRepeat tiles each source sample into a block", () => {
    const src = new Uint8Array([10, 20, 30, 40]);
    const dst = new Uint8Array(16);
    upscaleBlockRepeat(src, 2, 2, dst, 4, 4, 2);
    assert.deepEqual(
      Array.from(dst),
      [10, 10, 20, 20, 10, 10, 20, 20, 30, 30, 40, 40, 30, 30, 40, 40],
    );
  });

  it("downscaleBlockAverage averages source blocks", () => {
    const src = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
    const dst = new Uint8Array(4);
    downscaleBlockAverage(src, 4, 4, dst, 2, 2, 2);
    assert.deepEqual(Array.from(dst), [35, 55, 115, 135]);
  });
});

describe("engine/compositing/pixel-ops.js mask overlays (pre-move goldens)", () => {
  // A 2x2 filled square (value 200) centred in a 4x4 mask channel.
  const maskSquare = () =>
    new Uint8Array([0, 0, 0, 0, 0, 200, 200, 0, 0, 200, 200, 0, 0, 0, 0, 0]);

  it("traceChannelBoundary marks edge pixels of a thresholded mask", () => {
    const dst = new Uint8Array(16);
    traceChannelBoundary(maskSquare(), dst, new Rect(0, 0, 4, 4));
    assert.deepEqual(Array.from(dst), [0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0]);
  });

  it("renderMaskBoundaryOverlay draws a two-tone stipple on the mask edge", () => {
    const dst = new Uint8Array(16 * 4);
    renderMaskBoundaryOverlay(maskSquare(), dst, new Rect(0, 0, 4, 4), new Rect(0, 0, 4, 4));
    assert.deepEqual(Array.from(new Uint32Array(dst.buffer)), [
      0, 0, 0, 0, 0, 4278190080, 4278190080, 0, 0, 4278190080, 4294967295, 0, 0, 0, 0, 0,
    ]);
  });

  it("renderMaskBoundaryOverlay leaves the interior of a uniform mask untouched under clip", () => {
    const uniform = new Uint8Array(16).fill(200);
    const dst = new Uint8Array(16 * 4);
    renderMaskBoundaryOverlay(uniform, dst, new Rect(0, 0, 4, 4), new Rect(1, 1, 2, 2));
    assert.deepEqual(Array.from(new Uint32Array(dst.buffer)), new Array(16).fill(0));
  });

  it("renderMaskFillOverlay packs gray fill and inverted half-intensity fill", () => {
    const ramp = () =>
      new Uint8Array([0, 64, 128, 255, 10, 74, 138, 255, 20, 84, 148, 255, 30, 94, 158, 255]);
    const fill = new Uint8Array(16 * 4);
    renderMaskFillOverlay(ramp(), fill, new Rect(0, 0, 4, 4), new Rect(0, 0, 4, 4), 2);
    assert.deepEqual(Array.from(new Uint32Array(fill.buffer)), [
      4278190080, 4282400832, 4286611584, 4294967295, 4278848010, 4283058762, 4287269514, 4294967295,
      4279505940, 4283716692, 4287927444, 4294967295, 4280163870, 4284374622, 4288585374, 4294967295,
    ]);
    const inverted = new Uint8Array(16 * 4);
    renderMaskFillOverlay(ramp(), inverted, new Rect(0, 0, 4, 4), new Rect(0, 0, 4, 4), 1);
    assert.deepEqual(Array.from(new Uint32Array(inverted.buffer)), [
      2130706687, 1593835775, 1056964863, 255, 2046820607, 1509949695, 973078783, 255, 1962934527,
      1426063615, 889192703, 255, 1879048447, 1342177535, 805306623, 255,
    ]);
  });

  // A grayscale channel expands to grey RGB over the fill ground, with alpha
  // left opaque; the fill shows through only where the channel does not reach.
  it("blitChannelToBuffer expands a grayscale channel into RGBA", () => {
    const sourceChannel = allocBuffer(4);
    sourceChannel.fill(64);
    const destRgba = allocBuffer(16);

    blitChannelToBuffer(
      sourceChannel,
      new Rect(0, 0, 2, 2),
      128,
      destRgba,
      new Rect(0, 0, 2, 2),
    );

    assert.deepEqual([destRgba[0], destRgba[1], destRgba[2], destRgba[3]], [64, 64, 64, 255]);
  });

  // Where the source channel does not cover the destination, the fill remains.
  it("blitChannelToBuffer leaves the fill outside the source rect", () => {
    const sourceChannel = allocBuffer(1);
    sourceChannel.fill(64);
    const destRgba = allocBuffer(16);

    blitChannelToBuffer(
      sourceChannel,
      new Rect(0, 0, 1, 1),
      128,
      destRgba,
      new Rect(0, 0, 2, 2),
    );

    assert.deepEqual([destRgba[0], destRgba[4]], [64, 128]);
  });
});
