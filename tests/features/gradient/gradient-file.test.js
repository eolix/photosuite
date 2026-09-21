/**
 * Golden values for gradient-file (.grd codec).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let GradientFile;
let BinaryUtils;
let RenderBuffer;

/** One renamed custom gradient as produced by serialize([grad]). */
const SERIALIZED_RENAMED_GRADIENT = [
  56, 66, 71, 82, 0, 5, 0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 110, 117, 108, 108, 0, 0, 0, 1, 0,
  0, 0, 0, 71, 114, 100, 76, 86, 108, 76, 115, 0, 0, 0, 1, 79, 98, 106, 99, 0, 0, 0, 10, 0, 71, 0,
  114, 0, 97, 0, 100, 0, 105, 0, 101, 0, 110, 0, 116, 0, 32, 0, 0, 0, 0, 0, 0, 71, 114, 100, 110, 0,
  0, 0, 1, 0, 0, 0, 0, 71, 114, 97, 100, 79, 98, 106, 99, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 71, 114, 100,
  110, 0, 0, 0, 5, 0, 0, 0, 0, 78, 109, 32, 32, 84, 69, 88, 84, 0, 0, 0, 8, 0, 82, 0, 101, 0, 110, 0,
  97, 0, 109, 0, 101, 0, 100, 0, 0, 0, 0, 0, 0, 71, 114, 100, 70, 101, 110, 117, 109, 0, 0, 0, 0, 71,
  114, 100, 70, 0, 0, 0, 0, 67, 115, 116, 83, 0, 0, 0, 0, 73, 110, 116, 114, 100, 111, 117, 98, 64,
  176, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 67, 108, 114, 115, 86, 108, 76, 115, 0, 0, 0, 0, 0, 0, 0, 0, 84,
  114, 110, 115, 86, 108, 76, 115, 0, 0, 0, 0,
];

function sampleGradient(name) {
  return {
    classID: "Grdn",
    Nm: { t: "TEXT", v: name },
    GrdF: { t: "enum", v: { GrdF: "CstS" } },
    Intr: { t: "doub", v: 4096 },
    Clrs: { t: "VlLs", v: [] },
    Trns: { t: "VlLs", v: [] },
  };
}

before(async () => {
  ({ GradientFile } = await import("../../../src/features/gradient/gradient-file.js"));
  ({ BinaryUtils } = await import("../../../src/core/binary/binary-utils.js"));
  ({ RenderBuffer } = await import("../../../src/core/render-buffer.js"));
});

describe("features/gradient/gradient-file.js", () => {
  it("setName updates descriptor Nm", () => {
    const gradient = sampleGradient("Test Grad");
    GradientFile.setName(gradient, "Renamed");
    assert.equal(gradient.Nm.v, "Renamed");
  });

  it("serialize writes version-5 8BGR bytes matching the golden bytes", () => {
    const gradient = sampleGradient("Test Grad");
    GradientFile.setName(gradient, "Renamed");
    const bytes = new Uint8Array(GradientFile.serialize([gradient]));
    assert.equal(bytes.byteLength, 226);
    assert.deepEqual([...bytes], SERIALIZED_RENAMED_GRADIENT);
  });

  it("parse round-trips serialize and reads empty version-3 lists", () => {
    const gradient = sampleGradient("Test Grad");
    GradientFile.setName(gradient, "Renamed");
    const parsed = GradientFile.parse(GradientFile.serialize([gradient]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].Nm.v, "Renamed");
    assert.equal(parsed[0].classID, "Grdn");
    assert.equal(parsed[0].Intr.v, 4096);

    const version3Empty = new RenderBuffer();
    BinaryUtils.writeAscii(version3Empty, 0, "8BGR");
    BinaryUtils.writeUint16(version3Empty, 4, 3);
    BinaryUtils.writeUint16(version3Empty, 6, 0);
    assert.deepEqual(GradientFile.parse(version3Empty.data.slice(0, 8).buffer), []);
  });
});
