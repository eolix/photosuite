/**
 * filter gallery thumbnail layout helpers + column-width goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let computeFilterGalleryThumbColumnWidth;
let FilterGalleryThumbnailPanel;
let FILTER_GALLERY_THUMB_COLUMN_COUNT;
let FILTER_GALLERY_THUMB_VIEWPORT_WIDTH_DIVISOR;
let FILTER_GALLERY_THUMB_COLUMN_MIN_WIDTH;
let filterGalleryThumbnailSignature;
let getOrComputeFilterGalleryThumbnails;
let clearFilterGalleryThumbnailCache;
let originalDevicePixelRatio;

before(async () => {
  originalDevicePixelRatio = window.devicePixelRatio;
  ({
    computeFilterGalleryThumbColumnWidth,
    FilterGalleryThumbnailPanel,
    FILTER_GALLERY_THUMB_COLUMN_COUNT,
    FILTER_GALLERY_THUMB_VIEWPORT_WIDTH_DIVISOR,
    FILTER_GALLERY_THUMB_COLUMN_MIN_WIDTH,
    filterGalleryThumbnailSignature,
    getOrComputeFilterGalleryThumbnails,
    clearFilterGalleryThumbnailCache,
  } = await import("../../../src/ui/filter-panels/filter-gallery-thumbnail-panel.js"));
});

after(() => {
  window.devicePixelRatio = originalDevicePixelRatio;
});

describe("ui/filter-panels/filter-gallery-thumbnail-panel.js", () => {
  it("exports layout constants", () => {
    assert.equal(FILTER_GALLERY_THUMB_COLUMN_COUNT, 3);
    assert.equal(FILTER_GALLERY_THUMB_VIEWPORT_WIDTH_DIVISOR, 10);
    assert.equal(FILTER_GALLERY_THUMB_COLUMN_MIN_WIDTH, 240);
  });

  it("computeFilterGalleryThumbColumnWidth goldens", () => {
    assert.equal(computeFilterGalleryThumbColumnWidth(800), 240);
    assert.equal(computeFilterGalleryThumbColumnWidth(100), 240);
    assert.equal(computeFilterGalleryThumbColumnWidth(), 240);

    window.devicePixelRatio = 2;
    assert.equal(computeFilterGalleryThumbColumnWidth(1280), 256);
  });

  it("FilterGalleryThumbnailPanel column width API", () => {
    const panel = new FilterGalleryThumbnailPanel(300);
    assert.equal(panel.thumbnailColumnWidth, 300);
    assert.equal(panel.setColumnWidth(300), false);
    assert.equal(panel.setColumnWidth(320), true);
    assert.equal(panel.thumbnailColumnWidth, 320);
    assert.equal(panel.setColumnWidth(100), true);
    assert.equal(panel.thumbnailColumnWidth, 240);
  });

  it("filterGalleryThumbnailSignature keys by rasterized size and artwork revision", () => {
    // The revision suffix retires persisted sets whose bitmaps were painted
    // differently, even when they were rendered at this exact size.
    assert.match(filterGalleryThumbnailSignature(120, 84), /^120x84-r\d+$/);
    assert.notEqual(
      filterGalleryThumbnailSignature(120, 84),
      filterGalleryThumbnailSignature(240, 168),
    );
  });

  it("getOrComputeFilterGalleryThumbnails memoizes per signature", () => {
    clearFilterGalleryThumbnailCache();
    let computeCalls = 0;
    const compute = () => {
      computeCalls += 1;
      return { blur: "data:sig-a" };
    };

    const first = getOrComputeFilterGalleryThumbnails("120x84", compute);
    const second = getOrComputeFilterGalleryThumbnails("120x84", compute);
    assert.equal(computeCalls, 1, "recompute avoided for the same signature");
    assert.equal(second, first, "returns the same cached object");
    assert.equal(first.blur, "data:sig-a");

    getOrComputeFilterGalleryThumbnails("240x168", compute);
    assert.equal(computeCalls, 2, "a new signature recomputes once");

    clearFilterGalleryThumbnailCache();
    getOrComputeFilterGalleryThumbnails("120x84", compute);
    assert.equal(computeCalls, 3, "clear forces a recompute");
  });
});
