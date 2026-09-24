/**
 * Leaf registry utilities imported by codecs without pulling in `file-format-registry.js`.
 *
 * Holds the bound format→codec map, late-bound parser loaders (`codecLoaders`),
 * magic-byte detection, and small binary helpers.
 */
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { IFFParser, RIFFParser } from "../metadata/chunk-container-parser.js";
import { hasAvifCompatibleBrand } from "../codecs/avif.js";
import { hasHeicCompatibleBrand } from "../codecs/heic.js";
import { lookupCameraBySize } from "../../../engine/compositing/raw-functions.js";

/* global pako, UZIP, BINDB, fetch, btoa */

/**
 * Formats the detector recognises but nothing decodes. Naming them is the whole
 * point: without this, `detectFormat` returns an id, no codec claims it, and
 * the open path calls a recognised file "unknown". The message says what the
 * file is and that PhotoSuite cannot read it, which is the truth.
 */
export const DETECT_ONLY_FORMAT_NAMES = {
  acv: "Photoshop curves preset (.acv)",
  ciff: "Canon CIFF raw (.crw)",
  msh: "Photoshop mesh (.msh)",
  pvr: "PowerVR texture (.pvr)",
};

/** @type {Record<string, { encode?, decode?, isLayered? }> | null} */
let formatCodecMap = null;

/** Late-bound parsers/loaders wired by `installFormatLoaders` at startup. */
export const codecLoaders = {};

export function bindFormatCodecMap(map) {
  formatCodecMap = map;
}

export function getFormat(id) {
  return formatCodecMap[id.toUpperCase()];
}

export function installCodecLoaders(loaders) {
  Object.assign(codecLoaders, loaders);
}

export function growWasmMemory(wasmModule, minByteLength) {
  const currentBytes = wasmModule.memory.buffer.byteLength;
  if (currentBytes < minByteLength) {
    wasmModule.memory.grow((minByteLength - currentBytes >>> 16) + 1);
  }
}

export function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let byteIdx = 0; byteIdx < bytes.length; byteIdx++) {
    out += String.fromCharCode(bytes[byteIdx]);
  }
  return btoa(out);
}

export function matchBytesAt(bytes, pattern, offset = 0) {
  for (let patternIdx = 0; patternIdx < pattern.length; patternIdx++) {
    if (pattern[patternIdx] != -1 && bytes[offset + patternIdx] != pattern[patternIdx]) {
      return false;
    }
  }
  return true;
}

