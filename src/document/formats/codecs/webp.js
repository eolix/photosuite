/**
 * WebP codec: libwebp WASM decode and canvas/Rust encode paths.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../../core/render-buffer.js";
import { RIFFParser } from "../metadata/chunk-container-parser.js";
import { growWasmMemory, detectFormat, devToolsBinDb } from "../registry/registry-helpers.js";
import { dataUrlToBuffer } from "../registry/registry-api.js";
import { XMPData } from "../metadata/xmp-metadata.js";
import { allocBuffer, fillBuffer } from "../../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../../engine/compositing/pixel-ops.js";
import { composite } from "../../../engine/compositing/compositing-ops.js";

/* global UPNG, UTIF */

const DEFAULT_ENCODE_OPTIONS = [70, true, 0, 0];
const VP8X_ICCP_FLAG = 32;
const VP8X_EXIF_XMP_FLAGS = 12;
const SMALL_WEBP_ICCP_STRIP_THRESHOLD = 20000;

export const webpCodec = {
  wasmModule: null,
  encodeWasmModule: null,
};

/**
 * True when any pixel is less than fully opaque.
 * @param {ArrayBuffer|Uint8Array|Uint8ClampedArray} rgbaBuffer
 * @param {number} pixelCount
 * @returns {boolean}
 */
function rgbaHasTransparency(rgbaBuffer, pixelCount) {
  const bytes = rgbaBuffer instanceof ArrayBuffer
    ? new Uint8Array(rgbaBuffer)
    : new Uint8Array(rgbaBuffer.buffer || rgbaBuffer, rgbaBuffer.byteOffset || 0, rgbaBuffer.byteLength);
  const alphaEnd = Math.min(bytes.length, pixelCount * 4);
  for (let alphaOff = 3; alphaOff < alphaEnd; alphaOff += 4) {
    if (bytes[alphaOff] !== 255) return true;
  }
  return false;
}

/** Canvas `toDataURL("image/webp")` when supported; otherwise Rust encoder in `src/wasm/webp-encode.wasm`. */
function encodeRgbaToWebpBuffer(rgbaBuffer, width, height, quality01) {
  var viaCanvas = dataUrlToBuffer(rgbaBuffer, width, height, "webp", quality01);
  if (detectFormat(viaCanvas) == "webp") return new Uint8Array(viaCanvas);
  // The WASM encoder rejects any image carrying transparency, so say what is
  // wrong here rather than letting it fail with an opaque status code. The
  // canvas path above handles alpha wherever the webview can encode WebP at all.
  if (rgbaHasTransparency(rgbaBuffer, width * height)) {
    throw new Error(
      "This system's WebP encoder cannot store transparency. "
      + "Flatten the image onto a background, or export as PNG."
    );
  }
  return encodeRgbaViaWasm(rgbaBuffer, width, height, quality01 * 100);
}

function encodeRgbaViaWasm(rgbaBuffer, width, height, qualityPercent) {
  var wasm = webpCodec.encodeWasmModule;
  if (wasm == null) throw "webp: encode WASM module not loaded";
  var pixelBytes = width * height * 4;
  wasm.wasm_reset();
  var inputPtr = wasm.wasm_alloc(pixelBytes);
  growWasmMemory(wasm, inputPtr + pixelBytes + width * height * 2);
  var mem = new Uint8Array(wasm.memory.buffer);
  mem.set(new Uint8Array(rgbaBuffer, 0, pixelBytes), inputPtr);
  if (wasm.encode_rgba(inputPtr, width, height, qualityPercent) == 0) throw new Error("WebP encoding failed for this image.");
  var outputPtr = wasm.get_result_pointer();
  var outputSize = wasm.get_result_size();
  growWasmMemory(wasm, outputPtr + outputSize);
  mem = new Uint8Array(wasm.memory.buffer);
  var output = mem.slice(outputPtr, outputPtr + outputSize);
  wasm.free_result();
  return output;
}

