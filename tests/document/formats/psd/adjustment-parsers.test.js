import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let CurvesParser, HueSaturationParser, LevelsParser, SelectiveColorParser;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  ({ CurvesParser, HueSaturationParser, LevelsParser, SelectiveColorParser } =
    await import("../../../../src/document/formats/psd/adjustment-parsers.js"));
});

after(() => { if (restoreBrowserGlobals) restoreBrowserGlobals(); });

describe("document/formats/psd/adjustment-parsers.js", () => {
  it("CurvesParser.createIdentityCurve is the 0..255 ramp", () => {
    const curve = CurvesParser.createIdentityCurve();
    assert.equal(curve.length, 256);
    assert.equal(curve[0], 0);
    assert.equal(curve[255], 255);
  });

  it("CurvesParser.readCurvePoints reads (y,x) pairs after the count", () => {
    const bytes = new Uint8Array([0, 2, 0, 10, 0, 20, 0, 30, 0, 40]);
    assert.deepEqual(CurvesParser.readCurvePoints(bytes, 0), [20, 10, 40, 30]);
  });

  it("SelectiveColorParser exposes the color-range enum names", () => {
    assert.deepEqual(SelectiveColorParser.colorRanges, ["Rds", "Ylws", "Grns", "Cyns", "Bls", "Mgnt", "Whts", "Ntrl", "Blks"]);
  });

  it("LevelsParser set/get channel level round-trips through the descriptor", () => {
    const desc = { Adjs: { v: [] } };
    LevelsParser.setChannelLevel(desc, 0, [10, 240, 5, 250, 120]);
    assert.deepEqual(LevelsParser.getChannelLevel(desc, 0), [10, 240, 5, 250, 120]);
    assert.deepEqual(LevelsParser.getChannelLevel(desc, 2), [0, 255, 0, 255, 100]);
  });

  it("SelectiveColorParser apply/extract round-trips CMYK for a color range", () => {
    const desc = { ClrC: { v: [] } };
    SelectiveColorParser.apply(desc, 0, [10, -20, 30, -40]);
    assert.deepEqual(SelectiveColorParser.extract(desc, 0), [10, -20, 30, -40]);
    assert.deepEqual(SelectiveColorParser.extract(desc, 1), [0, 0, 0, 0]);
  });

  it("HueSaturationParser.getChannelData returns master default when empty", () => {
    assert.deepEqual(HueSaturationParser.getChannelData({ Adjs: { v: [] } }, 0), [0, 0, 0]);
  });
});
