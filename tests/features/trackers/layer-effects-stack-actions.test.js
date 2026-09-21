/**
 * Stack-mutation handlers on LayerEffectsTracker after stack module attach.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;
let Layer;

before(async () => {
  await import("../../../src/features/trackers/layer-effects-stack-actions.js");
  await import("../../../src/features/trackers/layer-effects-history.js");
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});

function makeLayer(name) {
  return {
    name,
    add: { lsct: 0 },
    getName() {
      return this.name;
    },
  };
}

function makeDoc(layers) {
  return {
    layers,
    selectedLayerIndices: [0],
    history: [],
    historyIndex: -1,
    stateChanged: false,
    panelsDirty: false,
    dirty: false,
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
  };
}

describe("features/trackers/layer-effects-stack-actions.js", () => {
  it("deleteLayer replaces the stack and undo restores the deleted layer", () => {
    const keep = makeLayer("Keep");
    const drop = makeLayer("Drop");
    const doc = makeDoc([drop, keep]);
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    tracker.handleInput({ actionKind: Layer.deleteLayer }, {}, doc, {}, {});
    assert.equal(doc.layers.length, 1);
    assert.equal(doc.layers[0].name, "Keep");
    tracker.undo(doc.history[0].data, doc);
    assert.equal(doc.layers.length, 2);
    assert.equal(doc.layers[0].name, "Drop");
  });
});
