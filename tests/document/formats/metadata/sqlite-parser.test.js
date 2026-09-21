import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SqliteParser } from "../../../../src/document/formats/metadata/sqlite-parser.js";

describe("document/formats/metadata/sqlite-parser.js", () => {
  it("readVarint decodes single- and multi-byte base-128 varints", () => {
    assert.deepEqual(SqliteParser.readVarint(new Uint8Array([5]), 0), { value: 5, byteCount: 1 });
    assert.deepEqual(SqliteParser.readVarint(new Uint8Array([0x81, 0x01]), 0), { value: 129, byteCount: 2 });
    // Leading byte ignored, offset honored.
    assert.deepEqual(SqliteParser.readVarint(new Uint8Array([0xff, 0x00]), 1), { value: 0, byteCount: 1 });
  });

  it("parseRecord decodes a record header and typed column values", () => {
    // header-size 3, serial types [null(0), int8(1)], value 5.
    const record = SqliteParser.parseRecord(new Uint8Array([3, 0, 1, 5]), 4);
    assert.deepEqual(record, [null, 5]);
  });

  it("parseRecord reads a short UTF-8 string column", () => {
    // header-size 2, serial type 19 → text length (19-13)/2 = 3 ("abc").
    const record = SqliteParser.parseRecord(new Uint8Array([2, 19, 97, 98, 99]), 5);
    assert.deepEqual(record, ["abc"]);
  });

  it("parseSqliteHeader validates the signature and reads the page size", () => {
    const bytes = new Uint8Array(100);
    // Signature bytes checked by the header parser.
    bytes[18] = 1; bytes[19] = 1; bytes[20] = 0; bytes[21] = 64; bytes[22] = 32; bytes[23] = 32;
    // pageSize = 4096 (uint16 BE at offset 16).
    bytes[16] = 0x10; bytes[17] = 0x00;
    // textEncoding = 1 (uint32 BE at offset 56).
    bytes[59] = 1;

    const header = SqliteParser.parseSqliteHeader(bytes);
    assert.equal(header.pageSize, 4096);
    assert.equal(header.textEncoding, 1);
  });

  it("parseSqliteHeader rejects a bad signature", () => {
    assert.throws(() => SqliteParser.parseSqliteHeader(new Uint8Array(100)), /unexpected SQL3 header/);
  });
});
