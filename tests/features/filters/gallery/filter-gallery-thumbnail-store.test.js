import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { makeMockSettingsStore, installTauriWindowMock } from "../../../helpers/minimal-app-controller.js";

// One backing store shared across the suite: the store module memoizes the first
// store its load() returns, so persist and load in these tests must hit the same
// object for a round-trip to be observable.
const backing = makeMockSettingsStore();

let store;
let restoreWindow;

before(async () => {
  restoreWindow = installTauriWindowMock({
    load() {
      return Promise.resolve(backing.store);
    },
  });
  store = await import("../../../../src/features/filters/gallery/filter-gallery-thumbnail-store.js");
});

after(() => {
  if (restoreWindow) restoreWindow();
});

const SAMPLE = { blur: "data:image/png;base64,AAAA", sharpen: "data:image/png;base64,BBBB" };

describe("contract: filter gallery thumbnail store ↔ panel cache", () => {
  it("round-trips a rendered set for the same signature", async () => {
    await store.persistFilterGalleryThumbnails("160x112", SAMPLE);
    const loaded = await store.loadPersistedFilterGalleryThumbnails("160x112");
    assert.deepEqual(loaded, SAMPLE);
  });

  it("returns null for a different signature (display size / DPI changed)", async () => {
    await store.persistFilterGalleryThumbnails("160x112", SAMPLE);
    assert.equal(await store.loadPersistedFilterGalleryThumbnails("200x140"), null);
  });

  it("returns null when the persisted version does not match", async () => {
    await store.persistFilterGalleryThumbnails("160x112", SAMPLE);
    // Simulate a build that bumped the cache version after this set was written.
    await backing.store.set("version", store.FILTER_GALLERY_THUMBNAIL_CACHE_VERSION + 1);
    assert.equal(await store.loadPersistedFilterGalleryThumbnails("160x112"), null);
  });

  it("rejects non-data-URL payloads as invalid thumbnail maps", () => {
    assert.equal(store.isFilterGalleryThumbnailMap(SAMPLE), true);
    assert.equal(store.isFilterGalleryThumbnailMap({ blur: "not-a-data-url" }), false);
    assert.equal(store.isFilterGalleryThumbnailMap({}), false);
    assert.equal(store.isFilterGalleryThumbnailMap(null), false);
  });
});

