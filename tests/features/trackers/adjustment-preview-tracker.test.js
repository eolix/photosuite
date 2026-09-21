/**
 * Golden + post-register behavior for AdjustmentPreviewTracker.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";

installBrowserGlobals();

let TrackerRegistry;
let Rect;

before(async () => {
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  await import("../../../src/engine/layer-system.js");
  ({ Rect } = await import("../../../src/core/math/rect.js"));
});

function sampleHistogram() {
  const hist = new Array(256).fill(0);
  hist[10] = 50;
  hist[20] = 50;
  hist[200] = 50;
  hist[240] = 50;
  return hist;
}

describe("features/trackers/adjustment-preview-tracker.js", () => {
  it("buildLevelsStopFromHistogram matches the expected stops", () => {
    const Tracker = TrackerRegistry.AdjustmentPreviewTracker;
    assert.deepEqual(
      Tracker.buildLevelsStopFromHistogram(sampleHistogram(), 40, 200, false),
      [10, 240, 0, 255, 100],
    );
    assert.deepEqual(
      Tracker.buildLevelsStopFromHistogram(sampleHistogram(), 160, 200, true),
      [2, 248, 0, 255, 100],
    );
    const flat = new Array(256).fill(1);
    assert.deepEqual(
      Tracker.buildLevelsStopFromHistogram(flat, 10, 256, false),
      [9, 246, 0, 255, 100],
    );
  });

  it("getBottomLayerBackgroundColor packs RGB planar visibility", () => {
    const Tracker = TrackerRegistry.AdjustmentPreviewTracker;
    assert.equal(
      Tracker.getBottomLayerBackgroundColor({
        pathViewport: { channelVisibility: [1, 0, 0] },
      }),
      255,
    );
    assert.equal(
      Tracker.getBottomLayerBackgroundColor({
        pathViewport: { channelVisibility: [1, 1, 1] },
      }),
      16777215,
    );
  });

  it("instantiates after registry attach and redo writes adjustmentDescAfter", () => {
    const tracker = new TrackerRegistry.AdjustmentPreviewTracker();
    const layer = { add: { levl: { v: "before" } } };
    const layerState = {
      layers: [layer],
      dirty: false,
      markDirty() {
        this.dirty = true;
      },
    };
    tracker.redo(
      {
        layerIndex: 0,
        adjustmentDescBefore: { v: "before" },
        adjustmentDescAfter: { v: "after" },
      },
      layerState,
    );
    assert.deepEqual(layer.add.levl, { v: "after" });
    assert.equal(layerState.dirty, true);
    tracker.undo(
      {
        layerIndex: 0,
        adjustmentDescBefore: { v: "before" },
        adjustmentDescAfter: { v: "after" },
      },
      layerState,
    );
    assert.deepEqual(layer.add.levl, { v: "before" });
  });

  it("captureLayerPixelSnapshots clips the dirty rect to the document selection", () => {
    const Tracker = TrackerRegistry.AdjustmentPreviewTracker;
    const layerRect = new Rect(0, 0, 40, 40);
    const layer = {
      pixelContent: 0,
      rect: layerRect,
      buffer: allocBuffer(layerRect.area() * 4),
    };
    const selectionRect = new Rect(8, 8, 10, 10);
    const selectionChannel = allocBuffer(selectionRect.area());
    selectionChannel.fill(255);
    const layerState = {
      width: 40,
      height: 40,
      layers: [layer],
      selectedLayerIndices: [0],
      activeChannels: [],
      extraChannels: [],
      selectionMask: { channel: selectionChannel, rect: selectionRect },
    };

    const [snapshot] = Tracker.captureLayerPixelSnapshots(layerState, false);
    assert.deepEqual(
      [snapshot.dirtyRect.x, snapshot.dirtyRect.y, snapshot.dirtyRect.width, snapshot.dirtyRect.height],
      [8, 8, 10, 10],
    );
    assert.equal(snapshot.selectionMask.length, selectionRect.area());
    assert.equal(snapshot.selectionMask[0], 255);
  });

  it("captureLayerPixelSnapshots covers the whole layer with no selection", () => {
    const Tracker = TrackerRegistry.AdjustmentPreviewTracker;
    const layerRect = new Rect(0, 0, 40, 40);
    const layerState = {
      width: 40,
      height: 40,
      layers: [
        {
          pixelContent: 0,
          rect: layerRect,
          buffer: allocBuffer(layerRect.area() * 4),
        },
      ],
      selectedLayerIndices: [0],
      activeChannels: [],
      extraChannels: [],
      selectionMask: null,
    };

    const [snapshot] = Tracker.captureLayerPixelSnapshots(layerState, false);
    assert.equal(snapshot.dirtyRect.width, 40);
    assert.equal(snapshot.dirtyRect.height, 40);
    assert.equal(snapshot.selectionMask, undefined);
  });

  it("handleInput start with no selection is a no-op", () => {
    const tracker = new TrackerRegistry.AdjustmentPreviewTracker();
    assert.equal(
      tracker.handleInput({ actionKind: "start" }, {}, { selectedLayerIndices: [] }, {}, {}),
      undefined,
    );
  });
});
