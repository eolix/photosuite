import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let codecLoaders;
let installCodecLoaders;
let matchBytesAt;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ codecLoaders, installCodecLoaders, matchBytesAt } = await import(
    "../../../../src/document/formats/registry/registry-helpers.js"
  ));
});

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
});
