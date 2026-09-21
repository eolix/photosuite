/**
 * PanelColumn (resize, panel stack, float overlay).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let PanelColumn;

before(async () => {
  ({ PanelColumn } = await import("../../../src/ui/layout/panel-column.js"));
});

function makeStubPanel(headerHeight) {
  const el = globalThis.document.createElement("div");
  const expandedBodyEl = globalThis.document.createElement("div");
  let lastResize = null;
  let expanded = true;
  return {
    el,
    expandedBodyEl,
    parent: null,
    lastResize: () => lastResize,
    on() {},
    removeEventListener() {},
    dismissSidebarButtonPopups() {},
    getPreferredSize() {
      return { x: 200, y: 100 };
    },
    getHeaderHeight() {
      return headerHeight;
    },
    resize(w, h) {
      lastResize = { w, h };
    },
    expand() {
      expanded = true;
    },
    collapse() {
      expanded = false;
    },
    isExpanded() {
      return expanded;
    },
  };
}

/** A pointer event core/dom.js getEventPos() resolves to (x, y) in the target. */
function pointerEventAt(x, y) {
  return {
    clientX: x,
    clientY: y,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  };
}

describe("ui/layout/panel-column.js", () => {
  it("constructor goldens", () => {
    const wide = new PanelColumn(380);
    assert.equal(wide.columnWidth, 380);
    assert.equal(wide.getPanelCount(), 0);
    assert.equal(wide.floatingContentEl, null);
    assert.equal(wide.resizeStartWidth, 0);
    assert.equal(wide.resizeDragStartPos, null);
    assert.equal(wide.isExpanded(), true);

    const narrow = new PanelColumn(265);
    assert.equal(narrow.columnWidth, 265);
  });

  it("addPanel / removePanelAt parenting", () => {
    const col = new PanelColumn(200);
    const panel = makeStubPanel(26);
    col.addPanel(panel);
    assert.equal(panel.parent, col);
    assert.equal(col.getPanelCount(), 1);
    col.removePanelAt(0);
    assert.equal(panel.parent, null);
    assert.equal(col.getPanelCount(), 0);
  });

  it("resize distributes height: headers then remainder", () => {
    const col = new PanelColumn(100);
    const a = makeStubPanel(30);
    const b = makeStubPanel(40);
    const c = makeStubPanel(20);
    col.addPanel(a);
    col.addPanel(b);
    col.addPanel(c);
    // 206 minus the 9px collapse-handle inset leaves 197 for the panels: the
    // first two take their header heights and the last takes what is left.
    col.resize(100, 206);
    assert.deepEqual(a.lastResize(), { w: 100, h: 30 });
    assert.deepEqual(b.lastResize(), { w: 100, h: 40 });
    assert.deepEqual(c.lastResize(), { w: 100, h: 127 });
  });

  it("resize when collapsed gives full height to each panel", () => {
    const col = new PanelColumn(100);
    col.expandedFlag = 0;
    const a = makeStubPanel(30);
    const b = makeStubPanel(40);
    col.addPanel(a);
    col.addPanel(b);
    // Collapsed, every panel gets the full inset-adjusted height.
    col.resize(80, 106);
    assert.deepEqual(a.lastResize(), { w: 100, h: 97 });
    assert.deepEqual(b.lastResize(), { w: 100, h: 97 });
  });

  it("onPanelShowFloat mounts overlay; hideFloatingPanel clears it", () => {
    const col = new PanelColumn(120);
    const panel = makeStubPanel(26);
    col.addPanel(panel);
    col.cachedWidth = 120;
    col.cachedHeight = 200;
    col.onPanelShowFloat({ currentTarget: panel });
    assert.equal(col.floatingContentEl, panel.expandedBodyEl);
    col.hideFloatingPanel();
    assert.equal(col.floatingContentEl, null);
  });

  it("onColumnResizeMove updates width and dispatches layout invalidate", () => {
    const col = new PanelColumn(200);
    const events = [];
    col.dispatch = (evt) => events.push(evt);
    col.resizeDragStartPos = { x: 100, y: 0 };
    col.resizeStartWidth = 200;
    col.onColumnResizeMove(pointerEventAt(80, 0));
    assert.equal(col.columnWidth, 220);
    assert.ok(
      events.some(
        (e) => e.data && e.data.dispatchKind === UiCommand.documentLayoutInvalidate
      )
    );
  });
});
