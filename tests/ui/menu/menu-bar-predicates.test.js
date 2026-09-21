/**
 * menu-bar-predicates resolveRowState + effectRows helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let menuWhenDocOpen;
let menuWhenHasLayerSelection;
let menuWhenHasSelection;
let menuWhenCanCopy;
let menuWhenCanCut;
let menuWhenCanPaste;
let normalizePanelId;
let findPanelInEffectRowsIndex;
let removePanelFromEffectRows;
let isPanelInEffectRows;
let menuWhenPanelVisible;
let menuWhenThemeSelected;

before(async () => {
  ({
    menuWhenDocOpen,
    menuWhenHasLayerSelection,
    menuWhenHasSelection,
    menuWhenCanCopy,
    menuWhenCanCut,
    menuWhenCanPaste,
    normalizePanelId,
    findPanelInEffectRowsIndex,
    removePanelFromEffectRows,
    isPanelInEffectRows,
    menuWhenPanelVisible,
    menuWhenThemeSelected,
  } = await import("../../../src/ui/menu/menu-bar-predicates.js"));
});

describe("ui/menu/menu-bar-predicates.js", () => {
  it("menuWhenDocOpen goldens", () => {
    assert.deepEqual(menuWhenDocOpen(null), { enabled: false });
    assert.deepEqual(menuWhenDocOpen({}), { enabled: true });
  });

  it("menuWhenHasLayerSelection goldens", () => {
    assert.deepEqual(menuWhenHasLayerSelection({ selectedLayerIndices: [] }), { enabled: false });
    assert.deepEqual(menuWhenHasLayerSelection({ selectedLayerIndices: [0] }), { enabled: true });
  });

  it("menuWhenHasSelection goldens", () => {
    assert.deepEqual(menuWhenHasSelection({ selectionMask: {} }), { enabled: true });
    assert.deepEqual(menuWhenHasSelection({ selectionMask: null }), { enabled: false });
  });

  it("menuWhenCanCopy delegates to doc open", () => {
    assert.deepEqual(menuWhenCanCopy({}), { enabled: true });
  });

  it("menuWhenCanCut gates on selection, mask, paths, and pixels", () => {
    const emptyDoc = {
      selectedLayerIndices: [0],
      selectionMask: null,
      getPaths() {
        return [[], []];
      },
      layers: [{ add: {}, pixelContent: 0, buffer: null }],
    };
    assert.deepEqual(menuWhenCanCut(emptyDoc, {}), { enabled: false });
    assert.deepEqual(menuWhenCanCut({ ...emptyDoc, selectionMask: {} }, {}), { enabled: true });
    assert.deepEqual(
      menuWhenCanCut({
        ...emptyDoc,
        getPaths() {
          return [[], [{ x: 0 }]];
        },
      }, {}),
      { enabled: true }
    );
    assert.deepEqual(
      menuWhenCanCut({
        ...emptyDoc,
        layers: [{ add: {}, pixelContent: 1, buffer: null }],
      }, {}),
      { enabled: true }
    );
  });

  it("menuWhenCanPaste goldens", () => {
    // With no appData to consult, Paste offers the system clipboard.
    assert.deepEqual(menuWhenCanPaste(null, {}), { enabled: true });
    assert.deepEqual(
      menuWhenCanPaste(null, { clipboardPixelPayload: {}, pathClipboard: null, lastClipboardTextImportUrl: null }),
      { enabled: true }
    );
    assert.deepEqual(
      menuWhenCanPaste(null, { lastClipboardTextImportUrl: "https://example.com/x.png" }),
      { enabled: true }
    );
  });

  it("effectRows helpers goldens", () => {
    assert.equal(normalizePanelId("2"), 2);
    assert.equal(normalizePanelId("plg_x"), "plg_x");
    assert.equal(findPanelInEffectRowsIndex("2", [0, "2", 13]), 1);
    assert.equal(isPanelInEffectRows(2, { effectRows: [0, 2] }), true);

    const appData = { effectRows: [0, 2, "101"] };
    assert.equal(removePanelFromEffectRows(99, appData), false);
    assert.deepEqual(appData.effectRows, [0, 2, "101"]);
    assert.equal(removePanelFromEffectRows(2, appData), true);
    assert.deepEqual(appData.effectRows, [0, "101"]);
  });

  it("menuWhenPanelVisible and menuWhenThemeSelected", () => {
    assert.deepEqual(menuWhenPanelVisible("2")(null, { effectRows: [2] }), { checked: true });
    assert.deepEqual(menuWhenThemeSelected(1)(null, { theme: 1 }), { checked: true });
    assert.deepEqual(menuWhenThemeSelected(1)(null, { theme: 0 }), { checked: false });
  });
});