export function detectFormat(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    console.log("Input is not ArrayBuffer");
  }
  const bytes = new Uint8Array(buffer);
  const matchAt = matchBytesAt;
  let formatId;
  let scanStart = 0;
  let scanEnd = bytes.length - 1;
  if (matchAt(bytes, [239, 187, 191])) scanStart = 3;
  while (
    scanStart < bytes.length &&
    (bytes[scanStart] == 9 || bytes[scanStart] == 10 || bytes[scanStart] == 13 || bytes[scanStart] == 32)
  ) {
    scanStart++;
  }
  while (
    scanEnd != 0 &&
    (bytes[scanEnd] == 9 || bytes[scanEnd] == 10 || bytes[scanEnd] == 13 || bytes[scanEnd] == 32)
  ) {
    scanEnd--;
  }
  if (matchAt(bytes, [56, 66, 80, 83])) formatId = "psd";
  if (matchAt(bytes, [120])) formatId = "pxd";
  if (matchAt(bytes, [80, 68, 78, 51])) formatId = "pdn";
  if (matchAt(bytes, [103, 105, 109, 112, 32, 120, 99, 102, 32])) formatId = "xcf";
  if (matchAt(bytes, [102, 105, 103, 45, 107, 105, 119, 105])) formatId = "fig";
  if (matchAt(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
    formatId = "png";
    let chunkOffset = 8;
    while (chunkOffset < bytes.length) {
      const chunkSize = BinaryUtils.readUint32BE(bytes, chunkOffset);
      chunkOffset += 4;
      const chunkTag = BinaryUtils.readString(bytes, chunkOffset, 4);
      chunkOffset += 4;
      if (chunkTag == "mkTS") formatId = "fpng";
      chunkOffset += chunkSize + 4;
    }
  }
  if (matchAt(bytes, [87, 76])) formatId = "cdr";
  if (matchAt(bytes, [82, 73, 70, 70])) {
    const riffRoot = RIFFParser.parse(bytes);
    const listType = riffRoot.listType;
    if (listType == "WEBP") formatId = "webp";
    else if (listType.slice(0, 3) == "CDR") formatId = "cdr";
    else formatId = listType;
  }
  if (hasAvifCompatibleBrand(bytes)) formatId = "avif";
  if (matchAt(bytes, [70, 79, 82, 77]) || matchAt(bytes, [76, 73, 83, 84]) || matchAt(bytes, [67, 65, 84, 32])) {
    const iffRoot = IFFParser.parse(bytes);
    const listType = iffRoot.listType;
    if (listType == "ILBM") formatId = "ilbm";
    else formatId = listType;
  }
  if (matchAt(bytes, [255, 216, 255])) formatId = "jpg";
  if (matchAt(bytes, [0, 0, 0, 12, 106, 80, 32, 32])) formatId = "jpg";
  if (matchAt(bytes, [48, 0, 1, 0], 4)) formatId = "jpg";
  if (matchAt(bytes, [71, 73, 70, 56])) formatId = "gif";
  if (matchAt(bytes, [0, 0, 0, 2, 121, 102, 113, 76])) formatId = "msh";
  if (matchAt(bytes, [0, 0, 0, 3, 121, 102, 113, 76])) formatId = "msh";
  if (matchAt(bytes, [0, 0, 0, 16])) formatId = "atn";
  // After the `atn` check: a HEIF whose `ftyp` box is exactly 16 bytes long
  // opens with the same four bytes an action set does.
  if (hasHeicCompatibleBrand(bytes)) formatId = "heic";
  if (matchAt(bytes, [0, 1])) formatId = "aco";
  if (matchAt(bytes, [0, 2])) formatId = "aco";
  if ([0, 1].indexOf(bytes[1]) != -1 && [1, 2, 3, 9, 10, 11].indexOf(bytes[2]) != -1 && [0, 16, 24, 32].indexOf(bytes[7]) != -1) {
    formatId = "tga";
  }
  if (matchAt(bytes, [56, 66, 83, 76], 2)) formatId = "asl";
  if (matchAt(bytes, [0, 1, 0, -1, 0, 2, 0])) formatId = "abr";
  if (matchAt(bytes, [0, 2, 0, -1, 0, 2, 0])) formatId = "abr";
  if (matchAt(bytes, [0, 6, 0, 1])) formatId = "abr";
  if (matchAt(bytes, [0, 255, 75, 65])) formatId = "af";
  if (matchAt(bytes, [0, 6, 0, 2])) formatId = "abr";
  if (matchAt(bytes, [0, 7, 0, 2])) formatId = "abr";
  if (matchAt(bytes, [0, 9, 0, 2])) formatId = "abr";
  if (matchAt(bytes, [0, 10, 0, 2])) formatId = "abr";
  if (matchAt(bytes, [56, 66, 70, 83])) formatId = "shc";
  if (matchAt(bytes, [56, 66, 80, 84])) formatId = "pat";
  if (matchAt(bytes, [56, 66, 71, 82])) formatId = "grd";
  if (matchAt(bytes, [56, 66, 84, 80])) formatId = "tpl";
  if (matchAt(bytes, [0, 4, 0, 5])) formatId = "acv";
  if (matchAt(bytes, [99, 117, 115, 104])) formatId = "csh";
  if (matchAt(bytes, [0, 1, 0, 0, 0])) formatId = "otf";
  if (matchAt(bytes, [79, 84, 84, 79])) formatId = "otf";
  if (matchAt(bytes, [116, 116, 99, 102])) formatId = "otf";
  if (matchAt(bytes, [68, 68, 83, 32])) formatId = "dds";
  if (matchAt(bytes, [80, 86, 82, 3])) formatId = "pvr";
  if (matchAt(bytes, [86, 84, 70, 0])) formatId = "vtf";
  if (matchAt(bytes, [83, 73, 77, 80])) formatId = "fits";
  if (matchAt(bytes, [0, 0, 1, 0])) formatId = "ico";
  if (matchAt(bytes, [66, 77])) formatId = "bmp";
  if (matchAt(bytes, [40, 0, 0, 0])) formatId = "bmp";
  if (matchAt(bytes, [80, 49])) formatId = "ppm";
  if (matchAt(bytes, [80, 50])) formatId = "ppm";
  if (matchAt(bytes, [80, 51])) formatId = "ppm";
  if (matchAt(bytes, [80, 52])) formatId = "ppm";
  if (matchAt(bytes, [80, 53])) formatId = "ppm";
  if (matchAt(bytes, [80, 54])) formatId = "ppm";
  if (matchAt(bytes, [73, 73, 42, 0])) formatId = "tiff";
  if (matchAt(bytes, [77, 77, 0, 42])) formatId = "tiff";
  if (matchAt(bytes, [70, 85, 74, 73, 70, 73, 76, 77])) formatId = "raf";
  if (matchAt(bytes, [112])) formatId = "lif";
  if (matchAt(bytes, [73, 73, 26, 0])) formatId = "ciff";
  if (matchAt(bytes, [83, 81, 76, 105])) formatId = "sketch";
  if (matchAt(bytes, [80, 75])) {
    const zipEntries = UZIP.parse(buffer, true);
    if (zipEntries["document.json"]) formatId = "sketch";
    else if (zipEntries.manifest) formatId = "xd";
    else if (zipEntries["canvas.fig"]) formatId = "fig";
    else formatId = "zip";
  }
  if (matchAt(bytes, [123])) formatId = "json";
  if (BinaryUtils.readUint32BE(bytes, 0) == bytes.length) formatId = "icc";
  if (matchAt(bytes, [35])) formatId = "icc";
  if (matchAt(bytes, [84, 73, 84, 76], scanStart)) formatId = "icc";
  if (matchAt(bytes, [76, 85, 84, 95], scanStart)) formatId = "icc";
  if (matchAt(bytes, [60, 63, 120, 109], scanStart)) {
    if (BinaryUtils.indexOfBytes(bytes, "<look>") != -1) formatId = "icc";
    else formatId = "svg";
  }
  if (matchAt(bytes, [60, 115, 118, 103], scanStart)) formatId = "svg";
  if (matchAt(bytes, [60, 33, 100, 111], scanStart) || matchAt(bytes, [60, 33, 68, 79], scanStart)) {
    if (BinaryUtils.indexOfBytes(bytes, "<svg") != -1) formatId = "svg";
    else formatId = "html";
  }
  if (matchAt(bytes, [37, 33]) || matchAt(bytes, [197, 208, 211, 198])) {
    if (BinaryUtils.indexOfBytes(bytes, "%AI9_PrivateDataBegin") != -1 || BinaryUtils.indexOfBytes(bytes, "%AI5_BeginLayer") != -1) {
      formatId = "ai";
    } else formatId = "eps";
  }
  if (matchAt(bytes, [37, 80, 68, 70], scanStart)) {
    if (BinaryUtils.indexOfBytes(bytes, "/AIMetaData ") != -1) formatId = "ai";
    else formatId = "pdf";
  } else if (matchAt(bytes, [10, 69, 79, 70], scanEnd - 3)) formatId = "dxf";
  if (matchAt(bytes, [215, 205, 198, 154])) formatId = "wmf";
  if (matchAt(bytes, [1, 0, 0, 0])) formatId = "emf";
  if (matchAt(bytes, [118, 47, 49, 1])) formatId = "exr";
  if (matchAt(bytes, [10, 10, 10, 10])) formatId = "jsx";
  if (matchAt(bytes, [77, 90])) formatId = "exe";
  if (formatId == null && lookupCameraBySize(bytes.length) != null) return "tiff";
  return formatId;
}

