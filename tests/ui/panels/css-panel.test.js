/**
 * CSSPanel textarea formatting + OPEN_RECENT redraw gate.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { isInDOM } from "../../../src/core/dom.js";

installBrowserGlobals();

let CSSPanel;
let PopupTypes;
let CSS;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ CSS } = await import("../../../src/features/css-export/css.js"));
  ({ CSSPanel } = await import("../../../src/ui/panels/css-panel.js"));
});

describe("ui/panels/css-panel.js", () => {
  it("constructs a monospace textarea", () => {
    const panel = new CSSPanel();
    assert.ok(panel.cssArea);
    assert.equal(panel.activeDoc, null);
  });

  it("onUpdate redraws only for OPEN_RECENT", () => {
    const panel = new CSSPanel();
    let redrawCount = 0;
    panel.redraw = () => {
      redrawCount++;
    };
    panel.onUpdate({}, PopupTypes.ALL);
    panel.onUpdate({}, PopupTypes.COLOR_CHANGE);
    assert.equal(redrawCount, 0);
    panel.onUpdate({}, PopupTypes.OPEN_RECENT);
    assert.equal(redrawCount, 1);
  });

  it("open stores doc and redraws", () => {
    const panel = new CSSPanel();
    const doc = { selectedLayerIndices: [], layers: [] };
    let redrawCount = 0;
    panel.redraw = () => {
      redrawCount++;
    };
    panel.open(doc);
    assert.equal(panel.activeDoc, doc);
    assert.equal(redrawCount, 1);
  });

  it("redraw joins CSS rules with semicolon newlines", () => {
    const panel = new CSSPanel();
    document.body.appendChild(panel.panelBody);
    const original = CSS.generateLayerCSS;
    CSS.generateLayerCSS = () => ["color:red", "opacity:0.5"];
    try {
      panel.activeDoc = {
        selectedLayerIndices: [0],
        layers: [{ name: "Layer 0" }],
      };
      panel.redraw();
      assert.equal(panel.cssArea.value, "color:red;\nopacity:0.5;");
      CSS.generateLayerCSS = () => [];
      panel.redraw();
      assert.equal(panel.cssArea.value, "");
    } finally {
      CSS.generateLayerCSS = original;
    }
  });
});
