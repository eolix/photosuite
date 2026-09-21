/**
 * Golden values for css-export/css.js (colour / gradient / font helpers).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let CSS;

before(async () => {
  ({ CSS } = await import("../../../src/features/css-export/css.js"));
});

describe("features/css-export/css.js", () => {
  it("formatCssNumber / rgbToCss / psdColorToCss", () => {
    assert.deepEqual(
      [0, 0.5, 1.25, -3.7, 10].map((v) => CSS.formatCssNumber(v)),
      ["0", "0.5", "1.25", "-3.7", "10"],
    );
    assert.equal(CSS.rgbToCss({ h: 255, l: 0, O: 0 }, 1), "#ff0000");
    assert.equal(CSS.rgbToCss({ h: 10.4, l: 20.6, O: 30.2 }, 0.5), "rgba(10,21,30,0.5)");
    assert.equal(CSS.rgbToCss({ h: 0, l: 0, O: 0 }, null), "#000000");
    const psdRed = {
      classID: "RGBC",
      Rd: { t: "doub", v: 255 },
      Grn: { t: "doub", v: 0 },
      Bl: { t: "doub", v: 0 },
    };
    assert.equal(CSS.psdColorToCss(psdRed, 1), "#ff0000");
    assert.equal(CSS.psdColorToCss(psdRed, 0.25), "rgba(255,0,0,0.25)");
  });

  it("parseCssColor hex / named / functional", () => {
    assert.deepEqual(CSS.parseCssColor("#ff00aa"), { h: 255, l: 0, O: 170 });
    assert.deepEqual(CSS.parseCssColor("#f0a"), { h: 255, l: 0, O: 170 });
    assert.deepEqual(CSS.parseCssColor("aliceblue"), { h: 240, l: 248, O: 255 });
    assert.deepEqual(CSS.parseCssColor("rgb(10, 20, 30)"), { h: 10, l: 20, O: 30 });
    assert.deepEqual(CSS.parseCssColor("rgba(10%,20%,30%,0.5)"), {
      h: 25.5,
      l: 51,
      O: 76.5,
    });
    assert.deepEqual(CSS.parseCssColor(null), { h: 0, l: 0, O: 0 });
  });

  it("inferFontFamilyFromPostScriptName", () => {
    assert.equal(CSS.inferFontFamilyFromPostScriptName("HelveticaNeue-Bold"), "Helvetica Neue");
    assert.equal(CSS.inferFontFamilyFromPostScriptName("ArialMT"), "Arial");
    assert.equal(CSS.inferFontFamilyFromPostScriptName("MyFontPS"), "My Font");
    assert.equal(CSS.inferFontFamilyFromPostScriptName("OpenSans"), "Open Sans");
  });

  it("gradientToCss linear stops", () => {
    const psdRed = {
      classID: "RGBC",
      Rd: { t: "doub", v: 255 },
      Grn: { t: "doub", v: 0 },
      Bl: { t: "doub", v: 0 },
    };
    const grad = {
      Grad: {
        v: {
          Clrs: {
            v: [
              { v: { Clr: { v: psdRed }, Lctn: { v: 0 } } },
              {
                v: {
                  Clr: {
                    v: {
                      classID: "RGBC",
                      Rd: { t: "doub", v: 0 },
                      Grn: { t: "doub", v: 0 },
                      Bl: { t: "doub", v: 255 },
                    },
                  },
                  Lctn: { v: 4096 },
                },
              },
            ],
          },
          Trns: {
            v: [{ v: { Opct: { v: { val: 100 } } } }, { v: { Opct: { v: { val: 50 } } } }],
          },
        },
      },
      Ofst: { v: {} },
      Type: { v: { GrdT: "Lnr" } },
      Angl: { v: { val: 0 } },
      Rvrs: { v: false },
    };
    assert.equal(
      CSS.gradientToCss(grad),
      "linear-gradient(90deg, #ff0000 0%, rgba(0,0,255,0.5) 100%)",
    );
  });

  it("appendBackgroundRules + namedColors table", () => {
    const rules = [];
    CSS.appendBackgroundRules(
      ["#ff0000", "linear-gradient(90deg, #000 0%, #fff 100%)"],
      rules,
    );
    assert.deepEqual(rules, [
      "background-color: #ff0000",
      "background-image: linear-gradient(90deg, #000 0%, #fff 100%)",
    ]);
    assert.equal(CSS.namedColors.aliceblue, "#f0f8ff");
    assert.equal(CSS.namedColors.whitesmoke, "#f5f5f5");
    assert.equal(Object.keys(CSS.namedColors).length, 148);
  });
});
