/**
 * Golden values for contour-file (.shc codec).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { createCurvePoint } from "../../../src/engine/compositing/tone-curves.js";

installBrowserGlobals();

let ContourParser;
let BinaryUtils;
let RenderBuffer;

/** One renamed two-point contour as produced by serialize([contour]). */
const SERIALIZED_RENAMED_CONTOUR = [
  56, 66, 70, 83, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 8, 0, 82, 0, 101, 0, 110, 0, 97, 0, 109, 0,
  101, 0, 100, 0, 0, 0, 2, 0, 2, 0, 0, 0, 0, 0, 255, 0, 255, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
];

const SERIALIZED_EMPTY = [56, 66, 70, 83, 0, 1, 0, 0, 0, 0];

function sampleContour(name) {
  const pointA = createCurvePoint(0, 0, true);
  const pointB = createCurvePoint(255, 255, true);
  return {
    classID: "ShpC",
    Nm: { t: "TEXT", v: name },
    Crv: { t: "VlLs", v: [pointA, pointB] },
  };
}

before(async () => {
  ({ ContourParser } = await import("../../../src/features/layer-styles/contour-file.js"));
  await import("../../../src/engine/layer-system.js");
  ({ BinaryUtils } = await import("../../../src/core/binary/binary-utils.js"));
  ({ RenderBuffer } = await import("../../../src/core/render-buffer.js"));
});

describe("features/layer-styles/contour-file.js", () => {
  it("setName updates descriptor Nm", () => {
    const contour = sampleContour("Linear");
    ContourParser.setName(contour, "Renamed");
    assert.equal(contour.Nm.v, "Renamed");
  });

  it("serialize writes 8BFS bytes matching the golden bytes", () => {
    const contour = sampleContour("Linear");
    ContourParser.setName(contour, "Renamed");
    const bytes = new Uint8Array(ContourParser.serialize([contour]));
    assert.equal(bytes.byteLength, 56);
    assert.deepEqual([...bytes], SERIALIZED_RENAMED_CONTOUR);
    assert.deepEqual([...new Uint8Array(ContourParser.serialize([]))], SERIALIZED_EMPTY);
  });

  it("parse round-trips serialize and reads points-only entry format", () => {
    const contour = sampleContour("Linear");
    ContourParser.setName(contour, "Renamed");
    const parsed = ContourParser.parse(ContourParser.serialize([contour]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].Nm.v, "Renamed");
    assert.equal(parsed[0].classID, "ShpC");
    assert.equal(parsed[0].Crv.v.length, 2);
    assert.equal(parsed[0].Crv.v[0].v.Hrzn.v, 0);
    assert.equal(parsed[0].Crv.v[0].v.Vrtc.v, 0);
    assert.equal(parsed[0].Crv.v[0].v.Cnty.v, true);
    assert.equal(parsed[0].Crv.v[1].v.Hrzn.v, 255);
    assert.equal(parsed[0].Crv.v[1].v.Vrtc.v, 255);
    assert.equal(parsed[0].Crv.v[1].v.Cnty.v, true);

    // Hand-built points-only entry (format 1): no continuity bytes after coords.
    const pointsOnly = new RenderBuffer();
    let cursor = 0;
    BinaryUtils.writeAscii(pointsOnly, cursor, "8BFS");
    cursor += 4;
    BinaryUtils.writeUint16(pointsOnly, cursor, 1);
    cursor += 2;
    BinaryUtils.writeSize(pointsOnly, cursor, 1);
    cursor += 4;
    BinaryUtils.writeSize(pointsOnly, cursor, 1);
    cursor += 4;
    BinaryUtils.writeUnicodeString(pointsOnly, cursor, "A\0");
    cursor += 4 + 1 * 2 + 2;
    BinaryUtils.writeUint16(pointsOnly, cursor, 2);
    cursor += 2;
    BinaryUtils.writeUint16(pointsOnly, cursor, 1);
    cursor += 2;
    BinaryUtils.writeUint16(pointsOnly, cursor, 10);
    cursor += 2;
    BinaryUtils.writeUint16(pointsOnly, cursor, 20);
    cursor += 2;
    BinaryUtils.writeSize(pointsOnly, cursor, 0);
    cursor += 4;
    BinaryUtils.writeSize(pointsOnly, cursor, 0);
    cursor += 4;
    const pointsOnlyParsed = ContourParser.parse(pointsOnly.data.slice(0, cursor).buffer);
    assert.equal(pointsOnlyParsed.length, 1);
    assert.equal(pointsOnlyParsed[0].Nm.v, "A");
    assert.equal(pointsOnlyParsed[0].Crv.v.length, 1);
    assert.equal(pointsOnlyParsed[0].Crv.v[0].v.Vrtc.v, 10);
    assert.equal(pointsOnlyParsed[0].Crv.v[0].v.Hrzn.v, 20);
    assert.equal(pointsOnlyParsed[0].Crv.v[0].v.Cnty.v, true);
  });
});
