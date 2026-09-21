/**
 * panning the preview in the fullscreen filter dialogs.
 *
 * A PanelWrapper either pans on drag or hands the drag to its host, never both.
 * Camera Raw and Lens Correction want the hand by default and the drag only
 * while a tool that samples or measures is selected, so this checks both states
 * rather than only that the flag exists.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

/** The shared stub lacks the few element bits panel chrome touches. */
function installPreviewDom() {
  const context = new Proxy({}, {
    get: (target, key) => {
      if (key === "canvas") return { width: 400, height: 300 };
      if (key === "measureText") return () => ({ width: 10 });
      if (key === "getImageData" || key === "createImageData") {
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      }
      if (key === "createLinearGradient" || key === "createPattern") {
        return () => ({ addColorStop() {} });
      }
      return typeof key === "string" && key in target ? target[key] : () => {};
    },
    set: () => true,
  });
  const createElement = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === "canvas") element.getContext = () => context;
    element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
    if (!element.dataset) element.dataset = {};
    if (element.style && typeof element.style.setProperty !== "function") {
      element.style.setProperty = () => {};
    }
    return element;
  };
  const sample = createElement("div");
  if (!sample.querySelector) {
    const elementProto = Object.getPrototypeOf(sample);
    Object.defineProperty(elementProto, "querySelector", { value: () => null, enumerable: false });
    Object.defineProperty(elementProto, "querySelectorAll", { value: () => [], enumerable: false });
  }
}

let FilterParameterPanel;
let Rect;

before(async () => {
  installPreviewDom();
  await import("../../../src/ui/filter-panels/filter-parameter-panel.js");
  await import("../../../src/ui/filter-panels/camera-raw-panel.js");
  await import("../../../src/ui/filter-panels/lens-correction-panel.js");
  ({ FilterParameterPanel } = await import("../../../src/ui/filter-panels/filter-parameter-panel.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
});

/** Drag the preview by (60, 40) and report where the pan ended up. */
function dragPreview(view) {
  view.canvasEl.width = 400;
  view.canvasEl.height = 300;
  // An image larger than the viewport, so there is somewhere to pan to.
  view.frameSources = [{ rect: new Rect(0, 0, 2000, 1500), data: new ArrayBuffer(4) }];
  view.panZoomState.viewportRect = new Rect(0, 0, 400, 300);
  view.panZoomState.zoomScale = 1;
  view.panZoomState.panOffset.setXY(0, 0);
  const at = (x, y) => ({
    target: view.canvasEl, currentTarget: view.canvasEl, clientX: x, clientY: y, detail: 1,
  });
  view.onDragStart(at(200, 150));
  view.onDrag(at(260, 190));
  return { x: view.panZoomState.panOffset.x, y: view.panZoomState.panOffset.y };
}

describe("ui/filter-panels preview panning", () => {
  it("Camera Raw pans on drag, and yields to the white balance eyedropper", () => {
    const panel = new FilterParameterPanel.cameraRaw();
    assert.deepEqual(dragPreview(panel.view), { x: 60, y: 40 }, "the hand should pan the preview");
    panel.setEyedropperActive(true);
    assert.deepEqual(dragPreview(panel.view), { x: 0, y: 0 }, "the armed eyedropper takes the drag");
    panel.setEyedropperActive(false);
    assert.deepEqual(dragPreview(panel.view), { x: 60, y: 40 }, "and panning comes back");
  });

  it("Lens Correction pans on drag, and yields to Straighten", () => {
    const panel = new FilterParameterPanel.LnCr();
    assert.deepEqual(dragPreview(panel.view), { x: 60, y: 40 }, "the hand should pan the preview");
    const selectTool = (toolId) => panel.onToolbarDispatch({
      data: { dispatchKind: UiCommand.setActiveToolPanelMode, routingChannel: toolId },
    });
    selectTool(1);
    assert.deepEqual(dragPreview(panel.view), { x: 0, y: 0 }, "Straighten takes the drag");
    selectTool(2);
    assert.deepEqual(dragPreview(panel.view), { x: 60, y: 40 }, "the hand pans again");
  });

  it("Lens Correction has no zoom tool; the preview's own zoom bar does that", () => {
    const panel = new FilterParameterPanel.LnCr();
    const toolNames = panel.toolbarSpec.toolbarGroups.map((group) => group[0].tool.name);
    assert.equal(toolNames.length, 3);
    assert.ok(!toolNames.some((name) => /zoom/i.test(name)), toolNames.join(", "));
  });
});
