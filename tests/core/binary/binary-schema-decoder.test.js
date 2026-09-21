import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BinarySchemaDecoder } from "../../../src/core/binary/binary-schema-decoder.js";

describe("core/binary/binary-schema-decoder.js", () => {
  it("throws on non-ASCII schema name byte", () => {
    const bytes = new Uint8Array([0, 128, 0]);
    assert.throws(() => BinarySchemaDecoder.parseSchema(bytes), /non-ASCII/);
  });
});
