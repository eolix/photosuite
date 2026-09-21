/**
 * Committing a shape builds a new shape layer, and the layer's vector mask has
 * to come out of it as a usable path.
 *
 * These drive the real action handler rather than the geometry helpers under
 * it, because the failures this guards against are not wrong geometry — they
 * are a mask that never received any, which every later reader then misreads.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;
let Layer;
let Document;
let PathRecordCodec;
let usesEvenOddFill;

before(async () => {
  await import("../../../src/features/trackers/layer-effects-stack-actions.js");
  await import("../../../src/features/trackers/layer-effects-history.js");
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ Document } = await import("../../../src/document/model/document.js"));
  ({ PathRecordCodec } = await import(
    "../../../src/document/formats/psd/path-record-codec.js"
  ));
  ({ usesEvenOddFill } = await import(
    "../../../src/engine/compositing/path-records.js"
  ));
  installAnsweringCanvas();
});

/**
 * The shared stub returns no 2D context, and rendering a shape layer's fill
 * needs one. This answers every call so the render runs to completion.
 */
function installAnsweringCanvas() {
  const create = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = function (tag) {
    const element = create(tag);
    if (String(tag).toLowerCase() !== "canvas") return element;
    const context = new Proxy({ canvas: element }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === "getImageData") {
          return (x, y, width, height) => ({
            data: new Uint8ClampedArray(width * height * 4), width, height,
          });
        }
        if (prop === "measureText") return () => ({ width: 0 });
        return () => {};
      },
      set(target, prop, value) { target[prop] = value; return true; },
    });
    element.getContext = () => context;
    return element;
  };
}

function pixels(value) {
  return { t: "UntF", v: { type: "#Pxl", val: value } };
}

/** A document of one named layer, which the insert position is chosen against. */
function documentWithOneLayer() {
  const doc = new Document("shapes.psd");
  doc.width = 100;
  doc.height = 100;
  const base = doc.newLayer();
  base.setName("Background");
  doc.layers = [base];
  doc.selectedLayerIndices = [0];
  return doc;
}

/** The action the shape tool dispatches when a custom shape is committed. */
function newCustomShapeEvent(presetName) {
  return {
    actionDescriptor: {
      Usng: { v: {
        Type: { v: {
          classID: "solidColorLayer",
          Clr: { v: { classID: "RGBC", Rd: { v: 1 }, Grn: { v: 2 }, Bl: { v: 3 } } },
        } },
        Shp: { v: {
          classID: "customShape",
          Nm: { v: presetName },
          Left: pixels(0), Top: pixels(0), Rght: pixels(50), Btom: pixels(50),
        } },
      } },
    },
  };
}

function commitNewShapeLayer(doc, event, appData) {
  const tracker = new TrackerRegistry.LayerEffectsTracker();
  const handler = TrackerRegistry.LayerEffectsTracker.actionHandlers[Layer.newShapeLayer];
  handler.call(tracker, event, { dispatch() {} }, doc, {}, appData, Layer.newShapeLayer, 0, null);
  return doc.layers[doc.selectedLayerIndices[0]];
}

describe("committing a new shape layer", () => {
  // The preset's geometry has to reach the mask. Reading it from a field the
  // presets do not carry yields an empty record array, and the failure then
  // surfaces several frames away in whatever next walks the path.
  it("gives a custom shape layer the preset's path", () => {
    const preset = PathRecordCodec.create();
    const doc = documentWithOneLayer();
    const shapeLayer = commitNewShapeLayer(
      doc,
      newCustomShapeEvent(preset.categoryName),
      { customShapePresets: [preset], patternPresets: [] },
    );

    const records = shapeLayer.add.vmsk.pathRecords;
    assert.equal(records.length, preset.pathRecords.length);
    // The two-record preamble every reader of a path expects to find.
    assert.deepEqual(records[0], { type: 6 });
    assert.deepEqual(records[1], { type: 8, all: 0 });
    assert.equal(typeof usesEvenOddFill(records), "boolean");
  });

  // A name no preset answers to falls back to the shape's bounding rectangle,
  // which is a path in its own right rather than nothing.
  it("falls back to the bounding rectangle for an unknown preset", () => {
    const doc = documentWithOneLayer();
    const shapeLayer = commitNewShapeLayer(
      doc,
      newCustomShapeEvent("no-such-shape"),
      { customShapePresets: [PathRecordCodec.create()], patternPresets: [] },
    );

    const records = shapeLayer.add.vmsk.pathRecords;
    assert.ok(records.length > 2);
    assert.deepEqual(records[1], { type: 8, all: 0 });
    assert.equal(typeof usesEvenOddFill(records), "boolean");
  });
});
