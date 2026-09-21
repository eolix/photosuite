import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let CanvasViewport;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ CanvasViewport } = await import("../../../src/document/model/canvas-viewport.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/model/canvas-viewport.js", () => {
  it("screenToDocPoint and docToScreenPoint round-trip at zoom 1", () => {
    const viewport = new CanvasViewport({ width: 100, height: 50 });
    viewport.viewportRect = new Rect(0, 0, 200, 200);
    viewport.zoomScale = 1;
    viewport.panOffset = new Point(0, 0);

    const screenX = 80;
    const screenY = 90;
    const docPoint = viewport.screenToDocPoint(screenX, screenY);
    const backToScreen = viewport.docToScreenPoint(docPoint.x, docPoint.y);
    assert.equal(backToScreen.x, screenX);
    assert.equal(backToScreen.y, screenY);
  });

  it("getViewMatrix honors gesture zoom when requested", () => {
    const viewport = new CanvasViewport({ width: 100, height: 100 });
    viewport.viewportRect = new Rect(0, 0, 100, 100);
    viewport.zoomScale = 2;
    viewport.gestureZoomScale = 1;
    viewport.gesturePanOffset = new Point(5, 5);

    const defaultMatrix = viewport.getViewMatrix(false);
    const gestureMatrix = viewport.getViewMatrix(true);
    assert.notEqual(defaultMatrix.a, gestureMatrix.a);
  });
});
