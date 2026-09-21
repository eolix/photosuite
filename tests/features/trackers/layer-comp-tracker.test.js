/**
 * Golden + post-register behavior for LayerCompTracker.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;

before(async () => {
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
});

function sampleCompList() {
  return {
    list: {
      v: [
        { v: { compID: { v: 10 }, Nm: { v: "A" }, capturedInfo: { v: 7 } } },
        { v: { compID: { v: 20 }, Nm: { v: "B" }, capturedInfo: { v: 3 } } },
      ],
    },
    lastAppliedComp: { t: "long", v: 10 },
  };
}

describe("features/trackers/layer-comp-tracker.js", () => {
  it("findCompIndexById locates comp entries by compID", () => {
    const Tracker = TrackerRegistry.LayerCompTracker;
    const comps = sampleCompList();
    assert.equal(Tracker.findCompIndexById(comps, 10), 0);
    assert.equal(Tracker.findCompIndexById(comps, 20), 1);
    assert.equal(Tracker.findCompIndexById(comps, 99), -1);
  });

  it("offsetDescriptorPoint shifts Hrzn/Vrtc descriptor values", () => {
    const Tracker = TrackerRegistry.LayerCompTracker;
    const point = { v: { Hrzn: { v: 5 }, Vrtc: { v: 10 } } };
    Tracker.offsetDescriptorPoint(point, 3, -2);
    assert.equal(point.v.Hrzn.v, 8);
    assert.equal(point.v.Vrtc.v, 8);
  });

  it("normalizeCompLayerSettings merges sparse entries and fills defaults", () => {
    const Tracker = TrackerRegistry.LayerCompTracker;
    const cmls = {
      layerSettings: {
        v: [
          { v: { compList: { v: [{ v: 1 }] }, enab: { t: "bool", v: true } } },
          {
            v: {
              Ofst: {
                t: "Objc",
                v: { classID: "null", Hrzn: { t: "long", v: 1 }, Vrtc: { t: "long", v: 2 } },
              },
            },
          },
        ],
      },
    };
    Tracker.normalizeCompLayerSettings(cmls);
    assert.equal(cmls.layerSettings.v.length, 2);
    assert.equal(cmls.layerSettings.v[0].v.enab.v, true);
    assert.equal(cmls.layerSettings.v[1].v.Ofst.v.Hrzn.v, 1);
    assert.equal(cmls.layerSettings.v[1].v.enab.v, true);
  });

  it("actionHandlers.delLC removes comp and clears lastAppliedComp when active", () => {
    const Tracker = TrackerRegistry.LayerCompTracker;
    const comps = sampleCompList();
    const ctx = {
      compEvent: { idx: 10 },
      layerState: { layerComps: comps },
      layerCompsAfter: JSON.parse(JSON.stringify(comps)),
      historyLabel: null,
    };
    Tracker.actionHandlers.delLC(ctx);
    assert.equal(ctx.layerCompsAfter.list.v.length, 1);
    assert.equal(ctx.layerCompsAfter.lastAppliedComp, undefined);
    assert.equal(ctx.historyLabel, "Delete Layer Comp");
  });

  it("actionHandlers.editLC renames comp and toggles capturedInfo flag bits", () => {
    const Tracker = TrackerRegistry.LayerCompTracker;
    const comps = sampleCompList();
    const ctx = {
      compEvent: { idx: 10, newName: "Renamed", capturedFlagIndex: 1 },
      layerState: { layerComps: comps },
      layerCompsAfter: JSON.parse(JSON.stringify(comps)),
      historyLabel: null,
    };
    Tracker.actionHandlers.editLC(ctx);
    assert.equal(ctx.layerCompsAfter.list.v[0].v.Nm.v, "Renamed");
    assert.equal(ctx.layerCompsAfter.list.v[0].v.capturedInfo.v, 5);
    assert.equal(ctx.historyLabel, "Layer Comp properties");
  });

  it("actionHandlers.setLC clears lastAppliedComp when switching to default", () => {
    const Tracker = TrackerRegistry.LayerCompTracker;
    const comps = sampleCompList();
    const ctx = {
      compEvent: { idx: 0 },
      layerState: { layerComps: comps, layerCompsModified: false },
      layerCompsAfter: JSON.parse(JSON.stringify(comps)),
      historyLabel: null,
      shouldRedraw: false,
    };
    Tracker.actionHandlers.setLC(ctx);
    assert.equal(ctx.layerCompsAfter.lastAppliedComp, undefined);
    assert.equal(ctx.shouldRedraw, true);
    assert.equal(ctx.historyLabel, "Switch Layer Comp");
  });

  it("handleInput setLC redo updates layerComps on layerState", () => {
    const tracker = new TrackerRegistry.LayerCompTracker();
    const layerState = {
      layerComps: sampleCompList(),
      layers: [],
      history: [],
      stateChanged: false,
      pushHistory(entry) {
        this.history.push(entry);
      },
      markDirty() {},
    };
    tracker.handleInput({ actionKind: "setLC", idx: 20 }, {}, layerState, {});
    assert.equal(layerState.layerComps.lastAppliedComp.v, 20);
    assert.equal(layerState.stateChanged, true);
    assert.equal(layerState.history.length, 1);
    tracker.undo(layerState.history[0].data, layerState);
    assert.equal(layerState.layerComps.lastAppliedComp.v, 10);
  });
});
