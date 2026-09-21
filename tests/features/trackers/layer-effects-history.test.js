/**
 * Undo/redo tables on LayerEffectsTracker after history module attach.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;
let Layer;

before(async () => {
  await import("../../../src/features/trackers/layer-effects-history.js");
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});

describe("features/trackers/layer-effects-history.js", () => {
  it("setFillOpacity undo/redo swap iOpa on the target layer", () => {
    const layer = { add: { iOpa: 64 } };
    const doc = {
      layers: [layer],
      dirty: false,
      markDirty() {
        this.dirty = true;
      },
    };
    const snapshot = {
      actionKind: Layer.setFillOpacity,
      layerIndex: 0,
      fillOpacityBefore: 255,
      layerPropertyValue: 64,
    };
    const undo = TrackerRegistry.LayerEffectsTracker.undoHandlers[Layer.setFillOpacity];
    const redo = TrackerRegistry.LayerEffectsTracker.redoHandlers[Layer.setFillOpacity];
    undo(snapshot, doc, layer);
    assert.equal(layer.add.iOpa, 255);
    redo(snapshot, doc, layer);
    assert.equal(layer.add.iOpa, 64);
  });
});
