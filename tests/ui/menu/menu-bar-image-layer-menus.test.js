/**
 * Image/Layer menu builders.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = globalThis.SmartFilterBase || {};

let buildImageMenu;
let TrackerRegistry;
let buildLayerMenu;

before(async () => {
  ({ TrackerRegistry } = await import(
    "../../../src/features/trackers/tracker-registry.js"
  ));
  TrackerRegistry.LayerEffectsTracker = TrackerRegistry.LayerEffectsTracker || {
    copyContentFillToDescriptor() {},
  };
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
  ({ buildImageMenu, buildLayerMenu } = await import(
    "../../../src/ui/menu/menu-bar-image-layer-menus.js"
  ));
});

describe("ui/menu/menu-bar-image-layer-menus.js", () => {
  it("buildImageMenu includes adjustments and cropbysel without aiF", () => {
    const imageMenu = buildImageMenu();
    assert.equal(imageMenu.name, "topMenu.image");
    assert.equal(imageMenu.items.length, imageMenu.menuActions.length);
    const cropAction = imageMenu.menuActions.find(
      (action) => action.payload && action.payload.actionKind === "cropbysel"
    );
    assert.ok(cropAction);
    assert.equal("aiF" in cropAction.payload, false);
  });

  it("Layer > New offers via-copy and via-cut, each wired to its own action", () => {
    const layerMenu = buildLayerMenu();
    const newRowIndex = layerMenu.items.findIndex((item) => item.name === "clipboard.new");
    const newRow = layerMenu.items[newRowIndex];
    const newActions = layerMenu.menuActions[newRowIndex];

    // items and menuActions are index-parallel, and that holds inside `sub` too:
    // a row added to one array without the other silently mis-fires every row below it.
    assert.equal(newRow.sub.length, newActions.sub.length);
    assert.deepEqual(
      newRow.sub.map((item) => item.name),
      ["topMenu.layer", "topMenu.folder", "layer.layerViaCopy", "layer.layerViaCut"]
    );
    assert.deepEqual(
      newActions.sub.map((action) => action.payload.actionKind),
      ["newLayer", "newFolder", "newLayerViaCopy", "newLayerViaCut"]
    );
  });

  it("Layer via Cut needs a selection, and takes Shift with the via-copy shortcut", () => {
    const layerMenu = buildLayerMenu();
    const newRow = layerMenu.items.find((item) => item.name === "clipboard.new");
    const viaCopy = newRow.sub.find((item) => item.name === "layer.layerViaCopy");
    const viaCut = newRow.sub.find((item) => item.name === "layer.layerViaCut");

    // Via Copy falls back to duplicating the layer when nothing is selected, so it
    // stays enabled; Via Cut has no such fallback and is gated on a selection.
    assert.equal(viaCopy.resolveRowState({ selectedLayerIndices: [0], selectionMask: null }).enabled, true);
    assert.equal(viaCut.resolveRowState({ selectedLayerIndices: [0], selectionMask: null }).enabled, false);
    assert.equal(viaCut.resolveRowState({ selectedLayerIndices: [0], selectionMask: {} }).enabled, true);
    assert.equal(viaCut.shortcut.length, viaCopy.shortcut.length + 1);
  });

  it("buildLayerMenu includes Smart Object stack-mode stats submenu", () => {
    const layerMenu = buildLayerMenu();
    assert.equal(layerMenu.name, "topMenu.layer");
    assert.equal(layerMenu.items.length, layerMenu.menuActions.length);
    const smartObject = layerMenu.items.find((item) => item.name === "Smart Object");
    assert.ok(smartObject);
    assert.ok(smartObject.sub);
    const stackMode = smartObject.sub.find((item) => item.name === "layer.smartObject.stackMode");
    assert.equal(stackMode.sub.length, 9);
  });
});
