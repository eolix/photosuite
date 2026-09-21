/**
 * Golden values for EngineDataCodec expand/collapse.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let EngineDataCodec;

before(async () => {
  ({ EngineDataCodec } = await import("../../../src/features/text/engine-data-codec.js"));
});

describe("features/text/engine-data-codec.js", () => {
  it("expand/collapse round-trips FontSet wire", () => {
    const sample = {
      _0: {
        _1: {
          _0: [{ _0: { _99: "/CoolTypeFont", _0: { _0: "sArial" } } }],
        },
      },
    };
    const expanded = EngineDataCodec.expandEngineDataWire(sample);
    const collapsed = EngineDataCodec.collapseEngineDataWire(expanded);
    assert.deepEqual(collapsed, sample);
    assert.equal(
      expanded._DocumentResources._FontSet._Resources[0]._Resource._StreamTag,
      "/CoolTypeFont",
    );
  });

  it("expand names the text model's alternate-glyph run", () => {
    // Slot 9 of a text object's model: one run of 3 characters forced to
    // glyph 77, as the Glyphs panel writes it for an unmapped glyph.
    const sample = {
      _1: {
        _1: [{ _0: { _9: { _0: [{ _0: { _0: { _0: "i77", _1: "e" } }, _1: "i3" }] } } }],
      },
    };
    const expanded = EngineDataCodec.expandEngineDataWire(sample);
    const run =
      expanded._DocumentObjects._TextObjects[0]._Model._AlternateGlyphRun._RunArray[0];
    assert.equal(run._RunData._AlternateGlyphSheet._Glyph, "i77");
    assert.equal(run._Length, "i3");
    assert.deepEqual(EngineDataCodec.collapseEngineDataWire(expanded), sample);
  });

  it("mapWireToReadable / mapReadableToWire honor a small custom map", () => {
    const map = { Text: [0], Count: [1] };
    const wire = { _0: "sHello", _1: "i3" };
    const readable = EngineDataCodec.mapWireToReadable(wire, map, 0);
    assert.deepEqual(readable, { Text: "sHello", Count: "i3" });
    assert.deepEqual(EngineDataCodec.mapReadableToWire(readable, map), wire);
  });
});
