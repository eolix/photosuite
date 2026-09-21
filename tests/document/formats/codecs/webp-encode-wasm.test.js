/**
 * limits of the bundled WebP encoder WASM.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";

let wasm;

before(() => {
  const moduleBytes = readFileSync("src/wasm/webp-encode.wasm");
  wasm = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes)).exports;
});

/** Drive encode_rgba the way webp.js does. Returns encoded byte length, or 0. */
function encode(width, height, buildRgba, quality = 70) {
  const pixelBytes = width * height * 4;
  const rgba = new Uint8Array(pixelBytes);
  for (let byteIdx = 3; byteIdx < pixelBytes; byteIdx += 4) rgba[byteIdx] = 255;
  buildRgba(rgba);
  wasm.wasm_reset();
  const inputPtr = wasm.wasm_alloc(pixelBytes);
  const currentBytes = wasm.memory.buffer.byteLength;
  const needBytes = inputPtr + pixelBytes + width * height * 2;
  if (currentBytes < needBytes) wasm.memory.grow((needBytes - currentBytes >>> 16) + 1);
  new Uint8Array(wasm.memory.buffer).set(rgba, inputPtr);
  if (wasm.encode_rgba(inputPtr, width, height, quality) === 0) return 0;
  const size = wasm.get_result_size();
  wasm.free_result();
  return size;
}

describe("webp-encode.wasm", () => {
  it("encodes opaque images across sizes and qualities", () => {
    assert.ok(encode(16, 16, () => {}) > 0);
    assert.ok(encode(512, 512, (rgba) => {
      // Colour channels only — writing over the alpha byte would make these
      // pixels transparent and hit the limitation the next test pins.
      for (let px = 0; px < 256; px++) {
        rgba[px * 4] = 90; rgba[px * 4 + 1] = 40; rgba[px * 4 + 2] = 200;
      }
    }) > 0);
    assert.ok(encode(64, 64, () => {}, 0) > 0);
    assert.ok(encode(64, 64, () => {}, 100) > 0);
  });

  it("rejects transparency — one non-opaque pixel is enough", () => {
    // The limitation this pins is why webp.js refuses transparent input up front
    // instead of surfacing a bare failure code. If a rebuilt module makes these
    // pass, drop that guard and this expectation together.
    assert.equal(encode(64, 64, (rgba) => { rgba[3] = 254; }), 0);
    assert.equal(encode(64, 64, (rgba) => { rgba[rgba.length - 1] = 0; }), 0);
    assert.equal(encode(64, 64, (rgba) => {
      for (let alphaOff = 3; alphaOff < rgba.length; alphaOff += 4) rgba[alphaOff] = 128;
    }), 0);
  });

  it("rejects empty dimensions", () => {
    assert.equal(encode(0, 16, () => {}), 0);
    assert.equal(encode(16, 0, () => {}), 0);
  });
});
