/**
 * PluginToolPanel overlay install + path append helper.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { clonePath } from "../../../src/engine/compositing/anti-alias.js";

installBrowserGlobals();

let installPluginToolOverlays;
let PluginToolPanel;

before(async () => {
  globalThis.Typr = {
    U: {
      pathToContext() {},
    },
  };
  ({ installPluginToolOverlays } = await import(
    "../../../src/ui/panels/plugin-tool-overlays.js"
  ));
  ({ PluginToolPanel } = await import("../../../src/ui/panels/plugin-tool-panel.js"));
  await import("../../../src/engine/layer-system.js");
});

describe("ui/panels/plugin-tool-overlays.js", () => {
  it("exports installPluginToolOverlays", () => {
    assert.equal(typeof installPluginToolOverlays, "function");
  });

  it("appendPathToCanvasContext begins a path and clones via antiAlias", () => {
    const calls = [];
    const canvasCtx = {
      beginPath() {
        calls.push("beginPath");
      },
    };
    const pathShape = { commands: ["M", "L"], coords: [0, 0, 10, 10] };
    PluginToolPanel.prototype.appendPathToCanvasContext.call({}, pathShape, null, canvasCtx);
    assert.deepEqual(calls, ["beginPath"]);
    assert.ok(clonePath(pathShape));
  });

  it("drawDocumentGrid sets strokeStyle from unit RGBA helper", () => {
    const strokeStyles = [];
    const canvasCtx = {
      strokeStyle: "",
      save() {},
      restore() {},
      rect() {},
      clip() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {
        strokeStyles.push(this.strokeStyle);
      },
    };
    const pluginDocument = {
      width: 100,
      height: 100,
      pathViewport: { zoomScale: 8 },
    };
    PluginToolPanel.prototype.drawDocumentGrid.call(
      {},
      pluginDocument,
      canvasCtx,
      10,
      10,
      1,
      0,
    );
    assert.equal(strokeStyles.length, 1);
    assert.equal(typeof strokeStyles[0], "string");
    assert.match(strokeStyles[0], /^rgba\(/);
  });
});
