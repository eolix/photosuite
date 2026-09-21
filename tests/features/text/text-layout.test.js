/**
 * Golden values for TextLayout CJK classification.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TextLayout;

before(async () => {
  ({ TextLayout } = await import("../../../src/features/text/text-layout.js"));
});

describe("features/text/text-layout.js", () => {
  it("isCJK matches CJK unified ideographs and punctuation", () => {
    assert.equal(TextLayout.isCJK(0x4e00), true);
    assert.equal(TextLayout.isCJK(65), false);
    assert.equal(TextLayout.isCJK(0x3000), true);
  });

  it("exposes path helpers used by text tools", () => {
    assert.equal(typeof TextLayout.computePathData, "function");
    assert.equal(TextLayout.findPathIndex(0.5, [0, 0.2, 0.5, 0.9, 1]), 2);
  });
});
