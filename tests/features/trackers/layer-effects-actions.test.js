/**
 * Golden + post-register behavior for LayerEffectsTracker action/history tables.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;
let Layer;

before(async () => {
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});

function makeLayer(overrides = {}) {
  const layer = {
    name: "Layer 1",
    blendMode: "norm",
    Opct: 255,
    add: { iOpa: 255, lspf: 0, lsct: 0, lnsr: undefined, lclr: 0 },
    pixelContent: 0,
    pathLayerActive: false,
    renderCache: { dirty: false },
    isGroup() {
      return false;
    },
    getName() {
      return this.name;
    },
    setName(name) {
      this.name = name;
    },
    isVisible() {
      return this._visible !== false;
    },
    setVisible(visible) {
      this._visible = visible;
    },
    markDirty() {},
    invalidate() {},
    ...overrides,
  };
  return layer;
}

function makeDoc(layers, extra = {}) {
  const doc = {
    layers,
    selectedLayerIndices: extra.selectedLayerIndices || [0],
    history: [],
    historyIndex: -1,
    stateChanged: false,
    panelsDirty: false,
    dirty: false,
    pathViewport: { channelVisibility: [1, 1, 1] },
    selectedWorkPaths: [],
    selectedLayerPaths: null,
    markDirty() {
      this.dirty = true;
    },
    getLastHistoryEntry() {
      return this.history.length ? this.history[this.history.length - 1] : null;
    },
    pushHistory(entry) {
      this.history.push(entry);
      this.historyIndex = this.history.length - 1;
    },
    setLayers(nextLayers) {
      this.layers = nextLayers;
    },
    resolveLayerSelection() {
      return this.selectedLayerIndices.slice();
    },
    expandParentGroups() {},
    ...extra,
  };
  return doc;
}

function idleKeyboard() {
  return { isPressed() { return false; } };
}

describe("features/trackers/layer-effects-actions.js", () => {
  it("opacity byte 128 serializes to 50 percent on the action descriptor", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const layer = makeLayer({ Opct: 200 });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.setLayerOpacity, layerPropertyValue: 128 },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.Opct, 128);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].data.opacityActionDescriptor.T.v.Opct.v.val, 50);
    assert.equal(doc.history[0].data.layerPropertyValue, 128);
  });

  it("setFillOpacity redo/undo swaps iOpa after registry attach", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const layer = makeLayer({ add: { iOpa: 255, lspf: 0, lsct: 0 } });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.setFillOpacity, layerPropertyValue: 64 },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.add.iOpa, 64);
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.add.iOpa, 255);
    tracker.redo(doc.history[0].data, doc);
    assert.equal(layer.add.iOpa, 64);
  });

  it("toggleLayerLocks applies bit masks from toggle rows", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const layer = makeLayer({ add: { iOpa: 255, lspf: 0, lsct: 0 } });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      {
        actionKind: Layer.toggleLayerLocks,
        layerPropertyValue: [[true, false], [0, 1]],
      },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.add.lspf, 1);
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.add.lspf, 0);
  });

  it("renameLayer history tuple is [index, oldName, newName, lnsr, null]", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const layer = makeLayer({ name: "Old", add: { iOpa: 255, lspf: 0, lsct: 0, lnsr: "lrsn" } });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.renameLayer, name: "New" },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.name, "New");
    assert.deepEqual(doc.history[0].data.renameEntries, [[0, "Old", "New", "lrsn", null]]);
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.name, "Old");
    assert.equal(layer.add.lnsr, "lrsn");
  });

  it("setBlendMode writes psdCodes[index] onto the layer", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const layer = makeLayer();
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.setBlendMode, layerPropertyValue: 0 },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.blendMode, "norm");
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.blendMode, "norm");
  });
});
