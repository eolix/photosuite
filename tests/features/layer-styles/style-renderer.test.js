/**
 * Golden values for style-renderer pure helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let LayerStyleRenderer;
let findPattern;
let LayerEffectDefs;

before(async () => {
  ({ findPattern } = await import(
    "../../../src/document/formats/psd/layer-data-parsers.js"
  ));
  ({ LayerStyleRenderer } = await import("../../../src/features/layer-styles/style-renderer.js"));
  ({ LayerEffectDefs } = await import("../../../src/document/formats/psd/effect-defs.js"));
});

function strokeEffect(align, size) {
  return {
    Styl: { v: { FStl: align } },
    Sz: { v: { val: size } },
  };
}

function emptyLmfx() {
  const lmfx = {};
  for (const key of LayerEffectDefs.effectKeys) lmfx[key] = { v: [] };
  return lmfx;
}

describe("features/layer-styles/style-renderer.js", () => {
  it("getFrameEffectStrokePadding maps align to inner/outer padding", () => {
    assert.deepEqual(
      LayerStyleRenderer.getFrameEffectStrokePadding(strokeEffect("OutF", 10)),
      [0, 10],
    );
    assert.deepEqual(
      LayerStyleRenderer.getFrameEffectStrokePadding(strokeEffect("InsF", 10)),
      [10, 0],
    );
    assert.deepEqual(
      LayerStyleRenderer.getFrameEffectStrokePadding(strokeEffect("CtrF", 10)),
      [5, 5],
    );
  });

  it("hasNonFillEffects ignores fill-only effects", () => {
    assert.equal(LayerStyleRenderer.hasNonFillEffects(emptyLmfx()), false);
    const lmfx = emptyLmfx();
    lmfx.dropShadowMulti.v.push({ v: { enab: { v: true }, classID: "DrSh" } });
    assert.equal(LayerStyleRenderer.hasNonFillEffects(lmfx), true);
  });

  it("dashArrayToStrokeDescriptor scales dash lengths", () => {
    assert.deepEqual(LayerStyleRenderer.dashArrayToStrokeDescriptor([2, 4], 1.5), [
      { t: "UntF", v: { type: "#Nne", val: 3 } },
      { t: "UntF", v: { type: "#Nne", val: 6 } },
    ]);
  });

  it("vec3 helpers normalize, cross, and dot", () => {
    const vec = { x: 3, y: 0, z: 4 };
    LayerStyleRenderer.normalizeVec3(vec);
    assert.deepEqual(vec, { x: 0.6000000000000001, y: 0, z: 0.8 });
    assert.deepEqual(
      LayerStyleRenderer.crossVec3({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
      { x: 0, y: 0, z: 1 },
    );
    assert.equal(
      LayerStyleRenderer.dotVec3({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }),
      32,
    );
  });

  it("findPattern matches capture", () => {
    const patterns = [
      { id: "abc", name: "P1" },
      { id: "xyz", name: "P2" },
    ];
    assert.equal(
      findPattern({ Idnt: { v: "xyz" } }, patterns)?.name,
      "P2",
    );
    assert.equal(
      findPattern({ Idnt: { v: "nope" } }, patterns),
      null,
    );
  });
});
