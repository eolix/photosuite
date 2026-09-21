import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { XcfPropType } from "../../../../src/document/formats/metadata/xcf-prop-type.js";

describe("document/formats/metadata/xcf-prop-type.js", () => {
  it("exposes XCF PropType and compression id constants", () => {
    assert.equal(XcfPropType.PROP_END, 0);
    assert.equal(XcfPropType.PROP_SELECTION, 4);
    assert.equal(XcfPropType.PROP_PARASITES, 21);
    assert.equal(XcfPropType.PROP_FLOAT_COLOR, 38);
    assert.equal(XcfPropType.COMPRESS_RLE, 1);
    assert.equal(XcfPropType.COMPRESS_ZLIB, 2);
  });

  it("maps GIMP layer mode indices to PSD blend codes", () => {
    assert.equal(XcfPropType.psdBlendModeCodes[0], "norm");
    assert.equal(XcfPropType.psdBlendModeCodes[3], "mul ");
    assert.equal(XcfPropType.psdBlendModeCodes[4], "scrn");
    assert.equal(XcfPropType.psdBlendModeCodes.at(-1), "pass");
    assert.equal(XcfPropType.psdBlendModeCodes.length, 62);
  });
});
