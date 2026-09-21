/**
 * HEIC / HEIF import through libheif compiled to WebAssembly.
 * Encode is not implemented — export uses other raster formats.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { hasAvifCompatibleBrand } from "./avif.js";

/* global libheif, BINDB, fetch */

/** BINDB key for the libheif WebAssembly binary, fetched on first decode. */
const LIBHEIF_WASM_KEY = "wasm/libheif";

/**
 * ISOBMFF `ftyp` brands that denote a HEVC-coded HEIF still or sequence.
 * `mif1` / `msf1` are the generic HEIF brands, which AVIF also carries as a
 * compatible brand — `hasHeicCompatibleBrand` resolves that overlap.
 */
const HEIC_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"];

/** @type {WeakMap<ArrayBuffer, Array<{ rect: Rect, data: ArrayBuffer }>>} */
const decodeCache = new WeakMap();

/** @type {Promise<object>|null} Shared libheif module, instantiated once. */
let libheifModuleLoad = null;

function readFourCc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * True when the `ftyp` box marks the file as HEIC/HEIF rather than AVIF. AVIF is
 * also an ISOBMFF image and lists `mif1` among its compatible brands, so files
 * carrying an AVIF brand belong to `avif.js` and are rejected here.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function hasHeicCompatibleBrand(bytes) {
  if (bytes.length < 12 || readFourCc(bytes, 4) !== "ftyp") return false;
  if (hasAvifCompatibleBrand(bytes)) return false;
  if (HEIC_BRANDS.indexOf(readFourCc(bytes, 8)) !== -1) return true;
  const brandScanEnd = Math.min(bytes.length, 64);
  for (let brandOffset = 16; brandOffset + 4 <= brandScanEnd; brandOffset += 4) {
    if (HEIC_BRANDS.indexOf(readFourCc(bytes, brandOffset)) !== -1) return true;
  }
  return false;
}

/**
 * The libheif module, compiled and instantiated on first use and shared after.
 *
 * The loader compiles its wasm with the synchronous `WebAssembly.Module`
 * constructor, which Chromium — and so WebView2 — refuses on the main thread
 * above 4 KB. Compiling here with `WebAssembly.compile` and handing the ready
 * module to emscripten's `instantiateWasm` hook keeps that off the main thread
 * on every WebView, and keeps the 1.4 MB binary off the startup path.
 *
 * @returns {Promise<object>}
 */
function loadLibheif() {
  if (libheifModuleLoad) return libheifModuleLoad;
  if (typeof libheif !== "function") {
    return Promise.reject(new Error("heic: libheif loader is not on the page"));
  }
  const wasmUrl = typeof BINDB !== "undefined" ? BINDB[LIBHEIF_WASM_KEY] : null;
  if (!wasmUrl) return Promise.reject(new Error("heic: no BINDB entry for " + LIBHEIF_WASM_KEY));
  libheifModuleLoad = fetch(wasmUrl)
    .then((response) => {
      if (!response.ok) throw new Error("heic: could not fetch libheif.wasm (" + response.status + ")");
      return response.arrayBuffer();
    })
    .then((wasmBytes) => WebAssembly.compile(wasmBytes))
    .then((wasmModule) => libheif({
      instantiateWasm(imports, onInstantiated) {
        return onInstantiated(new WebAssembly.Instance(wasmModule, imports), wasmModule);
      },
    }))
    .catch((err) => {
      // Leave no rejected promise cached, so a later open retries the fetch.
      libheifModuleLoad = null;
      throw err;
    });
  return libheifModuleLoad;
}

/**
 * Fill `frame.data` with the image's RGBA pixels. libheif applies the container's
 * `irot` / `imir` rotation and mirroring, so the frame arrives display-oriented.
 * @param {object} heifImage
 * @returns {Promise<{ rect: Rect, data: ArrayBuffer }>}
 */
function readHeifImageToLayerFrame(heifImage) {
  const width = heifImage.get_width();
  const height = heifImage.get_height();
  const frame = { data: new Uint8ClampedArray(width * height * 4), width: width, height: height };
  return new Promise((resolve, reject) => {
    heifImage.display(frame, (displayed) => {
      if (!displayed) reject(new Error("heic: libheif could not render this image"));
      else resolve({ rect: new Rect(0, 0, width, height), data: displayed.data.buffer });
    });
  });
}

async function decodeHeicBufferToLayerFrames(buffer) {
  const lib = await loadLibheif();
  const heifImages = new lib.HeifDecoder().decode(new Uint8Array(buffer));
  if (!heifImages || heifImages.length === 0) throw new Error("heic: no image found in this file");
  const layerFrames = [];
  for (const heifImage of heifImages) {
    try {
      layerFrames.push(await readHeifImageToLayerFrame(heifImage));
    } finally {
      // Each image holds a decoded plane inside the wasm heap until released.
      if (typeof heifImage.free === "function") heifImage.free();
    }
  }
  return layerFrames;
}

/** Read-only codec: the two decode entry points below are its whole surface. */
export const heicCodec = {};

/**
 * Decode HEIC bytes to RGBA layer frames. A file holding several images — a
 * burst, or a still paired with its thumbnail — yields one frame each.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{ rect: Rect, data: ArrayBuffer }>>}
 */
heicCodec.decodeAsync = async function decodeAsync(buffer) {
  const cachedFrames = decodeCache.get(buffer);
  if (cachedFrames) return cachedFrames;
  const layerFrames = await decodeHeicBufferToLayerFrames(buffer);
  decodeCache.set(buffer, layerFrames);
  return layerFrames;
};

/**
 * Returns cached decode output when `decodeAsync` already ran on the same buffer.
 * libheif loads its binary on demand, so decode is asynchronous.
 * @param {ArrayBuffer} buffer
 */
heicCodec.decode = function decode(buffer) {
  const cachedFrames = decodeCache.get(buffer);
  if (cachedFrames) return cachedFrames;
  throw new Error("heic: decode is asynchronous — call decodeAsync first");
};
