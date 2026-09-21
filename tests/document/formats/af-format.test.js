import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let AffinityLoader;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ AffinityLoader } = await import("../../../src/document/formats/af-format.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/af-format.js", () => {
  it("entriesToNodes builds corner anchor with out handle", () => {
    const nodes = AffinityLoader.entriesToNodes([
      { f0: 1, f1: 1, x: 0, y: 0 },
      { f0: 1, f1: 2, x: 10, y: 0 },
    ]);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].outX, 0);
    assert.equal(nodes[1].inX, 10);
  });

  it("hasDataHeader finds Data marker before curve block", () => {
    const docDat = new Uint8Array(48);
    const DATA = 0x61 | (0x74 << 8) | (0x61 << 16) | (0x44 << 24);
    docDat[12] = 0x30;
    docDat[13] = 0x61;
    docDat[14] = 0x74;
    docDat[15] = 0x61;
    docDat[16] = 0x44;
    assert.equal(AffinityLoader.hasDataHeader(docDat, 20), true);
    assert.equal(AffinityLoader.hasDataHeader(docDat, 5), false);
  });
});
