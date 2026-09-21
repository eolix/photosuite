import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";
import { copyChannel, mulDiv255 } from "../../../src/engine/compositing/pixel-ops.js";
import { luminanceFromRgb, rgbLuminance, rgbSaturation } from "../../../src/engine/compositing/color-math.js";
import { RngState, applyLayerMask, clipColor, combineLayerPlanes, composite, compositeLayer, compositeNormal, darkF, divLut, lcg32, mulLut, multiplyF, normF, recipLut, scrnF, setHueSaturation, softLightD, undoAlphaPremult } from "../../../src/engine/compositing/compositing-ops.js";


describe("engine/compositing/compositing-ops.js combineLayerPlanes (stack modes)", () => {
  const threePlanes = () => [
    new Uint8Array([10, 20, 30, 255]),
    new Uint8Array([40, 60, 90, 255]),
    new Uint8Array([70, 100, 150, 255]),
  ];

  it("single plane copies straight through", () => {
    const out = new Uint8Array(4);
    combineLayerPlanes([new Uint8Array([5, 6, 7, 255])], out, "avrg");
    assert.deepEqual([...out], [5, 6, 7, 255]);
  });

  it("avrg / maxx / minn / medn reduce planes per pixel", () => {
    const run = (mode) => {
      const out = new Uint8Array(4);
      combineLayerPlanes(threePlanes(), out, mode);
      return [...out];
    };
    assert.deepEqual(run("avrg"), [40, 60, 90, 255]);
    assert.deepEqual(run("maxx"), [70, 100, 150, 255]);
    assert.deepEqual(run("minn"), [10, 20, 30, 255]);
    assert.deepEqual(run("medn"), [25, 40, 60, 255]);
  });

  it("rang yields max-min for color channels and max for alpha", () => {
    const out = new Uint8Array(4);
    combineLayerPlanes(threePlanes(), out, "rang");
    assert.deepEqual([...out], [60, 80, 120, 255]);
  });

  it("unrecognized mode leaves dst unchanged", () => {
    const out = new Uint8Array([1, 2, 3, 4]);
    combineLayerPlanes(threePlanes(), out, "xxxx");
    assert.deepEqual([...out], [1, 2, 3, 4]);
  });
});

describe("engine/compositing/compositing-ops.js lookup tables", () => {
  it("builds div/mul/recip lookup samples", () => {
    assert.equal(divLut[128 * 256 + 64], 128);
    assert.equal(mulLut[200 * 256 + 50], 161);
    assert.equal(Math.round(recipLut[128] * 1000) / 1000, 1.992);
  });
});

describe("engine/compositing/compositing-ops.js channel blend formulas", () => {
  it("evaluates multiply, screen, darken, and soft-light helpers", () => {
    assert.equal(multiplyF(0.5, 0.8, 1), 0.4);
    assert.equal(scrnF(0.5, 0.5, 1), 0.75);
    assert.equal(darkF(0.3, 0.7, 1), 0.3);
    assert.equal(softLightD(0.25), 0.5);
    assert.equal(clipColor(1, 0.5, 0, 0.8), 0.4);
  });

  it("setHueSaturation writes clipped saturation channels", () => {
    const out = { h: 0, l: 0, O: 0 };
    setHueSaturation({ h: 0.8, l: 0.2, O: 0.1 }, 0.5, out);
    assert.deepEqual(
      [out.h, out.l, out.O].map((value) => Math.round(value * 1000) / 1000),
      [0.5, 0.071, 0],
    );
  });
});

