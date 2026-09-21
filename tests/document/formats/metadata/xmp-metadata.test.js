import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { XMPData } from "../../../../src/document/formats/metadata/xmp-metadata.js";

describe("document/formats/metadata/xmp-metadata.js", () => {
  it("rationalsToDecimals divides numerator by denominator", () => {
    assert.deepEqual(XMPData.rationalsToDecimals([[1, 2], [0, 5], [3, 1]]), [0.5, 0, 3]);
  });

  it("decimalsToRationals round-trips integers", () => {
    assert.deepEqual(XMPData.decimalsToRationals([0, 1, 42]), [[0, 1], [1, 1], [42, 1]]);
  });
});
