/**
 * SwatchesPanel color pack/unpack and COLOR_CHANGE dispatch.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let SwatchesPanel;
let PopupTypes;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ SwatchesPanel } = await import("../../../src/ui/panels/swatches-panel.js"));
});

describe("ui/panels/swatches-panel.js", () => {
  it("packSwatchRgbChannels packs h/l/O into 0xRRGGBB", () => {
    assert.equal(SwatchesPanel.packSwatchRgbChannels({ h: 255, l: 128, O: 64 }), 0xff8040);
    assert.equal(SwatchesPanel.packSwatchRgbChannels({ h: 10.4, l: 20.6, O: 30.2 }), (10 << 16) | (21 << 8) | 30);
  });

  it("unpackPackedColorToSwatchValue restores channels and hex name", () => {
    const value = SwatchesPanel.unpackPackedColorToSwatchValue(0xff8040);
    assert.equal(value.h, 255);
    assert.equal(value.l, 128);
    assert.equal(value.O, 64);
    assert.match(value.name, /^Color #/);
  });

  it("onColorSelect from grid dispatches COLOR_CHANGE with the packed value", () => {
    const panel = Object.create(SwatchesPanel.prototype);
    panel.swatchGrid = { getValue: () => 0x112233 };
    panel.swatchPicker = { getValue: () => ({ h: 0, l: 0, O: 0 }) };
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    SwatchesPanel.prototype.onColorSelect.call(panel, { target: panel.swatchGrid });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, EventType.uiDispatch);
    assert.equal(events[0].data.popupType, PopupTypes.COLOR_CHANGE);
    assert.equal(events[0].data.value, 0x112233);
    assert.equal(events[0].data.operation, 0);
  });

  it("onColorSelect from picker packs rgb channels into value", () => {
    const panel = Object.create(SwatchesPanel.prototype);
    panel.swatchGrid = {};
    panel.swatchPicker = { getValue: () => ({ h: 1, l: 2, O: 3 }) };
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    SwatchesPanel.prototype.onColorSelect.call(panel, { target: panel.swatchPicker });
    assert.equal(events[0].data.value, (1 << 16) | (2 << 8) | 3);
  });
});