/**
 * The bundled binary asset store: WASM modules, packed textures and sample
 * images, keyed by path (`wasm/jpg`, `tex/…`, `img/beach`). `BINDB` maps a key
 * to a data URL the page ships with; `get` decodes and caches the bytes.
 *
 * It holds no document knowledge: codecs and the filter gallery reach it before
 * a document exists, which is why it sits at this level of the tree.
 */
export const devToolsBinDb = {
  fetchCompressAndLogBase64(url, tryCompress) {
    fetch(url)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => {
        let bytes = new Uint8Array(arrayBuffer);
        let rawLength = 0;
        if (tryCompress) {
          rawLength = bytes.length;
          const deflateOpts = { level: 9 };
          const pakoDeflated = pako.deflateRaw(bytes, deflateOpts);
          const uzipDeflated = UZIP.deflateRaw(bytes, deflateOpts);
          console.log(rawLength, pakoDeflated.length, uzipDeflated.length);
          bytes = pakoDeflated.length < uzipDeflated.length ? pakoDeflated : uzipDeflated;
        }
        let base64Chars = "";
        for (let byteIdx = 0; byteIdx < bytes.length; byteIdx++) {
          base64Chars += String.fromCharCode(bytes[byteIdx]);
        }
        const encoded = btoa(base64Chars);
        console.log(JSON.stringify([rawLength, encoded]));
      });
  },

  get(key, decodePayload) {
    const url = BINDB[key];
    if (!url) throw new Error("BINDB: unknown key: " + key);
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send();
    const raw = xhr.responseText;
    const payloadBytes = new Uint8Array(raw.length);
    for (let charIdx = 0; charIdx < raw.length; charIdx++) {
      payloadBytes[charIdx] = raw.charCodeAt(charIdx) & 0xff;
    }
    if (decodePayload) {
      const formatId = detectFormat(payloadBytes.buffer);
      return getFormat(formatId).decode(payloadBytes.buffer);
    }
    return payloadBytes;
  },
};
