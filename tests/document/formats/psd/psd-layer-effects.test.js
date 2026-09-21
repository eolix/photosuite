import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let normalizeLayerEffectsOnRead;
let normalizeLayerEffectsOnWrite;
let applyGradientFillDefaults;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({
    normalizeLayerEffectsOnRead,
    normalizeLayerEffectsOnWrite,
    applyGradientFillDefaults,
  } = await import("../../../../src/document/formats/psd/psd-layer-effects.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/psd/psd-layer-effects.js", () => {

  it("normalizeLayerEffectsOnRead merges single DrSh into dropShadowMulti", () => {
    const descriptor = {
      DrSh: { t: "Objc", v: { enab: { v: true } } },
    };
    normalizeLayerEffectsOnRead(descriptor);
    assert.equal(descriptor.DrSh, undefined);
    assert.equal(descriptor.dropShadowMulti.v.length, 1);
  });

  it("normalizeLayerEffectsOnWrite collapses single-item dropShadowMulti to DrSh", () => {
    const descriptor = {};
    normalizeLayerEffectsOnRead(descriptor);
    descriptor.dropShadowMulti.v = [{ t: "Objc", v: { enab: { v: true } } }];
    normalizeLayerEffectsOnWrite(descriptor);
    assert.notEqual(descriptor.DrSh, undefined);
    assert.equal(descriptor.dropShadowMulti, undefined);
  });

  it("normalizeLayerEffectsOnRead drops items with present.v false", () => {
    const descriptor = {
      dropShadowMulti: {
        t: "VlLs",
        v: [
          { t: "Objc", v: { present: { v: false } } },
          { t: "Objc", v: { enab: { v: true } } },
        ],
      },
    };
    normalizeLayerEffectsOnRead(descriptor);
    assert.equal(descriptor.dropShadowMulti.v.length, 1);
  });

  it("normalizeLayerEffectsOnWrite keeps multi-item lists and deletes empty lists", () => {
    const multiDescriptor = {};
    normalizeLayerEffectsOnRead(multiDescriptor);
    multiDescriptor.dropShadowMulti.v = [
      { t: "Objc", v: { enab: { v: true } } },
      { t: "Objc", v: { enab: { v: false } } },
    ];
    normalizeLayerEffectsOnWrite(multiDescriptor);
    assert.equal(multiDescriptor.DrSh, undefined);
    assert.equal(multiDescriptor.dropShadowMulti.v.length, 2);

    const emptyDescriptor = {};
    normalizeLayerEffectsOnRead(emptyDescriptor);
    emptyDescriptor.dropShadowMulti.v = [];
    normalizeLayerEffectsOnWrite(emptyDescriptor);
    assert.equal(emptyDescriptor.dropShadowMulti, undefined);
  });

  it("applyGradientFillDefaults wires GdFl defaults", () => {
    const descriptor = {};
    applyGradientFillDefaults(descriptor, "GdFl");
    assert.equal(descriptor.Algn.v, true);
    assert.equal(descriptor.Rvrs.v, false);
    assert.equal(descriptor.Dthr.v, false);
    assert.equal(descriptor.Angl.v.val, 0);
    assert.equal(descriptor.Scl.v.val, 100);
    assert.equal(descriptor.Ofst.v.classID, "Pnt");
  });

  it("applyGradientFillDefaults wires PtFl defaults", () => {
    const descriptor = {};
    applyGradientFillDefaults(descriptor, "PtFl");
    assert.equal(descriptor.Algn.v, true);
    assert.equal(descriptor.Scl.v.val, 100);
    assert.equal(descriptor.phase.v.Hrzn.v, 0);
    assert.equal(descriptor.phase.v.Vrtc.v, 0);
  });
});
