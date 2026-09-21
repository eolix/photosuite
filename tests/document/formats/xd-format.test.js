import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XDLoader;
let jsonToMatrix;
let shapeToPath;
let Matrix2D;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  const matrixMod = await import("../../../src/core/math/matrix2d.js");
  Matrix2D = matrixMod.Matrix2D;
  const mod = await import("../../../src/document/formats/xd-format.js");
  XDLoader = mod.XDLoader;
  jsonToMatrix = mod.jsonToMatrix;
  shapeToPath = mod.shapeToPath;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/xd-format.js", () => {

  it("jsonToMatrix returns identity for null input", () => {
    const matrix = jsonToMatrix(null);
    assert.ok(matrix instanceof Matrix2D);
    assert.equal(matrix.a, 1);
    assert.equal(matrix.d, 1);
  });

  it("jsonToMatrix maps XD transform JSON fields", () => {
    const matrix = jsonToMatrix({ a: 2, b: 0, c: 0, d: 3, tx: 10, ty: 20 });
    assert.equal(matrix.a, 2);
    assert.equal(matrix.d, 3);
    assert.equal(matrix.tx, 10);
    assert.equal(matrix.ty, 20);
  });

  it("shapeToPath builds rectangle path records", () => {
    const records = shapeToPath({ type: "rect", x: 5, y: 10, width: 20, height: 30 });
    assert.ok(records.length > 2);
    assert.equal(records[0].type, 6);
  });

  it("shapeToPath builds line path records", () => {
    const records = shapeToPath({ type: "line", x1: 0, y1: 0, x2: 100, y2: 50 });
    assert.ok(records.some((record) => record.type === 0));
  });
});
