import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BlendModes } from "../../../src/document/model/blend-modes.js";

const GOLDEN_PSD_CODES = [
  "norm", "diss", "dark", "mul ", "idiv", "lbrn", "dkCl", "lite", "scrn", "div ", "lddg", "lgCl",
  "over", "sLit", "hLit", "vLit", "lLit", "pLit", "hMix", "diff", "smud", "fsub", "fdiv", "hue ",
  "sat ", "colr", "lum ",
];

const GOLDEN_PSD_NAMES = [
  "Nrml", "Dslv", "Drkn", "Mltp", "CBrn", "linearBurn", "darkerColor", "Lghn", "Scrn", "CDdg",
  "linearDodge", "lighterColor", "Ovrl", "SftL", "HrdL", "vividLight", "linearLight", "pinLight",
  "hardMix", "Dfrn", "Xclu", "blendSubtraction", "blendDivide", "H", "Strt", "Clr", "Lmns",
];

describe("document/model/blend-modes.js", () => {
  it("exposes parallel catalog arrays", () => {
    assert.deepEqual(BlendModes.psdCodes, GOLDEN_PSD_CODES);
    assert.deepEqual(BlendModes.psdNames, GOLDEN_PSD_NAMES);
    assert.deepEqual(BlendModes.groupSizes, [2, 5, 5, 7, 4, 4]);
    assert.equal(BlendModes.uiLabels.length, 27);
    assert.equal(BlendModes.cssNames.length, 27);
  });

  it("fromPSD maps PSD names to wire codes", () => {
    assert.equal(BlendModes.fromPSD("Nrml"), "norm");
    assert.equal(BlendModes.fromPSD("Mltp"), "mul ");
    assert.equal(BlendModes.fromPSD("passThrough"), "pass");
    assert.equal(BlendModes.fromPSD(null), "norm");
    assert.equal(BlendModes.fromPSD("not-a-mode"), "norm");
  });

  it("toPSD and getName round-trip standard codes", () => {
    assert.equal(BlendModes.toPSD("pass"), "passThrough");
    assert.equal(BlendModes.toPSD("norm"), "Nrml");
    assert.equal(BlendModes.toPSD("mul "), "Mltp");
    assert.equal(
      BlendModes.getName("over"),
      "brushAndMessages.blendModes.overlay",
    );
  });

  it("cssNames align with wire codes for SVG import/export", () => {
    const overlayIndex = BlendModes.psdCodes.indexOf("over");
    assert.equal(BlendModes.cssNames[overlayIndex], "overlay");
    const multiplyIndex = BlendModes.psdCodes.indexOf("mul ");
    assert.equal(BlendModes.cssNames[multiplyIndex], "multiply");
  });
});