describe("engine/compositing/compositing-ops.js compositing pipelines", () => {
  it("compositeNormal replaces opaque source over destination", () => {
    const src = new Uint8ClampedArray([255, 128, 64, 255]);
    const dst = new Uint8ClampedArray([0, 0, 0, 255]);
    const rect = new Rect(0, 0, 1, 1);
    compositeNormal(src, rect, dst, rect, rect, 1, normF, 0);
    assert.equal(new Uint32Array(dst.buffer)[0], 4282417407);
  });

  it("composite multiply mode blends two pixels", () => {
    const src = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const dst = new Uint8ClampedArray([0, 0, 255, 255, 255, 255, 255, 255]);
    const rect = new Rect(0, 0, 2, 1);
    composite("mul ", src, rect, dst, rect, rect, 1, { fill: 1, lu: null, style: false, gd: false });
    assert.deepEqual(Array.from(new Uint32Array(dst.buffer)), [4278190080, 4278255360]);
  });

  it("compositeSeparable blends luminosity and darker-color modes", () => {
    const rect = new Rect(0, 0, 2, 1);
    const style = () => ({ fill: 1, lu: null, style: false, gd: false });
    let src = new Uint8ClampedArray([200, 100, 50, 255, 30, 220, 140, 200]);
    let dst = new Uint8ClampedArray([60, 60, 60, 255, 255, 255, 255, 128]);
    composite("lum ", src, rect, dst, rect, rect, 0.8, style());
    assert.deepEqual(Array.from(new Uint32Array(dst.buffer)), [4285493103, 3500919425]);
    src = new Uint8ClampedArray([200, 100, 50, 255, 30, 220, 140, 200]);
    dst = new Uint8ClampedArray([60, 60, 60, 255, 255, 255, 255, 128]);
    composite("dkCl", src, rect, dst, rect, rect, 1, style());
    assert.deepEqual(Array.from(new Uint32Array(dst.buffer)), [4282137660, 3835289657]);
  });

  it("compositeDissolved thresholds source pixels deterministically", () => {
    const rect = new Rect(0, 0, 2, 1);
    const src = new Uint8ClampedArray([200, 100, 50, 255, 30, 220, 140, 200]);
    const dst = new Uint8ClampedArray([60, 60, 60, 255, 10, 10, 10, 255]);
    composite("diss", src, rect, dst, rect, rect, 0.5, { fill: 1, lu: null, style: false, gd: false });
    assert.deepEqual(Array.from(new Uint32Array(dst.buffer)), [4282137660, 4278848010]);
  });

  it("compositeLayer clipped path composites through a mask channel", () => {
    const rect = new Rect(0, 0, 2, 1);
    const src = new Uint8ClampedArray([200, 100, 50, 255, 30, 220, 140, 200]);
    const dst = new Uint8ClampedArray([60, 60, 60, 255, 10, 10, 10, 255]);
    const mask = new Uint8Array([128, 200]);
    compositeLayer(src, rect, dst, rect, mask, rect, 0, rect, 0.75, false, [1, 1, 1]);
    assert.deepEqual(Array.from(new Uint32Array(dst.buffer)), [4281879408, 3729684756]);
  });

  it("undoAlphaPremult restores straight RGB from premultiplied samples", () => {
    const premul = new Uint8ClampedArray([128, 64, 32, 255, 200, 100, 50, 255]);
    const out = new Uint8ClampedArray(premul);
    const alpha = new Uint8Array([128, 255]);
    undoAlphaPremult(premul, out, alpha);
    assert.deepEqual([out[0], out[1], out[2], out[4]], [128, 64, 32, 200]);
  });
});

describe("engine/compositing/compositing-ops.js rng + masks", () => {
  it("lcg32 and RngState are deterministic", () => {
    assert.equal(lcg32(42), lcg32(42));
    const rng = new RngState(12345);
    assert.equal(Math.round(rng.get() * 1e6) / 1e6, 0.87079);
  });

  it("applyLayerMask returns zero for the sample descriptor", () => {
    const maskDesc = new Float32Array(32);
    maskDesc[0] = 0;
    maskDesc[1] = 1;
    maskDesc[2] = -1;
    maskDesc[3] = 0;
    const maskWeight = applyLayerMask(0.5, 0.5, 0.5, 0.2, 0.2, 0.2, 1, maskDesc);
    assert.equal(maskWeight, 0);
  });
});

describe("engine/compositing/compositing-ops.js registration", () => {
  it("registerCompositingOps wires composite dispatch that changes pixels", () => {
    const src = new Uint8ClampedArray([255, 255, 255, 128]);
    const dst = new Uint8ClampedArray([0, 0, 0, 255]);
    const rect = new Rect(0, 0, 1, 1);
    const before = new Uint32Array(dst.buffer)[0];
    composite("norm", src, rect, dst, rect, rect, 0.5, { fill: 1, lu: null, style: false, gd: false });
    const after = new Uint32Array(dst.buffer)[0];
    assert.notEqual(before, after);
    assert.ok((after >>> 24 & 255) > 0);
  });
});
