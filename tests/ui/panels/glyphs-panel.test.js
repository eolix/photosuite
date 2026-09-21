/**
 * GlyphsPanel: the Unicode block table the category dropdown is built from,
 * the zoom that sizes grid cells, and the two ways clicking a cell reaches the
 * text tool — as a character, or as a raw glyph id when the font maps none.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let GlyphsPanel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  globalThis.Typr = globalThis.Typr || {
    U: {
      codeToGlyph: () => 0,
      glyphToPath: () => ({ crds: [] }),
      pathToContext: () => {},
    },
  };
  ({ GlyphsPanel } = await import("../../../src/ui/panels/glyphs-panel.js"));
});

/**
 * A panel with its grid state filled in but no DOM behind it. Glyph 1 maps to
 * "A", glyph 2 maps to nothing, glyph 3 maps to "B".
 */
function makePanelStub() {
  const panel = Object.create(GlyphsPanel.prototype);
  panel.atlasWidthCss = 290;
  panel.cellTargetCss = 45;
  panel.rowsPerPage = 4;
  panel.zoomOutBtn = {};
  panel.zoomInBtn = {};
  panel.blockDropdown = { getValue: () => 0 };
  panel.menuList = {
    getValue: () => 0,
    getLastMousePosition: () => ({ x: 10, y: 10 }),
  };
  panel.glyphsByBlock = [[1, 2, 3]];
  panel.glyphMeta = [
    { codePoints: [] },
    { codePoints: [65] },
    { codePoints: [] },
    { codePoints: [66] },
  ];
  panel.dispatch = () => {};
  panel.redraw = () => {};
  return panel;
}

describe("ui/panels/glyphs-panel.js", () => {
  it("UNICODE_BLOCKS goldens", () => {
    const blocks = GlyphsPanel.UNICODE_BLOCKS;
    assert.equal(blocks.length, 10);
    assert.equal(blocks[0].label, "All Glyphs");
    assert.equal(blocks[0].codePointRanges, undefined);
    assert.deepEqual(blocks[1].codePointRanges, [0, 127, 128, 143]);
    assert.deepEqual(blocks[9].codePointRanges, [9728, 10095, 127744, 129535]);
    assert.equal(blocks[5].label, "Greek");
  });

  it("columns divide the panel width by the target cell size", () => {
    const panel = makePanelStub();
    assert.equal(panel.getColumnCount(), 6);
    panel.cellTargetCss = 29;
    assert.equal(panel.getColumnCount(), 10);
  });

  it("zoom clamps the target cell size to 20..100", () => {
    const panel = makePanelStub();
    panel.cellTargetCss = 100;
    panel.onZoomClick({ target: panel.zoomInBtn });
    assert.equal(panel.cellTargetCss, 100);
    panel.cellTargetCss = 20;
    panel.onZoomClick({ target: panel.zoomOutBtn });
    assert.equal(panel.cellTargetCss, 20);
    panel.cellTargetCss = 50;
    panel.onZoomClick({ target: panel.zoomInBtn });
    assert.equal(panel.cellTargetCss, 60);
    panel.onZoomClick({ target: panel.zoomOutBtn });
    assert.equal(panel.cellTargetCss, 50);
  });

  it("a click resolves to the cell under the pointer", () => {
    const panel = makePanelStub();
    // Tests run at a device pixel ratio of 1, so cell device px == cell CSS px.
    const cellPx = panel.getCellSizePx();
    assert.equal(panel.resolveGridIndex(0, { x: 1, y: 1 }), 0);
    assert.equal(panel.resolveGridIndex(0, { x: cellPx + 1, y: 1 }), 1);
    assert.equal(panel.resolveGridIndex(0, { x: 1, y: cellPx + 1 }), panel.getColumnCount());
    // One sheet holds rowsPerPage rows, so sheet 1 starts that many rows down.
    assert.equal(
      panel.resolveGridIndex(1, { x: 1, y: 1 }),
      panel.rowsPerPage * panel.getColumnCount()
    );
    assert.equal(panel.resolveGridIndex(0, { x: -1, y: 1 }), -1);
    assert.equal(panel.resolveGridIndex(0, { x: 1, y: cellPx * 4 + 1 }), -1);
  });

  it("selecting a mapped glyph inserts its character", () => {
    const panel = makePanelStub();
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onGlyphSelect({});
    assert.equal(events.length, 1);
    assert.equal(events[0].routingChannel, ToolId.TOOL_TYPE);
    assert.equal(events[0].data.actionKind, "insertText");
    assert.equal(events[0].data.insertText, "A");
  });

  it("selecting an unmapped glyph inserts the glyph id instead", () => {
    const panel = makePanelStub();
    // Second cell of the first row: glyph 2, which no codepoint reaches.
    panel.menuList.getLastMousePosition = () => ({ x: panel.getCellSizePx() + 1, y: 1 });
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onGlyphSelect({});
    assert.equal(events.length, 1);
    assert.equal(events[0].data.actionKind, "insertGlyph");
    assert.equal(events[0].data.insertGlyphId, 2);
  });

  it("clicking past the last glyph of a block does nothing", () => {
    const panel = makePanelStub();
    panel.menuList.getLastMousePosition = () => ({ x: panel.getCellSizePx() * 3 + 1, y: 1 });
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onGlyphSelect({});
    assert.equal(events.length, 0);
  });
});
