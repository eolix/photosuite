/**
 * Golden values for psd-color-utils (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Point } from "../../../src/core/math/point.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { angularGradientPos, buildGradientLut, clampRound, diamondGradientPos, gradientAngleFromPoints, gradientRenderers, gradientStopBlend, interpolateGradientStop, linearGradientEndpoints, linearGradientPos, parseColorStops, psdColorToRgb, radialGradientPos, readDescriptorScalar, reflectedGradientPos, sampleGradientColor, toRGBDesc } from "../../../src/engine/compositing/psd-color-utils.js";

let restoreBrowserGlobals;

function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

/** Minimal gradient descriptor with color + transparency stops and smoothness. */
function minimalGradDesc() {
  return {
    Intr: { v: 2048 },
    Clrs: {
      v: [
        { v: { Lctn: { v: 0 }, Mdpn: { v: 50 } } },
        { v: { Lctn: { v: 4096 }, Mdpn: { v: 50 } } },
      ],
    },
    Trns: {
      v: [
        { v: { Lctn: { v: 0 }, Mdpn: { v: 50 }, Opct: { v: { val: 100 } } } },
        { v: { Lctn: { v: 4096 }, Mdpn: { v: 50 }, Opct: { v: { val: 0 } } } },
      ],
    },
  };
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
});

after(() => {
  if (restoreBrowserGlobals) {
    restoreBrowserGlobals();
  }
});

describe("engine/compositing/psd-color-utils.js clampRound", () => {
  it("maps normalized values into [0, maxIndex]", () => {
    assert.deepEqual([
      clampRound(0, 1023),
      clampRound(0.5, 1023),
      clampRound(1, 1023),
      clampRound(-0.1, 1023),
      clampRound(1.1, 1023),
      clampRound(0.25, 10),
    ], [0, 511, 1023, 0, 1023, 2]);
  });
});

describe("engine/compositing/psd-color-utils.js gradient positions", () => {
  it("linearGradientPos returns u + 0.5", () => {
    assert.equal(linearGradientPos(0.3, -0.2), 0.8);
  });

  it("radialGradientPos doubles distance from origin", () => {
    assert.equal(radialGradientPos(0.3, 0.4), 1);
  });

  it("angularGradientPos wraps atan2 into [0, 1)", () => {
    assert.equal(angularGradientPos(0.3, 0.4), 0.1475836176504333);
  });

  it("reflectedGradientPos mirrors along u", () => {
    assert.equal(reflectedGradientPos(-0.25, 0.1), 0.5);
  });

  it("diamondGradientPos sums Manhattan distance", () => {
    assert.equal(diamondGradientPos(0.3, -0.4), 1.4);
  });
});

describe("engine/compositing/psd-color-utils.js color conversion", () => {
  it("psdColorToRgb reads RGBC integer channels", () => {
    assert.deepEqual(psdColorToRgb({
      classID: "RGBC",
      Rd: { t: "doub", v: 128 },
      Grn: { t: "doub", v: 64 },
      Bl: { t: "doub", v: 32 },
    }), { h: 128, l: 64, O: 32 });
  });

  it("psdColorToRgb converts HSBC via hsvToRgb", () => {
    assert.deepEqual(psdColorToRgb({
      classID: "HSBC",
      H: { t: "doub", v: 120 },
      Strt: { t: "doub", v: 50 },
      Brgh: { t: "doub", v: 75 },
    }), { h: 95.625, l: 191.25, O: 95.625 });
  });

  it("psdColorToRgb inverts Grsc gray level", () => {
    assert.deepEqual(psdColorToRgb({
      classID: "Grsc",
      Gry: { t: "doub", v: 40 },
    }), { h: 215, l: 215, O: 215 });
  });

  it("psdColorToRgb converts CMYC and LbCl, and falls back to black", () => {
    const cmyk = psdColorToRgb({ classID: "CMYC", Cyn: { v: 20 }, Mgnt: { v: 40 }, Ylw: { v: 60 }, Blck: { v: 10 } });
    assert.deepEqual(
      [cmyk.h, cmyk.l, cmyk.O].map((v) => Math.round(v * 1e6) / 1e6),
      [183.6, 146.88, 100.98],
    );
    const lab = psdColorToRgb({ classID: "LbCl", Lmnc: { v: 50 }, A: { v: 20 }, B: { v: -30 } });
    assert.deepEqual(
      [lab.h, lab.l, lab.O].map((v) => Math.round(v * 1e6) / 1e6),
      [133.955824, 107.764994, 169.389922],
    );
    assert.deepEqual(psdColorToRgb({ classID: "XXXX" }), { h: 0, l: 0, O: 0 });
  });

  it("readDescriptorScalar unwraps plain and unit fields", () => {
    assert.equal(readDescriptorScalar({ t: "long", v: 42 }), 42);
    assert.equal(readDescriptorScalar({ t: "UntF", v: { type: "#Prc", val: 75.5 } }), 75.5);
    assert.equal(readDescriptorScalar(null), null);
  });

  it("toRGBDesc builds an RGBC descriptor tree", () => {
    assert.deepEqual(toRGBDesc({ h: 100, l: 150, O: 200 }), {
      classID: "RGBC",
      Rd: { t: "doub", v: 100 },
      Grn: { t: "doub", v: 150 },
      Bl: { t: "doub", v: 200 },
    });
  });
});

