/**
 * Golden values for filter-pixel-ops (gallery kernels).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FilterPixelOps;

before(async () => {
  globalThis.alert = () => {};
  ({ FilterPixelOps } = await import("../../../../src/features/filters/gallery/filter-pixel-ops.js"));
});

function solidRgba(width, height, red, green, blue, alpha = 255) {
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buffer[i * 4] = red;
    buffer[i * 4 + 1] = green;
    buffer[i * 4 + 2] = blue;
    buffer[i * 4 + 3] = alpha;
  }
  return buffer;
}

function bufferSum(buffer) {
  return [...buffer].reduce((total, value) => total + value, 0);
}

describe("features/filters/gallery/filter-pixel-ops.js", () => {
  it("accentedEdges / glowingEdges / cutout match the golden buffers", () => {
    const width = 8;
    const height = 8;
    const source = solidRgba(width, height, 120, 80, 40);

    const accented = new Uint8ClampedArray(width * height * 4);
    FilterPixelOps.accentedEdges(source, width, height, accented, [2, 25, 3]);
    assert.deepEqual([...accented.slice(0, 4)], [120, 79, 40, 255]);
    assert.equal(bufferSum(accented), 31616);

    const glowing = new Uint8ClampedArray(width * height * 4);
    FilterPixelOps.glowingEdges(source, width, height, glowing, [1, 1, 1]);
    assert.deepEqual([...glowing.slice(0, 4)], [120, 80, 40, 255]);
    assert.equal(bufferSum(glowing), 31680);

    const cutout = new Uint8ClampedArray(width * height * 4);
    FilterPixelOps.cutout(source, width, height, cutout, [4, 2, 1]);
    assert.deepEqual([...cutout.slice(0, 4)], [120, 80, 40, 255]);
    assert.equal(bufferSum(cutout), 31680);
  });

  it("exports the gallery kernel surface", () => {
    assert.equal(typeof FilterPixelOps.angledStrokes, "function");
    assert.equal(typeof FilterPixelOps.edgeQuantize, "function");
    assert.equal(typeof FilterPixelOps.perlinNoise, "function");
    assert.equal(Object.keys(FilterPixelOps).length, 41);
  });

  it("provides every kernel the gallery dispatches by name", () => {
    // Kernels are called as FilterPixelOps[name], so a rename or removal is
    // invisible until the filter runs and throws. Read the names the definitions
    // actually ask for and check each one is here.
    const defsSource = readFileSync(
      "src/features/filters/gallery/gallery-filter-defs.js",
      "utf8"
    );
    const kernelNames = [...defsSource.matchAll(/kernel: "([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    assert.ok(kernelNames.length > 30, "expected the gallery to declare many kernels");
    for (const kernelName of new Set(kernelNames)) {
      assert.equal(
        typeof FilterPixelOps[kernelName],
        "function",
        kernelName + " is dispatched by the gallery but missing from FilterPixelOps"
      );
    }
  });
});
