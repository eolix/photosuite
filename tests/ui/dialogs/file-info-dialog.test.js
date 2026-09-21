/**
 * Golden I/O for FileInfoDialog XMP display helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FileInfoDialog;

before(async () => {
  ({ FileInfoDialog } = await import("../../../src/ui/dialogs/file-info-dialog.js"));
});

describe("ui/dialogs/file-info-dialog.js", () => {
  it("formatXmpDisplayName matches goldens", () => {
    assert.equal(FileInfoDialog.formatXmpDisplayName("exif:GPSLatitude"), "GPS Latitude");
    assert.equal(FileInfoDialog.formatXmpDisplayName("tiff:ImageDescription"), "Image Description");
  });

  it("parseExifGpsRationalToDecimal matches goldens", () => {
    assert.equal(FileInfoDialog.parseExifGpsRationalToDecimal("40,26,46.302N"), 40.446194999999996);
    assert.equal(FileInfoDialog.parseExifGpsRationalToDecimal("79,56,55.903W"), -79.94886194444445);
  });
});
