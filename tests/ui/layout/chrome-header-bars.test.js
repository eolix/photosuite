/**
 * ConfirmBar + LinkBar (merged chrome-header-bars).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ConfirmBar;
let LinkBar;

before(async () => {
  ({ ConfirmBar, LinkBar } = await import("../../../src/ui/layout/chrome-header-bars.js"));
});

describe("ui/layout/chrome-header-bars.js", () => {
  it("ConfirmBar mounts an option panel", () => {
    const bar = new ConfirmBar();
    assert.ok(bar.el);
    const optionPanel = {
      el: globalThis.document.createElement("div"),
      parent: null,
    };
    bar.setOptionPanel(optionPanel);
    assert.equal(optionPanel.parent, bar);
  });

  it("LinkBar resize / scroll-content goldens", () => {
    const horizontal = new LinkBar(true);
    assert.equal(horizontal.isHorizontal, true);
    assert.equal(horizontal.isUiReady, true);
    horizontal.resize(200, 40);
    assert.equal(horizontal.viewportWidth, 200);
    assert.equal(horizontal.viewportHeight, 40);

    const contentEl = globalThis.document.createElement("div");
    horizontal.setScrollContent(contentEl);
    assert.equal(horizontal.scrollContent, contentEl);
    assert.equal(contentEl.style.position, "absolute");
    assert.equal(String(contentEl.style.left), "0");
    // Floored at the viewport so the bars inside it, and the rules they draw,
    // reach the window edge even when their content is narrower.
    assert.equal(contentEl.style.minWidth, "100%");

    const vertical = new LinkBar(false);
    assert.equal(vertical.isHorizontal, false);
    const vContent = globalThis.document.createElement("div");
    vertical.setScrollContent(vContent);
    assert.equal(String(vContent.style.top), "0");
    assert.equal(vContent.style.minHeight, "100%");
  });
});
