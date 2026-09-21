import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import {
  DESCRIPTOR_TEMPLATES,
  EFFECT_DEFAULT_DESCRIPTORS,
  FILL_LAYER_DEFAULTS,
  LMFX_ROOT_DEFAULT,
  STROKE_STYLE_DEFAULT,
} from "../../../src/document/formats/psd/effect-default-data.js";

let LayerEffectDefs;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ LayerEffectDefs } = await import("../../../src/document/formats/psd/effect-defs.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("../../../src/document/formats/psd/effect-defs.js", () => {
  it("createLmfxRootTemplate matches lmfx root data", () => {
    assert.deepEqual(LayerEffectDefs.createLmfxRootTemplate(), LMFX_ROOT_DEFAULT);
  });

  it("getEffectDefault matches wire data for every effect class", () => {
    for (let index = 0; index < EFFECT_DEFAULT_DESCRIPTORS.length; index++) {
      const effectClassId = LayerEffectDefs.order[index];
      assert.deepEqual(
        LayerEffectDefs.getEffectDefault(effectClassId),
        EFFECT_DEFAULT_DESCRIPTORS[index],
        effectClassId,
      );
    }
  });

  it("descriptor templates expose gradient presets from data module", () => {
    assert.deepEqual(
      LayerEffectDefs.descriptorTemplates.foregroundBackgroundGradient,
      DESCRIPTOR_TEMPLATES.foregroundBackgroundGradient,
    );
    assert.deepEqual(
      LayerEffectDefs.descriptorTemplates.twoColorGradient,
      DESCRIPTOR_TEMPLATES.twoColorGradient,
    );
  });

  it("stroke and fill layer defaults match data module", () => {
    assert.deepEqual(LayerEffectDefs.StrokeStyleDefs.default, STROKE_STYLE_DEFAULT);
    assert.deepEqual(LayerEffectDefs.fillLayerDefaults, FILL_LAYER_DEFAULTS);
  });

  it("registry keys are readable and aligned with effect order", () => {
    assert.deepEqual(
      LayerEffectDefs.order,
      EFFECT_DEFAULT_DESCRIPTORS.map((descriptor) => descriptor.classID),
    );
    assert.equal(LayerEffectDefs.order.length, LayerEffectDefs.effectKeys.length);
    assert.equal(LayerEffectDefs.order.length, LayerEffectDefs.names.length);
    assert.deepEqual(LayerEffectDefs.singleSlotEffectKinds, ["DrSh", "IrSh", "SoFi", "GrFl", "FrFX"]);
    assert.deepEqual(LayerEffectDefs.fillPropertyKeyGroups, [
      LayerEffectDefs.solidFillPropertyKeys,
      LayerEffectDefs.gradientOverlayPropertyKeys,
      LayerEffectDefs.patternOverlayPropertyKeys,
    ]);
    assert.equal(LayerEffectDefs.getEffectDefault("DrSh").classID, "DrSh");
  });

  it("clone helpers return deep copies isolated from module data", () => {
    const root = LayerEffectDefs.createLmfxRootTemplate();
    root.masterFXSwitch.v = false;
    assert.notEqual(root.masterFXSwitch.v, LayerEffectDefs.createLmfxRootTemplate().masterFXSwitch.v);

    const dropShadow = LayerEffectDefs.getEffectDefault("DrSh");
    dropShadow.enab.v = false;
    assert.notEqual(dropShadow.enab.v, LayerEffectDefs.getEffectDefault("DrSh").enab.v);
  });

  it("JSON helpers round-trip wire data", () => {
    for (let index = 0; index < EFFECT_DEFAULT_DESCRIPTORS.length; index++) {
      const effectClassId = LayerEffectDefs.order[index];
      assert.equal(
        LayerEffectDefs.getEffectDefaultJson(effectClassId),
        JSON.stringify(EFFECT_DEFAULT_DESCRIPTORS[index]),
        effectClassId,
      );
    }
  });

  it("clone-source constants are immutable; in-place writes throw", () => {
    assert.ok(Object.isFrozen(LMFX_ROOT_DEFAULT));
    assert.ok(Object.isFrozen(EFFECT_DEFAULT_DESCRIPTORS));
    assert.ok(Object.isFrozen(EFFECT_DEFAULT_DESCRIPTORS[9].enab));
    assert.ok(Object.isFrozen(STROKE_STYLE_DEFAULT));
    assert.ok(Object.isFrozen(FILL_LAYER_DEFAULTS[0]));
    assert.throws(() => {
      EFFECT_DEFAULT_DESCRIPTORS[9].enab.v = false;
    }, TypeError);
    // Widget-facing templates are shared mutable objects by design.
    assert.ok(!Object.isFrozen(DESCRIPTOR_TEMPLATES.twoColorGradient));
  });

  it("getStrokeStyleDefault and getFillLayerDefault return isolated clones", () => {
    const strokeA = LayerEffectDefs.getStrokeStyleDefault();
    assert.deepEqual(strokeA, STROKE_STYLE_DEFAULT);
    strokeA.strokeEnabled.v = !strokeA.strokeEnabled.v;
    assert.notEqual(
      strokeA.strokeEnabled.v,
      LayerEffectDefs.getStrokeStyleDefault().strokeEnabled.v,
    );

    const solidFill = LayerEffectDefs.getFillLayerDefault(0);
    assert.deepEqual(solidFill, FILL_LAYER_DEFAULTS[0]);
    assert.notEqual(solidFill, FILL_LAYER_DEFAULTS[0]);
    assert.deepEqual(LayerEffectDefs.getFillLayerDefault(2), FILL_LAYER_DEFAULTS[2]);
  });
});