/** Drop `removeLength` bytes starting at `offset` in a byte array. */
function removeBufferRange(bytes, offset, removeLength) {
  var outLength = bytes.length - removeLength;
  var out = new Uint8Array(outLength);
  for (var beforeIdx = 0; beforeIdx < offset; beforeIdx++) out[beforeIdx] = bytes[beforeIdx];
  for (var afterIdx = offset; afterIdx < outLength; afterIdx++) out[afterIdx] = bytes[afterIdx + removeLength];
  return out;
}

/** Copy one RIFF chunk payload (header + data) into `outBuffer` at `writeOffset`. */
function copyRiffChunkPayload(chunk, sourceBytes, outBuffer, writeOffset) {
  var sourceStart = chunk.dataOffset - 8;
  var byteCount = chunk.size + 8;
  outBuffer.ensureCapacity(writeOffset, byteCount);
  for (var byteIdx = 0; byteIdx < byteCount; byteIdx++) {
    outBuffer.data[writeOffset + byteIdx] = sourceBytes[sourceStart + byteIdx];
  }
  return writeOffset + byteCount;
}

function readAnimLoopRepeat(encodeOptions) {
  return encodeOptions[encodeOptions.length - 3];
}

function indexRiffChunksByTag(chunks) {
  var chunkByTag = {};
  for (var chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    chunkByTag[chunks[chunkIdx].tag] = chunks[chunkIdx];
  }
  return chunkByTag;
}

function stripIccpFromSmallWebp(output, vp8xFlags) {
  if (output.length >= SMALL_WEBP_ICCP_STRIP_THRESHOLD) return { output, vp8xFlags };
  var riffRoot = RIFFParser.parse(output.buffer);
  var chunks = riffRoot.sub;
  for (var chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    if (chunks[chunkIdx].tag != "ICCP") continue;
    var iccpChunk = chunks[chunkIdx];
    if (vp8xFlags & VP8X_ICCP_FLAG) vp8xFlags -= VP8X_ICCP_FLAG;
    output = removeBufferRange(output, iccpChunk.dataOffset - 8, iccpChunk.size + 8);
    BinaryUtils.writeFloat32Raw(output, 4, BinaryUtils.readFloat32(output, 4) - (iccpChunk.size + 8));
    break;
  }
  return { output, vp8xFlags };
}

function attachExifXmpMetadata(output, xmpMetadata, vp8xFlags) {
  var exifBytes = new Uint8Array(UTIF.encode([XMPData.writeExifMetadata(xmpMetadata)]));
  var xmpTextBytes = BinaryUtils.encodeUtf8(XMPData.writeXmpXml(xmpMetadata));
  var exifChunkSize = 8 + exifBytes.length;
  exifChunkSize += exifChunkSize & 1;
  var xmpChunkSize = 8 + xmpTextBytes.length;
  xmpChunkSize += xmpChunkSize & 1;
  var metadataBytes = new Uint8Array(exifChunkSize + xmpChunkSize);
  BinaryUtils.writeAsciiRaw(metadataBytes, 0, "EXIF");
  BinaryUtils.writeFloat32Raw(metadataBytes, 4, exifBytes.length);
  metadataBytes.set(exifBytes, 8);
  BinaryUtils.writeAsciiRaw(metadataBytes, exifChunkSize, "XMP ");
  BinaryUtils.writeFloat32Raw(metadataBytes, exifChunkSize + 4, xmpTextBytes.length);
  metadataBytes.set(xmpTextBytes, exifChunkSize + 8);
  var merged = new Uint8Array(output.length + metadataBytes.length);
  merged.set(output, 0);
  merged.set(metadataBytes, output.length);
  BinaryUtils.writeFloat32Raw(merged, 4, BinaryUtils.readFloat32(merged, 4) + metadataBytes.length);
  vp8xFlags |= VP8X_EXIF_XMP_FLAGS;
  return { output: merged, vp8xFlags };
}

