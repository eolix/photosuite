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
  0, 0, 56, 66, 73, 77, 100, 101, 115, 99, 0, 0, 0, 38, 0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 110,
  117, 108, 108, 0, 0, 0, 1, 0, 0, 0, 0, 66, 114, 115, 104, 86, 108, 76, 115, 0, 0, 0, 0,
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

  it("serialize/parse round-trips a non-empty brush list", () => {
    // Regression test: serialize() used to assign writeDescriptor()'s return
    // value (a length delta) directly to `offset` instead of accumulating it,
    // silently truncating the file after the descriptor block's byte count.
    // The empty-list case above never caught this because an empty list's
    // truncated remainder still parsed back as "no descriptor block".
    //
    // Uses wire-format keys (`Dmtr`, matching what BrushFileCodec.parse()
    // itself produces) rather than BrushPresetUtil's runtime-normalized
    // `diameter` key (that's only valid post-load, via getBrushPresetFromListEntry).
    const preset = {
      classID: "brushPreset",
      Nm: { t: "TEXT", v: "Test Preset" },
      Brsh: {
        t: "Objc",
        v: {
          classID: "computedBrush",
          Dmtr: { t: "UntF", v: { type: "#Pxl", val: 30 } },
          Hrdn: { t: "UntF", v: { type: "#Prc", val: 0 } },
          Angl: { t: "UntF", v: { type: "#Ang", val: 0 } },
          Rndn: { t: "UntF", v: { type: "#Prc", val: 100 } },
          Spcn: { t: "UntF", v: { type: "#Prc", val: 25 } },
          Intr: { t: "bool", v: true },
          flipX: { t: "bool", v: false },
          flipY: { t: "bool", v: false },
        },
      },
      useTipDynamics: { t: "bool", v: false },
      useScatter: { t: "bool", v: false },
      dualBrush: { t: "Objc", v: { classID: "dualBrush", useDualBrush: { t: "bool", v: false } } },
      brushGroup: { t: "Objc", v: { classID: "brushGroup", useBrushGroup: { t: "bool", v: false } } },
      useTexture: { t: "bool", v: false },
      usePaintDynamics: { t: "bool", v: false },
      useColorDynamics: { t: "bool", v: false },
      Wtdg: { t: "bool", v: false },
      Nose: { t: "bool", v: false },
      Rpt: { t: "bool", v: false },
      useBrushSize: { t: "bool", v: true },
      useBrushPose: { t: "bool", v: false },
    };
    const bytes = new Uint8Array(
      BrushFileCodec.serialize({
        samples: [],
        patterns: [],
        list: [{ t: "Objc", v: preset }],
      }),
    );
    const parsed = BrushFileCodec.parse(bytes.buffer);
    assert.equal(parsed.list.length, 1);
    assert.equal(parsed.list[0].v.Nm.v, "Test Preset");
    assert.equal(parsed.list[0].v.classID, "brushPreset");
    assert.equal(parsed.list[0].v.Brsh.v.Dmtr.v.val, 30);
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
