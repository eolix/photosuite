import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let PatternParser, GradientParser;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ PatternParser, GradientParser } =
    await import("../../../../src/document/formats/psd/layer-data-parsers.js"));
});

after(() => { if (restoreBrowserGlobals) restoreBrowserGlobals(); });

const u16 = (n) => [(n >>> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

describe("document/formats/psd/layer-data-parsers.js", () => {
  it("exports the pattern and gradient parsers", () => {
    assert.equal(typeof PatternParser.extract, "function");
    assert.equal(typeof GradientParser.readGradientEntry, "function");
  });

  it("PatternParser.extract returns an empty list for zero length", () => {
    assert.deepEqual(PatternParser.extract(new Uint8Array(0), 0, 0), []);
  });

  it("readGradientEntry builds a Grdn descriptor with an RGB color stop", () => {
    const bytes = new Uint8Array([
      ...u16(1),          // 1 color stop
      ...u32(0),          // location
      ...u32(50),         // midpoint
      ...u16(0),          // colorSpace RGB
      ...u16(65535),      // ch0 -> R 255
      ...u16(0), ...u16(0), ...u16(0), // ch1..3
      0, 0,               // pad to 20-byte stride
      ...u16(0),          // 0 transparency stops
    ]);
    const [gradient, pos] = GradientParser.readGradientEntry(bytes, 0, "Test");
    assert.equal(gradient.classID, "Grdn");
    assert.equal(gradient.Nm.v, "Test");
    assert.equal(gradient.Clrs.v.length, 1);
    const stop = gradient.Clrs.v[0].v;
    assert.equal(stop.classID, "Clrt");
    assert.equal(stop.Lctn.v, 0);
    assert.equal(stop.Mdpn.v, 50);
    assert.equal(stop.Clr.v.classID, "RGBC");
    assert.equal(stop.Clr.v.Rd.v, 255);
    assert.equal(gradient.Trns.v.length, 0);
    assert.equal(pos, 24);
  });

  it("readGradientEntry throws when there are no color stops", () => {
    assert.throws(() => GradientParser.readGradientEntry(new Uint8Array([0, 0]), 0, "X"), /no color stops/);
  });
});
