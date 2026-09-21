/**
 * Golden values for text EngineData builders and wire codec.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TextLayerData;
let TextEngineData;

before(async () => {
  ({ TextLayerData } = await import("../../../src/features/text/engine-data.js"));
  ({ TextEngineData } = await import("../../../src/features/text/text-engine.js"));
});

describe("features/text/engine-data.js", () => {
  it("prefixTypedValues prefixes each numeric channel", () => {
    assert.deepEqual(TextLayerData.prefixTypedValues("f", [0, 1, 2.5]), ["f0", "f1", "f2.5"]);
  });

  it("buildFontSetDescriptor dedupes fonts and drops Script=0 wire field", () => {
    const engineData = TextEngineData.cloneEngineData();
    engineData.ResourceDict.FontSet = [
      { Name: "Arial", Script: 0, FontType: 1 },
      { Name: "Arial", Script: 0, FontType: 1 },
      { Name: "Other", Script: 1, FontType: 0 },
    ];
    assert.deepEqual(TextLayerData.buildFontSetDescriptor([engineData], null), {
      _0: [
        {
          _0: {
            _99: "/CoolTypeFont",
            _0: { _0: "sArial", _2: "i1" },
          },
        },
        {
          _0: {
            _99: "/CoolTypeFont",
            _0: { _0: "sOther", _1: "i1", _2: "i0" },
          },
        },
      ],
    });
  });

  it("applyStyleSheetToWire writes FauxBold on wire _2", () => {
    const engineData = TextEngineData.cloneEngineData();
    engineData.ResourceDict.FontSet = [{ Name: "Arial", Script: 0, FontType: 1 }];
    const fonts = TextLayerData.buildFontSetDescriptor([engineData], null);
    const wire = { _0: "s", _5: "i1", _6: {} };
    TextLayerData.applyStyleSheetToWire(
      wire,
      { Name: "", StyleSheetData: { Font: 0, FontSize: 12, FauxBold: true } },
      fonts._0,
      engineData.ResourceDict.FontSet,
    );
    assert.deepEqual(wire._6, { _0: "i0", _1: "f12", _2: true });
  });

  it("applyParagraphSheetToWire writes StartIndent on wire _2", () => {
    const para = { _0: "s", _5: {}, _6: "i1" };
    TextLayerData.applyParagraphSheetToWire(para, {
      Name: "",
      Properties: { Justification: 1, StartIndent: 10 },
    });
    assert.deepEqual(para._5, { _0: "i1", _2: "f10" });
  });

  it("renamed default sheet tables remain present", () => {
    assert.equal(TextLayerData.defaultStyleSheetWire._0, "sNormal RGB");
    assert.equal(TextLayerData.defaultParagraphSheetWire._0, "sNormal RGB");
    assert.ok(TextLayerData.mojiKumiTableSetDefaults._0.length > 0);
    assert.ok(TextLayerData.kinsokuSetDefaults._0.length > 0);
  });
});
