import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let LayerRecordParser;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  ({ LayerRecordParser } = await import("../../../../src/document/formats/psd/layer-record-parser.js"));
});

after(() => { if (restoreBrowserGlobals) restoreBrowserGlobals(); });

const mockBuf = (n) => ({ data: new Uint8Array(n), ensureCapacity() {} });

describe("document/formats/psd/layer-record-parser.js", () => {
  it("readMaskFlags decodes enabled / applied / has-params bits", () => {
    // flags 0 → both masks enabled, no params applied, no param block
    let mask = {};
    assert.equal(LayerRecordParser.readMaskFlags(mask, new Uint8Array([0]), 0), 0);
    assert.deepEqual([mask.enabled, mask.isEnabled, mask.parametersApplied], [true, true, false]);
    // bits 0,1,3,4 set (27) → disabled, disabled, params applied, has-params
    mask = {};
    assert.equal(LayerRecordParser.readMaskFlags(mask, new Uint8Array([27]), 0), 1);
    assert.deepEqual([mask.enabled, mask.isEnabled, mask.parametersApplied], [false, false, true]);
  });

  it("writeMaskFlags / readMaskFlags round-trip", () => {
    const buf = mockBuf(4);
    const src = { enabled: false, isEnabled: false, parametersApplied: true };
    LayerRecordParser.writeMaskFlags(src, buf, 0, true);
    const dst = {};
    const hasParams = LayerRecordParser.readMaskFlags(dst, buf.data, 0);
    assert.equal(hasParams, 1);
    assert.deepEqual([dst.enabled, dst.isEnabled, dst.parametersApplied], [false, false, true]);
  });

  it("readBlendRanges copies 40 bytes and advances by 44", () => {
    const layer = { blendIfData: [] };
    const bytes = new Uint8Array(4 + 40);
    bytes[3] = 40; // dataSize = 40 (big-endian uint32)
    for (let i = 0; i < 40; i++) bytes[4 + i] = i;
    const pos = LayerRecordParser.readBlendRanges(layer, bytes, 0);
    assert.equal(pos, 44);
    assert.equal(layer.blendIfData.length, 40);
    assert.equal(layer.blendIfData[7], 7);
  });
});
