import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let Layer;
let LayerSectionType;
let LayerAction;
let getVectorStrokeStyleSnapshot;
let applyVectorStrokeStyleSnapshot;
let Mask;
let VectorMask;
let Rect;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({
    Layer,
    LayerSectionType,
    LayerAction,
    getVectorStrokeStyleSnapshot,
    applyVectorStrokeStyleSnapshot,
  } = await import(
    "../../../src/document/model/layer.js"
  ));
  ({ Mask, VectorMask } = await import(
    "../../../src/document/model/layer-masks.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/model/layer.js", () => {
  it("LayerSectionType enumerates PSD section markers", () => {
    assert.deepEqual(LayerSectionType, {
      Normal: 0,
      OpenGroup: 1,
      ClosedGroup: 2,
      BoundingDivider: 3,
    });
  });

  it("extractSelectionData lifts the selection and, when cutting, returns the hole", () => {
    // A 4x4 opaque red layer with the left half selected.
    const layer = new Layer();
    layer.rect = new Rect(0, 0, 4, 4);
    layer.buffer = new Uint8ClampedArray(4 * 4 * 4);
    for (let px = 0; px < 16; px++) {
      layer.buffer[px * 4] = 255;
      layer.buffer[px * 4 + 3] = 255;
    }
    const selectionChannel = new Uint8ClampedArray(16);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 2; col++) selectionChannel[row * 4 + col] = 255;
    }
    const selectionMask = { channel: selectionChannel, rect: new Rect(0, 0, 4, 4) };
    const doc = { selectionMask };
    const bufferBefore = layer.buffer.slice(0);

    const copied = layer.extractSelectionData(doc, selectionMask);
    assert.equal(copied.cutBuffer, undefined, "a copy leaves no hole to apply");

    const cut = layer.extractSelectionData(doc, selectionMask, true);
    // The lifted pixels are trimmed to the selected region and fully opaque, so the
    // new layer's bounds hug the selection rather than inheriting the source's.
    assert.deepEqual([cut.rect.x, cut.rect.y, cut.rect.width, cut.rect.height], [0, 0, 2, 4]);
    const liftedAlpha = Array.from(cut.pixBuf).filter((_, idx) => idx % 4 === 3);
    assert.deepEqual(liftedAlpha, [255, 255, 255, 255, 255, 255, 255, 255]);

    // The hole keeps the source's full bounds: transparent across the selected
    // half, untouched red across the other.
    assert.deepEqual([cut.cutRect.x, cut.cutRect.y, cut.cutRect.width, cut.cutRect.height], [0, 0, 4, 4]);
    const holeAlpha = Array.from(cut.cutBuffer).filter((_, idx) => idx % 4 === 3);
    assert.deepEqual(holeAlpha, [0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
    assert.equal(cut.cutBuffer[2 * 4], 255, "red survives outside the selection");

    // Neither call may touch the layer: the erase is applied by the caller, inside
    // the same stack commit that inserts the new layer, so both undo together.
    assert.deepEqual(Array.from(layer.buffer), Array.from(bufferBefore));
  });

  it("new Layer seeds blend-if table and render cache", () => {
    const layer = new Layer();
    assert.equal(layer.blendIfData.length, 40);
    assert.equal(layer.blendMode, "norm");
    assert.equal(layer.Opct, 255);
    assert.equal(layer.isClippingMask, false);
    assert.ok(layer.renderCache instanceof Layer.RenderCache);
  });

  it("isGroup recognizes open and closed group markers", () => {
    const layer = new Layer();
    layer.add.lsct = LayerSectionType.Normal;
    assert.equal(layer.isGroup(), false);
    layer.add.lsct = LayerSectionType.OpenGroup;
    assert.equal(layer.isGroup(), true);
    layer.add.lsct = LayerSectionType.ClosedGroup;
    assert.equal(layer.isGroup(), true);
  });

  it("hasFillContent detects solid, gradient, and pattern fills", () => {
    const layer = new Layer();
    assert.equal(layer.hasFillContent(), false);
    layer.add.SoCo = {};
    assert.equal(layer.hasFillContent(), true);
    delete layer.add.SoCo;
    layer.add.GdFl = {};
    assert.equal(layer.hasFillContent(), true);
    delete layer.add.GdFl;
    layer.add.PtFl = {};
    assert.equal(layer.hasFillContent(), true);
  });

  it("visibility and pixel flags read layer bitfield", () => {
    const layer = new Layer();
    assert.equal(layer.isVisible(), true);
    assert.equal(layer.hasPixelData(), true);
    layer.layerFlags += 2;
    assert.equal(layer.isVisible(), false);
    layer.layerFlags += 14;
    assert.equal(layer.hasPixelData(), false);
  });

  it("isLockBitSet reads lspf lock bits", () => {
    const layer = new Layer();
    assert.equal(layer.isLockBitSet(1), false);
    layer.add.lspf = 1 << 1;
    assert.equal(layer.isLockBitSet(1), true);
  });

  it("getName prefers luni over legacy name field", () => {
    const layer = new Layer();
    layer.name = "legacy";
    assert.equal(layer.getName(), "legacy");
    layer.setName("Foreground");
    assert.equal(layer.getName(), "Foreground");
    assert.equal(layer.add.luni, "Foreground");
  });

  it("getChannelIds lists default transform channels", () => {
    const layer = new Layer();
    assert.deepEqual(layer.getChannelIds(), [-1, 0, 1, 2]);
    layer.d = {};
    assert.deepEqual(layer.getChannelIds(), [-1, 0, 1, 2, -2]);
  });

  it("Mask.getThreshold combines density and display color", () => {
    const mask = new Mask();
    mask.color = 0;
    mask.density = 200;
    assert.equal(mask.getThreshold(), 55);
  });

  it("Mask.combineWith intersects zero-threshold masks", () => {
    const left = new Mask();
    left.isEnabled = true;
    left.color = 0;
    left.density = 255;
    left.rect = new Rect(0, 0, 10, 10);
    left.channel = new Uint8Array(100);

    const right = new Mask();
    right.isEnabled = true;
    right.color = 0;
    right.density = 255;
    right.rect = new Rect(5, 5, 10, 10);
    right.channel = new Uint8Array(100);

    const combined = left.combineWith(right);
    assert.equal(combined.rect.x, 5);
    assert.equal(combined.rect.y, 5);
    assert.equal(combined.rect.width, 5);
    assert.equal(combined.rect.height, 5);
  });

  it("rectToArtboardDescriptor maps Rect to PSD artboard keys", () => {
    const descriptor = Layer.rectToArtboardDescriptor(new Rect(1, 2, 10, 20));
    assert.equal(descriptor.Top.v, 2);
    assert.equal(descriptor.Left.v, 1);
    assert.equal(descriptor.Rght.v, 11);
    assert.equal(descriptor.Btom.v, 22);
  });

  it("VectorMask.clonePathRecords deep-copies knot records", () => {
    const vectorMask = new VectorMask();
    const cloned = VectorMask.clonePathRecords(vectorMask.pathRecords);
    assert.equal(cloned.length, vectorMask.pathRecords.length);
    assert.notEqual(cloned, vectorMask.pathRecords);
  });

  it("LayerAction and Layer expose matching history tokens", () => {
    assert.equal(LayerAction.setBlendMode, "setBlendMode");
    assert.equal(Layer.setBlendMode, "setBlendMode");
  });

  it("getMaskOffsets reports mask layout without masks", () => {
    const layer = new Layer();
    assert.deepEqual(layer.getMaskOffsets(), {
      hasRasterMask: false,
      hasVectorMask: false,
      rasterVectorOffsetX: 0,
      rasterVectorOffsetY: 0,
    });
  });

  // A vector shape's fill is one of three descriptors, or switched off; a
  // snapshot carries it across a transform or a restyle.
  it("getVectorStrokeStyleSnapshot maps SoCo / GdFl / PtFl fill kinds", () => {
    const soCoDesc = { classID: "SoCo", Clr: { t: "Objc", v: {} } };
    const gdFlDesc = { classID: "GdFl", Grad: { t: "Objc", v: {} } };
    const ptFlDesc = { classID: "PtFl", Ptrn: { t: "Objc", v: {} } };

    assert.deepEqual(
      getVectorStrokeStyleSnapshot(
        {
          layers: [{
            add: {
              vstk: { fillEnabled: { v: false } },
              SoCo: null,
              GdFl: null,
              PtFl: null,
            },
          }],
        },
        0,
      ),
      { fillKind: 0 },
    );

    assert.deepEqual(
      getVectorStrokeStyleSnapshot(
        { layers: [{ add: { vstk: { fillEnabled: { v: true } }, SoCo: soCoDesc, GdFl: null, PtFl: null } }] },
        0,
      ),
      { fillKind: 1, fillDescriptor: soCoDesc },
    );

    assert.deepEqual(
      getVectorStrokeStyleSnapshot(
        { layers: [{ add: { vstk: null, SoCo: null, GdFl: gdFlDesc, PtFl: null } }] },
        0,
      ),
      { fillKind: 2, fillDescriptor: gdFlDesc },
    );

    assert.deepEqual(
      getVectorStrokeStyleSnapshot(
        { layers: [{ add: { vstk: null, SoCo: null, GdFl: null, PtFl: ptFlDesc } }] },
        0,
      ),
      { fillKind: 3, fillDescriptor: ptFlDesc },
    );
  });

  it("applyVectorStrokeStyleSnapshot writes fill descriptor and fillEnabled", () => {
    const fillDescriptor = { classID: "SoCo", Clr: { t: "Objc", v: {} } };
    const layer = {
      add: {
        vmsk: {},
        vstk: { fillEnabled: { v: false } },
        SoCo: { classID: "old" },
        GdFl: { classID: "grad" },
        PtFl: null,
      },
    };

    applyVectorStrokeStyleSnapshot(layer, {
      fillKind: 1,
      fillDescriptor,
    });

    assert.equal(layer.add.vstk.fillEnabled.v, true);
    assert.deepEqual(layer.add.SoCo, fillDescriptor);
    assert.equal(layer.add.GdFl, undefined);
    assert.equal(layer.add.PtFl, undefined);

    applyVectorStrokeStyleSnapshot(layer, { fillKind: 0 });
    assert.equal(layer.add.vstk.fillEnabled.v, false);
  });
});
