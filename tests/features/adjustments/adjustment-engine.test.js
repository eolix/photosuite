/**
 * Golden values for adjustment-engine (/ descriptor→shader routing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let AdjustmentEngine;
let adjustmentKeyOf;
let LayerSystem;

before(async () => {
  ({ AdjustmentEngine } = await import("../../../src/features/adjustments/adjustment-engine.js"));
  ({ adjustmentKeyOf } = await import(
    "../../../src/document/formats/psd/adjustment-parsers.js"
  ));
  ({ LayerSystem } = await import("../../../src/engine/layer-system.js"));
  LayerSystem.webglEnabled = false;
});

describe("features/adjustments/adjustment-engine.js", () => {
  it("satPow / satPowInverse match captured curves", () => {
    assert.deepEqual(
      [-1, -0.5, 0, 0.25, 0.5, 0.75, 0.99].map((v) => AdjustmentEngine.satPow(v)),
      [-1, -0.5, 0, 0.3179739991813622, 0.9999999999999999, 3.144911227252993, 221.30831018806472],
    );
    assert.deepEqual(
      [-1, -0.5, 0, 0.25, 0.5].map((v) => AdjustmentEngine.satPowInverse(v)),
      [-1, -0.5, 0, 0.21106828194172336, 0.3377937448413666],
    );
  });

  it("hueWeight matches band falloff goldens", () => {
    assert.equal(AdjustmentEngine.hueWeight(0, 0), 1);
    assert.equal(AdjustmentEngine.hueWeight(0.1, 0), 0.3999999999999999);
    assert.equal(AdjustmentEngine.hueWeight(0.5, 0.5), 1);
    assert.equal(AdjustmentEngine.hueWeight(1, 0), 1);
  });

  it("get / getAutoLevelsMode route descriptors", () => {
    assert.equal(adjustmentKeyOf({ brit: {} }), "brit");
    assert.equal(adjustmentKeyOf({ levl: {}, brit: {} }), "brit");
    assert.equal(adjustmentKeyOf({}), null);
    assert.equal(AdjustmentEngine.getAutoLevelsMode("curv", {}), -1);
    assert.equal(AdjustmentEngine.getAutoLevelsMode("levl", null), -1);
    assert.equal(AdjustmentEngine.getAutoLevelsMode("levl", { Auto: 1 }), 0);
    assert.equal(AdjustmentEngine.getAutoLevelsMode("levl", { AuCo: 1 }), 1);
    assert.equal(AdjustmentEngine.getAutoLevelsMode("levl", { autoBlackWhite: 1 }), 2);
    assert.equal(AdjustmentEngine.getAutoLevelsMode("levl", {}), -1);
  });

  it("buildShaderOptions invert / threshold / posterize / exposure / vibrance", () => {
    const inv = AdjustmentEngine.buildShaderOptions("nvrt", {});
    assert.equal(inv.type, 0);
    assert.equal(inv.lutR[0], 255);
    assert.equal(inv.lutR[1], 254);
    assert.equal(inv.lutR[255], 0);
    assert.equal(inv.toGray, false);
    assert.equal(inv.preserveLuminosity, false);

    const th = AdjustmentEngine.buildShaderOptions("thrs", { Lvl: { v: 128 } });
    assert.equal(th.type, 0);
    assert.equal(th.lutR[127], 0);
    assert.equal(th.lutR[128], 255);
    assert.equal(th.lutR[255], 255);
    assert.equal(th.toGray, true);

    const post = AdjustmentEngine.buildShaderOptions("post", { Lvls: { v: 4 } });
    assert.equal(post.type, 0);
    assert.deepEqual(
      [0, 64, 128, 192, 255].map((i) => Math.round(post.lutR[i])),
      [0, 85, 170, 255, 255],
    );

    const ex = AdjustmentEngine.buildShaderOptions("expA", {
      Exps: { v: 0.5 },
      Ofst: { v: 0 },
      gammaCorrection: { v: 1 },
    });
    assert.equal(ex.type, 0);
    assert.deepEqual(
      [0, 64, 128, 192, 255].map((i) => ex.lutR[i]),
      [0, 75, 150, 225, 255],
    );

    const vib = AdjustmentEngine.buildShaderOptions("vibA", {
      vibrance: { v: 50 },
      Strt: { v: 10 },
    });
    assert.equal(vib.type, 2);
    assert.deepEqual(vib.vibranceSat, [50, 10]);
  });

  it("buildShaderOptions brit non-legacy builds a fully-populated LUT", () => {
    // The brightness-remap index and the loop counter must stay separate.
    // Collapsed into one variable, the counter is overwritten mid-iteration and
    // ~1003/1024 LUT entries stay at zero, giving near-black output. A correct
    // LUT is dense (only the black tail is 0) and ends at full white.
    const brit = AdjustmentEngine.buildShaderOptions("brit", {
      Brgh: { v: 50 },
      Cntr: { v: 20 },
      useLegacy: { v: false },
    });
    assert.equal(brit.type, 0);
    assert.equal(brit.lutR.length, 1024);
    let zeros = 0;
    for (let i = 0; i < brit.lutR.length; i++) {
      if (brit.lutR[i] === 0) zeros += 1;
    }
    assert.equal(zeros, 2);
    assert.deepEqual(
      [0, 128, 256, 384, 512, 640, 768, 896, 1023].map((i) => brit.lutR[i]),
      [0, 39, 83, 130, 173, 207, 231, 246, 255],
    );
    for (let i = 1; i < brit.lutR.length; i++) {
      assert.ok(brit.lutR[i] >= brit.lutR[i - 1]);
    }
  });

  it("buildShaderOptions brit legacy uses the color-matrix path", () => {
    const legacy = AdjustmentEngine.buildShaderOptions("brit", {
      Brgh: { v: 40 },
      Cntr: { v: 30 },
      useLegacy: { v: true },
    });
    assert.equal(legacy.type, 0);
    assert.equal(legacy.lutR.length, 256);
    assert.deepEqual(
      [0, 64, 128, 192, 255].map((i) => legacy.lutR[i]),
      [0, 72, 168, 255, 255],
    );
  });

  it("parseChannelMixer / channelMixerToDescriptor round-trip", () => {
    const mixDesc = {
      Mnch: { t: "bool", v: false },
      Rd: {
        t: "Objc",
        v: {
          classID: "ChMx",
          Rd: { t: "UntF", v: { type: "#Prc", val: 100 } },
          Grn: { t: "UntF", v: { type: "#Prc", val: 0 } },
          Bl: { t: "UntF", v: { type: "#Prc", val: 0 } },
          Cnst: { t: "UntF", v: { type: "#Prc", val: 0 } },
        },
      },
      Grn: {
        t: "Objc",
        v: {
          classID: "ChMx",
          Rd: { t: "UntF", v: { type: "#Prc", val: 0 } },
          Grn: { t: "UntF", v: { type: "#Prc", val: 100 } },
          Bl: { t: "UntF", v: { type: "#Prc", val: 0 } },
          Cnst: { t: "UntF", v: { type: "#Prc", val: 0 } },
        },
      },
      Bl: {
        t: "Objc",
        v: {
          classID: "ChMx",
          Rd: { t: "UntF", v: { type: "#Prc", val: 0 } },
          Grn: { t: "UntF", v: { type: "#Prc", val: 0 } },
          Bl: { t: "UntF", v: { type: "#Prc", val: 100 } },
          Cnst: { t: "UntF", v: { type: "#Prc", val: 0 } },
        },
      },
    };
    const parsed = AdjustmentEngine.parseChannelMixer(mixDesc);
    assert.equal(parsed.isMonochrome, false);
    assert.deepEqual(parsed.channelValues, [
      100, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const back = AdjustmentEngine.channelMixerToDescriptor(parsed);
    assert.equal(back.Mnch.v, false);
    assert.equal(back.Rd.v.Rd.v.val, 100);
    assert.equal(back.Grn.v.Grn.v.val, 100);
    assert.equal(back.Bl.v.Bl.v.val, 100);
  });

  it("applySoftware invert preserves alpha and inverts RGB", () => {
    const inv = AdjustmentEngine.buildShaderOptions("nvrt", {});
    const src = new Uint8Array([10, 20, 30, 255, 200, 100, 50, 128]);
    const dst = new Uint8Array(8);
    AdjustmentEngine.applySoftware(inv, src, dst, {
      area: () => 1,
      clone() {
        return this;
      },
      width: 1,
      height: 1,
      x: 0,
      y: 0,
    });
    assert.deepEqual([...dst], [245, 235, 225, 255, 55, 155, 205, 128]);
  });
});
