import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BinaryPlistParser, parseBinaryPlist } from "../../../src/document/formats/metadata/plist-parser.js";

const TRAILER_BYTE_COUNT = 31;

/** Build a minimal single-object bplist with 1-byte object refs. */
function buildSingleObjectPlist(objectByte) {
  const trailer = new Uint8Array(TRAILER_BYTE_COUNT);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer[15] = 1;

  const header = new TextEncoder().encode("bplist00");
  const objects = new Uint8Array([objectByte]);
  const ptrTable = new Uint8Array([8]);
  const bytes = new Uint8Array(
    header.length + objects.length + ptrTable.length + trailer.length
  );
  bytes.set(header, 0);
  bytes.set(objects, 8);
  bytes.set(ptrTable, 9);
  bytes.set(trailer, 10);
  return bytes;
}

describe("binary-plist-parser", () => {

  it("parses bool true", () => {
    const bytes = buildSingleObjectPlist(0x09);
    assert.equal(parseBinaryPlist(bytes, 0), true);
    assert.equal(BinaryPlistParser.parse(bytes, 0), true);
  });

  it("parses bool false", () => {
    const bytes = buildSingleObjectPlist(0x08);
    assert.equal(parseBinaryPlist(bytes, 0), false);
  });
});
