/**
 * RightSidebar layout helpers + registry lookup (lazy registry).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

/** Canvas 2d stub; webgl returns null so LayerSystem skips GPU init on import. */
function installCanvasStubs() {
  const fake2d = {
    getImageData(_x, _y, w, h) {
      const width = Math.max(1, w | 0);
      const height = Math.max(1, h | 0);
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    },
    putImageData() {},
    drawImage() {},
    fillRect() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    arc() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    rotate() {},
    setTransform() {},
    transform() {},
    rect() {},
    clip() {},
    measureText() {
      return { width: 0 };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    canvas: { width: 100, height: 100 },
  };
  const prev = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = function (tag) {
    const el = prev(tag);
    el.width = 256;
    el.height = 256;
    el.getContext = (type) => (type === "2d" || type == null ? fake2d : null);
    el.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
    });
    el.toDataURL = () => "data:,";
    return el;
  };
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext(type) {
      return type === "2d" ? fake2d : null;
    }
  };
}

installCanvasStubs();

let RightSidebar;
let resolveHostColumnIndex;
let shouldCollapseSecondaryColumn;
let serializeLayoutRowKey;
let findRegistryEntryByPanelId;

before(async () => {
  ({
    RightSidebar,
    resolveHostColumnIndex,
    shouldCollapseSecondaryColumn,
    serializeLayoutRowKey,
    findRegistryEntryByPanelId,
  } = await import("../../../src/ui/layout/right-sidebar.js"));
});

describe("ui/layout/right-sidebar.js", () => {
  it("resolveHostColumnIndex packs slots by width", () => {
    assert.equal(resolveHostColumnIndex(0, 800), 1);
    assert.equal(resolveHostColumnIndex(1, 800), 1);
    assert.equal(resolveHostColumnIndex(2, 800), 0);
    assert.equal(resolveHostColumnIndex(5, 800), 0);
    assert.equal(resolveHostColumnIndex(2, 499), 1);
    assert.equal(resolveHostColumnIndex(5, 400), 1);
  });

  it("shouldCollapseSecondaryColumn goldens", () => {
    assert.equal(shouldCollapseSecondaryColumn(699, { compact: false }, true), true);
    assert.equal(shouldCollapseSecondaryColumn(700, { compact: false }, true), false);
    assert.equal(shouldCollapseSecondaryColumn(900, { compact: true }, true), true);
    assert.equal(shouldCollapseSecondaryColumn(900, { compact: false }, false), true);
    assert.equal(shouldCollapseSecondaryColumn(900, { compact: false }, true), false);
  });

  it("serializeLayoutRowKey matches JSON.stringify", () => {
    assert.equal(serializeLayoutRowKey(["2", "13"]), '["2","13"]');
    assert.equal(serializeLayoutRowKey([]), "[]");
  });

  it("findRegistryEntryByPanelId + prototype lookup", () => {
    const entries = [
      { panel: { panelId: "2" }, columnIndex: 1 },
      { panel: { panelId: "13" }, columnIndex: 0 },
    ];
    assert.equal(findRegistryEntryByPanelId(entries, "13").columnIndex, 0);
    assert.equal(findRegistryEntryByPanelId(entries, "99"), undefined);

    const sidebar = Object.create(RightSidebar.prototype);
    sidebar.panelEntries = entries;
    assert.equal(sidebar.findEntryByPanelId("2").columnIndex, 1);
  });

  it("redraw no-ops without doc or zero host width", () => {
    const sidebar = Object.create(RightSidebar.prototype);
    sidebar.doc = null;
    sidebar.hostWidth = 800;
    sidebar.cachedLayoutRowKey = "keep";
    sidebar.redraw();
    assert.equal(sidebar.cachedLayoutRowKey, "keep");

    sidebar.doc = { effectRows: ["2"], compact: false };
    sidebar.hostWidth = 0;
    sidebar.redraw();
    assert.equal(sidebar.cachedLayoutRowKey, "keep");
  });
});
