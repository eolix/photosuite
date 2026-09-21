/**
 * LayerEffectRow pointer helpers, applyEvent, shadow drag.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let LayerEffectRow;
let AppEvent;

before(async () => {
  ({ AppEvent } = await import("../../../src/core/event-bus.js"));
  ({ LayerEffectRow } = await import("../../../src/ui/panels/layer-effect-row.js"));
});

describe("ui/panels/layer-effect-row.js", () => {
  it("pointerYRatioInElement maps clientY within element bounds", () => {
    const el = { getBoundingClientRect: () => ({ top: 10, height: 20 }) };
    assert.equal(LayerEffectRow.pointerYRatioInElement({ clientY: 10 }, el), 0);
    assert.equal(LayerEffectRow.pointerYRatioInElement({ clientY: 30 }, el), 1);
  });

  it("fieldListsByEffectClass exposes expected DrSh field count", () => {
    assert.equal(LayerEffectRow.fieldListsByEffectClass.DrSh.length, 12);
    assert.equal(LayerEffectRow.fieldListsByEffectClass.bops[0], "blOptions");
  });

  it("applyEvent updates inline descriptor and dispatches widgetSelect", () => {
    const row = Object.create(LayerEffectRow.prototype);
    row.isInlineForm = true;
    row.effectDescriptor = { enab: { v: false } };
    const events = [];
    row.dispatch = (evt) => events.push(evt.type);
    row.applyEvent({ descriptorKey: "enab", value: true });
    assert.equal(row.effectDescriptor.enab.v, true);
    assert.deepEqual(events, ["widgetSelect"]);
  });

  it("applyEvent dispatches changeprop for dialog rows", () => {
    const row = Object.create(LayerEffectRow.prototype);
    row.isInlineForm = false;
    row.effectDescriptor = { Opct: { v: { type: "#Prc", val: 50 } } };
    row.parent = { data: { layerIndex: 2 } };
    row.effectPathIndices = [1, 0];
    const events = [];
    row.dispatch = (evt) => events.push(`${evt.type}:${evt.data?.actionKind ?? ""}`);
    row.applyEvent({ descriptorKey: "Opct", value: { type: "#Prc", val: 75 } });
    assert.deepEqual(row.effectDescriptor.Opct.v, { type: "#Prc", val: 75 });
    assert.deepEqual(events, ["documentAction:changeprop", "afterchange:"]);
  });

  it("onMouseMove adjusts shadow distance and angle from pointer delta", () => {
    const row = Object.create(LayerEffectRow.prototype);
    row.effectClassId = "DrSh";
    row.dragStartPointer = { x: 0, y: 0 };
    row.dragStartDescriptor = { Dstn: { v: { val: 10 } } };
    row.dragStartAngleValue = { oc: 0 };
    row.widgets = {
      Dstn: { setValue(value) { this._distance = value; } },
      lagl: { setValue(_value, _alt, _silent) { this._angle = _value; } },
    };
    row.onMouseMove({ pathViewport: { zoomScale: 1 } }, null, null, null, { x: 3, y: 4 });
    assert.equal(row.widgets.Dstn._distance, 8.06225774829855);
    assert.equal(row.widgets.lagl._angle, 29.744881296942225);
  });

  it("enableEffectOnSelect enables disabled effect via applyEvent", () => {
    const row = Object.create(LayerEffectRow.prototype);
    row.widgets = { enab: { getValue: () => false } };
    const payloads = [];
    row.applyEvent = (payload) => payloads.push(payload);
    row.enableEffectOnSelect();
    assert.deepEqual(payloads, [{ descriptorKey: "enab", value: true }]);
  });
});