function encodeStaticWebp(frames, width, height, encodeOptions, quality) {
  var output = encodeRgbaToWebpBuffer(frames[0][0], width, height, quality);
  if (detectFormat(output.buffer) != "webp") {
    throw new Error("This system cannot export WebP.");
  }
  var isVp8x = BinaryUtils.readString(output, 12, 4) == "VP8X";
  var vp8xFlags = isVp8x ? output[20] : 0;
  var stripped = stripIccpFromSmallWebp(output, vp8xFlags);
  output = stripped.output;
  vp8xFlags = stripped.vp8xFlags;
  var attachMetadata = encodeOptions.length > 1 ? encodeOptions[1] : true;
  if (attachMetadata && frames[0][3]) {
    var metadataResult = attachExifXmpMetadata(output, frames[0][3], vp8xFlags);
    output = metadataResult.output;
    vp8xFlags = metadataResult.vp8xFlags;
  }
  if (BinaryUtils.readString(output, 12, 4) == "VP8X") output[20] = vp8xFlags;
  return output.buffer;
}

function encodeAnimatedWebp(frames, width, height, encodeOptions, quality) {
  var writeAscii = BinaryUtils.writeAscii;
  var writeLe32 = BinaryUtils.writeFloat32;
  var outBuffer = new RenderBuffer();
  var writeOffset = 0;
  writeAscii(outBuffer, writeOffset, "RIFF    WEBPVP8X");
  writeOffset += 16;
  writeLe32(outBuffer, writeOffset, 10);
  writeOffset += 4;
  writeLe32(outBuffer, writeOffset, 18);
  writeOffset += 4;
  writeLe32(outBuffer, writeOffset, width - 1);
  writeOffset += 3;
  writeLe32(outBuffer, writeOffset, height - 1);
  writeOffset += 3;
  writeAscii(outBuffer, writeOffset, "ANIM");
  writeOffset += 4;
  writeLe32(outBuffer, writeOffset, 6);
  writeOffset += 4;
  outBuffer.ensureCapacity(writeOffset, 4);
  outBuffer.data[writeOffset + 3] = 255;
  BinaryUtils.writeUint16LE(outBuffer, writeOffset + 4, readAnimLoopRepeat(encodeOptions));
  writeOffset += 6;
  var rgbaBuffers = [];
  for (var frameIdx = 0; frameIdx < frames.length; frameIdx++) rgbaBuffers.push(frames[frameIdx][0]);
  var compressedFrames = UPNG.encode.compress(
    rgbaBuffers,
    width,
    height,
    quality == 1 ? 0 : Math.max(2, Math.floor(quality * 500)),
    [false, true, true, 0, true]
  ).frames;
  for (var animFrameIdx = 0; animFrameIdx < frames.length; animFrameIdx++) {
    writeAscii(outBuffer, writeOffset, "ANMF");
    writeOffset += 4;
    var chunkSizeOffset = writeOffset;
    writeOffset += 4;
    var frameInfo = compressedFrames[animFrameIdx];
    var frameRect = frameInfo.rect;
    var anmfHeader = [
      frameRect.x >>> 1,
      frameRect.y >>> 1,
      frameRect.width - 1,
      frameRect.height - 1,
      frames[animFrameIdx][1],
    ];
    for (var fieldIdx = 0; fieldIdx < 5; fieldIdx++) writeLe32(outBuffer, writeOffset + 3 * fieldIdx, anmfHeader[fieldIdx]);
    writeOffset += 15;
    outBuffer.ensureCapacity(writeOffset, 1);
    outBuffer.data[writeOffset] = 1 - frameInfo.blend << 1 | frameInfo.dispose;
    writeOffset++;
    var frameWebp = encodeRgbaToWebpBuffer(frameInfo.img.buffer, frameRect.width, frameRect.height, 1);
    var frameChunks = RIFFParser.parse(frameWebp.buffer).sub;
    var chunkByTag = indexRiffChunksByTag(frameChunks);
    if (chunkByTag.VP8L) writeOffset = copyRiffChunkPayload(chunkByTag.VP8L, frameWebp, outBuffer, writeOffset);
    else throw "webp: frame missing VP8 or VP8L chunk";
    var anmfPayloadSize = writeOffset - chunkSizeOffset - 4;
    writeLe32(outBuffer, chunkSizeOffset, anmfPayloadSize);
    if ((anmfPayloadSize & 1) == 1) {
      outBuffer.ensureCapacity(writeOffset, 1);
      writeOffset++;
    }
  }
  writeLe32(outBuffer, 4, writeOffset - 8);
  return outBuffer.data.slice(0, writeOffset).buffer;
}

