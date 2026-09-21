/**
 * ToolPresetsPanel sync gates and setToolId on resize.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolPresetsPanel;
let PopupTypes;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ ToolPresetsPanel } = await import("../../../src/ui/panels/tool-presets-panel.js"));
});

describe("ui/panels/tool-presets-panel.js", () => {
  it("shouldSyncToolPresets accepts ALL and TOOL_PRESETS only", () => {
    assert.equal(ToolPresetsPanel.shouldSyncToolPresets(PopupTypes.ALL), true);
    assert.equal(ToolPresetsPanel.shouldSyncToolPresets(PopupTypes.TOOL_PRESETS), true);
    assert.equal(ToolPresetsPanel.shouldSyncToolPresets(PopupTypes.COLOR_CHANGE), false);
  });

  it("onUpdate stores doc and setPresets when TOOL_PRESETS", () => {
    const panel = Object.create(ToolPresetsPanel.prototype);
    const calls = [];
    panel.presetBtn = { setPresets: (p) => calls.push(p) };
    const doc = { toolPresets: [{ name: "a" }] };
    ToolPresetsPanel.prototype.onUpdate.call(panel, doc, PopupTypes.TOOL_PRESETS);
    assert.equal(panel.doc, doc);
    assert.deepEqual(calls, [doc.toolPresets]);
  });

  it("onUpdate skips setPresets for unrelated popup types", () => {
    const panel = Object.create(ToolPresetsPanel.prototype);
    const calls = [];
    panel.presetBtn = { setPresets: (p) => calls.push(p) };
    ToolPresetsPanel.prototype.onUpdate.call(panel, { toolPresets: [] }, PopupTypes.COLOR_CHANGE);
    assert.equal(calls.length, 0);
  });

  it("refresh setPresets from panel.doc.toolPresets", () => {
    const panel = Object.create(ToolPresetsPanel.prototype);
    const calls = [];
    panel.doc = { toolPresets: [{ name: "b" }] };
    panel.presetBtn = { setPresets: (p) => calls.push(p) };
    ToolPresetsPanel.prototype.refresh.call(panel);
    assert.deepEqual(calls, [panel.doc.toolPresets]);
  });

  it("resize calls setToolId with activeToolId", () => {
    const panel = Object.create(ToolPresetsPanel.prototype);
    const calls = [];
    panel.doc = { activeToolId: 42 };
    panel.presetBtn = { setToolId: (id) => calls.push(id) };
    ToolPresetsPanel.prototype.resize.call(panel, 100, 200);
    assert.deepEqual(calls, [42]);
  });
});
