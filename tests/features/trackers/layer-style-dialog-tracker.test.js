/**
 * Golden + instance behavior for LayerStyleDialogTracker.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;
let LayerEffectDefs;

before(async () => {
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ LayerEffectDefs } = await import("../../../src/document/formats/psd/effect-defs.js"));
});

function makeLayer(overrides = {}) {
  return {
    blendMode: "norm",
    Opct: 128,
    blendIfData: [0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255],
    add: { iOpa: 64, brst: [1, 1, 1], lmfx: null },
    renderCache: { dirty: false },
    isGroup() {
      return false;
    },
    ...overrides,
  };
}

function makeDoc(layers) {
  return {
    layers,
    selectedLayerIndices: [0],
    history: [],
    historyIndex: -1,
    dirty: false,
    stateChanged: false,
    rotation: 10,
    globalLight: 20,
    getRotationAngle() {
      return this.rotation;
    },
    getGlobalLightAngle() {
      return this.globalLight;
    },
    setRotationAngle(value) {
      this.rotation = value;
    },
    setGlobalLightAngle(value) {
      this.globalLight = value;
    },
    markDirty() {
      this.dirty = true;
    },
    pushHistory(entry) {
      this.history.push(entry);
      this.historyIndex = this.history.length - 1;
    },
    registerPattern() {},
    dispatch() {},
  };
}

describe("features/trackers/layer-style-dialog-tracker.js", () => {
  it("snapshotBlendingOptions encodes opacity bytes as percent UntF values", () => {
    const Tracker = TrackerRegistry.LayerStyleDialogTracker;
    const layer = makeLayer();
    const doc = makeDoc([layer]);
    const snap = Tracker.snapshotBlendingOptions(doc, layer);
    assert.equal(snap.lrMd.v, 0);
    assert.equal(snap.Opct.v.val, 50);
    assert.equal(snap.Opct.v.type, "#Prc");
    assert.equal(snap.iOpa.v.val, 25);
    assert.equal(snap.rotationAngle, 10);
    assert.equal(snap.globalLightAngle, 20);
    assert.equal(snap.isGroup, false);
  });

  it("applyBlendingSnapshot restores opacity and light angles from a snapshot", () => {
    const Tracker = TrackerRegistry.LayerStyleDialogTracker;
    const layer = makeLayer({ Opct: 255, add: { iOpa: 255, brst: [1, 1, 1] } });
    const doc = makeDoc([layer]);
    doc.rotation = 0;
    doc.globalLight = 0;
    Tracker.applyBlendingSnapshot(doc, layer, {
      lrMd: { v: 0 },
      Opct: { v: { type: "#Prc", val: 50 }, t: "UntF" },
      iOpa: { v: { type: "#Prc", val: 25 }, t: "UntF" },
      blIf: { v: [1, 2, 3, 4] },
      brst: { v: [0, 1, 0] },
      rotationAngle: 33,
      globalLightAngle: 44,
      isGroup: false,
    });
    assert.equal(layer.Opct, 128);
    assert.equal(layer.add.iOpa, 64);
    assert.deepEqual(layer.blendIfData, [1, 2, 3, 4]);
    assert.deepEqual(layer.add.brst, [0, 1, 0]);
    assert.equal(doc.rotation, 33);
    assert.equal(doc.globalLight, 44);
  });

  it("handleInput changeprop writes blending Opct and creates lmfx", () => {
    const tracker = new TrackerRegistry.LayerStyleDialogTracker();
    const layer = makeLayer();
    const doc = makeDoc([layer]);
    tracker.handleInput(
      {
        actionKind: "changeprop",
        layerIndex: 0,
        idx: 0,
        descriptorKey: "Opct",
        value: { type: "#Prc", val: 75 },
      },
      {},
      doc,
      {},
      { patternPresets: [] },
    );
    assert.ok(layer.add.lmfx);
    assert.equal(layer.add.lmfx[LayerEffectDefs.effectKeys[0]].t, "VlLs");
    assert.equal(layer.Opct, Math.round((75 * 255) / 100));
    assert.equal(layer.renderCache.dirty, true);
  });

  it("confirm pushes history and undo restores prior blending opacity", () => {
    const tracker = new TrackerRegistry.LayerStyleDialogTracker();
    const layer = makeLayer();
    const doc = makeDoc([layer]);
    tracker.handleInput(
      {
        actionKind: "changeprop",
        layerIndex: 0,
        idx: 0,
        descriptorKey: "Opct",
        value: { type: "#Prc", val: 75 },
      },
      {},
      doc,
      {},
      { patternPresets: [] },
    );
    const effectsBefore = tracker.effectsJsonBefore;
    tracker.handleInput({ actionKind: "confirm", layerIndex: 0 }, { dispatch() {} }, doc, {}, {});
    assert.equal(doc.history.length, 1);
    assert.deepEqual(doc.history[0].data.layerIndices, [0]);
    assert.equal(doc.history[0].data.effectsBeforeJson[0], effectsBefore);
    const blendingBefore = doc.history[0].data.blendingBeforeJson[0];
    layer.add.lmfx = { classID: "Lefx", masterFXSwitch: { t: "bool", v: true } };
    layer.Opct = 10;
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.add.lmfx == null, effectsBefore == null);
    assert.equal(layer.Opct, Math.round((JSON.parse(blendingBefore).Opct.v.val * 255) / 100));
  });

  it("st_movsingle swaps effect variants by moveDelta", () => {
    const tracker = new TrackerRegistry.LayerStyleDialogTracker();
    const layer = makeLayer();
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: "changeprop", layerIndex: 0, idx: 0, descriptorKey: "Opct", value: { type: "#Prc", val: 50 } },
      {},
      doc,
      {},
      { patternPresets: [] },
    );
    const effectKey = LayerEffectDefs.effectKeys[5];
    layer.add.lmfx[effectKey].v = [
      { t: "Objc", v: { tag: "A" } },
      { t: "Objc", v: { tag: "B" } },
    ];
    tracker.effectsJsonBefore = JSON.stringify(layer.add.lmfx);
    tracker.handleInput(
      {
        actionKind: "st_movsingle",
        layerIndex: 0,
        effectPathIndices: [5, 0],
        moveDelta: 1,
      },
      {},
      doc,
      {},
      { patternPresets: [] },
    );
    assert.equal(layer.add.lmfx[effectKey].v[0].v.tag, "B");
    assert.equal(layer.add.lmfx[effectKey].v[1].v.tag, "A");
  });
});