function readWebpXmpMetadata(bytes, buffer, chunkByTag) {
  var xmpMetadata = null;
  if (chunkByTag.EXIF) {
    var exifChunk = chunkByTag.EXIF;
    var exifStart = exifChunk.dataOffset;
    var exifEnd = exifStart + exifChunk.size;
    if (bytes[exifChunk.dataOffset] == 69) exifStart += 6;
    var exifIfd = UTIF.decode(buffer.slice(exifStart, exifEnd))[0];
    if (exifIfd) xmpMetadata = XMPData.readExifMetadata(exifIfd);
  }
  var xmpChunk = chunkByTag["XMP\0"];
  if (xmpChunk == null) xmpChunk = chunkByTag["XMP "];
  if (xmpChunk) {
    var xmpBytes = new Uint8Array(buffer, xmpChunk.dataOffset, xmpChunk.size);
    if (xmpMetadata == null) xmpMetadata = {};
    xmpMetadata = XMPData.readXmpXml(BinaryUtils.readUtf8(xmpBytes, 0, xmpBytes.length), xmpMetadata);
  }
  return xmpMetadata;
}

function decodeStaticWebp(bytes, buffer, chunkByTag, xmpMetadata) {
  var vp8lChunk = chunkByTag.VP8L;
  var vp8Chunk = chunkByTag["VP8 "];
  var decodedWidth;
  var decodedHeight;
  if (vp8Chunk) {
    decodedWidth = BinaryUtils.readUint16LE(bytes, vp8Chunk.dataOffset + 6);
    decodedHeight = BinaryUtils.readUint16LE(bytes, vp8Chunk.dataOffset + 8);
  } else if (vp8lChunk) {
    var losslessBits = BinaryUtils.readFloat32(bytes, vp8lChunk.dataOffset + 1);
    decodedWidth = (losslessBits & (1 << 14) - 1) + 1;
    decodedHeight = (losslessBits >>> 14 & (1 << 14) - 1) + 1;
  } else throw "webp: unsupported bitstream type";
  var layerFrame = webpCodec.decodeWebpChunkToRgba(null, buffer, {
    dataOffset: 0,
    size: bytes.length,
  }, decodedWidth, decodedHeight);
  layerFrame.xmpMetadata = xmpMetadata;
  return [layerFrame];
}

function decodeAnimatedWebp(bytes, buffer, chunks, vp8xChunk) {
  var vp8xOffset = vp8xChunk.dataOffset;
  var canvasWidth = 1 + (BinaryUtils.readFloat32(bytes, vp8xOffset + 4) & 16777215);
  var canvasHeight = 1 + (BinaryUtils.readFloat32(bytes, vp8xOffset + 7) & 16777215);
  var animationFrames = [];
  var canvasRect = new Rect(0, 0, canvasWidth, canvasHeight);
  var canvasPixels = allocBuffer(canvasWidth * canvasHeight * 4);
  for (var chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    var anmfChunk = chunks[chunkIdx];
    if (anmfChunk.tag != "ANMF") continue;
    var anmfFields = [];
    for (var fieldIdx = 0; fieldIdx < 5; fieldIdx++) {
      anmfFields.push(BinaryUtils.readFloat32(bytes, anmfChunk.dataOffset + fieldIdx * 3) & 16777215);
    }
    var frameRect = new Rect(anmfFields[0] * 2, anmfFields[1] * 2, anmfFields[2] + 1, anmfFields[3] + 1);
    var frameDelayCs = anmfFields[4];
    var decodedFrame = webpCodec.decodeWebpChunkToRgba(null, buffer, {
      dataOffset: anmfChunk.dataOffset + 16,
      size: anmfChunk.size - 16,
    }, canvasWidth, canvasHeight);
    var framePixels = new Uint8Array(decodedFrame.data);
    var frameFlags = bytes[anmfChunk.dataOffset + 15];
    if (frameFlags >>> 1 == 0) {
      composite("norm", framePixels, frameRect, canvasPixels, canvasRect, frameRect, 1);
    } else {
      copyPixels(framePixels, frameRect, canvasPixels, canvasRect);
    }
    animationFrames.push({
      layerName: "_a_" + animationFrames.length + "," + frameDelayCs,
      rect: canvasRect.clone(),
      data: canvasPixels.buffer.slice(0),
    });
    if ((frameFlags & 1) == 1) {
      fillBuffer(framePixels, 0);
      copyPixels(framePixels, frameRect, canvasPixels, canvasRect);
    }
  }
  return animationFrames;
}

