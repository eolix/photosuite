import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultSliceDescriptor,
  writeSliceBoundsToDescriptor,
} from "../../../../src/document/formats/psd/slice-descriptor.js";

/** Goldens from createDefaultSliceDescriptor / writeSliceBoundsToDescriptor. */
const GOLDEN_SLICE_CLASS_ID = "slice";
const GOLDEN_SLICE_TYPE = "Img";
const GOLDEN_BOUNDS_CLASS_ID = "Rct1";
const GOLDEN_WRITTEN_BOUNDS = [10, 20, 110, 220];

describe("document/formats/psd/slice-descriptor.js", () => {

  it("createDefaultSliceDescriptor wires PSD slice defaults", () => {
    const sliceDescriptor = createDefaultSliceDescriptor();
    assert.equal(sliceDescriptor.t, "Objc");
    assert.equal(sliceDescriptor.v.classID, GOLDEN_SLICE_CLASS_ID);
    assert.equal(sliceDescriptor.v.Type.v.ESliceType, GOLDEN_SLICE_TYPE);
    assert.equal(sliceDescriptor.v.origin.v.ESliceOrigin, "userGenerated");
    assert.equal(sliceDescriptor.v.cellTextIsHTML.v, true);
    assert.equal(sliceDescriptor.v.bounds.v.classID, GOLDEN_BOUNDS_CLASS_ID);
    assert.deepEqual(
      Object.keys(sliceDescriptor.v.bounds.v).sort(),
      ["Btom", "Left", "Rght", "Top", "classID"],
    );
  });

  it("writeSliceBoundsToDescriptor writes left, top, right, bottom wire keys", () => {
    const sliceList = [createDefaultSliceDescriptor()];
    writeSliceBoundsToDescriptor(sliceList, 0, GOLDEN_WRITTEN_BOUNDS);
    const boundsNode = sliceList[0].v.bounds.v;
    assert.equal(boundsNode.Left.v, GOLDEN_WRITTEN_BOUNDS[0]);
    assert.equal(boundsNode.Top.v, GOLDEN_WRITTEN_BOUNDS[1]);
    assert.equal(boundsNode.Rght.v, GOLDEN_WRITTEN_BOUNDS[2]);
    assert.equal(boundsNode.Btom.v, GOLDEN_WRITTEN_BOUNDS[3]);
  });
});
