/**
 * recent-files normalization, cap, and age formatting.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

let normalizeRecentFileEntries;
let formatRecentFileAge;
let buildRecentFileListAfterOpen;
let findRecentFileIndex;
let MAX_RECENT_FILES;

before(async () => {
  ({
    normalizeRecentFileEntries,
    formatRecentFileAge,
    buildRecentFileListAfterOpen,
    findRecentFileIndex,
    MAX_RECENT_FILES
  } = await import("../../src/core/recent-files.js"));
});

describe("core/recent-files.js", () => {
  it("normalizeRecentFileEntries caps and skips invalid rows", () => {
    assert.equal(MAX_RECENT_FILES, 5);
    const normalized = normalizeRecentFileEntries([
      { path: "/a.psd", name: "a.psd", openedAt: 100 },
      { path: "", name: "skip" },
      null,
      { path: "/b.png", openedAt: 200 },
      { path: "/c.jpg" },
      { path: "/d.tif" },
      { path: "/e.gif" },
      { path: "/f.webp" }
    ]);
    assert.equal(normalized.length, 5);
    assert.equal(normalized[0].path, "/a.psd");
    assert.equal(normalized[1].name, "b.png");
    assert.equal(normalized[2].name, "c.jpg");
    // The path names the entry even when a stored row carries a stale title.
    assert.equal(normalizeRecentFileEntries([{ path: "/photos/sun.jpg", name: "sun-jpg.psd" }])[0].name, "sun.jpg");
  });

  it("normalizeRecentFileEntries ignores inline thumbnail blobs", () => {
    const normalized = normalizeRecentFileEntries([
      { path: "/a.psd", name: "a.psd", openedAt: 100, thumbnail: "data:image/jpeg;base64,abc" }
    ]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].thumbnail, undefined);
  });

  it("formatRecentFileAge buckets elapsed time", () => {
    const now = 1_700_000_000_000;
    assert.equal(formatRecentFileAge(now - 30_000, now), "Just now");
    assert.equal(formatRecentFileAge(now - 5 * 60_000, now), "5 minutes ago");
    assert.equal(formatRecentFileAge(now - 2 * 60 * 60_000, now), "2 hours ago");
    assert.equal(formatRecentFileAge(now - 3 * 24 * 60 * 60_000, now), "3 days ago");
    assert.equal(formatRecentFileAge(now - 40 * 24 * 60 * 60_000, now), "1 month ago");
  });

  it("buildRecentFileListAfterOpen moves duplicate path to front without extra row", () => {
    const rows = [
      { path: "/beach.psd", name: "beach.psd", openedAt: 500 },
      { path: "/a.png", name: "a.png", openedAt: 400 },
      { path: "/b.png", name: "b.png", openedAt: 300 }
    ];
    const reopened = buildRecentFileListAfterOpen(rows, {
      path: "/beach.psd",
      name: "beach.psd",
      openedAt: 900
    });
    assert.deepEqual(reopened.map(function(row) { return row.path; }), [
      "/beach.psd",
      "/a.png",
      "/b.png"
    ]);
    assert.equal(reopened[0].openedAt, 900);
    assert.equal(findRecentFileIndex(rows, "/beach.psd"), 0);
    assert.equal(findRecentFileIndex(rows, "/missing"), -1);
  });
});
