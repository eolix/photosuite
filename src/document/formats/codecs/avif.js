/**
 * AVIF import via the host WebView image decoder (`createImageBitmap`).
 * Encode is not implemented — export uses other raster formats.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { makeElement } from "../../../core/dom.js";

/** @type {WeakMap<ArrayBuffer, Array<{ rect: Rect, data: ArrayBuffer }>>} */
const decodeCache = new WeakMap();

let rasterCanvas = null;

function readFourCc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * ISOBMFF `ftyp` compatible brands that denote AVIF still images.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function hasAvifCompatibleBrand(bytes) {
  if (bytes.length < 12 || readFourCc(bytes, 4) !== "ftyp") return false;
  const majorBrand = readFourCc(bytes, 8);
  if (majorBrand === "avif" || majorBrand === "avis") return true;
  const brandScanEnd = Math.min(bytes.length, 64);
  for (let brandOffset = 16; brandOffset + 4 <= brandScanEnd; brandOffset += 4) {
    const compatibleBrand = readFourCc(bytes, brandOffset);
    if (compatibleBrand === "avif" || compatibleBrand === "avis") return true;
  }
  return false;
}

function acquireRasterCanvas(width, height) {
  let canvas = rasterCanvas;
  if (canvas == null) canvas = rasterCanvas = makeElement("canvas");
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (ctx == null) throw new Error("avif: 2D canvas context unavailable");
  return { canvas, ctx };
}

async function decodeAvifBufferToLayerFrames(buffer) {
  if (typeof createImageBitmap !== "function") {
    throw new Error("avif: createImageBitmap is not available in this WebView");
  }
  const blob = new Blob([buffer], { type: "image/avif" });
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const { ctx } = acquireRasterCanvas(width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    return [{
      rect: new Rect(0, 0, width, height),
      data: imageData.data.buffer.slice(0),
    }];
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

export const avifCodec = {
  usesNativeDecoder: true,
};

/**
 * Decode AVIF bytes to RGBA layer frames using the host image decoder.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{ rect: Rect, data: ArrayBuffer }>>}
 */
avifCodec.decodeAsync = async function decodeAsync(buffer) {
  const cachedFrames = decodeCache.get(buffer);
  if (cachedFrames) return cachedFrames;
  const layerFrames = await decodeAvifBufferToLayerFrames(buffer);
  decodeCache.set(buffer, layerFrames);
  return layerFrames;
};

/**
 * Returns cached decode output when `decodeAsync` already ran on the same buffer.
 * Native AVIF decode is asynchronous — call `decodeAsync` first.
 * @param {ArrayBuffer} buffer
 */
avifCodec.decode = function decode(buffer) {
  const cachedFrames = decodeCache.get(buffer);
  if (cachedFrames) return cachedFrames;
  throw new Error("avif: native decode is asynchronous — call decodeAsync first");
};
