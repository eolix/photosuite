/**
 * Golden values for .csh ShapeFile parse / serialize.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let ShapeFile;
let shapeAspectRatio;
let PathRecordCodec;

before(async () => {
  ({ ShapeFile, shapeAspectRatio } = await import("../../../src/features/shape/shape-file.js"));
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

  /** The created triangle's knots, stretched to twice as wide as they are tall. */
  function wideTrianglePathRecords() {
    const records = PathRecordCodec.create().pathRecords;
    for (const record of records) {
      for (const pointKey of ["cp1", "anchor", "anchorOut"]) {
        if (record[pointKey]) record[pointKey].x *= 2;
      }
    }
    return records;
  }

  // Parsing normalises the knots into the unit square, so the design box is the
  // only thing left that remembers a shape's proportions. The bundled icon
  // library records `bottom == top` for every entry, which left that box zero
  // pixels tall — every preview came out blank and every placement distorted.
  describe("design box", () => {
    it("falls back to the knots' own box when the library records a flat one", () => {
      const buffer = ShapeFile.serialize([
        {
          categoryName: "icons",
          shapeName: "wide",
          pathRecords: wideTrianglePathRecords(),
          boundsRect: { x: 0, y: 0, width: 512, height: 0 },
        },
      ]);
      const parsed = ShapeFile.parse(buffer)[0];
      assert.ok(parsed.boundsRect.width > 0, "width must be usable");
      assert.ok(parsed.boundsRect.height > 0, "a zero-height box flattens the shape");
      assert.equal(
        Math.round((parsed.boundsRect.width / parsed.boundsRect.height) * 100) / 100,
        2,
        "the knots' own proportions were not recovered",
      );
    });

    it("keeps a design box the library records properly", () => {
      const buffer = ShapeFile.serialize([
        {
          categoryName: "icons",
          shapeName: "wide",
          pathRecords: wideTrianglePathRecords(),
          boundsRect: { x: 0, y: 0, width: 300, height: 100 },
        },
      ]);
      const parsed = ShapeFile.parse(buffer)[0];
      assert.equal(parsed.boundsRect.width, 300);
      assert.equal(parsed.boundsRect.height, 100);
    });

    it("normalises a shape with no extent on one axis without NaN coords", () => {
      const records = PathRecordCodec.create().pathRecords;
      for (const record of records) {
        for (const pointKey of ["cp1", "anchor", "anchorOut"]) {
          if (record[pointKey]) record[pointKey].y = 10;
        }
      }
      const buffer = ShapeFile.serialize([
        { categoryName: "flat", shapeName: "line", pathRecords: records, boundsRect: { x: 0, y: 0, width: 50, height: 0 } },
      ]);
      const parsed = ShapeFile.parse(buffer)[0];
      for (const record of parsed.pathRecords) {
        if (!record.anchor) continue;
        assert.ok(Number.isFinite(record.anchor.x) && Number.isFinite(record.anchor.y), "a coord came out NaN");
      }
    });
  });

  // Every caller scales a unit-square path by this, so it is the last place a
  // bad design box can reach the geometry.
  describe("shapeAspectRatio", () => {
    it("reports the box's ratio, and 1 when there is none to trust", () => {
      assert.equal(shapeAspectRatio({ width: 200, height: 100 }), 2);
      assert.equal(shapeAspectRatio({ width: 100, height: 200 }), 0.5);
      assert.equal(shapeAspectRatio({ width: 512, height: 0 }), 1, "a flat box must not divide by zero");
      assert.equal(shapeAspectRatio({ width: 0, height: 0 }), 1);
      assert.equal(shapeAspectRatio({ width: -5, height: 10 }), 1);
      assert.equal(shapeAspectRatio(null), 1);
    });
  });

  // The library that ships with the app is the one every user opens the picker
  // onto.
  it("parses the bundled shape library with a usable box for every shape", () => {
    const libraryPath = path.join(repoRoot, "src/resources/libraries/shapes.csh");
    const fileBytes = fs.readFileSync(libraryPath);
    const shapes = ShapeFile.parse(
      fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
    );
    assert.ok(shapes.length > 100, "the bundled library did not parse");
    const flattened = shapes.filter((shape) => !(shape.boundsRect.width > 0 && shape.boundsRect.height > 0));
    assert.deepEqual(flattened.map((shape) => shape.categoryName), [], "shapes with an unusable design box");
  });

  // A `.csh` coordinate is 8.24 fixed point, so it holds about ±128 — writing a
  // 512-unit icon raw wrapped every value and shipped a library of scribble.
  // These icons are ones whose proportions are not in doubt.
  it("keeps the bundled icons' proportions", () => {
    const libraryPath = path.join(repoRoot, "src/resources/libraries/shapes.csh");
    const fileBytes = fs.readFileSync(libraryPath);
    const shapes = ShapeFile.parse(
      fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
    );
    const ratioOf = (categoryName) => {
      const shape = shapes.find((candidate) => candidate.categoryName === categoryName);
      assert.ok(shape, categoryName + " is missing from the library");
      return shapeAspectRatio(shape.boundsRect);
    };
    assert.ok(ratioOf("arrow-up (solid)") < 0.9, "arrow-up should be taller than it is wide");
    assert.ok(ratioOf("arrow-right (solid)") > 1.1, "arrow-right should be wider than it is tall");
    assert.ok(ratioOf("minus (solid)") > 4, "minus should be a long thin dash");
    assert.ok(Math.abs(ratioOf("circle (solid)") - 1) < 0.02, "circle should be square");
  });
});
