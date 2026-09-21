import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IFFParser, RIFFParser } from "../../../../src/document/formats/metadata/chunk-container-parser.js";

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

describe("document/formats/metadata/chunk-container-parser.js", () => {
  it("IFFParser parses a FORM container (big-endian sizes) with a child chunk", () => {
    const child = [...ascii("BMHD"), ...u32be(4), ...ascii("DATA")];
    const body = [...ascii("ILBM"), ...child];
    const bytes = new Uint8Array([...ascii("FORM"), ...u32be(body.length), ...body]);

    const tree = IFFParser.parse(bytes.buffer);
    assert.equal(tree.tag, "FORM");
    assert.equal(tree.listType, "ILBM");
    assert.equal(tree.sub.length, 1);
    assert.equal(tree.sub[0].tag, "BMHD");
    assert.equal(tree.sub[0].size, 4);
    assert.equal(tree.sub[0].dataOffset, 20);
  });

  it("IFFParser throws when a chunk size overflows the buffer", () => {
    const bytes = new Uint8Array([...ascii("FORM"), ...u32be(9999), ...ascii("ILBM")]);
    assert.throws(() => IFFParser.parse(bytes.buffer), /chunk size exceeds buffer/);
  });

  it("RIFFParser parses a RIFF container (little-endian sizes) and recurses", () => {
    const child = [...ascii("VP8L"), ...u32le(2), 9, 9];
    const body = [...ascii("WEBP"), ...child];
    const bytes = new Uint8Array([...ascii("RIFF"), ...u32le(body.length), ...body]);

    const tree = RIFFParser.parse(bytes.buffer);
    assert.equal(tree.tag, "RIFF");
    assert.equal(tree.listType, "WEBP");
    assert.equal(tree.sub.length, 1);
    assert.equal(tree.sub[0].tag, "VP8L");
    assert.equal(tree.sub[0].size, 2);
  });

  it("RIFFParser reads a cmpr LIST's type but keeps it opaque (no recursion)", () => {
    const bytes = new Uint8Array([...ascii("LIST"), ...u32le(8), ...ascii("cmpr"), 1, 2, 3, 4]);
    const tree = RIFFParser.parse(bytes.buffer);
    assert.equal(tree.tag, "LIST");
    assert.equal(tree.listType, "cmpr");
    assert.equal(tree.sub, undefined);
  });
});