webpCodec.encode = function(frames, width, height, encodeOptions) {
  if (encodeOptions == null) encodeOptions = DEFAULT_ENCODE_OPTIONS;
  var quality = encodeOptions[0] / 100;
  if (frames.length == 1) return encodeStaticWebp(frames, width, height, encodeOptions, quality);
  return encodeAnimatedWebp(frames, width, height, encodeOptions, quality);
};

webpCodec.decode = function(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunks = RIFFParser.parse(buffer).sub;
  var chunkByTag = indexRiffChunksByTag(chunks);
  var xmpMetadata = readWebpXmpMetadata(bytes, buffer, chunkByTag);
  if (chunkByTag.ANIM == null) return decodeStaticWebp(bytes, buffer, chunkByTag, xmpMetadata);
  return decodeAnimatedWebp(bytes, buffer, chunks, chunkByTag.VP8X);
};

webpCodec.decodeWebpChunkToRgba = function(_canvasPixels, buffer, chunkSlice, canvasWidth, canvasHeight) {
  var wasm = webpCodec.wasmModule;
  var wasmMemory = wasm.memory;
  var requiredBytes = 5e6 + 2 * chunkSlice.size + canvasWidth * canvasHeight * 10;
  growWasmMemory(wasm, requiredBytes);
  var memoryView = new Uint8Array(wasmMemory.buffer);
  var inputPtr = wasm.malloc(chunkSlice.size);
  memoryView.set(new Uint8Array(buffer, chunkSlice.dataOffset, chunkSlice.size), inputPtr);
  var sizePtr = wasm.malloc(8);
  var argbPtr = wasm.WebPDecodeARGB(inputPtr, chunkSlice.size, sizePtr, sizePtr + 4);
  var decodedWidth = BinaryUtils.readFloat32(memoryView, sizePtr);
  var decodedHeight = BinaryUtils.readFloat32(memoryView, sizePtr + 4);
  var pixelCount = decodedWidth * decodedHeight * 4;
  var rgbaPixels = allocBuffer(pixelCount);
  for (var pixelOffset = 0; pixelOffset < pixelCount; pixelOffset += 4) {
    rgbaPixels[pixelOffset] = memoryView[argbPtr + pixelOffset + 1];
    rgbaPixels[pixelOffset + 1] = memoryView[argbPtr + pixelOffset + 2];
    rgbaPixels[pixelOffset + 2] = memoryView[argbPtr + pixelOffset + 3];
    rgbaPixels[pixelOffset + 3] = memoryView[argbPtr + pixelOffset];
  }
  wasm.WebPFree(argbPtr);
  wasm.free(sizePtr);
  wasm.free(inputPtr);
  return {
    rect: new Rect(0, 0, decodedWidth, decodedHeight),
    data: rgbaPixels.buffer,
  };
};

/** Loads libwebp decode WASM from `src/wasm/webp.wasm`. */
export function initWebpWasmDecoder() {
  var wasmBytes = devToolsBinDb.get("wasm/webp").buffer;
  return WebAssembly.instantiate(wasmBytes).then(function(result) {
    webpCodec.wasmModule = result.instance.exports;
  });
}

/** Rust lossy encoder (`src/wasm/webp-encode/`). Sync init — no import stubs. */
export function initWebpWasmEncoder() {
  var wasmBytes = devToolsBinDb.get("wasm/webp-enc").buffer;
  var instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes));
  webpCodec.encodeWasmModule = instance.exports;
}

initWebpWasmDecoder();
initWebpWasmEncoder();
