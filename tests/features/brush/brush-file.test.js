/**
 * Golden values for brush-file (.abr codec).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let BrushFileCodec;

/** Empty modern .abr as produced by serialize({ samples:[], patterns:[], list:[] }). */
const EMPTY_SERIALIZE_BYTES = [
  0, 6, 0, 2, 56, 66, 73, 77, 115, 97, 109, 112, 0, 0, 0, 0, 56, 66, 73, 77, 112, 97, 116, 116, 0, 0,
  0, 0, 56, 66, 73, 77, 100, 101,
];

before(async () => {
  ({ BrushFileCodec } = await import("../../../src/features/brush/brush-file.js"));
});

describe("features/brush/brush-file.js", () => {
  it("serialize empty brush file matches captured bytes", () => {
    const bytes = new Uint8Array(
      BrushFileCodec.serialize({
        samples: [],
        patterns: [],
        list: [],
      }),
    );
    assert.deepEqual([...bytes], EMPTY_SERIALIZE_BYTES);
  });

  it("parse empty modern .abr yields empty samples/patterns/list", () => {
    const parsed = BrushFileCodec.parse(new Uint8Array(EMPTY_SERIALIZE_BYTES).buffer);
    assert.deepEqual(parsed.samples, []);
    assert.deepEqual(parsed.patterns, []);
    assert.deepEqual(parsed.list, []);
  });

  it("setName updates descriptor Nm", () => {
    const descriptor = {
      v: {
        Nm: {
          v: "old",
        },
      },
    };
    BrushFileCodec.setName(descriptor, "new");
    assert.equal(descriptor.v.Nm.v, "new");
  });
});