describe("engine/compositing/psd-color-utils.js gradient stops and LUT", () => {
  const rgbStops = [
    { h: 255, l: 0, O: 0 },
    { h: 0, l: 0, O: 255 },
  ];

  it("parseColorStops resolves UsrS RGBC stop", () => {
    const colorStopList = [{
      v: {
        Type: { v: { Clry: "UsrS" } },
        Clr: {
          v: {
            classID: "RGBC",
            Rd: { t: "doub", v: 255 },
            Grn: { t: "doub", v: 128 },
            Bl: { t: "doub", v: 64 },
          },
        },
      },
    }];
    assert.deepEqual(parseColorStops(colorStopList, 0xff0000, 0x00ff00), [
      { h: 255, l: 128, O: 64 },
    ]);
  });

  it("gradientStopBlend returns midpoint factor for two-stop list", () => {
    const stopList = [
      { v: { Lctn: { v: 0 }, Mdpn: { v: 50 } } },
      { v: { Lctn: { v: 4096 }, Mdpn: { v: 50 } } },
    ];
    assert.equal(gradientStopBlend(stopList, 1 / 4096, 0, 0.5, 0.5), 0.5);
  });

  it("sampleGradientColor packs RGBA at start and midpoint", () => {
    const gradDesc = minimalGradDesc();
    assert.equal(sampleGradientColor(gradDesc, rgbStops, 0), -16776961);
    assert.equal(sampleGradientColor(gradDesc, rgbStops, 0.5), 2139095168);
  });

  it("interpolateGradientStop returns float RGBA at midpoint", () => {
    const gradDesc = minimalGradDesc();
    assert.deepEqual(interpolateGradientStop(gradDesc, rgbStops, 0.5), [
      127.5,
      0,
      127.5,
      127.49999999999999,
    ]);
  });

  it("buildGradientLut fills packed entries across span", () => {
    const gradDesc = minimalGradDesc();
    const lut = buildGradientLut(gradDesc, rgbStops, 4, false);
    assert.equal(lut.length, 4);
    assert.equal(lut[0], 4278190335);
    assert.equal(lut[3], 969277497);
  });
});

describe("engine/compositing/psd-color-utils.js gradient geometry", () => {
  it("linearGradientEndpoints returns Point instances from angle/scale/offset", () => {
    const gradDesc = {
      Angl: { v: { val: 45 } },
      Scl: { v: { val: 100 } },
      Ofst: { v: { Hrzn: { v: { val: 10 } }, Vrtc: { v: { val: -5 } } } },
    };
    const [start, end] = linearGradientEndpoints(gradDesc, { x: 0, y: 0, width: 100, height: 80 });
    assert.ok(start instanceof Point);
    assert.deepEqual([start.x, start.y], [60, 36]);
    assert.deepEqual([end.x, end.y].map((v) => Math.round(v * 1e6) / 1e6), [100, -4]);
  });

  it("gradientAngleFromPoints writes angle/scale/offset back into the descriptor", () => {
    const gradDesc = {
      Angl: { v: { val: 0 } },
      Scl: { v: { val: 0 } },
      Ofst: { v: { Hrzn: { v: { val: 0 } }, Vrtc: { v: { val: 0 } } } },
    };
    gradientAngleFromPoints({ x: 10, y: 10 }, { x: 60, y: 40 }, { x: 0, y: 0, width: 100, height: 80 }, gradDesc);
    assert.deepEqual(
      [gradDesc.Angl.v.val, gradDesc.Scl.v.val, gradDesc.Ofst.v.Hrzn.v.val, gradDesc.Ofst.v.Vrtc.v.val].map(
        (v) => Math.round(v * 1e6) / 1e6,
      ),
      [-30.963757, 100, -40, -37.5],
    );
  });
});

describe("engine/compositing/psd-color-utils.js registration", () => {
  it("registerPsdColorUtils wires five gradient renderers that write pixels", () => {
    assert.equal(gradientRenderers.length, 5);
    const rgbStops = [{ h: 255, l: 0, O: 0 }, { h: 0, l: 0, O: 255 }];
    const lut = buildGradientLut(minimalGradDesc(), rgbStops, 1024, false);
    const out = new Uint32Array(6 * 4);
    gradientRenderers[0](out, lut, [0.1, 0, 0, 0.1], { width: 6, height: 4 }, 0, 0, 1023);
    // Linear renderer fills every pixel from the LUT (no zero-initialized holes).
    assert.ok(out.every((packed) => packed !== 0));
  });
});
