/**
 * panel-widgets pure helper goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let buildCubePresetPaths;
let orientationWireToIndex;
let indexToOrientationWire;
let formatZoomPercentLabel;
let resolveFrameAdvanceDelayMs;
let buildPanelTabRebuildCacheKey;
let computeHistogramBandScale;
let computeHistogramChannelMean;
let extractStylePresetLabel;
let ChannelModeSelect;
let ICCProfileButton;
let DisplayOptions;
let PanelWrapper;
let PanelTab;

before(async () => {
  ({
    buildCubePresetPaths,
    orientationWireToIndex,
    indexToOrientationWire,
    formatZoomPercentLabel,
    resolveFrameAdvanceDelayMs,
    buildPanelTabRebuildCacheKey,
    computeHistogramBandScale,
    computeHistogramChannelMean,
    extractStylePresetLabel,
    ChannelModeSelect,
    ICCProfileButton,
    DisplayOptions,
    PanelWrapper,
    PanelTab
  } = await import("../../../../src/ui/widgets/controls/panel-widgets.js"));
});

describe("ui/widgets/controls/panel-widgets.js", () => {
  it("buildCubePresetPaths golden", () => {
    var paths = buildCubePresetPaths();
    assert.equal(paths.length, 45);
    assert.equal(paths[0], "luts/BMPCC_4K.CUBE");
    assert.equal(paths[44], "luts/WonderW.CUBE");
  });

  it("orientation wire mapping goldens", () => {
    assert.equal(orientationWireToIndex("Hrzn"), 0);
    assert.equal(orientationWireToIndex("Vrtc"), 1);
    assert.equal(indexToOrientationWire(0), "Hrzn");
    assert.equal(indexToOrientationWire(1), "Vrtc");
  });

  it("formatZoomPercentLabel goldens", () => {
    assert.equal(formatZoomPercentLabel(0.5), "50.00%");
    assert.equal(formatZoomPercentLabel(1), "100%");
    assert.equal(formatZoomPercentLabel(2.345), "235%");
  });

  it("resolveFrameAdvanceDelayMs goldens", () => {
    assert.equal(resolveFrameAdvanceDelayMs("layer,0"), 16);
    assert.equal(resolveFrameAdvanceDelayMs("layer,100"), 100);
    assert.equal(resolveFrameAdvanceDelayMs(null), 30);
  });

  it("buildPanelTabRebuildCacheKey golden", () => {
    assert.equal(buildPanelTabRebuildCacheKey("PNG", true, false), "PNG true false");
  });

  it("histogram helper goldens", () => {
    assert.equal(computeHistogramBandScale(1000), 6);
    var bins = new Array(256).fill(0);
    bins[100] = 10;
    bins[200] = 10;
    assert.equal(computeHistogramChannelMean(bins, 20, true).toFixed(1), "50.0");
    assert.equal(computeHistogramChannelMean(bins, 20, false).toFixed(1), "150.0");
  });

  it("extractStylePresetLabel golden", () => {
    assert.equal(
      extractStylePresetLabel({ Nm: { v: "foo/bar/MyLook.CUBE" } }),
      "MyLook.CUBE"
    );
  });

  it("exports constructors", () => {
    assert.equal(typeof ChannelModeSelect, "function");
    assert.equal(typeof ICCProfileButton, "function");
    assert.equal(typeof DisplayOptions, "function");
    assert.equal(typeof PanelWrapper, "function");
    assert.equal(typeof PanelTab, "function");
    assert.equal(typeof ChannelModeSelect.drawHistogramBand, "function");
  });
});
