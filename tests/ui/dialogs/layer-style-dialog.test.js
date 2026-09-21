/**
 * Golden I/O for LayerStyleDialog menu builders.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = { brit: {}, levl: {} };

let LayerStyleDialog;

before(async () => {
  ({ LayerStyleDialog } = await import("../../../src/ui/dialogs/layer-style-dialog.js"));
});

describe("ui/dialogs/layer-style-dialog.js", () => {
  it("buildLayerEffectMenuItems matches goldens", () => {
    const items = LayerStyleDialog.buildLayerEffectMenuItems(false);
    assert.equal(items.length, 11);
    assert.equal(items[0].name, "layerEffects.blendingOptions");
    assert.equal(items[0].separatorAfter, true);
    assert.equal(items[items.length - 1].name, "layerEffects.dropShadow");
  });

  it("buildLayerEffectMenuActions matches goldens", () => {
    const actions = LayerStyleDialog.buildLayerEffectMenuActions(false);
    assert.equal(actions.length, 11);
    assert.equal(actions[0].payload.dialogRouteId, "layerstyle");
  });

  it("buildAdjustmentLayerMenuItems matches goldens", () => {
    const items = LayerStyleDialog.buildAdjustmentLayerMenuItems(false);
    assert.equal(items.length, 17);
  });

  it("buildAdjustmentLayerMenuActions matches goldens", () => {
    const actions = LayerStyleDialog.buildAdjustmentLayerMenuActions(false);
    assert.equal(actions.length, 17);
  });
});
