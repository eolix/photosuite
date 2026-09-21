/**
 * Golden + instance dispatch for LayerEffectsTracker.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;
let Layer;
let Rect;

before(async () => {
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
});

function makeLayer(name) {
  return {
    name,
    add: {},
    pixelContent: 1,
    pathLayerActive: true,
    getName() {
      return this.name;
    },
    invalidate() {
      this.invalidated = true;
    },
    markDirty() {
      this.layerDirty = true;
    },
    rasterizeSmartObject() {
      this.rasterized = true;
    },
  };
}

describe("features/trackers/layer-effects-tracker.js", () => {
  it("handleInput remaps newLayerViaCopy to duplicateLayer when there is no selection mask", () => {
    const Tracker = TrackerRegistry.LayerEffectsTracker;
    const seen = [];
    Tracker.actionHandlers[Layer.duplicateLayer] = function () {
      seen.push("duplicateLayer");
    };
    Tracker.actionHandlers[Layer.newLayerViaCopy] = function () {
      seen.push("newLayerViaCopy");
    };
    const tracker = new Tracker();
    const doc = {
      layers: [makeLayer("A")],
      selectedLayerIndices: [0],
      selectionMask: null,
      stateChanged: false,
    };
    tracker.handleInput({ actionKind: Layer.newLayerViaCopy }, {}, doc, {}, {});
    assert.deepEqual(seen, ["duplicateLayer"]);
    assert.equal(doc.stateChanged, true);
    delete Tracker.actionHandlers[Layer.duplicateLayer];
    delete Tracker.actionHandlers[Layer.newLayerViaCopy];
  });

  it("copyContentFillToDescriptor clones solid Clr and stamps solidColorLayer", () => {
    const sourceFill = { Clr: { t: "Objc", v: { classID: "RGBC", Rd: { t: "doub", v: 12 } } } };
    const targetDescriptor = {};
    TrackerRegistry.LayerEffectsTracker.copyContentFillToDescriptor(sourceFill, targetDescriptor, 0);
    assert.equal(targetDescriptor.classID, "solidColorLayer");
    assert.equal(targetDescriptor.Clr.v.Rd.v, 12);
    targetDescriptor.Clr.v.Rd.v = 99;
    assert.equal(sourceFill.Clr.v.Rd.v, 12);
  });

  it("cloneMaskFromActiveMask copies selection channel bytes and zeros mask color", () => {
    const rect = new Rect(1, 2, 3, 4);
    const doc = {
      selectionMask: {
        channel: new Uint8Array([9, 8, 7]),
        rect,
      },
    };
    const clonedMask = TrackerRegistry.LayerEffectsTracker.cloneMaskFromActiveMask(doc);
    assert.equal(clonedMask.color, 0);
    assert.deepEqual(Array.from(clonedMask.channel), [9, 8, 7]);
    clonedMask.channel[0] = 1;
    assert.equal(doc.selectionMask.channel[0], 9);
    assert.equal(clonedMask.rect.x, 1);
    assert.equal(clonedMask.rect.width, 3);
    clonedMask.rect.x = 50;
    assert.equal(doc.selectionMask.rect.x, 1);
  });

  it("nextDuplicateLayerNameSuffix returns the max numeric suffix after the prefix", () => {
    const doc = {
      layers: [makeLayer("Copy 1"), makeLayer("Copy 4"), makeLayer("Other")],
    };
    assert.equal(TrackerRegistry.LayerEffectsTracker.nextDuplicateLayerNameSuffix(doc, "Copy "), 4);
  });

  it("getLayerBoundsForMask recenters when sourceDocSize differs from the document", () => {
    const maskContext = {
      sourceDocSize: { x: 10, y: 10 },
      rect: new Rect(0, 0, 4, 6),
    };
    const boundsRect = TrackerRegistry.LayerEffectsTracker.getLayerBoundsForMask(maskContext, {
      width: 20,
      height: 30,
    });
    assert.equal(boundsRect.x, 8);
    assert.equal(boundsRect.y, 12);
    assert.equal(boundsRect.width, 4);
    assert.equal(boundsRect.height, 6);
  });

  it("invertMaskChannel inverts color and marks the mask combine dirty", () => {
    const layer = makeLayer("M");
    const doc = {
      invalidated: null,
      invalidate(target) {
        this.invalidated = target;
      },
    };
    const mask = { color: 40, channel: new Uint8Array(4), maskCombineDirty: false };
    TrackerRegistry.LayerEffectsTracker.invertMaskChannel(doc, mask, layer);
    assert.equal(mask.color, 215);
    assert.equal(mask.maskCombineDirty, true);
    assert.equal(doc.invalidated, layer);
    assert.equal(layer.layerDirty, true);
  });

  it("undo dispatches undoHandlers and sets panelsDirty", () => {
    const Tracker = TrackerRegistry.LayerEffectsTracker;
    Tracker.undoHandlers.testUndoKind = function (historySnapshot, layerState) {
      layerState.sawUndo = historySnapshot.actionKind;
    };
    const tracker = new Tracker();
    const layer = makeLayer("A");
    const doc = {
      layers: [layer],
      stateChanged: false,
      panelsDirty: false,
    };
    tracker.undo({ actionKind: "testUndoKind", layerIndex: 0 }, doc);
    assert.equal(doc.sawUndo, "testUndoKind");
    assert.equal(doc.stateChanged, true);
    assert.equal(doc.panelsDirty, true);
    delete Tracker.undoHandlers.testUndoKind;
  });
});
