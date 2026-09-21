/**
 * Golden values for brush-presets (descriptor schema / defaults).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let BrushPresetUtil;

before(async () => {
  ({ BrushPresetUtil } = await import("../../../src/features/brush/brush-presets.js"));
});

describe("features/brush/brush-presets.js", () => {
  it("getDefaultBrushDescriptor computed + sampled tips", () => {
    const def = BrushPresetUtil.getDefaultBrushDescriptor();
    assert.equal(def.classID, "brushPreset");
    assert.equal(def.Nm.v, "Custom Brush");
    assert.equal(def.Brsh.v.classID, "computedBrush");
    assert.equal(def.Brsh.v.diameter.v.val, 15);
    assert.equal(def.Brsh.v.Intr.v, true);
    assert.equal(def.Brsh.v.Hrdn.v.val, 100);
    assert.equal(def.Rpt.v, false);

    const sampled = BrushPresetUtil.getDefaultBrushDescriptor("abc-uid");
    assert.equal(sampled.Brsh.v.classID, "sampledBrush");
    assert.equal(sampled.Brsh.v.sampledData.v, "abc-uid");
    assert.equal(sampled.Brsh.v.Nm.v, "layer.png");
    assert.equal("Hrdn" in sampled.Brsh.v, false);
  });

  it("getBrushPresetFromListEntry filters and aliases Dmtr", () => {
    const def = BrushPresetUtil.getDefaultBrushDescriptor();
    assert.equal(
      BrushPresetUtil.getBrushPresetFromListEntry({ t: "Objc", v: BrushPresetUtil.deepClone(def) }).Nm.v,
      "Custom Brush",
    );
    assert.equal(BrushPresetUtil.getBrushPresetFromListEntry(null), null);
    assert.equal(
      BrushPresetUtil.getBrushPresetFromListEntry({
        v: { Brsh: { v: { classID: "brushGroup", diameter: { v: { val: 1 } } } } },
      }),
      null,
    );
    const dmtrOnly = {
      Brsh: {
        v: {
          classID: "computedBrush",
          Dmtr: { t: "UntF", v: { type: "#Pxl", val: 42 } },
        },
      },
    };
    assert.equal(BrushPresetUtil.getBrushPresetFromListEntry(dmtrOnly).Brsh.v.diameter.v.val, 42);
  });

  it("sanitizeBrushPresetList drops invalid entries", () => {
    const def = BrushPresetUtil.getDefaultBrushDescriptor();
    const list = [
      { t: "Objc", v: BrushPresetUtil.deepClone(def) },
      { v: { Brsh: { v: { classID: "brushGroup" } } } },
      null,
      { v: { Brsh: { v: { classID: "computedBrush" } } } },
    ];
    BrushPresetUtil.sanitizeBrushPresetList(list);
    assert.equal(list.length, 1);
  });

  it("normalize toggles tip-dynamics defaults", () => {
    const withDyn = BrushPresetUtil.deepClone(BrushPresetUtil.getDefaultBrushDescriptor());
    withDyn.useTipDynamics = { t: "bool", v: true };
    BrushPresetUtil.brushDescriptorSchema.normalize(withDyn);
    assert.equal(withDyn.minimumDiameter != null, true);
    assert.equal(withDyn.minimumDiameter.v.val, 0);
    withDyn.useTipDynamics.v = false;
    BrushPresetUtil.brushDescriptorSchema.normalize(withDyn);
    assert.equal(withDyn.minimumDiameter == null, true);
  });

  it("validate fills missing tip flipX/flipY defaults", () => {
    const abrShaped = BrushPresetUtil.deepClone(BrushPresetUtil.getDefaultBrushDescriptor());
    abrShaped.Brsh.v.Dmtr = abrShaped.Brsh.v.diameter;
    delete abrShaped.Brsh.v.flipX;
    delete abrShaped.Brsh.v.flipY;
    const logs = [];
    const oldLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    BrushPresetUtil.brushDescriptorSchema.validate(abrShaped);
    console.log = oldLog;
    assert.equal(abrShaped.Brsh.v.flipX.v, false);
    assert.equal(abrShaped.Brsh.v.flipY.v, false);
    assert.equal(logs[0], "Extra parameter diameter");
  });

  it("deepClone isolates mutations", () => {
    const def = BrushPresetUtil.getDefaultBrushDescriptor();
    const clone = BrushPresetUtil.deepClone(def);
    clone.Nm.v = "mutated";
    assert.equal(def.Nm.v, "Custom Brush");
  });
});
