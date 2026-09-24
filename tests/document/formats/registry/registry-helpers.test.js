import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let codecLoaders;
let detectFormat;
let installCodecLoaders;
let matchBytesAt;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ codecLoaders, detectFormat, installCodecLoaders, matchBytesAt } = await import(
    "../../../../src/document/formats/registry/registry-helpers.js"
  ));
});

/** A style library header: version, `8BSL`, then an empty pattern block. */
function buildAslBuffer(version) {
  const bytes = new Uint8Array(16);
  bytes[1] = version;
  bytes.set([0x38, 0x42, 0x53, 0x4c], 2);
  bytes[7] = 3;
  return bytes.buffer;
}

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/registry/registry-helpers.js", () => {
  it("installCodecLoaders merges into codecLoaders", () => {
    assert.equal(installCodecLoaders.length, 1);
    const marker = { id: "test-parser" };
    installCodecLoaders({ TestParser: marker });
    assert.equal(codecLoaders.TestParser, marker);
    delete codecLoaders.TestParser;
  });

  it("matchBytesAt compares a byte pattern at an offset", () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    assert.equal(matchBytesAt(bytes, [1, 2], 1), true);
    assert.equal(matchBytesAt(bytes, [9, 2], 1), false);
  });

  // Both library versions are in the wild. Matching the leading `00 02` instead
  // of the signature left every version-3 file undetected — the open path then
  // called a perfectly good style library an unknown format.
  it("detectFormat reads a style library at either version", () => {
    assert.equal(detectFormat(buildAslBuffer(2)), "asl");
    assert.equal(detectFormat(buildAslBuffer(3)), "asl");
  });

  // A version-2 header opens with the same two bytes as a swatch file, so the
  // signature check has to win over the `aco` magic.
  it("detectFormat still reads a swatch file", () => {
    const acoBytes = new Uint8Array(16);
    acoBytes[1] = 1;
    // Colour count: a zero here is also the opening of an OpenType header.
    acoBytes[3] = 2;
    assert.equal(detectFormat(acoBytes.buffer), "aco");
  });
});
