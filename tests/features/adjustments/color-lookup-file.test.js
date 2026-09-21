/**
 * Golden values for color-lookup-file (LUT / ICC routing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ColorLookupParser;
let BinaryUtils;

const CUBE_2 = `# comment
TITLE "t"
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

before(async () => {
  ({ ColorLookupParser } = await import("../../../src/features/adjustments/color-lookup-file.js"));
  ({ BinaryUtils } = await import("../../../src/core/binary/binary-utils.js"));
});

describe("features/adjustments/color-lookup-file.js", () => {
  it("parseLUTText cube + transposeAxes match captured lattice", () => {
    const cubeBuf = BinaryUtils.encodeUtf8(CUBE_2);
    const [lutSize, values] = ColorLookupParser.parseLUTText(new Uint8Array(cubeBuf), "cube");
    assert.equal(lutSize, 2);
    assert.deepEqual(values, [
      0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1,
    ]);
    assert.deepEqual(
      ColorLookupParser.transposeAxes(2, [
        0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
      ]),
      [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1],
    );
  });

  it("parseLUTText 3dl samples and size-from-first-row", () => {
    const text = `#x
0 1 2 3
0 0 0
4095 0 0
`;
    const [lutSize, values] = ColorLookupParser.parseLUTText(
      new Uint8Array(BinaryUtils.encodeUtf8(text)),
      "3DL",
    );
    assert.equal(lutSize, 4);
    assert.deepEqual(values, [0, 0, 0, 1, 0, 0]);
  });

  it("parse builds ICC-backed descriptor; serialize round-trips profile bytes", () => {
    const cubeBuf = BinaryUtils.encodeUtf8(CUBE_2);
    const descArr = ColorLookupParser.parse(cubeBuf, "test.cube");
    assert.equal(descArr.length, 1);
    assert.equal(descArr[0].classID, "null");
    assert.equal(descArr[0].Dthr.v, true);
    assert.equal(descArr[0].Nm.v, "test.cube");
    assert.equal(descArr[0].lookupType.v.colorLookupType, "abstractProfile");
    assert.equal(descArr[0].profile.v.length, 324);
    assert.deepEqual(descArr[0].profile.v.slice(0, 16), [
      0, 0, 1, 68, 65, 68, 66, 69, 4, 0, 0, 0, 108, 105, 110, 107,
    ]);
    const sizeField =
      (descArr[0].profile.v[0] << 24) |
      (descArr[0].profile.v[1] << 16) |
      (descArr[0].profile.v[2] << 8) |
      descArr[0].profile.v[3];
    assert.equal(sizeField, 324);

    const serialized = new Uint8Array(ColorLookupParser.serialize(descArr));
    assert.equal(serialized.length, 324);
    assert.deepEqual([...serialized], descArr[0].profile.v);

    ColorLookupParser.setName(descArr[0], "renamed.icc");
    assert.equal(descArr[0].Nm.v, "renamed.icc");
  });

  it("parse passes through ICC when size prefix matches length", () => {
    const icc = new Uint8Array(128);
    icc[3] = 128;
    for (let i = 4; i < 128; i++) icc[i] = i & 255;
    const descArr = ColorLookupParser.parse(icc.buffer, "p.icc");
    assert.equal(descArr[0].profile.v.length, 128);
    assert.deepEqual(descArr[0].profile.v.slice(0, 4), [0, 0, 0, 128]);
  });

  it("serializeCube matches captured .cube text", () => {
    const text = new TextDecoder().decode(
      ColorLookupParser.serializeCube([0, 0, 0, 1, 1, 1], 1, "Title"),
    );
    assert.equal(
      text,
      '#Created by PhotoSuite\nTITLE "Title"\n\n#LUT size\nLUT_3D_SIZE 1\n\n#data domain\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n\n#LUT data points\n0.000000 0.000000 0.000000\n1.000000 1.000000 1.000000\n',
    );
  });
});
