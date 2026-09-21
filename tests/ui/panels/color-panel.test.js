/**
 * ColorPanel swatch selection + wheel COLOR_CHANGE dispatch.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let ColorPanel;
let PopupTypes;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ ColorPanel } = await import("../../../src/ui/panels/color-panel.js"));
});

function makePanelStub() {
  const panel = Object.create(ColorPanel.prototype);
  panel.activeColorIndex = 0;
  panel.lastChangeTime = 0;
  panel.doc = null;
  panel.colorSwatches = [
    { el: { style: {} }, setPackedRgb() {} },
    { el: { style: {} }, setPackedRgb() {} },
  ];
  panel.colorWheel = {
    getValue: () => ({ h: 1, l: 0.5, O: 0 }),
    setValue() {},
  };
  panel.dispatch = () => {};
  return panel;
}

describe("ui/panels/color-panel.js", () => {
  it("exports ColorPanel", () => {
    assert.equal(typeof ColorPanel, "function");
  });

  it("swatch click updates activeColorIndex", () => {
    const panel = makePanelStub();
    panel.doc = { colorInt: 0xff0000, bgColor: 0x00ff00 };
    panel.lastChangeTime = Date.now();
    panel.onSwatchClick({ currentTarget: panel.colorSwatches[1] });
    assert.equal(panel.activeColorIndex, 1);
  });

  it("wheel change dispatches COLOR_CHANGE with packed value", () => {
    const panel = makePanelStub();
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onWheelChange({});
    assert.equal(events.length, 1);
    assert.equal(events[0].data.dispatchKind, UiCommand.openResourcePresetPopup);
    assert.equal(events[0].data.popupType, PopupTypes.COLOR_CHANGE);
    assert.equal(events[0].data.operation, 0);
    assert.equal(events[0].data.value, (255 << 16) | (128 << 8) | 0);
    assert.ok(panel.lastChangeTime > 0);
  });

  it("onUpdate redraws for COLOR_CHANGE and ALL", () => {
    const panel = makePanelStub();
    let redrawCount = 0;
    panel.redraw = () => {
      redrawCount++;
    };
    panel.onUpdate({ colorInt: 1, bgColor: 2 }, PopupTypes.BRUSHES);
    assert.equal(redrawCount, 0);
    panel.onUpdate({ colorInt: 1, bgColor: 2 }, PopupTypes.COLOR_CHANGE);
    panel.onUpdate({ colorInt: 1, bgColor: 2 }, PopupTypes.ALL);
    assert.equal(redrawCount, 2);
  });
});
