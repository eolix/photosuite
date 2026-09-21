import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let FileFormatRegistry;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ FileFormatRegistry } = await import(
    "../../../../src/document/formats/registry/file-format-registry.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/registry/file-format-registry.js", () => {
  it("exposes codec modules under readable property names", () => {
    assert.equal(FileFormatRegistry.pngCodec, FileFormatRegistry.getFormat("PNG"));
    assert.equal(FileFormatRegistry.psdCodec, FileFormatRegistry.getFormat("PSD"));
    assert.equal(FileFormatRegistry.aiCodec, FileFormatRegistry.getFormat("AI"));
  });

  it("wires registry API helpers", () => {
    assert.equal(typeof FileFormatRegistry.detectFormat, "function");
    assert.equal(typeof FileFormatRegistry.encodeDocument, "function");
    assert.equal(FileFormatRegistry.formatGroups.primary.includes("PNG"), true);
  });

  it("registers the AVIF import codec without an encode path", () => {
    const avifHandler = FileFormatRegistry.getFormat("AVIF");
    assert.equal(avifHandler, FileFormatRegistry.avifCodec);
    assert.equal(typeof avifHandler.decodeAsync, "function");
    assert.equal(avifHandler.encode, undefined);
  });

  it("registers the HEIC import codec without an encode path", () => {
    const heicHandler = FileFormatRegistry.getFormat("HEIC");
    assert.equal(typeof heicHandler.decodeAsync, "function");
    assert.equal(typeof heicHandler.decode, "function");
    assert.equal(heicHandler.encode, undefined);
    // Read-only formats stay out of the Save As / Export As lists.
    assert.equal(FileFormatRegistry.listSaveFormats().includes("HEIC"), false);
  });
});
