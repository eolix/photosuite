/**
 * File format registry — detection, codecs, and document open/save dispatch.
 *
 * Codecs live under ../codecs/ (one or more formats per module).
 * Codecs import `registry-helpers.js` and `registry-api.js`, not this file.
 * Loader implementations are wired from `main.js` via `installLoaders`.
 */
import {
  getFormat,
  growWasmMemory,
  bytesToBase64,
  bindFormatCodecMap,
  detectFormat,
  matchBytesAt,
  installCodecLoaders,
  devToolsBinDb,
} from "./registry-helpers.js";

import { jpegCodec } from "../codecs/jpeg.js";
import { webpCodec } from "../codecs/webp.js";
import { avifCodec } from "../codecs/avif.js";
import { heicCodec } from "../codecs/heic.js";
import { pngCodec, gifCodec, icoCodec, tiffCodec } from "../codecs/raster-common.js";
import { bmpCodec, tgaCodec, ppmCodec, ilbmCodec } from "../codecs/raster-bitmap.js";
import { ddsCodec, vtfCodec } from "../codecs/raster-texture.js";
import { exrCodec, fitsCodec } from "../codecs/raster-hdr.js";
import { lifCodec, exeCodec } from "../codecs/raster-extra.js";
import { rafCodec, rawCodec } from "../codecs/camera-raw.js";
import {
  svgCodec,
  epsCodec,
  pdfCodec,
  aiCodec,
  wmfCodec,
  emfCodec,
  cdrCodec,
  dxfCodec,
  afCodec,
} from "../codecs/vector.js";
import {
  psbCodec,
  psdCodec,
  pxdCodec,
  sketchCodec,
  xdCodec,
  figCodec,
  xcfCodec,
  fpngCodec,
  pdnCodec,
} from "../codecs/layered-codec.js";
import { formatGroups, documentSaveFormatIds, listEncodableFormats, listSaveFormats, dataUrlToBuffer, parseDataUrlToBytes, bufferToDataUrl, base64ToBuffer, collectArtboardLayerIndices, encodeDocument, openFiles } from "./registry-api.js";

/** Format id → codec module. Also bound into `getFormat` via `bindFormatCodecMap`. */
const formatCodecEntries = [
  ["BMP", bmpCodec],
  ["CDR", cdrCodec],
  ["DDS", ddsCodec],
  ["EMF", emfCodec],
  ["DXF", dxfCodec],
  ["EPS", epsCodec],
  ["FIG", figCodec],
  ["FPNG", fpngCodec],
  ["GIF", gifCodec],
  ["ICO", icoCodec],
  ["ILBM", ilbmCodec],
  ["FITS", fitsCodec],
  ["EXR", exrCodec],
  ["JPG", jpegCodec],
  ["LIF", lifCodec],
  ["PDF", pdfCodec],
  ["PDN", pdnCodec],
  ["PNG", pngCodec],
  ["PPM", ppmCodec],
  ["PSB", psbCodec],
  ["PSD", psdCodec],
  ["PXD", pxdCodec],
  ["RAF", rafCodec],
  ["RAW", rawCodec],
  ["SKETCH", sketchCodec],
  ["SVG", svgCodec],
  ["TGA", tgaCodec],
  ["TIFF", tiffCodec],
  ["VTF", vtfCodec],
  ["WEBP", webpCodec],
  ["AVIF", avifCodec],
  ["HEIC", heicCodec],
  ["WMF", wmfCodec],
  ["XCF", xcfCodec],
  ["XD", xdCodec],
  ["EXE", exeCodec],
  ["AI", aiCodec],
  ["AF", afCodec],
];

const formatCodecMap = Object.fromEntries(formatCodecEntries);

bindFormatCodecMap(formatCodecMap);

function codecRegistryProperty(formatId) {
  return `${formatId.toLowerCase()}Codec`;
}

export const FileFormatRegistry = {
  installLoaders: installCodecLoaders,
  formatGroups,
  documentSaveFormatIds,
  growWasmMemory,
  devToolsBinDb,
  detectFormat,
  matchBytesAt,
  getFormat,
  listEncodableFormats,
  listSaveFormats,
  dataUrlToBuffer,
  parseDataUrlToBytes,
  bufferToDataUrl,
  bytesToBase64,
  base64ToBuffer,
  collectArtboardLayerIndices,
  encodeDocument,
  openFiles,
};

for (const [formatId, codec] of Object.entries(formatCodecMap)) {
  FileFormatRegistry[codecRegistryProperty(formatId)] = codec;
}
