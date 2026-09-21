import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { PlanarRgbaBuffer, alignToFour, buildMipPyramidAlpha, downsampleHalfAlphaWeighted, downsampleHalfBox, downsampleHalfChannel, equals, extractChannel, extractChannelByte, fillBuffer, fillBufferRect, grayChannelToRgba, interleavedToPlanar, planarToInterleaved, rgbaToGrayChannel } from "../../../src/engine/compositing/buffer-utils.js";



before(async () => {
});

describe("engine/compositing/buffer-utils.js color conversion", () => {
  it("rgbaToGrayChannel uses default and custom luma weights", () => {
    const rgba = new Uint8Array([100, 150, 200, 255, 0, 0, 0, 0]);
    const gray = new Uint8Array(2);
    rgbaToGrayChannel(rgba, gray);
    assert.deepEqual(Array.from(gray), [141, 0]);
    rgbaToGrayChannel(rgba, gray, [0.25, 0.5, 0.25]);
    assert.deepEqual(Array.from(gray), [150, 0]);
  });

  it("grayChannelToRgba replicates gray into RGB", () => {
    const out = new Uint8Array(8);
    grayChannelToRgba(new Uint8Array([128, 64]), out);
    assert.deepEqual(Array.from(out), [128, 128, 128, 0, 64, 64, 64, 0]);
  });
});

describe("engine/compositing/buffer-utils.js buffer helpers", () => {
  it("alignToFour pads to a four-byte boundary", () => {
    assert.equal(alignToFour(5), 8);
    assert.equal(alignToFour(8), 8);
  });

  it("equals compares typed-array backing stores", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const c = new Uint8Array([1, 2, 3, 5]);
    assert.equal(equals(a, b), true);
    assert.equal(equals(a, c), false);
  });

  it("fillBuffer and fillBufferRect write masked words", () => {
    const buf = new Uint8Array(8);
    fillBuffer(buf, 0xff0000ff);
    assert.deepEqual(Array.from(new Uint32Array(buf.buffer)), [4278190335, 4278190335]);

    const rectBuf = new Uint8Array(16);
    fillBufferRect(rectBuf, new Rect(0, 0, 2, 2), new Rect(1, 0, 1, 2), 0x01020304);
    assert.deepEqual(Array.from(new Uint32Array(rectBuf.buffer)), [0, 16909060, 0, 16909060]);
  });

  it("extractChannelByte and extractChannel read one channel", () => {
    const src = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const channel = new Uint8Array(2);
    extractChannelByte(src, channel, 1);
    assert.deepEqual(Array.from(channel), [20, 60]);

    const rgba = new Uint8Array(16);
    for (let idx = 0; idx < 4; idx++) {
      rgba[idx] = 10 + idx * 10;
    }
    const out = new Uint8Array(16);
    extractChannel(rgba, out, 0);
    assert.deepEqual(Array.from(out).filter((_, idx) => idx % 4 === 0), [10, 20, 30, 40]);
  });
});

describe("engine/compositing/buffer-utils.js planar layout", () => {
  it("round-trips planar h/l/O/w channels through interleaved RGBA", () => {
    const planar = {
      h: new Uint8Array([5, 6, 7, 8]),
      l: new Uint8Array([9, 10, 11, 12]),
      O: new Uint8Array([13, 14, 15, 16]),
      w: new Uint8Array([1, 2, 3, 4]),
    };
    const interleaved = new Uint8Array(16);
    planarToInterleaved(planar, interleaved);
    assert.deepEqual(
      Array.from(interleaved),
      [5, 9, 13, 1, 6, 10, 14, 2, 7, 11, 15, 3, 8, 12, 16, 4],
    );

    const roundtrip = {
      h: new Uint8Array(4),
      l: new Uint8Array(4),
      O: new Uint8Array(4),
      w: new Uint8Array(4),
    };
    interleavedToPlanar(interleaved, roundtrip);
    assert.deepEqual(Array.from(roundtrip.h), [5, 6, 7, 8]);
    assert.deepEqual(Array.from(roundtrip.l), [9, 10, 11, 12]);
  });

  it("PlanarRgbaBuffer convention round-trips standard RGBA byte order", () => {
    const planar = new PlanarRgbaBuffer(1);
    planar.h[0] = 100;
    planar.l[0] = 150;
    planar.O[0] = 200;
    planar.w[0] = 255;
    const interleaved = new Uint8Array(4);
    planarToInterleaved(planar, interleaved);
    assert.deepEqual(Array.from(interleaved), [100, 150, 200, 255]);
  });

  it("PlanarRgbaBuffer allocates four planes and clone deep-copies without sharing", () => {
    const buf = new PlanarRgbaBuffer(4);
    assert.deepEqual(
      [buf.w.length, buf.h.length, buf.l.length, buf.O.length],
      [4, 4, 4, 4],
    );
    buf.h[0] = 10;
    buf.l[0] = 20;
    buf.O[0] = 30;
    buf.w[0] = 40;
    buf.h[1] = 11;
    buf.l[1] = 21;
    buf.O[1] = 31;
    buf.w[1] = 41;
    const copy = buf.clone();
    assert.deepEqual(
      [copy.h[0], copy.l[0], copy.O[0], copy.w[0], copy.h[1], copy.l[1], copy.O[1], copy.w[1]],
      [10, 20, 30, 40, 11, 21, 31, 41],
    );
    copy.h[0] = 99;
    assert.equal(buf.h[0], 10);
  });

  it("PlanarRgbaBuffer zero-length clones to zero-length planes", () => {
    const empty = new PlanarRgbaBuffer(0);
    assert.equal(empty.w.length, 0);
    assert.equal(empty.clone().w.length, 0);
  });
});

describe("engine/compositing/buffer-utils.js downsampling", () => {
  it("downsampleHalfBox averages a 4×4 patch", () => {
    const pixels = new Uint8Array(64);
    for (let idx = 0; idx < 16; idx++) {
      const value = idx * 17;
      pixels[idx * 4] = value;
      pixels[idx * 4 + 1] = value + 1;
      pixels[idx * 4 + 2] = value + 2;
      pixels[idx * 4 + 3] = 255;
    }
    const half = downsampleHalfBox(pixels, new Rect(0, 0, 4, 4));
    assert.equal(half.rect.width, 2);
    assert.equal(half.rect.height, 2);
    assert.deepEqual(
      Array.from(new Uint32Array(half.buffer.buffer)),
      [4281150507, 4283387469, 4290098355, 4288124629],
    );
  });

  it("downsampleHalfAlphaWeighted blends premultiplied quadrants", () => {
    const pixels = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const half = downsampleHalfAlphaWeighted(pixels, new Rect(0, 0, 2, 2));
    assert.deepEqual(Array.from(new Uint32Array(half.buffer.buffer)), [4282417280]);
  });

  it("buildMipPyramidAlpha appends half-size levels", () => {
    const pixels = new Uint8Array(64);
    for (let idx = 0; idx < 16; idx++) {
      const value = idx * 10;
      pixels[idx * 4] = value;
      pixels[idx * 4 + 1] = value;
      pixels[idx * 4 + 2] = value;
      pixels[idx * 4 + 3] = 255;
    }
    const mipChain = [pixels, new Rect(0, 0, 4, 4)];
    buildMipPyramidAlpha(mipChain);
    assert.equal(mipChain.length, 6);
    assert.equal(mipChain[3].width, 2);
    assert.equal(mipChain[3].height, 2);
    assert.equal(new Uint32Array(mipChain[2].buffer)[0], 4279834905);
  });
});
