/**
 * Golden I/O for shared LayerEffectsTracker history/apply helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let applyLockToggleBits;
let applyRenameEntries;
let findDurationBucketIndex;
let opacityByteToPercent;

before(async () => {
  ({
    applyLockToggleBits,
    applyRenameEntries,
    findDurationBucketIndex,
    opacityByteToPercent,
  } = await import("../../../src/features/trackers/layer-effects-action-helpers.js"));
});

describe("features/trackers/layer-effects-action-helpers.js", () => {
  it("opacity byte 128 maps to 50 percent", () => {
    assert.equal(opacityByteToPercent(128), 50);
  });

  it("applyLockToggleBits sets bit 0 from toggle rows", () => {
    assert.equal(applyLockToggleBits(0, [[true, false], [0, 1]]), 1);
  });

  it("findDurationBucketIndex walks until the offset is covered", () => {
    assert.equal(findDurationBucketIndex([10, 20, 30], 0), 0);
    assert.equal(findDurationBucketIndex([10, 20, 30], 10), 1);
    assert.equal(findDurationBucketIndex([10, 20, 30], 30), 2);
  });

  it("applyRenameEntries writes name and lnsr from tuple slots", () => {
    const layer = {
      name: "Old",
      add: { lnsr: "lrsn" },
      setName(name) {
        this.name = name;
      },
    };
    applyRenameEntries({ layers: [layer] }, [[0, "Old", "New", "lrsn", null]], 2, 4);
    assert.equal(layer.name, "New");
    assert.equal("lnsr" in layer.add, false);
  });
});
