import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { checkerboardCell, drawCheckerboard, getScratch2dContext, hasEnoughColorVariety, hexToRgb, hslToRgb, hsvToRgb, hueDiff, invert, invertAlpha, invertRgb, labSimilarity, labToRgb, linearToSrgb, luminanceFromRgb, rgbLuminance, rgbSaturation, rgbToHex, rgbToHsl, rgbToHsv, rgbToLab, rgbaToYcbcr, saturationFromRgb, srgbToLinear } from "../../../src/engine/compositing/color-math.js";

let restoreBrowserGlobals;

function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
});

after(() => {
  if (restoreBrowserGlobals) {
    restoreBrowserGlobals();
  }
});

describe("engine/compositing/color-math.js hex and luma", () => {
  it("rgbToHex and hexToRgb round-trip packed RGB", () => {
    assert.equal(rgbToHex(0x0f0a05), "0f0a05");
    assert.equal(hexToRgb("ff8040"), 16744512);
  });

  it("luminanceFromRgb and saturationFromRgb match byte weights", () => {
    assert.equal(luminanceFromRgb(100, 150, 200), 140.5);
    assert.equal(Math.round(saturationFromRgb(100, 150, 200) * 1000) / 1000, 100);
  });

  it("rgbLuminance reads h/l/O channel object", () => {
    assert.equal(rgbLuminance({ h: 100, l: 150, O: 200 }), 140.5);
  });
});

describe("engine/compositing/color-math.js hue and transfer functions", () => {
  it("hueDiff wraps across the unit circle", () => {
    assert.equal(hueDiff(0.9, 0.1), 0.19999999999999996);
  });

  it("linearToSrgb and srgbToLinear sample mid-gray", () => {
    assert.equal(Math.round(linearToSrgb(0.5) * 10000) / 10000, 0.7354);
    assert.equal(Math.round(srgbToLinear(0.5) * 10000) / 10000, 0.214);
  });
});

describe("engine/compositing/color-math.js HSL and HSV", () => {
  it("rgbToHsl and hslToRgb round-trip byte-range samples", () => {
    const hsl = rgbToHsl(128, 64, 32);
    assert.equal(hsl.hue, 0.05555555555555555);
    assert.equal(hsl.saturation, -0.6075949367088608);
    assert.equal(hsl.lightness, 80);
    const rgb = hslToRgb(hsl.hue, hsl.saturation, hsl.lightness);
    assert.deepEqual(rgb, { h: 128, l: 64, O: 32 });
  });

  it("rgbToHsv and hsvToRgb convert pure green", () => {
    const hsv = rgbToHsv(0, 255, 0);
    assert.equal(hsv.hue, 0.3333333333333333);
    assert.equal(hsv.saturation, 1);
    assert.equal(hsv.value, 255);
    const rgb = hsvToRgb(1 / 3, 1, 1);
    assert.deepEqual(rgb, { h: 0, l: 1, O: 0 });
  });
});

describe("engine/compositing/color-math.js checkerboard and YCbCr", () => {
  it("checkerboardCell alternates gray bands", () => {
    assert.equal(checkerboardCell(3, 5, 2), 204);
  });

  it("drawCheckerboard fills RGBA gray tiles", () => {
    const rgba = new Uint8Array(16);
    drawCheckerboard(rgba, 2, 2, 4);
    assert.deepEqual(Array.from(rgba), [
      255, 255, 255, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
    ]);
  });

  it("rgbaToYcbcr converts the first pixel", () => {
    const rgba = new Uint8Array([255, 128, 64, 255, 0, 0, 0, 0]);
    const ycbcr = new Uint8Array(8);
    rgbaToYcbcr(rgba, ycbcr);
    assert.deepEqual(Array.from(ycbcr.slice(0, 4)), [152, 99, 188, 255]);
  });
});

describe("engine/compositing/color-math.js Lab and invert", () => {
  it("rgbToLab and labToRgb round-trip mid-gray", () => {
    const lab = rgbToLab(128, 128, 128);
    assert.deepEqual(
      [lab.labL, lab.labA, lab.labB].map((value) => Math.round(value * 10) / 10),
      [53.4, 0, -0.6],
    );
    const rgb = labToRgb(lab.labL, lab.labA, lab.labB);
    assert.deepEqual(
      [Math.round(rgb.h), Math.round(rgb.l), Math.round(rgb.O)],
      [128, 127, 128],
    );
  });

  it("labSimilarity returns full weight inside the fuzz box", () => {
    const sample = rgbToLab(128, 128, 128);
    const weight = labSimilarity(
      sample,
      { labL: 0, labA: -100, labB: -100 },
      { labL: 100, labA: 100, labB: 100 },
      0.5,
      2,
    );
    assert.equal(Math.round(weight * 1000) / 1000, 1);
  });

  it("invert and invertRgb flip buffer bits", () => {
    const wordBuf = new Uint8Array(4);
    wordBuf[0] = 10;
    wordBuf[1] = 20;
    wordBuf[2] = 30;
    wordBuf[3] = 40;
    invert(wordBuf);
    assert.equal(new Uint32Array(wordBuf.buffer)[0], 3621907445);

    const rgb = new Uint8Array([0, 255, 128, 64]);
    invertRgb(rgb);
    assert.deepEqual(Array.from(rgb), [255, 0, 127, 64]);
  });

  it("rgbSaturation reads h/l/O channel object", () => {
    assert.equal(rgbSaturation({ h: 200, l: 50, O: 120 }), 150);
    assert.equal(rgbSaturation({ h: 80, l: 80, O: 80 }), 0);
  });

  it("invertAlpha flips only the alpha byte of each pixel", () => {
    const rgba = new Uint8Array([0, 255, 128, 64, 1, 2, 3, 4]);
    invertAlpha(rgba);
    // RGB untouched; alpha (idx 3, 7) becomes ~x & 255.
    assert.deepEqual(Array.from(rgba), [0, 255, 128, 191, 1, 2, 3, 251]);
  });
});

describe("engine/compositing/color-math.js registration", () => {
  // The sRGB lookup tables are built on first use, so the first conversion
  // that reads them is what brings them into existence.
  it("builds the sRGB lookup tables on demand", () => {
    const lab = rgbToLab(128, 64, 32);
    assert.ok(lab.labL > 0);

    assert.equal(typeof getScratch2dContext, "function");
    assert.equal(linearToSrgb(0), 0);

    const sparse = new Uint8Array(12);
    for (let idx = 0; idx < 9; idx++) {
      sparse[idx * 4] = idx * 20;
    }
    assert.equal(hasEnoughColorVariety(sparse, 3, 3), false);
  });
});
