import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let webpCodec;
let initWebpWasmDecoder;
let initWebpWasmEncoder;
let restoreBrowserGlobals;

function buildMockWebpDecoderExports() {
  var buffer = new ArrayBuffer(8 * 1024 * 1024);
  var memoryView = new Uint8Array(buffer);
  var sizeView = new DataView(buffer);
  memoryView[0] = 0;
  memoryView[1] = 128;
  memoryView[2] = 255;
  memoryView[3] = 64;
  sizeView.setFloat32(8, 1, true);
  sizeView.setFloat32(12, 1, true);
  var mallocCalls = 0;
  return {
    memory: {
      buffer,
      grow() {},
    },
    malloc() {
      return mallocCalls++ === 0 ? 16 : 8;
    },
    free() {},
    WebPDecodeARGB() {
      return 0;
    },
    WebPFree() {},
  };
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  globalThis.BINDB["wasm/webp-enc"] = "about:blank";
  globalThis.WebAssembly = {
    Module: class WebAssemblyModule {},
    Instance: class WebAssemblyInstance {
      constructor() {
        this.exports = {
          wasm_reset() {},
          wasm_alloc() { return 0; },
          encode_rgba() { return 1; },
          get_result_pointer() { return 0; },
          get_result_size() { return 0; },
          free_result() {},
          memory: { buffer: new ArrayBuffer(65536), grow() {} },
        };
      }
    },
    instantiate() {
      return Promise.resolve({ instance: { exports: buildMockWebpDecoderExports() } });
    },
  };
  globalThis.alert = function() {};
  globalThis.UPNG = {
    encode: {
      compress(rgbaBuffers, width, height) {
        return {
          frames: rgbaBuffers.map(function(buffer, frameIdx) {
            return {
              rect: { x: 0, y: 0, width, height },
              img: { buffer },
              blend: 0,
              dispose: 0,
            };
          }),
        };
      },
    },
  };
  globalThis.UTIF = {
    encode() { return [new Uint8Array(0)]; },
    decode() { return [null]; },
  };
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  const mod = await import("../../../../src/document/formats/codecs/webp.js");
  webpCodec = mod.webpCodec;
  initWebpWasmDecoder = mod.initWebpWasmDecoder;
  initWebpWasmEncoder = mod.initWebpWasmEncoder;
  await initWebpWasmDecoder();
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/webp.js", () => {
  it("initWebpWasmDecoder assigns wasmModule", () => {
    assert.ok(webpCodec.wasmModule);
    assert.equal(typeof webpCodec.wasmModule.WebPDecodeARGB, "function");
    assert.equal(typeof webpCodec.decodeWebpChunkToRgba, "function");
  });

  it("initWebpWasmEncoder assigns encodeWasmModule", () => {
    initWebpWasmEncoder();
    assert.ok(webpCodec.encodeWasmModule);
    assert.equal(typeof webpCodec.encodeWasmModule.encode_rgba, "function");
  });

});
