/**
 * file-name splitting and size formatting shared by document loading, saving
 * and exporting.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

let basenameFromPath;
let fileExtension;
let stripFileExtension;
let replaceFileExtension;
let formatByteSize;

before(async () => {
  ({
    basenameFromPath,
    fileExtension,
    stripFileExtension,
    replaceFileExtension,
    formatByteSize
  } = await import("../../src/core/file-names.js"));
});

describe("core/file-names.js", () => {
  it("basenameFromPath takes the last segment of posix and windows paths", () => {
    assert.equal(basenameFromPath("/home/pat/photos/sun.jpg"), "sun.jpg");
    assert.equal(basenameFromPath("C:\\photos\\sun.jpg"), "sun.jpg");
    assert.equal(basenameFromPath("sun.jpg"), "sun.jpg");
  });

  it("fileExtension reads the final extension, lowercased", () => {
    assert.equal(fileExtension("Sun.JPG"), "jpg");
    assert.equal(fileExtension("my.photo.tar.gz"), "gz");
    assert.equal(fileExtension("sun"), "");
    // A dotfile is a name, not an extension.
    assert.equal(fileExtension(".gitignore"), "");
  });

  it("stripFileExtension removes only the final extension", () => {
    assert.equal(stripFileExtension("my.photo.jpg"), "my.photo");
    assert.equal(stripFileExtension("sun"), "sun");
    assert.equal(stripFileExtension(".gitignore"), ".gitignore");
  });

  it("replaceFileExtension swaps the extension in place", () => {
    assert.equal(replaceFileExtension("sun.jpg", "psd"), "sun.psd");
    assert.equal(replaceFileExtension("sun", "psd"), "sun.psd");
  });

  // Shown next to an export preview and in the stored-resources list, so the
  // unit steps at 1024 and always carries one decimal.
  it("formatByteSize picks the largest binary unit under 1024", () => {
    assert.equal(formatByteSize(0), "0.0 B");
    assert.equal(formatByteSize(64), "64.0 B");
    assert.equal(formatByteSize(1024), "1.0 KB");
    assert.equal(formatByteSize(1536), "1.5 KB");
    assert.equal(formatByteSize(1048576), "1.0 MB");
  });
});
