/**
 * Golden values for filter-data-cache (mesh parse/serialize).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let CachedLayerData;
let BinaryUtils;

before(async () => {
  ({ CachedLayerData } = await import("../../../src/features/filters/filter-data-cache.js"));
  ({ BinaryUtils } = await import("../../../src/core/binary/binary-utils.js"));
});

describe("features/filters/filter-data-cache.js", () => {
  it("serialize writes sparse v3 bytes matching the golden buffer", () => {
    const mesh = {
      gridWidth: 2,
      gridHeight: 3,
      map: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]),
    };
    const bytes = new Uint8Array(CachedLayerData.serialize(mesh));
    assert.equal(bytes.byteLength, 104);
    assert.deepEqual(
      [...bytes],
      [
        0, 0, 0, 3, 121, 102, 113, 76, 104, 115, 101, 77, 2, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0,
        0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 205, 204, 204, 61, 205, 204, 76, 62, 154, 153,
        153, 62, 205, 204, 204, 62, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 63, 154, 153, 25, 63, 51, 51,
        51, 63, 205, 204, 76, 63, 0, 0, 0, 0, 2, 0, 0, 0, 102, 102, 102, 63, 0, 0, 128, 63, 205,
        204, 140, 63, 154, 153, 153, 63,
      ],
    );
  });

  it("parse round-trips serialize and reads dense v2 / sparse v4", () => {
    const mesh = {
      gridWidth: 2,
      gridHeight: 3,
      map: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]),
    };
    const parsed = CachedLayerData.parse(CachedLayerData.serialize(mesh));
    assert.equal(parsed.gridWidth, 2);
    assert.equal(parsed.gridHeight, 3);
    assert.deepEqual([...parsed.map], [
      0.10000000149011612,
      0.20000000298023224,
      0.30000001192092896,
      0.4000000059604645,
      0.5,
      0.6000000238418579,
      0.699999988079071,
      0.800000011920929,
      0.8999999761581421,
      1,
      1.100000023841858,
      1.2000000476837158,
    ]);

    const denseBytes = new Uint8Array(32 + 2 * 2 * 8);
    let cursor = 0;
    BinaryUtils.writeUint32BE(denseBytes, cursor, 2);
    cursor += 4;
    BinaryUtils.writeAsciiRaw(denseBytes, cursor, "yfqLhseM");
    cursor += 8;
    BinaryUtils.writeFloat32Raw(denseBytes, cursor, 2);
    cursor += 4;
    BinaryUtils.writeFloat32Raw(denseBytes, cursor, 2);
    cursor += 4;
    BinaryUtils.writeFloat32Raw(denseBytes, cursor, 2);
    cursor += 4;
    BinaryUtils.writeFloat32Raw(denseBytes, cursor, 0);
    new Float32Array(denseBytes.buffer, 32, 8).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const dense = CachedLayerData.parse(denseBytes.buffer);
    assert.equal(dense.gridWidth, 2);
    assert.equal(dense.gridHeight, 2);
    assert.deepEqual([...dense.map], [1, 2, 3, 4, 5, 6, 7, 8]);

    const sparseV4 = new Uint8Array(64 + 16);
    cursor = 0;
    BinaryUtils.writeUint32BE(sparseV4, cursor, 4);
    cursor += 4;
    BinaryUtils.writeAsciiRaw(sparseV4, cursor, "yfqLhseM");
    cursor += 8;
    BinaryUtils.writeFloat32Raw(sparseV4, cursor, 2);
    cursor += 4;
    BinaryUtils.writeFloat32Raw(sparseV4, cursor, 1);
    cursor += 4;
    BinaryUtils.writeFloat32Raw(sparseV4, cursor, 1);
    cursor = 64;
    BinaryUtils.writeFloat32Raw(sparseV4, cursor, 0);
    cursor += 4;
    BinaryUtils.writeFloat32Raw(sparseV4, cursor, 1);
    cursor += 4;
    BinaryUtils.writeFloat32LERaw(sparseV4, cursor, 9);
    BinaryUtils.writeFloat32LERaw(sparseV4, cursor + 4, 10);
    const alt = CachedLayerData.parse(sparseV4.buffer.slice(0, cursor + 8));
    assert.deepEqual({ w: alt.gridWidth, h: alt.gridHeight, map: [...alt.map] }, {
      w: 1,
      h: 1,
      map: [9, 10],
    });
  });

  it("parse rejects unknown mesh versions with the original message", () => {
    assert.throws(
      () => CachedLayerData.parse(new ArrayBuffer(32)),
      (error) => String(error.message || error) === "unknown Mesh version: 0",
    );
  });
});
