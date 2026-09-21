/**
 * Golden values for key-origins (compositing / PSD descriptor helpers).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";
import { matrix2DToHomography } from "../../../src/engine/compositing/homography.js";
import { countSubpaths, usesEvenOddFill } from "../../../src/engine/compositing/path-records.js";
import { assignKeyOriginIndices, bboxArrayFromKeyOrigin, rebuildVectorMaskFromKeyOrigins, buildKeyOriginDescriptor, buildKeyOriginFromGeom, cornerRadiiFromKeyOrigin, cornerRadiiFromUnitQuad, createEmptyKeyOrigin, createForSubpaths, invalidateKeyOriginAtIndex, keyOriginFromShapeDescriptor, lineEndpointsFromKeyOrigin, transformKeyOriginsWithMatrix, unitRectToBBoxArray } from "../../../src/engine/compositing/key-origins.js";


describe("key-origins", () => {
  it("createEmpty / assign / invalidate goldens", () => {
    const empty = createEmptyKeyOrigin();
    assert.deepEqual(empty, {
      t: "Objc",
      v: {
        classID: "null",
        keyOriginIndex: { t: "long", v: 0 },
        keyShapeInvalidated: { t: "bool", v: true },
      },
    });
    const list = [createEmptyKeyOrigin(), createEmptyKeyOrigin()];
    assignKeyOriginIndices(list);
    assert.deepEqual(
      list.map((origin) => origin.v.keyOriginIndex.v),
      [0, 1],
    );
    invalidateKeyOriginAtIndex(list, 0);
    assert.equal(list[0].v.keyShapeInvalidated.v, true);
  });

  it("unitRect / radii / geom builders goldens", () => {
    assert.deepEqual(
      unitRectToBBoxArray({
        Left: { t: "UntF", v: { type: "#Pxl", val: 10 } },
        Top: { t: "UntF", v: { type: "#Pxl", val: 20 } },
        Rght: { t: "UntF", v: { type: "#Pxl", val: 110 } },
        Btom: { t: "UntF", v: { type: "#Pxl", val: 80 } },
      }),
      [10, 20, 110, 80],
    );
    assert.deepEqual(
      cornerRadiiFromUnitQuad({
        topLeft: { t: "UntF", v: { type: "#Pxl", val: 1 } },
        topRight: { t: "UntF", v: { type: "#Pxl", val: 2 } },
        bottomRight: { t: "UntF", v: { type: "#Pxl", val: 3 } },
        bottomLeft: { t: "UntF", v: { type: "#Pxl", val: 4 } },
      }),
      [1, 2, 3, 4],
    );
    const rectOrigin = buildKeyOriginFromGeom(2, [10, 20, 110, 80], [5, 5, 5, 5], null, 0);
    assert.equal(rectOrigin.v.keyOriginType.v, 2);
    assert.deepEqual(bboxArrayFromKeyOrigin(rectOrigin.v), [10, 20, 110, 80]);
    assert.deepEqual(cornerRadiiFromKeyOrigin(rectOrigin.v), [5, 5, 5, 5]);
    const lineOrigin = buildKeyOriginFromGeom(4, null, null, [0, 0, 100, 50], 3);
    assert.deepEqual(lineEndpointsFromKeyOrigin(lineOrigin.v), [0, 0, 100, 50]);
    assert.deepEqual(bboxArrayFromKeyOrigin(lineOrigin.v), [0, 0, 100, 50]);
    assert.equal(lineOrigin.v.keyOriginLineWeight.v, 3);
  });

  it("descriptor round-trips and classID mapping", () => {
    const fromDesc = keyOriginFromShapeDescriptor({
      t: "Objc",
      v: {
        classID: "Rctn",
        Left: { t: "UntF", v: { type: "#Pxl", val: 1 } },
        Top: { t: "UntF", v: { type: "#Pxl", val: 2 } },
        Rght: { t: "UntF", v: { type: "#Pxl", val: 11 } },
        Btom: { t: "UntF", v: { type: "#Pxl", val: 22 } },
      },
    });
    assert.deepEqual(bboxArrayFromKeyOrigin(fromDesc.v), [1, 2, 11, 22]);
    const ellipseDesc = buildKeyOriginDescriptor("Elps", [0, 0, 50, 40], null, null, 0, "MyEllipse");
    assert.equal(ellipseDesc.v.classID, "Elps");
    assert.equal(ellipseDesc.v.Nm.v, "MyEllipse");
    assert.equal(ellipseDesc.v.Left.v.val, 0);
    const lineDesc = buildKeyOriginDescriptor("Ln", null, null, [1, 2, 3, 4], 5, null);
    assert.equal(lineDesc.v.Strt.v.Hrzn.v.val, 1);
    assert.equal(lineDesc.v.End.v.Vrtc.v.val, 4);
    assert.equal(lineDesc.v.Wdth.v.val, 5);
  });

  it("transformKeyOriginsWithMatrix scales an ellipse bbox", () => {
    const origins = [buildKeyOriginFromGeom(5, [0, 0, 10, 10], null, null, 0)];
    const matrix = matrix2DToHomography(new Matrix2D(2, 0, 0, 2, 10, 20));
    transformKeyOriginsWithMatrix(origins, matrix, [], false);
    assert.deepEqual(bboxArrayFromKeyOrigin(origins[0].v), [10, 20, 30, 40]);
  });

  it("transformKeyOriginsWithMatrix rotates and flips rounded-rect radii", () => {
    const rotated = [buildKeyOriginFromGeom(2, [0, 0, 20, 10], [1, 2, 3, 4], null, 0)];
    transformKeyOriginsWithMatrix(rotated, matrix2DToHomography(new Matrix2D(0, 1, -1, 0, 0, 0)), [], true);
    assert.deepEqual(bboxArrayFromKeyOrigin(rotated[0].v), [-10, 0, 0, 20]);
    assert.deepEqual(cornerRadiiFromKeyOrigin(rotated[0].v), [1, 2, 3, 4]);

    const flipped = [buildKeyOriginFromGeom(2, [0, 0, 20, 10], [1, 2, 3, 4], null, 0)];
    transformKeyOriginsWithMatrix(flipped, matrix2DToHomography(new Matrix2D(-1, 0, 0, 1, 0, 0)), [], false);
    assert.deepEqual(cornerRadiiFromKeyOrigin(flipped[0].v), [1, 2, 3, 4]);
  });

  it("transformKeyOriginsWithMatrix scales a line's endpoints and weight", () => {
    const origins = [buildKeyOriginFromGeom(4, null, null, [0, 0, 100, 50], 3)];
    transformKeyOriginsWithMatrix(origins, matrix2DToHomography(new Matrix2D(2, 0, 0, 2, 5, 5)), [], true);
    assert.deepEqual(lineEndpointsFromKeyOrigin(origins[0].v), [5, 5, 205, 105]);
    assert.equal(origins[0].v.keyOriginLineWeight.v, 6);
  });

  it("transformKeyOriginsWithMatrix invalidates on a perspective homography", () => {
    const origins = [buildKeyOriginFromGeom(5, [0, 0, 10, 10], null, null, 0)];
    transformKeyOriginsWithMatrix(origins, [1, 0.5, 0, 0, 1, 0, 0.001, 0.002], [], false);
    assert.equal(origins[0].v.keyShapeInvalidated.v, true);
  });

  // A vector-shape layer carries one `vogk` entry per subpath, so the count has
  // to track the path records exactly.
  it("createForSubpaths returns one empty origin per subpath", () => {
    const threeSubpaths = [
      { type: 6 }, { type: 6 },
      { type: 0, length: 1, fillRule: 0 }, { type: 1 },
      { type: 0, length: 1, fillRule: 0 }, { type: 1 },
      { type: 0, length: 1, fillRule: 0 }, { type: 1 },
    ];
    const origins = createForSubpaths(threeSubpaths);
    assert.equal(origins.length, 3);
    // A fresh origin carries no cached geometry, so it is marked invalid.
    assert.equal(origins[0].v.keyShapeInvalidated.v, true);
  });

  // An origin describes one subpath. A mask can hold fewer subpaths than the
  // layer has origins — a shape drawn onto a path that carries none — and the
  // origin then has nothing to rebuild from. Rebuilding it anyway spliced the
  // records at -1, which takes the last record off the two-record preamble and
  // leaves an array every later reader misreads.
  it("skips an origin whose subpath the mask does not hold", () => {
    const rectOrigin = buildKeyOriginFromGeom(1, [0, 0, 10, 10], null, null, 0);

    const preambleOnly = { pathRecords: [{ type: 6 }, { type: 8, all: 0 }] };
    rebuildVectorMaskFromKeyOrigins([rectOrigin], preambleOnly);
    assert.deepEqual(preambleOnly.pathRecords, [{ type: 6 }, { type: 8, all: 0 }]);
    // A preamble with no subpath reads as a path rather than throwing.
    assert.equal(typeof usesEvenOddFill(preambleOnly.pathRecords), "boolean");

    // With the subpath present the rebuild runs in full.
    const withSubpath = {
      pathRecords: [{ type: 6 }, { type: 8, all: 0 }, { type: 0, fillRule: 1, length: 0 }],
    };
    rebuildVectorMaskFromKeyOrigins([rectOrigin], withSubpath);
    assert.equal(withSubpath.pathRecords.length, 7);
    assert.deepEqual(withSubpath.pathRecords[1], { type: 8, all: 0 });
    assert.equal(withSubpath.maskCombineDirty, true);
  });
});
