/**
 * InfoPanel pixel sampling, dimension readout, pointer labels.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { isInDOM } from "../../../src/core/dom.js";

installBrowserGlobals();

let InfoPanel;

before(async () => {
  ({ InfoPanel } = await import("../../../src/ui/panels/info-panel.js"));
});

function makeRasterLayer(overrides = {}) {
  const raster = new Uint8ClampedArray(4 * 3 * 3);
  raster[(1 * 3 + 1) * 4 + 0] = 10;
  raster[(1 * 3 + 1) * 4 + 1] = 20;
  raster[(1 * 3 + 1) * 4 + 2] = 30;
  raster[(1 * 3 + 1) * 4 + 3] = 40;
  return {
    width: 3,
    height: 3,
    dpi: 72,
    pathViewport: { screenToDocPoint: (x, y) => ({ x, y }) },
    hasDirtyRect: () => false,
    getRasterData: () => raster,
    selectionMask: { rect: { width: 2, height: 1 } },
    ...overrides,
  };
}

function stubReadoutPanel(layer, doc) {
  const panel = Object.create(InfoPanel.prototype);
  panel.panelBody = { parentNode: document };
  panel.rgbaLabels = Array.from({ length: 4 }, () => ({
    setValue(value) {
      this._val = value;
    },
    getValue() {
      return this._val;
    },
  }));
  panel.xLabel = { setValue(v) { this._val = v; }, getValue() { return this._val; } };
  panel.yLabel = { setValue(v) { this._val = v; }, getValue() { return this._val; } };
  panel.widthLabel = { setValue(v) { this._val = v; }, getValue() { return this._val; } };
  panel.heightLabel = { setValue(v) { this._val = v; }, getValue() { return this._val; } };
  panel.activeLayer = layer;
  panel.doc = doc;
  return panel;
}

describe("ui/panels/info-panel.js", () => {
  it("samplePixelRgba reads in-bounds pixels and zeros outside", () => {
    const layer = makeRasterLayer();
    assert.deepEqual(
      InfoPanel.samplePixelRgba(layer, new Point(1, 1)),
      { r: 10, g: 20, b: 30, a: 40 },
    );
    assert.deepEqual(
      InfoPanel.samplePixelRgba(layer, new Point(5, 5)),
      { r: 0, g: 0, b: 0, a: 0 },
    );
  });

  it("resolveMeasuredDimensions prefers overlay then selection mask", () => {
    const layer = makeRasterLayer();
    assert.deepEqual(InfoPanel.resolveMeasuredDimensions(layer), { width: 2, height: 1 });
    layer.pathViewport.dimensionOverlay = { width: -5, height: 7 };
    assert.deepEqual(InfoPanel.resolveMeasuredDimensions(layer), { width: -5, height: 7 });
  });

  it("onMouseMove updates rgba and axis labels", () => {
    const layer = makeRasterLayer({
      pathViewport: { screenToDocPoint: () => ({ x: 1.7, y: 1.2 }) },
    });
    const appData = { prefs: { AppWindow: 0 } };
    const panel = stubReadoutPanel(layer, appData);
    InfoPanel.prototype.onMouseMove.call(panel, layer, null, appData, null, { x: 0, y: 0, isDown: false });
    assert.deepEqual(
      panel.rgbaLabels.map((label) => label.getValue()),
      ["R: 10", "G: 20", "B: 30", "A: 40"],
    );
    assert.equal(panel.xLabel.getValue(), "X: 1");
    assert.equal(panel.yLabel.getValue(), "Y: 1");
    assert.equal(panel.widthLabel.getValue(), "p: 2");
    assert.equal(panel.heightLabel.getValue(), "p: 1");
  });

  it("updateSize formats overlay dimensions", () => {
    const layer = makeRasterLayer({
      pathViewport: {
        screenToDocPoint: () => ({ x: 0, y: 0 }),
        dimensionOverlay: { width: -5, height: 7 },
      },
    });
    const panel = stubReadoutPanel(layer, { prefs: { AppWindow: 0 } });
    InfoPanel.prototype.updateSize.call(panel);
    assert.equal(panel.widthLabel.getValue(), "p: 5");
    assert.equal(panel.heightLabel.getValue(), "p: 7");
  });
});
