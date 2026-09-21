/**
 * Golden values for .csh ShapeFile parse / serialize.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ShapeFile;
let PathRecordCodec;

before(async () => {
  ({ ShapeFile } = await import("../../../src/features/shape/shape-file.js"));
  ({ PathRecordCodec } = await import("../../../src/document/formats/psd/path-record-codec.js"));
});

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function serializePathRecord(record) {
  if (record.type === 6) return { type: 6 };
  if (record.type === 8) return { type: 8, all: record.all };
  if (record.type === 0 || record.type === 3) {
    return {
      type: record.type,
      fillRule: record.fillRule,
      length: record.length,
      subpathUint32A: record.subpathUint32A,
      subpathUint32B: record.subpathUint32B,
      subpathHeaderFlags: record.subpathHeaderFlags,
    };
  }
  return {
    type: record.type,
    cp1: { x: record.cp1.x, y: record.cp1.y },
    anchor: { x: record.anchor.x, y: record.anchor.y },
    anchorOut: { x: record.anchorOut.x, y: record.anchorOut.y },
  };
}

// Golden values.
const EMPTY_SHAPE_HEX =
  "637573680000000200000001000000040043006100740000000000010000001403426f7800000000000000000000006400000064";

const TRI_SHAPE_HEX =
  "637573680000000200000001000000050070006c006100790000000000000001000000b00354726900000000000000000000003200000032000600000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000300010001000000000000000000000000000000000000000100199999001999990019999900199999001999990019999900010080000000e666660080000000e666660080000000e66666000100e666660019999900e666660019999900e6666600199999";

describe("features/shape/shape-file.js", () => {
  it("serialize empty path shape matches byte golden", () => {
    const buffer = ShapeFile.serialize([
      {
        categoryName: "Cat",
        shapeName: "Box",
        pathRecords: [],
        boundsRect: { x: 0, y: 0, width: 100, height: 100 },
      },
    ]);
    assert.equal(bufferToHex(buffer), EMPTY_SHAPE_HEX);
  });

  it("parse empty-path .csh matches shape entry", () => {
    const parsed = ShapeFile.parse(hexToBuffer(EMPTY_SHAPE_HEX));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].categoryName, "Cat");
    assert.equal(parsed[0].shapeName, "Box");
    assert.deepEqual(parsed[0].pathRecords, []);
    assert.equal(parsed[0].boundsRect.x, 0);
    assert.equal(parsed[0].boundsRect.y, 0);
    assert.equal(parsed[0].boundsRect.width, 100);
    assert.equal(parsed[0].boundsRect.height, 100);
  });

  it("serialize polygon shape matches byte golden", () => {
    const created = PathRecordCodec.create();
    const buffer = ShapeFile.serialize([
      {
        categoryName: "play",
        shapeName: "Tri",
        pathRecords: created.pathRecords,
        boundsRect: created.boundsRect,
      },
    ]);
    assert.equal(bufferToHex(buffer), TRI_SHAPE_HEX);
  });

  it("parse polygon .csh normalizes path coords to unit square", () => {
    const parsed = ShapeFile.parse(hexToBuffer(TRI_SHAPE_HEX));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].categoryName, "play");
    assert.equal(parsed[0].shapeName, "Tri");
    assert.equal(parsed[0].boundsRect.x, 0);
    assert.equal(parsed[0].boundsRect.y, 0);
    assert.equal(parsed[0].boundsRect.width, 50);
    assert.equal(parsed[0].boundsRect.height, 50);
    assert.deepEqual(parsed[0].pathRecords.map(serializePathRecord), [
      { type: 6 },
      { type: 8, all: 0 },
      {
        type: 0,
        fillRule: 1,
        length: 3,
        subpathUint32A: 0,
        subpathUint32B: 0,
        subpathHeaderFlags: 1,
      },
      {
        type: 1,
        cp1: { x: 0, y: 0 },
        anchor: { x: 0, y: 0 },
        anchorOut: { x: 0, y: 0 },
      },
      {
        type: 1,
        cp1: { x: 1, y: 0.5000000372529024 },
        anchor: { x: 1, y: 0.5000000372529024 },
        anchorOut: { x: 1, y: 0.5000000372529024 },
      },
      {
        type: 1,
        cp1: { x: 0, y: 1 },
        anchor: { x: 0, y: 1 },
        anchorOut: { x: 0, y: 1 },
      },
    ]);
  });

  it("setName updates categoryName", () => {
    const entry = { categoryName: "Old" };
    ShapeFile.setName(entry, "New");
    assert.equal(entry.categoryName, "New");
  });
});
