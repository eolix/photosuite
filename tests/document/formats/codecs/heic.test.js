import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

// The browser stubs replace globalThis.WebAssembly with an inert double; the
// end-to-end decode needs the real one back.
const nodeWebAssembly = globalThis.WebAssembly;

let hasHeicCompatibleBrand;
let heicCodec;
let detectFormat;
let restoreBrowserGlobals;
let previousGlobals;

const repoFile = (relativePath) =>
  fileURLToPath(new URL("../../../../" + relativePath, import.meta.url));

const LIBHEIF_LOADER = repoFile("src/vendor/wasm/libheif/libheif.js");
const LIBHEIF_WASM = repoFile("src/vendor/wasm/libheif/libheif.wasm");
// libheif ships a sample HEIC with its source; the pinned submodule is the one
// place a real HEVC-coded file exists in the tree, so the end-to-end decode
// leans on it and skips when submodules are not checked out.
const SAMPLE_HEIC = repoFile("src/vendor/libheif/examples/example.heic");

/** The file's bytes as a tightly sized ArrayBuffer — Node pools Buffer storage. */
function readFileBuffer(path) {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Minimal ISOBMFF `ftyp` box carrying `major` and one compatible brand. */
function buildFtypBuffer(major, compatible) {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 32, 102, 116, 121, 112]); // box length, "ftyp"
  for (let charIdx = 0; charIdx < 4; charIdx++) bytes[8 + charIdx] = major.charCodeAt(charIdx);
  if (compatible) {
    for (let charIdx = 0; charIdx < 4; charIdx++) bytes[16 + charIdx] = compatible.charCodeAt(charIdx);
  }
  return bytes.buffer;
}

/**
 * The page globals `heic.js` reads: the emscripten loader as a script global,
 * the wasm URL map, and a `fetch` that serves the binary off disk.
 */
function installLibheifGlobals() {
  previousGlobals = {
    WebAssembly: globalThis.WebAssembly,
    libheif: globalThis.libheif,
    BINDB: globalThis.BINDB,
    fetch: globalThis.fetch,
  };
  globalThis.WebAssembly = nodeWebAssembly;
  globalThis.libheif = createRequire(import.meta.url)(LIBHEIF_LOADER);
  globalThis.BINDB = { "wasm/libheif": LIBHEIF_WASM };
  globalThis.fetch = (url) =>
    Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(readFileBuffer(url)) });
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ hasHeicCompatibleBrand, heicCodec } = await import(
    "../../../../src/document/formats/codecs/heic.js"
  ));
  ({ detectFormat } = await import(
    "../../../../src/document/formats/registry/registry-helpers.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
  if (previousGlobals) Object.assign(globalThis, previousGlobals);
});

describe("document/formats/codecs/heic.js", () => {
  it("hasHeicCompatibleBrand matches the HEVC still brands", () => {
    for (const brand of ["heic", "heix", "heim", "heis", "hevc", "mif1", "msf1"]) {
      assert.equal(hasHeicCompatibleBrand(new Uint8Array(buildFtypBuffer(brand))), true, brand);
    }
  });

  it("hasHeicCompatibleBrand matches a brand listed after the major one", () => {
    const bytes = new Uint8Array(buildFtypBuffer("mp41", "heic"));
    assert.equal(hasHeicCompatibleBrand(bytes), true);
  });

  it("hasHeicCompatibleBrand leaves AVIF to its own codec", () => {
    // AVIF is an ISOBMFF image too and lists the generic HEIF brand `mif1`
    // alongside `avif`, so brand overlap alone must not claim the file.
    const bytes = new Uint8Array(buildFtypBuffer("avif", "mif1"));
    assert.equal(hasHeicCompatibleBrand(bytes), false);
  });

  it("hasHeicCompatibleBrand ignores files with no ftyp box", () => {
    assert.equal(hasHeicCompatibleBrand(new Uint8Array(64)), false);
  });

  it("detectFormat returns heic for a HEIC ftyp", () => {
    assert.equal(detectFormat(buildFtypBuffer("heic")), "heic");
  });

  it("detectFormat still returns avif for an AVIF ftyp", () => {
    assert.equal(detectFormat(buildFtypBuffer("avif", "mif1")), "avif");
  });

  it("detectFormat prefers heic over the action-set magic on a 16-byte ftyp", () => {
    // An action set opens with the same 00 00 00 10 a 16-byte ftyp box does.
    const bytes = new Uint8Array(64);
    bytes.set([0, 0, 0, 16, 102, 116, 121, 112]);
    bytes.set([104, 101, 105, 99], 8); // "heic"
    assert.equal(detectFormat(bytes.buffer), "heic");
  });

  it("decode throws until decodeAsync populates the cache", () => {
    assert.throws(() => heicCodec.decode(buildFtypBuffer("heic")), /asynchronous/);
  });

  it("decodeAsync renders a HEIC file to opaque RGBA frames", { skip: !existsSync(SAMPLE_HEIC) }, async () => {
    installLibheifGlobals();
    const buffer = readFileBuffer(SAMPLE_HEIC);
    const frames = await heicCodec.decodeAsync(buffer);

    assert.ok(frames.length >= 1);
    const [{ rect, data }] = frames;
    assert.ok(rect.width > 0 && rect.height > 0);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    assert.equal(data.byteLength, rect.width * rect.height * 4);

    // A rendered still is fully opaque and not a uniform block of one colour.
    const pixels = new Uint8ClampedArray(data);
    assert.equal(pixels[3], 255);
    assert.ok(pixels.some((channel, index) => index % 4 !== 3 && channel !== pixels[0]));

    // The second call is served from the cache, so the sync entry point works.
    assert.equal(heicCodec.decode(buffer), frames);
  });
});
