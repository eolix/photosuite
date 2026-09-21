import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let svgCodec;
let pdfCodec;
let emfCodec;
let dxfCodec;
let aiCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  globalThis.FromPS = { Parse() {} };
  globalThis.FromPDF = { Parse() {} };
  globalThis.FromWMF = { Parse() {} };
  globalThis.FromEMF = { Parse() {} };
  globalThis.ToPDF = function ToPDF() {
    this.buffer = new ArrayBuffer(0);
  };
  globalThis.ToEMF = function ToEMF() {
    this.buffer = new ArrayBuffer(0);
  };
  globalThis.WebAssembly = {
    Module: class WebAssemblyModule {},
    Instance: class WebAssemblyInstance {},
    instantiate() {
      return Promise.resolve({ instance: { exports: { ai: true } } });
    },
  };
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  const mod = await import("../../../../src/document/formats/codecs/vector.js");
  svgCodec = mod.svgCodec;
  pdfCodec = mod.pdfCodec;
  emfCodec = mod.emfCodec;
  dxfCodec = mod.dxfCodec;
  aiCodec = mod.aiCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/vector.js", () => {
  it("layered vector codecs expose isLayered", () => {
    assert.equal(svgCodec.isLayered, true);
    assert.equal(pdfCodec.isLayered, true);
    assert.equal(emfCodec.isLayered, true);
    assert.equal(dxfCodec.isLayered, true);
  });

  it("emfCodec and dxfCodec have no in-dialog preview", () => {
    assert.equal(emfCodec.noPreviewAvailable, true);
    assert.equal(dxfCodec.noPreviewAvailable, true);
  });

  it("installAiZstdWasmModule assigns aiCodec.zstdWasmExports", async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(aiCodec.zstdWasmExports);
  });

});
