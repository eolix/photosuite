import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let GalleryFilterDefs;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ GalleryFilterDefs } = await import("../../../../src/features/filters/gallery/gallery-filter-defs.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("filter-gallery/gallery-filter-defs.js", () => {
  it("create builds GEfc descriptor for known filter", () => {
    const desc = GalleryFilterDefs.create("Gls");
    assert.equal(desc.classID, "GEfc");
    assert.equal(desc.GEfk.v.GEft, "Gls");
    assert.equal(desc.GELv.v, true);
  });

  it("colorizeGrayToRgba blends fg and bg by gray", () => {
    const gray = new Uint8Array([0, 255]);
    const rgba = new Uint8ClampedArray(8);
    GalleryFilterDefs.colorizeGrayToRgba(gray, rgba, { h: 10, l: 20, O: 30 }, { h: 100, l: 110, O: 120 });
    assert.deepEqual([rgba[0], rgba[1], rgba[2]], [10, 20, 30]);
    assert.deepEqual([rgba[4], rgba[5], rgba[6]], [100, 110, 120]);
  });
});
