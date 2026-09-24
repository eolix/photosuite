/**
 * Format parsers arrive on demand, so the open path has to answer two questions
 * before it can decode: is this format's parser here, and if not, when will it
 * be? Getting the first one wrong means decoding with an undefined loader;
 * getting the second wrong means the file silently never opens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let codecLoaders;
let ensureFormatLoaders;
let hasFormatLoaders;
let lazyFormatIds;

before(async () => {
  ({ codecLoaders } = await import(
    "../../../../src/document/formats/registry/registry-helpers.js"
  ));
  ({ ensureFormatLoaders, hasFormatLoaders, lazyFormatIds } = await import(
    "../../../../src/document/formats/registry/format-loader-imports.js"
  ));
});

describe("document/formats/registry/format-loader-imports.js", () => {
  it("reports a format whose parser ships in the bundle as ready", () => {
    // PNG decodes with a codec that is always present, so nothing to fetch.
    assert.equal(hasFormatLoaders("png"), true);
    assert.equal(hasFormatLoaders("not-a-format"), true);
  });

  it("reports a deferred parser as missing until it is fetched", async () => {
    assert.equal(hasFormatLoaders("xcf"), false);
    await ensureFormatLoaders("xcf");
    assert.equal(hasFormatLoaders("xcf"), true);
    assert.equal(typeof codecLoaders.XCFParser, "object");
  });

  it("is case-insensitive, since a format id can come from a file extension", async () => {
    await ensureFormatLoaders("XCF");
    assert.equal(hasFormatLoaders("XCF"), true);
  });

  it("shares one fetch when the same format is asked for twice at once", async () => {
    const [first, second] = await Promise.all([
      ensureFormatLoaders("fpng"),
      ensureFormatLoaders("fpng"),
    ]);
    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(hasFormatLoaders("fpng"), true);
  });

  it("resolves immediately for a parser already installed", async () => {
    await ensureFormatLoaders("xcf");
    const before = codecLoaders.XCFParser;
    await ensureFormatLoaders("xcf");
    assert.equal(codecLoaders.XCFParser, before, "re-imported an installed parser");
  });

  // Smart objects, layer extraction and embedded AI patterns all round-trip
  // through the PSD writer from synchronous code that cannot await an import,
  // so PSD is installed at startup rather than on first open of a .psd.
  it("treats PSD and PSB as ready without fetching anything", async () => {
    assert.equal(hasFormatLoaders("psd"), true);
    assert.equal(hasFormatLoaders("psb"), true);
    assert.ok(!lazyFormatIds().includes("psd"));
    assert.ok(!lazyFormatIds().includes("psb"));
    assert.equal(await ensureFormatLoaders("psd"), undefined);
  });
});
