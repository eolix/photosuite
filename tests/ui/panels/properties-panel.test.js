/**
 * PropertiesPanel dimension helpers, live-shape detect, mask kind, dispatch.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let EventChannel;
let PropertiesPanel;
let DocumentModel;

before(async () => {
  ({ EventChannel } = await import("../../../src/document/model/tool-base.js"));
  globalThis.SmartFilterBase = globalThis.SmartFilterBase || {};
  ({ PropertiesPanel } = await import("../../../src/ui/panels/properties-panel.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
});

function stubDimensionFields(initial) {
  return [0, 1, 2, 3].map((idx) => {
    let value = initial ? initial[idx] : 0;
    return {
      setValue(next) {
        value = next;
      },
      getValue() {
        return value;
      },
    };
  });
}

describe("ui/panels/properties-panel.js", () => {
  it("setDimensionValues / getDimensionValues round-trip", () => {
    const fields = stubDimensionFields();
    PropertiesPanel.setDimensionValues(fields, [10, 20, 30, 40]);
    assert.deepEqual(PropertiesPanel.getDimensionValues(fields), [10, 20, 30, 40]);
  });

  it("buildShapeCornerRadii swaps indices 2/3 and respects sameRadii", () => {
    assert.deepEqual(
      PropertiesPanel.buildShapeCornerRadii([1, 2, 3, 4], 0, false),
      [1, null, null, null],
    );
    assert.deepEqual(
      PropertiesPanel.buildShapeCornerRadii([5, 2, 3, 4], 0, true),
      [5, 5, 5, 5],
    );
  });

  it("buildShapeBoundsRect applies aspect lock on W change", () => {
    assert.deepEqual(
      PropertiesPanel.buildShapeBoundsRect([100, 50, 10, 20], 0, 2, true),
      [10, 20, 110, 70],
    );
  });

  it("detectLiveShapeLayer finds vogk keyOriginType when not invalidated", () => {
    const pathLayer = {
      idx: 7,
      add: {
        vogk: [
          {
            v: {
              keyOriginType: { t: "long", v: 1 },
              keyShapeInvalidated: { t: "bool", v: false },
            },
          },
        ],
      },
    };
    const doc = {
      getPaths() {
        return [[pathLayer], [0]];
      },
    };
    const result = PropertiesPanel.detectLiveShapeLayer(doc);
    assert.equal(result.hasLiveShape, true);
    assert.equal(result.liveShapeLayerIndex, 7);
  });

  it("detectLiveShapeLayer skips invalidated or missing keyOriginType", () => {
    const pathLayer = {
      idx: 3,
      add: {
        vogk: [
          { v: { keyOriginType: { t: "long", v: 1 }, keyShapeInvalidated: { t: "bool", v: true } } },
          { v: { keyOriginType: null } },
        ],
      },
    };
    const doc = {
      getPaths() {
        return [[pathLayer], [0]];
      },
    };
    assert.equal(PropertiesPanel.detectLiveShapeLayer(doc).hasLiveShape, false);
  });

  it("resolveActiveMaskKind prefers raster mask when getMask present and no preferred kind", () => {
    const layer = {
      add: { vmsk: {} },
      hasSmartFilters() {
        return false;
      },
      getLinkedPlacedItem() {
        return { d: null };
      },
      getMask() {
        return {};
      },
      pathLayerActive: false,
      pixelContent: 0,
    };
    assert.equal(PropertiesPanel.resolveActiveMaskKind(layer, {}, null), 0);
  });

  it("LayerSectionForm adjustment dispatch uses the value key", () => {
    const form = Object.create(PropertiesPanel.LayerSectionForm.prototype);
    const captured = [];
    form.activeAdjustmentWidget = {
      getValue() {
        return { packed: 42 };
      },
    };
    form.dispatch = function (evt) {
      captured.push(evt);
    };
    form.onAdjustmentWidgetChange();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].routingChannel, EventChannel.EVENT_ADJUSTMENT);
    assert.equal(captured[0].data.actionKind, "edit_layer");
    assert.deepEqual(captured[0].data.value, { packed: 42 });
    assert.equal("value" in captured[0].data, true);
  });
});
