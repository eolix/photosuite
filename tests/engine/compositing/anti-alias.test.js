import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { boundsFromCoordPairs, canonicalPath, clonePath, douglasPeuckerSimplify, earClipTriangulate, filletCornerArcLengths, filletCornerBezierKnots, filletCornerControlPoints, findNearestVertexIndex, isCounterClockwiseTurn, isPolygonConvex, normalizePathToCubics, pathHasDrawCommands, pixelAlignRect, polygonScanlineXsAtY, rectToPathOutline, toTyprPath, transformCoordPairs } from "../../../src/engine/compositing/anti-alias.js";

const square = [0, 0, 100, 0, 100, 100, 0, 100];


describe("engine/compositing/anti-alias.js", () => {
  it("isPolygonConvex detects convex and concave polygons", () => {
    assert.equal(isPolygonConvex([0, 0, 100, 0, 100, 100, 0, 100]), true);
    assert.equal(isPolygonConvex([0, 0, 50, 50, 100, 0, 50, 25]), false);
  });

  it("isCounterClockwiseTurn classifies turn direction", () => {
    assert.equal(isCounterClockwiseTurn(0, 0, 1, 0, 1, 1), true);
    assert.equal(isCounterClockwiseTurn(0, 0, 1, 0, 1, -1), false);
  });

  it("findNearestVertexIndex returns closest vertex within radius", () => {
    assert.equal(findNearestVertexIndex(square, 3, 3, 10), 0);
    assert.equal(findNearestVertexIndex(square, 1000, 1000, 10), -1);
  });

  it("boundsFromCoordPairs builds axis-aligned bounds", () => {
    const bounds = boundsFromCoordPairs(square);
    assert.ok(bounds instanceof Rect);
    assert.equal(bounds.x, 0);
    assert.equal(bounds.y, 0);
    assert.equal(bounds.width, 100);
    assert.equal(bounds.height, 100);
  });

  it("rectToPathOutline produces closed rectangular path", () => {
    const outline = rectToPathOutline(new Rect(1, 2, 3, 4));
    assert.deepEqual(outline.commands, ["M", "L", "L", "L", "Z"]);
    assert.deepEqual(outline.coords, [1, 2, 4, 2, 4, 6, 1, 6]);
  });

  it("transformCoordPairs applies matrix to coordinate pairs", () => {
    const matrix = new Matrix2D(2, 0, 0, 2, 10, 20);
    const out = [];
    transformCoordPairs(square, matrix, out);
    assert.deepEqual(out, [10, 20, 210, 20, 210, 220, 10, 220]);
  });

  it("normalizePathToCubics converts line segments to cubics", () => {
    const normalized = normalizePathToCubics({
      commands: ["M", "L", "L", "Z"],
      coords: [0, 0, 10, 0, 10, 10],
    });
    assert.deepEqual(normalized, {
      commands: ["M", "C", "C", "Z"],
      coords: [0, 0, 0, 0, 10, 0, 10, 0, 10, 0, 10, 10, 10, 10],
    });
  });

  it("earClipTriangulate triangulates a square", () => {
    assert.deepEqual(earClipTriangulate(square), [0, 1, 2, 0, 2, 3]);
  });

  it("douglasPeuckerSimplify removes near-collinear points", () => {
    assert.deepEqual(
      douglasPeuckerSimplify([0, 0, 5, 0.01, 10, 0], 1),
      [0, 0, 10, 0],
    );
  });

  it("polygonScanlineXsAtY returns sorted edge crossings", () => {
    assert.deepEqual(polygonScanlineXsAtY(square, 50), [0, 100]);
  });

  it("toTyprPath maps wire aliases to Typr shape", () => {
    assert.deepEqual(toTyprPath({ K: ["M", "L"], H: [1, 2, 3, 4] }), {
      cmds: ["M", "L"],
      crds: [1, 2, 3, 4],
    });
  });

  it("pixelAlignRect snaps fractional bounds to pixel grid", () => {
    const aligned = pixelAlignRect(new Rect(0.2, 0.2, 1.5, 1.5));
    assert.ok(aligned instanceof Rect);
    assert.equal(aligned.x, 0);
    assert.equal(aligned.y, 0);
    assert.equal(aligned.width, 2);
    assert.equal(aligned.height, 2);
  });

  it("pathHasDrawCommands reports non-empty command lists", () => {
    assert.equal(pathHasDrawCommands({ commands: ["M"], coords: [0, 0] }), true);
    assert.equal(pathHasDrawCommands({ commands: [], coords: [] }), false);
  });

  it("clone returns a shallow copy of canonical path", () => {
    const src = { commands: ["M", "L"], coords: [0, 0, 1, 1] };
    const copy = clonePath(src);
    assert.notEqual(copy.commands, src.commands);
    assert.deepEqual(copy, { commands: ["M", "L"], coords: [0, 0, 1, 1] });
  });

  it("canonicalPath rejects null and undefined", () => {
    assert.throws(() => canonicalPath(null), /path is null or undefined/);
    assert.throws(() => canonicalPath(undefined), /path is null or undefined/);
  });

  it("fillet corner math matches captured goldens", () => {
    // Locks the round-corner bezier helpers to their captured values: a
    // fillet's arc lengths and knots feed the shape tools' corner radii.
    assert.deepEqual(
      filletCornerArcLengths(0, 0, 50, 0, 50, 50, 10),
      [10, -1, 0, 0, 1],
    );
    assert.deepEqual(
      filletCornerBezierKnots(0, 0, 50, 0, 50, 50, 10),
      [0, 0, 40, 0, 45.52284749830793, 0, 50, 4.477152501692067, 50, 10],
    );
    assert.deepEqual(
      filletCornerControlPoints(0, 0, 50, 0, 50, 50, 10, 10),
      [10, 0, 40, 0, 45.53, 0, 50, 4.47, 50, 10],
    );
  });
});
