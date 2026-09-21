/**
 * BaseTool label / sidebar caption helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let BaseTool;
let computePanelTabLabelLayout;
let buildShortSidebarLabel;

before(async () => {
  ({
    BaseTool,
    computePanelTabLabelLayout,
    buildShortSidebarLabel
  } = await import("../../../src/ui/widgets/base-tool.js"));
});

describe("ui/widgets/base-tool.js", () => {
  it("computePanelTabLabelLayout truncates at width 0 (22 chars)", () => {
    const long = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const layout = computePanelTabLabelLayout(long, 0);
    assert.equal(layout.maxChars, 22);
    assert.equal(layout.truncate, true);
    assert.equal(layout.displayText, "ABCDEFGHIJKLMNOPQRST");
  });

  it("buildShortSidebarLabel goldens", () => {
    assert.equal(buildShortSidebarLabel("Layer Comps"), "LaC");
    assert.equal(buildShortSidebarLabel("Info"), "Inf");
    assert.equal(buildShortSidebarLabel("\u2e00xx"), "\u2e00");
  });

  it("exposes stable PanelId wire values", () => {
    assert.equal(BaseTool.PanelId.LAYERS, "2");
    assert.equal(BaseTool.PanelId.CSS, "6");
    assert.equal(BaseTool.PanelId.WEB_IMAGES, "101");
  });

  it("exports BaseTool and InlineRenameInput", () => {
    assert.equal(typeof BaseTool, "function");
    assert.equal(typeof BaseTool.InlineRenameInput, "function");
  });
});
