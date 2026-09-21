/**
 * recent-file preview map.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

let isRecentThumbnailMap;
let pruneRecentThumbnailMap;
let buildRecentFileListAfterOpen;

before(async () => {
  ({
    isRecentThumbnailMap,
    pruneRecentThumbnailMap,
    buildRecentFileListAfterOpen
  } = await import("../../src/core/recent-files.js"));
});

describe("core/recent-files.js — preview map", () => {
  it("accepts a map of data URLs, including an empty one", () => {
    // Empty is what a first run stores, and what clearing the list leaves behind;
    // rejecting it would make the store look corrupt and discard good entries.
    assert.equal(isRecentThumbnailMap({}), true);
    assert.equal(isRecentThumbnailMap({ "/a.psd": "data:image/jpeg;base64,AAA" }), true);
    assert.equal(isRecentThumbnailMap({ "/a.psd": "/tmp/a.jpg" }), false);
    assert.equal(isRecentThumbnailMap({ "/a.psd": 42 }), false);
    assert.equal(isRecentThumbnailMap(null), false);
  });

  it("drops previews whose file has left the list", () => {
    const thumbnails = {
      "/a.psd": "data:image/jpeg;base64,A",
      "/b.png": "data:image/jpeg;base64,B",
      "/gone.tif": "data:image/jpeg;base64,C"
    };
    const kept = pruneRecentThumbnailMap(thumbnails, [{ path: "/b.png" }, { path: "/a.psd" }]);
    assert.deepEqual(Object.keys(kept).sort(), ["/a.psd", "/b.png"]);
    assert.equal(kept["/a.psd"], "data:image/jpeg;base64,A");
  });

  it("keeps a preview with its file when the list re-orders", () => {
    // Previews are keyed by path, so promoting a file to the front cannot hand
    // its picture to a different entry. Keying by list position could.
    const thumbnails = {
      "/a.psd": "data:image/jpeg;base64,A",
      "/b.png": "data:image/jpeg;base64,B"
    };
    const reordered = buildRecentFileListAfterOpen(
      [{ path: "/a.psd", name: "a" }, { path: "/b.png", name: "b" }],
      { path: "/b.png", name: "b", openedAt: 2 }
    );
    assert.deepEqual(reordered.map((row) => row.path), ["/b.png", "/a.psd"]);
    const kept = pruneRecentThumbnailMap(thumbnails, reordered);
    assert.equal(kept["/b.png"], "data:image/jpeg;base64,B");
    assert.equal(kept["/a.psd"], "data:image/jpeg;base64,A");
  });
});
