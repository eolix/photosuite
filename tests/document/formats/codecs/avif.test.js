import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let hasAvifCompatibleBrand;
let avifCodec;
let detectFormat;
let restoreBrowserGlobals;

/** Minimal ISOBMFF `ftyp` box with major brand `avif`. */
function buildMinimalAvifFtypBuffer() {
  const bytes = new Uint8Array(32);
  bytes[4] = 102; // f
  bytes[5] = 116; // t
  bytes[6] = 121; // y
  bytes[7] = 112; // p
  bytes[8] = 97; // a
  bytes[9] = 118; // v
  bytes[10] = 105; // i
  bytes[11] = 102; // f
  return bytes.buffer;
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ hasAvifCompatibleBrand, avifCodec } = await import(
    "../../../../src/document/formats/codecs/avif.js"
  ));
  ({ detectFormat } = await import(
    "../../../../src/document/formats/registry/registry-helpers.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/avif.js", () => {
  it("hasAvifCompatibleBrand matches avif major brand", () => {
    const bytes = new Uint8Array(buildMinimalAvifFtypBuffer());
    assert.equal(hasAvifCompatibleBrand(bytes), true);
  });

  it("hasAvifCompatibleBrand rejects HEIC-style ftyp without avif brands", () => {
    const bytes = new Uint8Array(32);
    bytes[4] = 102;
    bytes[5] = 116;
    bytes[6] = 121;
    bytes[7] = 112;
    bytes[8] = 104; // h
    bytes[9] = 101; // e
    bytes[10] = 105; // i
    bytes[11] = 99; // c
    assert.equal(hasAvifCompatibleBrand(bytes), false);
  });

  it("detectFormat returns avif for compatible ftyp", () => {
    assert.equal(detectFormat(buildMinimalAvifFtypBuffer()), "avif");
  });

  it("decode throws until decodeAsync populates the cache", () => {
    const buffer = buildMinimalAvifFtypBuffer();
    assert.throws(
      () => avifCodec.decode(buffer),
      /decodeAsync first/,
    );
  });
});
