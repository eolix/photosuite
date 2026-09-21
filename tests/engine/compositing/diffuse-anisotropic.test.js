/**
 * the Diffuse filter's anisotropic mode.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { filter } from "../../../src/engine/compositing/diffuse.js";

installBrowserGlobals();
globalThis.LayerSystem = globalThis.LayerSystem || { webglEnabled: false };

let Rect;
let DIFFUSE_MODES;
let DIFFUSE_MODE_ANISOTROPIC;

before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ DIFFUSE_MODES, DIFFUSE_MODE_ANISOTROPIC } = await import(
    "../../../src/features/filters/filter-apply.js"
  ));
});

/** Checkerboard with colour ramps, so an edge-preserving filter has edges to keep. */
function makeTestImage(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = ((x >> 2) + (y >> 2)) % 2 ? 230 : 30;
      rgba[i + 1] = (x * 10) & 255;
      rgba[i + 2] = (y * 10) & 255;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("Diffuse — anisotropic mode", () => {
  it("is the fourth mode, and the applier and panel share one list", () => {
    // The panel writes descriptor.Md.v.DfsM from this list and the applier reads an
    // index back out of it. Two copies that drift by one would silently run the
    // wrong filter, so both sites import this one.
    assert.deepEqual(DIFFUSE_MODES, ["Nrml", "DrkO", "LghO", "anisotropic"]);
    assert.equal(DIFFUSE_MODES[DIFFUSE_MODE_ANISOTROPIC], "anisotropic");

    const panelSource = readFileSync("src/ui/filter-panels/builtin-filter-panels.js", "utf8");
    assert.ok(
      panelSource.includes("DIFFUSE_MODES.indexOf(descriptor.Md.v.DfsM)"),
      "the Diffuse panel must read the shared mode list"
    );
  });

  it("actually filters the image on the CPU path", () => {
    // Params are the ones applyDiffuseFilter passes for this mode.
    const width = 24, height = 24;
    const source = makeTestImage(width, height);
    const dest = new Uint8ClampedArray(width * height * 4);
    filter(
      source, new Rect(0, 0, width, height), dest, [1.4, 1.6, 1, 4, false, 2, [0, 0, 0.001]]
    );

    let changed = 0;
    for (let byteIdx = 0; byteIdx < source.length; byteIdx++) {
      if (source[byteIdx] !== dest[byteIdx]) changed++;
    }
    assert.ok(changed > 0, "anisotropic diffusion left the image untouched");

    // Edge-preserving smoothing redistributes colour rather than adding or
    // removing it, and it must not disturb alpha.
    const sum = (buf) => buf.reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum(dest) - sum(source)) / sum(source) < 0.05);
    for (let alphaOff = 3; alphaOff < dest.length; alphaOff += 4) {
      assert.equal(dest[alphaOff], 255);
    }
  });
});
