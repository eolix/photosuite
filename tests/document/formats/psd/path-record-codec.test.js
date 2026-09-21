import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Point } from "../../../../src/core/math/point.js";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let PathRecordCodec;
let restoreBrowserGlobals;

/** Golden values for PathRecordCodec. */
const GOLDEN_SERIALIZED_PATH = [
  { type: 6 },
  { type: 0, length: 2, frule: 1, subpathHeaderFlags: 2, subpathUint32A: 0, subpathUint32B: 0 },
  { type: 1, c: [0, 0, 10, 20, 30, 40] },
  { type: 8, all: 0 },
];

const GOLDEN_CREATE_BOUNDS = [0, 0, 50, 50];
const GOLDEN_CREATE_CATEGORY = "play";
const GOLDEN_CREATE_PATH_TYPES = [6, 8, 0, 1, 1, 1];

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ PathRecordCodec } = await import(
    "../../../../src/document/formats/psd/path-record-codec.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

function samplePathRecords() {
  return [
    { type: 6 },
    {
      type: 0,
      length: 2,
      fillRule: 1,
      subpathHeaderFlags: 2,
      subpathUint32A: 0,
      subpathUint32B: 0,
    },
    { type: 1, cp1: new Point(0, 0), anchor: new Point(10, 20), anchorOut: new Point(30, 40) },
    { type: 8, all: 0 },
  ];
}

describe("document/formats/psd/path-record-codec.js", () => {
  it("PathRecordCodec.create matches golden defaults", () => {
    const preset = PathRecordCodec.create();
    assert.deepEqual(
      [preset.boundsRect.x, preset.boundsRect.y, preset.boundsRect.width, preset.boundsRect.height],
      GOLDEN_CREATE_BOUNDS,
    );
    assert.equal(preset.shapeName, "");
    assert.equal(preset.categoryName, GOLDEN_CREATE_CATEGORY);
    assert.deepEqual(preset.pathRecords.map((record) => record.type), GOLDEN_CREATE_PATH_TYPES);
  });

  it("pathToSerializable matches golden wire JSON shape", () => {
    const serialized = PathRecordCodec.pathToSerializable(samplePathRecords());
    assert.deepEqual(serialized, GOLDEN_SERIALIZED_PATH);
  });

  it("serializableToPath round-trips golden serialized knots", () => {
    const pathRecords = PathRecordCodec.serializableToPath(GOLDEN_SERIALIZED_PATH);
    assert.equal(pathRecords[2].anchor.x, 10);
    assert.equal(pathRecords[2].anchor.y, 20);
    assert.deepEqual(PathRecordCodec.pathToSerializable(pathRecords), GOLDEN_SERIALIZED_PATH);
  });

  it("writePathPoints / readPathPoints round-trip bezier and header knots", () => {
    const pathRecords = samplePathRecords();
    const buffer = new Uint8Array(26 * pathRecords.length);
    PathRecordCodec.writePathPoints(buffer, 0, pathRecords, 1, 1);
    const parsed = PathRecordCodec.readPathPoints(buffer, 0, buffer.length, 1, 1);
    assert.deepEqual(
      parsed.map((record) => record.type),
      [6, 0, 1, 8],
    );
    assert.equal(parsed[2].anchor.x, 10);
    assert.equal(parsed[2].anchor.y, 20);
    assert.equal(parsed[2].cp1.x, 0);
    assert.equal(parsed[2].anchorOut.x, 30);
  });

});
