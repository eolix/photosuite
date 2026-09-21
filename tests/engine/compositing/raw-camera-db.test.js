/**
 * The shipped camera table: entries the RAW decoder looks a sensor up in.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { BAYER_PATTERNS, lookupCameraBySize, rationalsToFloats } from "../../../src/engine/compositing/raw-functions.js";
import { CAMERA_DATABASE } from "../../../src/engine/compositing/raw-camera-db.js";

installBrowserGlobals();

describe("engine/compositing/raw-camera-db.js", () => {
  // A four-element entry is matrix-only; a six-element one also carries the
  // sensor dimensions the size lookup matches on.
  it("holds the known Canon / GitUp entries", () => {
    assert.deepEqual(CAMERA_DATABASE["canon eos 100d"], [
      [6602, -841, -939, -4472, 12458, 2247, -975, 2039, 6148],
      1,
      2048,
      15e3,
    ]);
    assert.deepEqual(CAMERA_DATABASE["gitup git2"], [
      [8489, -2583, -1036, -8051, 15583, 2643, -1307, 1407, 7354],
      1,
      3200,
      65535,
      4608,
      3456,
    ]);
  });

  it("covers more than a hundred camera models", () => {
    assert.ok(Object.keys(CAMERA_DATABASE).length > 100);
  });
});

describe("engine/compositing/raw-functions.js camera helpers", () => {
  it("rationalsToFloats divides EXIF rational pairs", () => {
    assert.deepEqual(rationalsToFloats([[1, 2], [3, 4]]), [0.5, 0.75]);
    assert.deepEqual(rationalsToFloats([1, 2, 3]), [1, 2, 3]);
  });

  it("bayerPatterns lists the four 2\u00d72 CFA phases", () => {
    assert.deepEqual(BAYER_PATTERNS, [
      [2, 1, 1, 0],
      [0, 1, 1, 2],
      [1, 0, 2, 1],
      [1, 2, 0, 1],
    ]);
  });

  // The decoder identifies a sensor by how many bytes its frame occupies.
  it("lookupCameraBySize matches GitUp GIT2 at 16 bpp", () => {
    const entry = CAMERA_DATABASE["gitup git2"];
    const byteLength = (entry[4] * entry[5] * 16) / 8;
    assert.deepEqual(lookupCameraBySize(byteLength), ["gitup git2", 16]);
  });
});
