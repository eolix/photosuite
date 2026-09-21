import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { BinaryUtils } from "../../../../src/core/binary/binary-utils.js";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let PSDResourceParser;
let restoreBrowserGlobals;

const mockWriteBuffer = (capacity = 256) => ({
  data: new Uint8Array(capacity),
  ensureCapacity() {},
});

const layerContext = { width: 100, height: 50, dpi: 72 };

/** Wrap one 8BIM additional-layer-info block. */
function wrapLayerInfoTag(tag, payload) {
  const block = new Uint8Array(12 + payload.length);
  BinaryUtils.writeAsciiRaw(block, 0, "8BIM");
  BinaryUtils.writeAsciiRaw(block, 4, tag);
  BinaryUtils.writeInt32BE(block, 8, payload.length);
  block.set(payload, 12);
  return block;
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ PSDResourceParser } = await import(
    "../../../../src/document/formats/psd/psd-resource-parser.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/psd/psd-resource-parser.js", () => {

  it("reads lyid layer id", () => {
    const data = wrapLayerInfoTag("lyid", new Uint8Array([0, 0, 0, 42]));
    const layerAdd = {};
    const endPos = PSDResourceParser.parseAdditionalLayerInfo(
      data,
      0,
      data.length,
      layerAdd,
      false,
      layerContext,
    );
    assert.equal(endPos, 16);
    assert.equal(layerAdd.lyid, 42);
  });

  it("reads iOpa fill opacity byte", () => {
    const data = wrapLayerInfoTag("iOpa", new Uint8Array([200, 0, 0, 0]));
    const layerAdd = {};
    PSDResourceParser.parseAdditionalLayerInfo(data, 0, data.length, layerAdd, false, layerContext);
    assert.equal(layerAdd.iOpa, 200);
  });

  it("reads lsct section divider with blend mode", () => {
    const payload = new Uint8Array(12);
    BinaryUtils.writeUint32BE(payload, 0, 1);
    BinaryUtils.writeAsciiRaw(payload, 8, "pass");
    const data = wrapLayerInfoTag("lsct", payload);
    const layerAdd = {};
    PSDResourceParser.parseAdditionalLayerInfo(data, 0, data.length, layerAdd, false, layerContext);
    assert.deepEqual(layerAdd.lsct, { type: 1, blendMode: "pass" });
  });

  it("writeAdditionalLayerInfo / parseAdditionalLayerInfo round-trip luni name", () => {
    const writeBuffer = mockWriteBuffer(64);
    const sourceAdd = { luni: "Layer 1" };
    const writeEnd = PSDResourceParser.writeAdditionalLayerInfo(
      writeBuffer,
      0,
      sourceAdd,
      false,
      layerContext,
    );
    const writtenBytes = [...writeBuffer.data.slice(0, writeEnd)];
    assert.deepEqual(writtenBytes, [
      56, 66, 73, 77, 108, 117, 110, 105, 0, 0, 0, 20, 0, 0, 0, 7, 0, 76, 0, 97, 0, 121, 0, 101,
      0, 114, 0, 32, 0, 49, 0, 0,
    ]);
    const parsedAdd = {};
    PSDResourceParser.parseAdditionalLayerInfo(
      writeBuffer.data,
      0,
      writeEnd,
      parsedAdd,
      false,
      layerContext,
    );
    assert.equal(parsedAdd.luni, "Layer 1");
  });

  it("clone copies fxrp point", () => {
    const point = {
      x: 1.5,
      y: 2.5,
      clone() {
        return { x: this.x, y: this.y, clone: this.clone };
      },
    };
    const cloned = PSDResourceParser.clone("fxrp", point);
    assert.equal(cloned.x, 1.5);
    assert.equal(cloned.y, 2.5);
  });
});
