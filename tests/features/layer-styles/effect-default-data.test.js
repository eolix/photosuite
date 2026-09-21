import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DESCRIPTOR_TEMPLATES,
  EFFECT_DEFAULT_DESCRIPTORS,
  FILL_LAYER_DEFAULTS,
  LMFX_ROOT_DEFAULT,
  STROKE_STYLE_DEFAULT,
} from "../../../src/document/formats/psd/effect-default-data.js";

const EXPECTED_EFFECT_ORDER = [
  "ebbl",
  "FrFX",
  "IrSh",
  "IrGl",
  "ChFX",
  "SoFi",
  "GrFl",
  "patternFill",
  "OrGl",
  "DrSh",
];

describe("../../../src/document/formats/psd/effect-default-data.js", () => {
  it("exports one wire descriptor per layer-effect class", () => {
    assert.equal(EFFECT_DEFAULT_DESCRIPTORS.length, EXPECTED_EFFECT_ORDER.length);
    for (let index = 0; index < EXPECTED_EFFECT_ORDER.length; index++) {
      assert.equal(EFFECT_DEFAULT_DESCRIPTORS[index].classID, EXPECTED_EFFECT_ORDER[index]);
      assert.equal(EFFECT_DEFAULT_DESCRIPTORS[index].enab.v, true);
    }
  });

  it("lmfx root and template payloads are descriptor trees", () => {
    assert.equal(LMFX_ROOT_DEFAULT.classID, "null");
    assert.equal(LMFX_ROOT_DEFAULT.masterFXSwitch.v, true);
    assert.equal(STROKE_STYLE_DEFAULT.classID, "strokeStyle");
    assert.equal(FILL_LAYER_DEFAULTS.length, 3);
    assert.ok(DESCRIPTOR_TEMPLATES.twoColorGradient.v.classID === "Grdn");
    assert.ok(DESCRIPTOR_TEMPLATES.foregroundBackgroundGradient.v.classID === "Grdn");
  });
});
