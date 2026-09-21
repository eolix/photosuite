/**
 * Golden values for layer-system (compositing / WebGL runtime).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";
import { allocBuffer } from "../../src/engine/compositing/buffer-utils.js";

installBrowserGlobals();

let Rect;
let initLayerSystemGl;
let AdjustmentShaderType;
let defaultShapeStyleParams;

function stubWebGlCanvas() {
  document.createElement = (tag) => {
    if (tag === "canvas") {
      const gl = {
        createFramebuffer() {
          return {};
        },
        bindFramebuffer() {},
        disable() {},
        createBuffer() {
          return {};
        },
        bindBuffer() {},
        bufferData() {},
        enableVertexAttribArray() {},
        vertexAttribPointer() {},
        getParameter() {
          return 8192;
        },
        FRAGMENT_SHADER: 1,
        VERTEX_SHADER: 2,
        ARRAY_BUFFER: 3,
        STATIC_DRAW: 4,
        FLOAT: 5,
        FRAMEBUFFER: 6,
        BLEND: 19,
        DEPTH_TEST: 20,
      };
      return {
        getContext(type) {
          return type === "webgl" || type === "experimental-webgl" ? gl : null;
        },
      };
    }
    return { style: {} };
  };
}

function createLayerSystem() {
  stubWebGlCanvas();
  return initLayerSystemGl();
}

before(async () => {
  ({ Rect } = await import("../../src/core/math/rect.js"));
  ({ initLayerSystemGl, AdjustmentShaderType, defaultShapeStyleParams } = await import(
    "../../src/engine/layer-system.js"
  ));
});

describe("engine/layer-system.js", () => {
  it("the layer system enables WebGL when a context is available", () => {
    const ls = createLayerSystem();
    assert.equal(ls.webglEnabled, true);
    assert.equal(ls.glContextAvailable, true);
    assert.equal(typeof ls.RgbaTexture, "function");
    assert.equal(typeof ls.renderers.BlendShader, "function");
    assert.equal(Object.keys(ls.renderers.blendShaderBodies).length, 27);
    assert.equal(Object.keys(ls.shaderLib).length, 21);
    assert.equal(ls.filter.DEPTH_BEVEL, 3);
  });

  it("minifyGlsl collapses whitespace around punctuation", () => {
    const ls = createLayerSystem();
    assert.equal(ls.minifyGlsl("  foo  ;  bar  }  {  =  |  x  "), " foo ;bar}{=|x ");
  });

  it("rectToViewportCoords matches captured Float32 values", () => {
    const ls = createLayerSystem();
    const coords = ls.rectToViewportCoords(
      new Rect(10, 20, 30, 40),
      new Rect(0, 0, 100, 200),
    );
    assert.deepEqual(Array.from(coords), [
      0.10000000149011612, 0.10000000149011612, 0.30000001192092896, 0.20000000298023224,
    ]);
  });

  it("bindMainCanvas rejects scissorRect", () => {
    const ls = createLayerSystem();
    try {
      ls.bindMainCanvas(100, 100, new Rect(0, 0, 10, 10));
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /scissor/);
    }
  });

  // The ids index LayerSystem.adjLayerShaders, and the adjustment engine names
  // them when it builds shader options — reordering them would silently swap
  // which shader program runs.
  it("AdjustmentShaderType ids match the adjLayerShaders order", () => {
    assert.deepEqual({ ...AdjustmentShaderType }, {
      LookupTable: 0,
      HueSat: 1,
      Vibrance: 2,
      SelectiveColor: 3,
      BlackWhite: 4,
      ColorMatrix: 5,
      ReplaceColor: 6,
      IccLut: 7,
    });
  });

  // What `renderers.composite` falls back to when a caller has no layer style.
  it("defaultShapeStyleParams is a full-fill, no-knockout layer", () => {
    assert.deepEqual(defaultShapeStyleParams(), {
      fill: 1,
      blendIfTable: null,
      channelRestrictions: [1, 1, 1],
      knockout: 0,
      style: false,
      preserveDestAlpha: false,
    });
  });
});
