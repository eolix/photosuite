/**
 * canvas-widgets dial / curve coord goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let pointerOffsetToAngleAltitude;
let normalizeAngleDegrees;
let pointerToCurveCanvasCoords;
let DrawingCanvas;
let CurveEditor;

before(async () => {
  ({
    pointerOffsetToAngleAltitude,
    normalizeAngleDegrees,
    pointerToCurveCanvasCoords,
    DrawingCanvas,
    CurveEditor
  } = await import("../../../../src/ui/widgets/controls/canvas-widgets.js"));
});

describe("ui/widgets/controls/canvas-widgets.js", () => {
  it("pointerOffsetToAngleAltitude goldens", () => {
    var east = pointerOffsetToAngleAltitude(18, 0, 20);
    // atan2 can yield -0 before/after Math.round; coerce for comparison.
    assert.equal(east.angleDeg + 0, 0);
    assert.equal(east.altitudeDeg, 0);
    assert.deepEqual(pointerOffsetToAngleAltitude(0, -18, 20), {
      angleDeg: 90,
      altitudeDeg: 0
    });
    assert.deepEqual(pointerOffsetToAngleAltitude(9, -9, 20), {
      angleDeg: 45,
      altitudeDeg: 26
    });
  });

  it("normalizeAngleDegrees goldens", () => {
    assert.equal(normalizeAngleDegrees(45), 45);
    assert.equal(normalizeAngleDegrees(400), 40);
    assert.equal(normalizeAngleDegrees(-10), -10);
  });

  it("pointerToCurveCanvasCoords swapAxes goldens", () => {
    assert.deepEqual(pointerToCurveCanvasCoords(10, 20, false), {
      canvasX: 10,
      canvasY: 236
    });
    assert.deepEqual(pointerToCurveCanvasCoords(10, 20, true), {
      canvasX: 20,
      canvasY: 10
    });
  });

  it("exports DrawingCanvas and CurveEditor", () => {
    assert.equal(typeof DrawingCanvas, "function");
    assert.equal(typeof CurveEditor, "function");
  });
});
