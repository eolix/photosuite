/**
 * PluginToolPanel input helpers and composite color statics (via install).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let PluginToolPanel;
let LayerSystem;
let KeyboardHandler;

before(async () => {
  ({ PluginToolPanel } = await import("../../../src/ui/panels/plugin-tool-panel.js"));
  ({ LayerSystem } = await import("../../../src/engine/layer-system.js"));
  ({ KeyboardHandler } = await import("../../../src/core/keyboard-handler.js"));
});

describe("ui/panels/plugin-tool-panel.js", () => {
  it("shouldIgnoreTouchWhenNoTouch is true for touch+NoTouch", () => {
    window.__kb = { isPressed: (key) => key === KeyboardHandler.NoTouch };
    assert.equal(PluginToolPanel.shouldIgnoreTouchWhenNoTouch({ pointerType: "touch" }), true);
  });

  it("shouldIgnoreTouchWhenNoTouch is false for mouse", () => {
    window.__kb = { isPressed: () => true };
    assert.equal(PluginToolPanel.shouldIgnoreTouchWhenNoTouch({ pointerType: "mouse" }), false);
  });

  it("onGestureEvent uses WebKit gestureEvt.scale (not PSD Scl)", () => {
    const panel = Object.create(PluginToolPanel.prototype);
    panel.gestureBaselineScale = 1;
    panel.activePointers = [];
    panel.lastPointerState = { x: 0, y: 0, isDown: false };
    const dispatched = [];
    panel.dispatch = (evt) => dispatched.push(evt);
    panel.assignPointerStateToMouseEvent = function(sourceEvt, mouseEvt) {
      mouseEvt.pointerState = { x: 0, y: 0, isDown: false };
    };
    panel.onGestureEvent({ type: "gesturestart", scale: 2 });
    assert.equal(panel.gestureBaselineScale, 2);
    panel.onGestureEvent({ type: "gesturechange", scale: 1 });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].action, "scroll");
    assert.equal(dispatched[0].scrollDelta.y, 50);
  });

  it("install attaches composite and overlay draw methods", () => {
    assert.equal(typeof PluginToolPanel.prototype.drawWebglComposite, "function");
    assert.equal(typeof PluginToolPanel.prototype.drawCanvas2dComposite, "function");
    assert.equal(typeof PluginToolPanel.prototype.drawActiveMaskOverlays, "function");
    assert.equal(typeof PluginToolPanel.prototype.appendPathToCanvasContext, "function");
    assert.equal(typeof PluginToolPanel.unitRgbaToCssString, "function");
  });
});
