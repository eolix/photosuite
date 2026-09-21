import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Rect } from "../../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let parseSampleList;
let writeSampleList;
let restoreBrowserGlobals;

const mockBuffer = () => ({ data: new Uint8Array(4096), ensureCapacity() {} });

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ parseSampleList, writeSampleList } = await import(
    "../../../../src/document/formats/psd/sample-list-codec.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/psd/sample-list-codec.js", () => {

  it("writeSampleList then parseSampleList round-trips brush-style records", () => {
    const sample = {
      id: "tips",
      boundsRect: new Rect(0, 0, 2, 2),
      channel: new Uint8Array([10, 20, 30, 40]),
    };
    const buf = mockBuffer();
    const endOffset = writeSampleList(buf, 0, [sample]);
    const parsed = parseSampleList(buf.data, 0, endOffset, 2, 6);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, sample.id);
    assert.equal(parsed[0].boundsRect.width, 2);
    assert.equal(parsed[0].boundsRect.height, 2);
    assert.deepEqual(Array.from(parsed[0].channel.slice(0, 4)), [10, 20, 30, 40]);
  });
});
