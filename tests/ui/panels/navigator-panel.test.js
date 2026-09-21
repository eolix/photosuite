/**
 * NavigatorPanel zoom slider + thumb pan math.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let NavigatorPanel;
let ZoomTool;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  const viewTools = await import("../../../src/document/tools/view-tools.js");
  ZoomTool = viewTools.ZoomTool;
  ({ NavigatorPanel } = await import("../../../src/ui/panels/navigator-panel.js"));
});

describe("ui/panels/navigator-panel.js", () => {
  it("zoomLevelFromSliderValue maps inverted step index", () => {
    const steps = ZoomTool.ZOOM_STEPS;
    assert.equal(NavigatorPanel.zoomLevelFromSliderValue(0), steps[steps.length - 1]);
    assert.equal(NavigatorPanel.zoomLevelFromSliderValue(steps.length - 1), steps[0]);
  });

  it("sliderValueFromZoomScale inverts findZoomStepIndex", () => {
    const scale = 2;
    const slider = NavigatorPanel.sliderValueFromZoomScale(scale);
    assert.equal(NavigatorPanel.zoomLevelFromSliderValue(slider), scale);
  });

  it("computePanOriginFromThumb scales by zoom and document size", () => {
    const doc = {
      width: 1000,
      height: 800,
      pathViewport: { zoomScale: 2 },
    };
    const panA = NavigatorPanel.computePanOriginFromThumb(doc, 0.25, 0);
    assert.equal(panA.x, -500);
    assert.ok(Math.abs(panA.y) < 1e-9);
    const panB = NavigatorPanel.computePanOriginFromThumb(doc, 0, 0.5);
    assert.ok(Math.abs(panB.x) < 1e-9);
    assert.equal(panB.y, -800);
  });

  it("onZoomChange dispatches zoom documentAction with S wire key", () => {
    const panel = Object.create(NavigatorPanel.prototype);
    const steps = ZoomTool.ZOOM_STEPS;
    panel.zoomSlider = { getValue: () => 0 };
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    NavigatorPanel.prototype.onZoomChange.call(panel, {});
    assert.equal(events.length, 1);
    assert.equal(events[0].data.actionKind, "zoom");
    assert.equal(events[0].data.S, steps[steps.length - 1]);
    assert.equal(events[0].routingChannel, ToolId.TOOL_ZOOM);
  });

  // Dragging the navigator thumb pans the view: the panel turns the thumb
  // position into a scroll origin and the hand tool writes it to the viewport.
  it("onThumbPointerMove pans the document viewport", () => {
    const panel = Object.create(NavigatorPanel.prototype);
    panel.offscreenCanvas = {
      width: 100,
      height: 80,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const panOffset = {
      x: 0,
      y: 0,
      setXY(x, y) {
        this.x = x;
        this.y = y;
      },
    };
    panel.activeDoc = {
      width: 1000,
      height: 800,
      pathViewport: {
        zoomScale: 2,
        panOffset,
        // The zoomed document is larger than the viewport, so the pan offset
        // is kept rather than snapped back to the origin.
        viewportRect: { width: 500, height: 400 },
      },
    };
    NavigatorPanel.prototype.onThumbPointerMove.call(panel, {
      clientX: 75,
      clientY: 40,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    });
    assert.equal(panOffset.x, -500);
    assert.ok(Math.abs(panOffset.y) < 1e-9);
    assert.equal(panel.activeDoc.panelsDirty, true);
  });

  // A document that fits entirely inside the viewport cannot be panned.
  it("onThumbPointerMove snaps back when the document fits the viewport", () => {
    const panel = Object.create(NavigatorPanel.prototype);
    panel.offscreenCanvas = {
      width: 100,
      height: 80,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const panOffset = {
      x: 7,
      y: 9,
      setXY(x, y) {
        this.x = x;
        this.y = y;
      },
    };
    panel.activeDoc = {
      width: 1000,
      height: 800,
      pathViewport: {
        zoomScale: 2,
        panOffset,
        viewportRect: { width: 5000, height: 4000 },
      },
    };
    NavigatorPanel.prototype.onThumbPointerMove.call(panel, {
      clientX: 75,
      clientY: 40,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    });
    assert.deepEqual({ x: panOffset.x, y: panOffset.y }, { x: 0, y: 0 });
  });
});
