import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Matrix2D, scaleIgnoringRotation } from "../../../src/core/math/matrix2d.js";
import { packDoublesList, unpackDoublesList } from "../../../src/document/formats/psd/descriptor-codec.js";

let restoreBrowserGlobals;
let TransformToolBase;

function chainToolPrototypes() {
  function ToolBase() {}

  }

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ TransformToolBase } = await import("../../../src/document/transform/transform-static.js"));
  chainToolPrototypes();
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("matrixScale", () => {
  it("returns 1 for an identity matrix", () => {
    assert.equal(scaleIgnoringRotation(new Matrix2D()), 1);
  });

  it("returns 2.5 for independent x/y scale", () => {
    assert.equal(scaleIgnoringRotation(new Matrix2D(2, 0, 0, 3, 10, 20)), 2.5);
  });

  it("returns 2 for rotate 45° then uniform scale 2", () => {
    const matrix = new Matrix2D();
    matrix.rotate(Math.PI / 4);
    matrix.scale(2, 2);
    assert.equal(scaleIgnoringRotation(matrix), 2);
  });
});

describe("TransformToolBase packDoublesList / unpackDoublesList", () => {
  it("round-trips a doubles list descriptor", () => {
    const values = [1.5, 2.5, -3];
    const packed = packDoublesList(values);
    assert.deepEqual(unpackDoublesList(packed), values);
    assert.equal(packed.t, "VlLs");
    assert.equal(packed.v.length, 3);
    assert.deepEqual(packed.v[0], { t: "doub", v: 1.5 });
    assert.deepEqual(packed.v[1], { t: "doub", v: 2.5 });
    assert.deepEqual(packed.v[2], { t: "doub", v: -3 });
  });
});

describe("TransformToolBase.buildRotateOrFlipAction", () => {
  it("builds a rotate action with Angl unit float", () => {
    const action = TransformToolBase.buildRotateOrFlipAction(true, 90);
    assert.equal(action.uf, "rotateEventEnum");
    assert.equal(action.actionDescriptor.classID, "null");
    assert.equal(action.actionDescriptor.Angl.t, "UntF");
    assert.deepEqual(action.actionDescriptor.Angl.v, { type: "#Ang", val: 90 });
    assert.equal(action.actionDescriptor.Axis, undefined);
  });

  it("builds a horizontal flip action with Axis enum", () => {
    const action = TransformToolBase.buildRotateOrFlipAction(false, "Hrzn");
    assert.equal(action.uf, "flip");
    assert.equal(action.actionDescriptor.classID, "null");
    assert.deepEqual(action.actionDescriptor.Axis, {
      t: "enum",
      v: { Ornt: "Hrzn" },
    });
    assert.equal(action.actionDescriptor.Angl, undefined);
  });
});
