/**
 * Golden values for filter-apply (descriptor + pixel apply paths).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { boxBlurRgbaInPlace } from "../../../src/engine/compositing/blur.js";

installBrowserGlobals();

let FilterDefs;
let Rect;

before(async () => {
  globalThis.alert = () => {};
  ({ FilterDefs } = await import("../../../src/features/filters/filter-apply.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  await import("../../../src/engine/layer-system.js");
});

function solidRgba(width, height, red, green, blue, alpha = 255) {
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buffer[i * 4] = red;
    buffer[i * 4 + 1] = green;
    buffer[i * 4 + 2] = blue;
    buffer[i * 4 + 3] = alpha;
  }
  return { buffer, rect: new Rect(0, 0, width, height) };
}

function bufferSum(pixels) {
  return [...pixels.buffer].reduce((total, value) => total + value, 0);
}

describe("features/filters/filter-apply.js", () => {
  it("createFilterFxDescriptor builds filterFX with blend options and Fltr", () => {
    const descriptor = FilterDefs.createFilterFxDescriptor("boxblur", {
      colorInt: 0xff0000,
      bgColor: 0x00ff00,
    });
    assert.equal(descriptor.v.classID, "filterFX");
    assert.equal(descriptor.v.enab.v, true);
    assert.equal(descriptor.v.hasoptions.v, true);
    assert.equal(descriptor.v.blendOptions.v.Opct.v.val, 100);
    assert.equal(descriptor.v.blendOptions.v.Md.v.blendMode, "Nrml");
    assert.equal(descriptor.v.FrgC.v.classID, "RGBC");
    assert.equal(descriptor.v.filterID.v, 777);
    assert.ok(descriptor.v.Fltr);
    assert.equal(descriptor.v.Fltr.v.classID, "boxblur");
  });

  it("copyRgbaToSharedBuffer copies bytes into the shared scratch", () => {
    const source = new Uint8ClampedArray([10, 20, 30, 40, 50, 60, 70, 80]);
    FilterDefs.copyRgbaToSharedBuffer(source);
    assert.deepEqual([...new Uint8Array(FilterDefs.sharedRgbaScratchBuffer, 0, 8)], [
      10, 20, 30, 40, 50, 60, 70, 80,
    ]);
  });

  it("applyFilterToPixels Frgm / Avrg / Slrz match the golden buffers", () => {
    const solid = solidRgba(4, 4, 100, 150, 200, 255);
    const fragment = FilterDefs.applyFilterToPixels(
      "Frgm",
      solid,
      FilterDefs.create("Frgm"),
      [0, 0, 0],
      [255, 255, 255],
      null,
      {},
    );
    assert.deepEqual([...fragment.buffer.slice(0, 4)], [100, 150, 200, 255]);
    assert.equal(bufferSum(fragment), 11280);

    const average = FilterDefs.applyFilterToPixels(
      "Avrg",
      solidRgba(4, 4, 100, 150, 200, 255),
      FilterDefs.create("Avrg"),
      [0, 0, 0],
      [255, 255, 255],
      null,
      {},
    );
    assert.deepEqual([...average.buffer.slice(0, 4)], [100, 150, 200, 255]);
    assert.equal(bufferSum(average), 11280);

    const solarize = FilterDefs.applyFilterToPixels(
      "Slrz",
      solidRgba(2, 2, 200, 100, 50, 255),
      FilterDefs.create("Slrz"),
      [0, 0, 0],
      [255, 255, 255],
      null,
      {},
    );
    assert.deepEqual(
      [...solarize.buffer],
      [55, 100, 50, 255, 55, 100, 50, 255, 55, 100, 50, 255, 55, 100, 50, 255],
    );
    assert.equal(bufferSum(solarize), 1840);
  });

  it("applyPremultipliedBlur matches convolution path", () => {
    const blurBuffer = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < 9; i++) {
      blurBuffer[i * 4] = i * 20;
      blurBuffer[i * 4 + 1] = i * 10;
      blurBuffer[i * 4 + 2] = i * 5;
      blurBuffer[i * 4 + 3] = 255;
    }
    FilterDefs.applyPremultipliedBlur(
      0.5,
      boxBlurRgbaInPlace,
      blurBuffer,
      new Rect(0, 0, 3, 3),
    );
    assert.deepEqual(
      [...blurBuffer],
      [
        18, 9, 4, 255, 33, 17, 8, 255, 49, 24, 12, 255, 64, 32, 16, 255, 80, 40, 20, 255, 96, 48,
        24, 255, 111, 56, 28, 255, 127, 63, 32, 255, 142, 71, 36, 255,
      ],
    );
  });

  // Displace reads its map from a linked-file item embedded in the document; the
  // filter context hands the list of those items to the apply path, and `DspF`
  // names which one by tag.
  function displacementMapItem(tag, width, height, fill) {
    const mapPixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const rgba = fill(i % width, Math.floor(i / width));
      mapPixels[i * 4] = rgba[0];
      mapPixels[i * 4 + 1] = rgba[1];
      mapPixels[i * 4 + 2] = rgba[2];
      mapPixels[i * 4 + 3] = 255;
    }
    return {
      tag,
      getRasterData() {},
      rasterCache: [mapPixels, new Rect(0, 0, width, height)],
    };
  }

  function checkerRgba(width, height) {
    const buffer = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const value = ((i % width) + Math.floor(i / width)) % 2 === 0 ? 255 : 0;
      buffer[i * 4] = value;
      buffer[i * 4 + 1] = value;
      buffer[i * 4 + 2] = value;
      buffer[i * 4 + 3] = 255;
    }
    return { buffer, rect: new Rect(0, 0, width, height) };
  }

  function applyDisplace(source, mapItems, configure) {
    const descriptor = FilterDefs.create("Dspl");
    descriptor.HrzS.v = 40;
    descriptor.VrtS.v = 40;
    if (configure) configure(descriptor);
    return FilterDefs.applyFilterToPixels(
      "Dspl",
      source,
      descriptor,
      [0, 0, 0],
      [255, 255, 255],
      null,
      [mapItems, null, null],
    );
  }

  it("Displace leaves the layer alone until a map is chosen", () => {
    const source = checkerRgba(16, 16);
    const untouched = applyDisplace(source, []);
    assert.deepEqual([...untouched.buffer], [...checkerRgba(16, 16).buffer]);
  });

  it("Displace reads horizontal offsets from channel 1 and vertical from channel 2", () => {
    const source = checkerRgba(16, 16);
    const greyMap = displacementMapItem("map", 16, 16, () => [220, 220, 220]);
    const splitMap = displacementMapItem("map", 16, 16, () => [220, 40, 128]);
    const greyResult = applyDisplace(source, [greyMap], (d) => (d.DspF.v.pth = "map"));
    const splitResult = applyDisplace(source, [splitMap], (d) => (d.DspF.v.pth = "map"));
    assert.notDeepEqual([...splitResult.buffer], [...greyResult.buffer]);
  });

  it("Displace tiles a small map instead of stretching it", () => {
    const source = checkerRgba(16, 16);
    const rampMap = displacementMapItem("map", 4, 4, (x) => [40 + x * 60, 40 + x * 60, 0]);
    const stretched = applyDisplace(source, [rampMap], (d) => (d.DspF.v.pth = "map"));
    const tiled = applyDisplace(source, [rampMap], (d) => {
      d.DspF.v.pth = "map";
      d.DspM.v.DspM = "Tile";
    });
    assert.notDeepEqual([...tiled.buffer], [...stretched.buffer]);
  });
});
