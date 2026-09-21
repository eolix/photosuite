import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let PagedDocParser;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  ({ PagedDocParser } = await import("../../../../src/document/formats/metadata/paged-doc-parser.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/metadata/paged-doc-parser.js", () => {
  it("exports parse entry point", () => {
    assert.equal(typeof PagedDocParser.parse, "function");
  });

  it("stripImmutablePrefix maps MSImmutableFoo to MSFoo", () => {
    assert.equal(PagedDocParser.stripImmutablePrefix("MSImmutablePage"), "MSPage");
    assert.equal(PagedDocParser.stripImmutablePrefix("MSPage"), "MSPage");
  });

  it("decodeLatin1 reads bytes as per-byte char codes", () => {
    assert.equal(PagedDocParser.decodeLatin1(new Uint8Array([72, 105, 33]), 0, 3), "Hi!");
    assert.equal(PagedDocParser.decodeLatin1(new Uint8Array([0, 65, 66]), 1, 2), "AB");
  });

  it("resolveBinaryFileReference finds the first matching extension", () => {
    const zipEntries = { "img/1.png": new Uint8Array([1, 2]) };
    assert.deepEqual(
      PagedDocParser.resolveBinaryFileReference("img/1", zipEntries, {}),
      { key: "1", bdata: zipEntries["img/1.png"] },
    );
    assert.equal(PagedDocParser.resolveBinaryFileReference("img/missing", {}, {}), undefined);
  });

  it("resolveBinaryFileReference prefers png over later extensions and bare path", () => {
    const zipEntries = { "a/b": new Uint8Array([9]), "a/b.jpg": new Uint8Array([7]) };
    const ref = PagedDocParser.resolveBinaryFileReference("a/b", zipEntries, {});
    // No .png, so .jpg wins over the bare path.
    assert.deepEqual(ref, { key: "b", bdata: zipEntries["a/b.jpg"] });
  });
});
