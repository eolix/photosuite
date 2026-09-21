/**
 * BrushPanel / BrushEffectRow family (enable toggles, tip inputs, dispatch).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { iconImgHtml } from "../../../src/assets/icon-registry.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let BrushPanel;
let BrushEffectRow;
let BrushTipShapeRow;
let BrushTipDynamicsRow;
let BrushScatterRow;
let BrushColorDynamicsRow;
let BrushPresetUtil;
let PopupTypes;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ BrushPresetUtil } = await import("../../../src/features/brush/brush-presets.js"));
  ({
    BrushPanel,
    BrushEffectRow,
    BrushTipShapeRow,
    BrushTipDynamicsRow,
    BrushScatterRow,
    BrushColorDynamicsRow,
  } = await import("../../../src/ui/panels/brush-panel.js"));
});

function tipBrush(classID) {
  return {
    classID,
    diameter: { t: "UntF", v: { type: "#Pxl", val: 20 } },
    Angl: { t: "UntF", v: { type: "#Ang", val: 15 } },
    Rndn: { t: "UntF", v: { type: "#Prc", val: 80 } },
    Hrdn: { t: "UntF", v: { type: "#Prc", val: 60 } },
    Spcn: { t: "UntF", v: { type: "#Prc", val: 25 } },
  };
}

function minimalBrushSettings() {
  const descriptor = {
    classID: "brush",
    Nm: { t: "TEXT", v: "Sample" },
    Brsh: { t: "Objc", v: tipBrush("computedBrush") },
    useTipDynamics: { t: "bool", v: false },
    useScatter: { t: "bool", v: false },
    useColorDynamics: { t: "bool", v: false },
    usePaintDynamics: { t: "bool", v: false },
    useTexture: { t: "bool", v: false },
    useBrushSize: { t: "bool", v: false },
    useBrushPose: { t: "bool", v: false },
    Wtdg: { t: "bool", v: false },
    Nose: { t: "bool", v: false },
    Rpt: { t: "bool", v: false },
    dualBrush: {
      t: "Objc",
      v: { classID: "dualBrush", useDualBrush: { t: "bool", v: false } },
    },
    brushGroup: {
      t: "Objc",
      v: { classID: "brushGroup", useBrushGroup: { t: "bool", v: false } },
    },
  };
  BrushPresetUtil.brushDescriptorSchema.normalize(descriptor);
  return descriptor;
}

describe("ui/panels/brush-panel.js", () => {
  it("exports surface and base row defaults", () => {
    assert.equal(typeof BrushPanel, "function");
    assert.equal(typeof BrushEffectRow, "function");
    assert.equal(typeof BrushTipShapeRow, "function");
    assert.equal(typeof BrushTipDynamicsRow, "function");
    assert.equal(typeof BrushScatterRow, "function");
    assert.equal(typeof BrushColorDynamicsRow, "function");
    const base = new BrushEffectRow("panels.brush");
    assert.equal(base.isPressed(), false);
    assert.equal(base.labelKey, "panels.brush");
    assert.equal(base.brushSettings, null);
  });

  it("tip shape is always pressed and wires five inputs", () => {
    const tip = new BrushTipShapeRow();
    assert.equal(tip.isPressed(), true);
    assert.equal(tip.inputs.length, 5);
    assert.equal(tip.labelKey, "brushAndMessages.tipShape");
  });

  it("tip dynamics enable normalizes and exposes jitter fields", () => {
    const row = new BrushTipDynamicsRow();
    const settings = minimalBrushSettings();
    row.setValue(settings);
    assert.equal(row.isPressed(), false);
    row.setEffectEnabled(true);
    assert.equal(row.isPressed(), true);
    assert.equal(row.brushSettings.useTipDynamics.v, true);
    assert.ok(row.brushSettings.szVr);
    assert.ok(row.brushSettings.minimumDiameter);
    row.brushSettings.szVr.v.jitter.v.val = 33;
    row.onSizeJitterChange({ target: { getValue: () => 33 } });
    assert.equal(row.brushSettings.szVr.v.jitter.v.val, 33);
  });

  it("scatter enable normalizes count fields", () => {
    const row = new BrushScatterRow();
    row.setValue(minimalBrushSettings());
    row.setEffectEnabled(true);
    assert.equal(row.isPressed(), true);
    assert.equal(row.brushSettings.useScatter.v, true);
    assert.ok(row.brushSettings.Cnt);
    assert.ok(row.brushSettings.scatterDynamics);
    row.onCountChange({ target: { getValue: () => 4 } });
    assert.equal(row.brushSettings.Cnt.v, 4);
  });

  it("color dynamics enable wires H / Strt / Brgh", () => {
    const row = new BrushColorDynamicsRow();
    row.setValue(minimalBrushSettings());
    row.setEffectEnabled(true);
    assert.equal(row.isPressed(), true);
    row.onHueJitterChange({ target: { getValue: () => 12 } });
    row.onSatJitterChange({ target: { getValue: () => 7 } });
    row.onBrightnessJitterChange({ target: { getValue: () => 3 } });
    assert.equal(row.brushSettings.H.v.val, 12);
    assert.equal(row.brushSettings.Strt.v.val, 7);
    assert.equal(row.brushSettings.Brgh.v.val, 3);
  });

  it("tip size change mutates Brsh.diameter", () => {
    const tip = new BrushTipShapeRow();
    tip.brushSettings = minimalBrushSettings();
    tip.onSizeChange({ target: { getValue: () => 48 } });
    assert.equal(tip.brushSettings.Brsh.v.diameter.v.val, 48);
  });

  it("onBrushChange dispatches openResourcePresetPopup with brushPreset", () => {
    const panel = Object.create(BrushPanel.prototype);
    const tip = new BrushTipShapeRow();
    tip.brushSettings = minimalBrushSettings();
    panel.effectRows = [tip];
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onBrushChange({ currentTarget: tip });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.dispatchKind, UiCommand.openResourcePresetPopup);
    assert.equal(events[0].data.popupType, PopupTypes.SCRIPTS);
    assert.equal(events[0].data.brushPreset.Brsh.v.diameter.v.val, 20);
    assert.notEqual(events[0].data.brushPreset, tip.brushSettings);
  });
});
