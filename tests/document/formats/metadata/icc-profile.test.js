import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ICC } from "../../../../src/document/formats/metadata/icc-profile.js";

describe("document/formats/metadata/icc-profile.js", () => {
  it("parse reads header fields from minimal buffer", () => {
    const bytes = new Uint8Array(132);
    bytes[8] = 0x02;
    bytes[9] = 0x10;
    const profile = ICC.parse(bytes.buffer);
    assert.equal(profile.header.version, "2.1.0");
    assert.ok(profile.tags);
  });

  it("exports ICC helpers", () => {
    assert.equal(typeof ICC.parse, "function");
    assert.equal(typeof ICC.applyLUT, "function");
  });
});
