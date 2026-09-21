/**
 * Golden values for style-file (.asl codec).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let StyleParser;

/** Minimal renamed style as produced by serialize(bundle). */
const SERIALIZED_RENAMED_STYLE = [
  0, 2, 56, 66, 83, 76, 0, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 114, 0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0,
  0, 0, 0, 110, 117, 108, 108, 0, 0, 0, 1, 0, 0, 0, 0, 78, 109, 32, 32, 84, 69, 88, 84, 0, 0, 0, 8,
  0, 82, 0, 101, 0, 110, 0, 97, 0, 109, 0, 101, 0, 100, 0, 0, 0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 0, 0,
  0, 83, 116, 121, 108, 0, 0, 0, 1, 0, 0, 0, 12, 98, 108, 101, 110, 100, 79, 112, 116, 105, 111, 110,
  115, 79, 98, 106, 99, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 66, 108, 110, 79, 0, 0, 0, 0,
];

const SERIALIZED_EMPTY = [0, 2, 56, 66, 83, 76, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0];

function minimalBundle(styleName) {
  return {
    patterns: [],
    layerStyles: [
      {
        styleInfo: {
          classID: "null",
          Nm: { t: "TEXT", v: styleName },
        },
        styleEffects: {
          classID: "Styl",
          blendOptions: {
            t: "Objc",
            v: { classID: "BlnO" },
          },
        },
      },
    ],
  };
}

before(async () => {
  ({ StyleParser } = await import("../../../src/features/layer-styles/style-file.js"));
});

describe("features/layer-styles/style-file.js", () => {
  it("setName updates styleInfo Nm", () => {
    const bundle = minimalBundle("My Style");
    StyleParser.setName(bundle.layerStyles[0], "Renamed");
    assert.equal(bundle.layerStyles[0].styleInfo.Nm.v, "Renamed");
  });

  it("serialize writes 8BSL bytes matching the golden bytes", () => {
    const bundle = minimalBundle("My Style");
    StyleParser.setName(bundle.layerStyles[0], "Renamed");
    const bytes = new Uint8Array(StyleParser.serialize(bundle));
    assert.equal(bytes.byteLength, 134);
    assert.deepEqual([...bytes], SERIALIZED_RENAMED_STYLE);
    assert.deepEqual(
      [...new Uint8Array(StyleParser.serialize({ patterns: [], layerStyles: [] }))],
      SERIALIZED_EMPTY,
    );
  });

  it("parse round-trips serialize", () => {
    const bundle = minimalBundle("My Style");
    StyleParser.setName(bundle.layerStyles[0], "Renamed");
    const parsed = StyleParser.parse(StyleParser.serialize(bundle));
    assert.equal(parsed.patterns.length, 0);
    assert.equal(parsed.layerStyles.length, 1);
    assert.equal(parsed.layerStyles[0].styleInfo.Nm.v, "Renamed");
    assert.equal(parsed.layerStyles[0].styleEffects.classID, "Styl");
  });
});
