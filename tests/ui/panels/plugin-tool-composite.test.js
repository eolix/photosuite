/**
 * PluginToolPanel composite color / WebGL blue-patch helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let PluginToolPanel;
let LayerSystem;
let installPluginToolComposite;

before(async () => {
  ({ installPluginToolComposite } = await import(
    "../../../src/ui/panels/plugin-tool-composite.js"
  ));
  ({ PluginToolPanel } = await import("../../../src/ui/panels/plugin-tool-panel.js"));
  ({ LayerSystem } = await import("../../../src/engine/layer-system.js"));
});

describe("ui/panels/plugin-tool-composite.js", () => {
  it("exports installPluginToolComposite", () => {
    assert.equal(typeof installPluginToolComposite, "function");
  });

  it("unitRgbaToCssString formats unit channels", () => {
    assert.equal(PluginToolPanel.unitRgbaToCssString([1, 0.5, 0.25, 1]), "rgba(255,127.5,63.75,1)");
  });

  it("unitRgbaToCssString forceMinBlue with webgl off keeps blue 0", () => {
    const prev = LayerSystem.webglEnabled;
    LayerSystem.webglEnabled = false;
    try {
      assert.equal(PluginToolPanel.unitRgbaToCssString([1, 0.5, 0, 1], true), "rgba(255,127.5,0,1)");
    } finally {
      LayerSystem.webglEnabled = prev;
    }
  });

  it("patchZeroBlueForWebglImageData bumps blue 0 to 3 when webgl on", () => {
    const prev = LayerSystem.webglEnabled;
    LayerSystem.webglEnabled = true;
    try {
      const pixels = new Uint8Array([10, 20, 0, 255, 1, 2, 5, 255]);
      PluginToolPanel.patchZeroBlueForWebglImageData(pixels);
      assert.equal(pixels[2], 3);
      assert.equal(pixels[6], 5);
    } finally {
      LayerSystem.webglEnabled = prev;
    }
  });

  it("psdColorToUnitRgba converts RGBC 128/64/32", () => {
    const rgba = PluginToolPanel.psdColorToUnitRgba({
      v: {
        classID: "RGBC",
        Rd: { t: "doub", v: 128 },
        Grn: { t: "doub", v: 64 },
        Bl: { t: "doub", v: 32 },
      },
    });
    assert.ok(Math.abs(rgba[0] - 128 / 255) < 1e-9);
    assert.ok(Math.abs(rgba[1] - 64 / 255) < 1e-9);
    assert.ok(Math.abs(rgba[2] - 32 / 255) < 1e-9);
    assert.equal(rgba[3], 1);
  });
});
