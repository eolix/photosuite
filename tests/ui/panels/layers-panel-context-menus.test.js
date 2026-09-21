/**
 * Layers-panel context menus: every row menu is installed on the panel, and the
 * per-row `resolveRowState` predicates gate entries off the selected layer's
 * PSD descriptor keys (TySh for text, placedData for smart objects, lmfx for
 * effects), which is what greys out the right-click entries in the UI.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { iconImgHtml } from "../../../src/assets/icon-registry.js";

installBrowserGlobals();
// Adjustment-layer rows ask SmartFilterBase which adjustments open a dialog.
globalThis.SmartFilterBase = globalThis.SmartFilterBase || {};

let installLayersPanelContextMenus;
let TrackerRegistry;
let ShapeToolBase;

before(async () => {
  ({ ShapeToolBase } = await import("../../../src/document/tools/shape-tools.js"));
  ({ TrackerRegistry } = await import(
    "../../../src/features/trackers/tracker-registry.js"
  ));
  TrackerRegistry.LayerEffectsTracker = TrackerRegistry.LayerEffectsTracker || {
    copyContentFillToDescriptor() {},
  };
  // Fill-layer rows build shape actions through ShapeToolBase.
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/pen-path-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  await import("../../../src/document/tools/crop-tools.js");
  await import("../../../src/document/tools/retouch-tools.js");
  await import("../../../src/document/tools/shape-tools.js");
  await import("../../../src/document/tools/view-tools.js");
  await import("../../../src/document/tools/move-tools.js");
  await import("../../../src/document/tools/text-tools.js");
  await import("../../../src/document/transform/transform-tools.js");
  // Menu rows render icon <img> tags through iconImgHtml, which
  // reads the real icon registry off globalThis.
  await import("../../../src/assets/icon-registry.js");
  ({ installLayersPanelContextMenus } = await import(
    "../../../src/ui/panels/layers-panel-context-menus.js"
  ));
});

/** A DocumentModel stand-in holding one selected layer with the given `add` keys. */
function docModelWithSelectedLayer(add = {}, { isGroup = false } = {}) {
  return {
    selectedLayerIndices: [0],
    layers: [{ add, isGroup: () => isGroup }],
  };
}

/** The row state a menu item reports for a given document, or null if unguarded. */
function rowStateFor(menu, itemName, docModel) {
  const item = menu.menuItemDescriptors.find((entry) => entry.name === itemName);
  assert.ok(item, `no menu item named ${itemName}`);
  return item.resolveRowState ? item.resolveRowState(docModel) : null;
}

describe("ui/panels/layers-panel-context-menus.js", () => {
  it("installs one InputHandler per Layers-panel row type", () => {
    const panel = {};
    installLayersPanelContextMenus(panel);

    for (const menuName of [
      "placedLayerEffectsMenu", "layerRowContextMenu", "smartFilterMenu",
      "smartFilterItemMenu", "layerEffectsStackMenu", "layerEffectItemMenu",
      "rasterMaskMenu", "filterMaskMenu", "vectorMaskMenu",
      "adjustmentLayerMenu", "layerStyleMenu",
    ]) {
      const menu = panel[menuName];
      assert.ok(menu, `${menuName} was not installed`);
      assert.ok(
        Array.isArray(menu.menuItemDescriptors) && menu.menuItemDescriptors.length > 0,
        `${menuName} has no rows`,
      );
      // Items and actions are parallel arrays: choosing row i dispatches action i.
      assert.equal(
        menu.menuItemDescriptors.length,
        menu.menuActionDescriptors.length,
        `${menuName} row/action arrays disagree`,
      );
    }
  });

  it("enables Rasterise only for layers with rasterisable content", () => {
    const panel = {};
    installLayersPanelContextMenus(panel);
    const menu = panel.layerRowContextMenu;

    // TySh (text), SoCo (solid colour), GdFl (gradient), PtFl (pattern) and
    // placedData (smart object) each have pixels to bake down.
    for (const key of ["TySh", "SoCo", "GdFl", "PtFl", "placedData"]) {
      assert.equal(
        rowStateFor(menu, "layer.rasterise", docModelWithSelectedLayer({ [key]: {} })).enabled,
        true,
        `${key} layer should be rasterisable`,
      );
    }
    assert.equal(
      rowStateFor(menu, "layer.rasterise", docModelWithSelectedLayer({})).enabled,
      false,
      "a plain raster layer has nothing to rasterise",
    );
  });

  it("gates Rasterise Layer Style on lmfx and excludes groups", () => {
    const panel = {};
    installLayersPanelContextMenus(panel);
    const menu = panel.layerRowContextMenu;
    const item = "layer.rasteriseLayerStyle";

    assert.equal(rowStateFor(menu, item, docModelWithSelectedLayer({ lmfx: {} })).enabled, true);
    assert.equal(rowStateFor(menu, item, docModelWithSelectedLayer({})).enabled, false);
    assert.equal(
      rowStateFor(menu, item, docModelWithSelectedLayer({ lmfx: {} }, { isGroup: true })).enabled,
      false,
      "a group carrying effects still cannot be flattened from this row",
    );
  });

  it("gates Convert to Shape on a text layer and Smart Obj. via Copy on placedData", () => {
    const panel = {};
    installLayersPanelContextMenus(panel);
    const menu = panel.layerRowContextMenu;

    assert.equal(
      rowStateFor(menu, "layer.convertToShape", docModelWithSelectedLayer({ TySh: {} })).enabled, true);
    assert.equal(
      rowStateFor(menu, "layer.convertToShape", docModelWithSelectedLayer({})).enabled, false);

    assert.equal(
      rowStateFor(menu, "New Smart Obj. via Copy", docModelWithSelectedLayer({ placedData: {} })).enabled, true);
    assert.equal(
      rowStateFor(menu, "New Smart Obj. via Copy", docModelWithSelectedLayer({})).enabled, false);
  });
});
