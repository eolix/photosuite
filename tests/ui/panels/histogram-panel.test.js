/**
 * HistogramPanel empty/redraw path + transparent-bin padding goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { isInDOM } from "../../../src/core/dom.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";

installBrowserGlobals();

let HistogramPanel;
let ThemeConfig;

before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ ThemeConfig } = await import("../../../src/ui/config/theme-config.js"));
  ({ HistogramPanel } = await import("../../../src/ui/panels/histogram-panel.js"));
});

describe("ui/panels/histogram-panel.js", () => {
  it("exports HistogramPanel", () => {
    assert.equal(typeof HistogramPanel, "function");
  });

  it("redraw with no doc sets empty histogram", () => {
    const panel = Object.create(HistogramPanel.prototype);
    panel.panelBody = { parentNode: document };
    const setValues = [];
    panel.channelSelect = {
      setValue: (...args) => setValues.push(args),
    };
    panel.activeDoc = null;
    panel.redraw();
    assert.equal(setValues.length, 1);
    assert.equal(setValues[0].length, 1);
    const hist = setValues[0][0];
    assert.equal(hist.length, 6);
    assert.equal(hist[0].length, 256);
  });

  it("redraw with no selection pads transparent bins", () => {
    const panel = Object.create(HistogramPanel.prototype);
    panel.panelBody = { parentNode: document };
    const setValues = [];
    panel.channelSelect = {
      setValue: (...args) => setValues.push(args),
    };
    // 2x2 opaque white-ish buffer via getRasterData
    const pixels = allocBuffer(2 * 2 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 200;
      pixels[i + 1] = 100;
      pixels[i + 2] = 50;
      pixels[i + 3] = 255;
    }
    panel.activeDoc = {
      selectedLayerIndices: [0],
      width: 2,
      height: 2,
      selectionMask: null,
      getRasterData: () => pixels,
    };
    panel.redraw();
    const [hist, area] = setValues[0];
    assert.equal(area, 4);
    // Fully opaque: hist[5] should equal area after compute; pad adds 0
    assert.equal(hist[5], 4);
    assert.ok(hist[0][200] >= 1 || hist[0].some((v) => v > 0));
  });

  it("onUpdate applies theme text color to histogram fill", () => {
    const panel = Object.create(HistogramPanel.prototype);
    let lastColor = null;
    panel.channelSelect = {
      setHistogramFillColor: (c) => {
        lastColor = c;
      },
    };
    const themeName = Object.keys(ThemeConfig.themes)[0];
    const expected = ThemeConfig.themes[themeName]["--text-color"];
    panel.onUpdate({ theme: themeName }, null);
    assert.equal(lastColor, expected);
  });
});
