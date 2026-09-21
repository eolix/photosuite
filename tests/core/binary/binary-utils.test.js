import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BinaryUtils } from "../../../src/core/binary/binary-utils.js";

describe("core/binary/binary-utils.js", () => {
  it("fourCC round-trip", () => {
    const code = "8BIM";
    assert.equal(BinaryUtils.uint32ToFourCC(BinaryUtils.fourCCToUint32(code)), code);
  });

  it("read/write uint16 LE raw", () => {
    const buf = new Uint8Array(2);
    BinaryUtils.writeUint16LEraw(buf, 0, 0x1234);
    assert.equal(BinaryUtils.readUint16LE(buf, 0), 0x1234);
  });

  it("readUtf8 decodes ASCII", () => {
    const bytes = new Uint8Array([72, 105]);
    assert.equal(BinaryUtils.readUtf8(bytes, 0, 2), "Hi");
  });
});
