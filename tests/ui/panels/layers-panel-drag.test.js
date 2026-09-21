/**
 * layers panel drag helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let readLayerDragPayload;
let layerPanelEventYRatioInElement;
let layerPanelDragState;

before(async () => {
  ({
    readLayerDragPayload,
    layerPanelEventYRatioInElement,
    layerPanelDragState,
  } = await import("../../../src/ui/panels/layers-panel-drag.js"));
});

describe("ui/panels/layers-panel-drag.js", () => {
  it("readLayerDragPayload prefers Text then text/plain", () => {
    assert.equal(
      readLayerDragPayload({ getData: (type) => (type === "Text" ? "payload" : "") }),
      "payload",
    );
    assert.equal(
      readLayerDragPayload({ getData: (type) => (type === "text/plain" ? "plain" : "") }),
      "plain",
    );
    assert.equal(readLayerDragPayload(null), "");
  });


  it("layerPanelEventYRatioInElement maps pointer Y within element bounds", () => {
    const el = { getBoundingClientRect: () => ({ top: 20, height: 40 }) };
    assert.equal(layerPanelEventYRatioInElement({ clientY: 20 }, el), 0);
    assert.equal(layerPanelEventYRatioInElement({ clientY: 60 }, el), 1);
  });
});
