/**
 * Golden values for tone-curves / curveUtils (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { applyLutToChannel, buildCurveTable, buildToneCurveLut, createCurvePoint, extractCurvePoints, padCurveLut, transformCurvePoints } from "../../../src/engine/compositing/tone-curves.js";

installBrowserGlobals();

let Matrix2D;

before(async () => {
  ({ Matrix2D } = await import("../../../src/core/math/matrix2d.js"));
});

describe("engine/compositing/tone-curves.js", () => {
  it("createCurvePoint builds CrPt descriptor", () => {
    assert.deepEqual(createCurvePoint(128, 180, true), {
      t: "Objc",
      v: {
        classID: "CrPt",
        Hrzn: { t: "doub", v: 128 },
        Vrtc: { t: "doub", v: 180 },
        Cnty: { t: "bool", v: true },
      },
    });
  });

  it("transformCurvePoints rounds mapped Hrzn/Vrtc", () => {
    const pts = [
      createCurvePoint(0, 0, true),
      createCurvePoint(64, 32, true),
      createCurvePoint(192, 220, true),
      createCurvePoint(255, 255, true),
    ];
    transformCurvePoints(pts, new Matrix2D(1, 0, 0, 1, 10, -5));
    assert.deepEqual(
      pts.map((p) => [p.v.Hrzn.v, p.v.Vrtc.v]),
      [
        [10, -5],
        [74, 27],
        [202, 215],
        [265, 250],
      ],
    );
  });

  it("buildToneCurveLut identity and S-curve samples", () => {
    const identity = [createCurvePoint(0, 0, true), createCurvePoint(255, 255, true)];
    assert.deepEqual(
      buildToneCurveLut(identity, 5).map((v) => +v.toFixed(6)),
      [0, 0.25, 0.5, 0.75, 1],
    );
    const sCurve = [
      createCurvePoint(0, 0, true),
      createCurvePoint(64, 40, true),
      createCurvePoint(192, 215, true),
      createCurvePoint(255, 255, true),
    ];
    const lut = buildToneCurveLut(sCurve, 256);
    assert.deepEqual(
      [0, 32, 64, 128, 192, 255].map((i) => +lut[i].toFixed(6)),
      [0, 0.060993, 0.156863, 0.499805, 0.843137, 1],
    );
  });

  it("buildCurveTable / applyLutToChannel / broken continuity", () => {
    const sCurve = [
      createCurvePoint(0, 0, true),
      createCurvePoint(64, 40, true),
      createCurvePoint(192, 215, true),
      createCurvePoint(255, 255, true),
    ];
    const table = buildCurveTable(sCurve, 256, false);
    assert.deepEqual(
      [0, 32, 64, 128, 192, 255].map((i) => table[i]),
      [0, 15, 40, 127, 215, 255],
    );
    const soft = buildCurveTable(sCurve, 256, true);
    assert.deepEqual([soft[0], soft[1], soft[2]], [0, 0, 0]);
    assert.deepEqual(Array.from(applyLutToChannel(new Uint8Array([0, 64, 128, 255]), table)), [
      0, 40, 127, 255,
    ]);
    const broken = [
      createCurvePoint(0, 0, true),
      createCurvePoint(100, 50, false),
      createCurvePoint(255, 255, true),
    ];
    assert.deepEqual(extractCurvePoints(broken), {
      knotX: [0, 100, 255],
      knotY: [0, 50, 255],
      continuity: [true, false, true],
    });
    assert.deepEqual(
      buildToneCurveLut(broken, 8).map((v) => +v.toFixed(6)),
      [0, 0.071429, 0.142857, 0.24424, 0.43318, 0.62212, 0.81106, 1],
    );
  });

  it("padCurveLut extends trailing edge", () => {
    assert.deepEqual(
      padCurveLut([0.1, 0.2, 0.3, 0.4, 0.5], 8, false).map((v) => +v.toFixed(6)),
      [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.5, 0.5],
    );
  });
});
