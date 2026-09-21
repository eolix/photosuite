/**
 * Vector and page codecs: SVG, EPS, PDF, AI, WMF, EMF, CDR, DXF, AF.
 * Wired in `file-format-registry.js`.
 */

import { Matrix2D } from "../../../core/math/matrix2d.js";
import { codecLoaders, devToolsBinDb } from "../registry/registry-helpers.js";
import { ToDXF, FromDXF } from "../dxf-format.js";

/* global FromPS, FromPDF, FromWMF, FromEMF, ToPDF, ToEMF */

const DEFAULT_SVG_ENCODE_OPTIONS = [true, false, false, false, true, true];
const DEFAULT_PDF_ENCODE_OPTIONS = ["", 100, false, false, false];
const DEFAULT_EMF_ENCODE_OPTIONS = ["", false, false, false];
const DXF_ENCODE_OPTIONS = ["", 100, false, false, false];

/** Maps SVG encode flags to the export object read by {@link codecLoaders.SVGLoader.exportSvg}. */
function buildSvgExportOptions(encodeOptions, width, height) {
  return {
    embedRasterLayers: encodeOptions[0],
    hidden: encodeOptions[1],
    textAsPaths: encodeOptions[2],
    textAsElements: !encodeOptions[3],
    names: encodeOptions[4],
    prettyPrint: encodeOptions[5],
    exportWidth: width,
    exportHeight: height,
  };
}

/**
 * Builds a VectorPageBuilder parser for PostScript/PDF/metafile loaders.
 * @param {object} doc
 * @param {number} rasterDpi
 * @param {boolean} flipY
 */
function createVectorPageBuilder(doc, rasterDpi, flipY) {
  var transform = new Matrix2D(1, 0, 0, flipY ? -1 : 1, 0, 0);
  transform.scale(rasterDpi / 72, rasterDpi / 72);
  doc.dpi = rasterDpi;
  return new codecLoaders.VectorPageBuilder(doc, transform, flipY);
}

function decodePdfDocument(buffer, doc, minSize) {
  var scaleFactor = 2;
  while (true) {
    var dpi = scaleFactor * 72;
    var pageBuilder = createVectorPageBuilder(doc, dpi, true);
    FromPDF.Parse(buffer, pageBuilder);
    var maxDimension = Math.max(doc.width, doc.height);
    if (minSize && maxDimension < Math.max(minSize[0], minSize[1])) {
      doc.layers = [];
      var startScaleFactor = scaleFactor;
      while (maxDimension * (scaleFactor / startScaleFactor) < Math.max(minSize[0], minSize[1])) {
        scaleFactor++;
      }
    } else break;
  }
}

function encodeSvgDocument(doc, width, height, encodeOptions, encodeContext) {
  if (encodeOptions == null) encodeOptions = DEFAULT_SVG_ENCODE_OPTIONS.slice();
  return codecLoaders.SVGLoader.exportSvg(
    doc,
    buildSvgExportOptions(encodeOptions, width, height),
    encodeContext.fontRegistry,
  );
}

function decodeSvgDocument(buffer, doc, minSize) {
  codecLoaders.SVGLoader.parse(buffer, doc, minSize);
}

function decodeEpsDocument(buffer, doc) {
  var pageBuilder = createVectorPageBuilder(doc, 150, true);
  FromPS.Parse(buffer, pageBuilder);
}

function encodePdfDocument(doc, width, height, encodeOptions, encodeContext) {
  if (encodeOptions == null) encodeOptions = DEFAULT_PDF_ENCODE_OPTIONS.slice();
  encodeOptions[5] = ["jpg"];
  var pdfWriter = new ToPDF();
  codecLoaders.VectorPageExporter.renderDocumentToPdf(doc, encodeOptions, pdfWriter, encodeContext.fontRegistry);
  return pdfWriter.buffer;
}

function decodeAiDocument(buffer, doc) {
  codecLoaders.AiFormatLoader.parse(buffer, doc);
}

function decodeWmfDocument(buffer, doc) {
  var pageBuilder = createVectorPageBuilder(doc, 72, false);
  FromWMF.Parse(buffer, pageBuilder);
}

function encodeEmfDocument(doc, width, height, encodeOptions, encodeContext) {
  if (encodeOptions == null) encodeOptions = DEFAULT_EMF_ENCODE_OPTIONS.slice();
  encodeOptions[4] = [];
  var emfWriter = new ToEMF();
  codecLoaders.VectorPageExporter.renderDocumentToPdf(doc, encodeOptions, emfWriter, encodeContext.fontRegistry);
  return emfWriter.buffer;
}

function decodeEmfDocument(buffer, doc) {
  var pageBuilder = createVectorPageBuilder(doc, 72, false);
  FromEMF.Parse(buffer, pageBuilder);
}

function decodeCdrDocument(buffer, doc) {
  return codecLoaders.CdrLoader.parse(buffer, doc);
}

function decodeAfDocument(buffer, doc) {
  if (!codecLoaders.AffinityLoader.zstdWasm) {
    codecLoaders.AffinityLoader.zstdWasm = aiCodec.zstdWasmExports;
  }
  return codecLoaders.AffinityLoader.parse(buffer, doc, codecLoaders);
}

function encodeDxfDocument(doc, width, height, encodeOptions, encodeContext) {
  encodeOptions = DXF_ENCODE_OPTIONS.slice();
  encodeOptions[5] = ["jpg"];
  var dxfWriter = new ToDXF();
  codecLoaders.VectorPageExporter.renderDocumentToPdf(doc, encodeOptions, dxfWriter, encodeContext.fontRegistry);
  return dxfWriter.buffer;
}

function decodeDxfDocument(buffer, doc) {
  var pageBuilder = createVectorPageBuilder(doc, 72, false);
  FromDXF.Parse(buffer, pageBuilder);
}

/** Loads zstd WASM exports for AI/Affinity compressed streams. */
function installAiZstdWasmModule() {
  var zstdWasmBytes = devToolsBinDb.get("wasm/zstd").buffer;
  WebAssembly.instantiate(zstdWasmBytes).then(function (wasmModule) {
    aiCodec.zstdWasmExports = wasmModule.instance.exports;
  });
}

export const svgCodec = {};
svgCodec.isLayered = true;
svgCodec.encode = encodeSvgDocument;
svgCodec.decode = decodeSvgDocument;

export const epsCodec = {};
epsCodec.isLayered = true;
epsCodec.decode = decodeEpsDocument;

export const pdfCodec = {};
pdfCodec.isLayered = true;
pdfCodec.encode = encodePdfDocument;
pdfCodec.decode = decodePdfDocument;

export const aiCodec = {};
aiCodec.isLayered = true;
aiCodec.decode = decodeAiDocument;

export const wmfCodec = {};
wmfCodec.isLayered = true;
wmfCodec.decode = decodeWmfDocument;

export const emfCodec = {};
emfCodec.noPreviewAvailable = true;
emfCodec.isLayered = true;
emfCodec.encode = encodeEmfDocument;
emfCodec.decode = decodeEmfDocument;

export const cdrCodec = {};
cdrCodec.isLayered = true;
cdrCodec.decode = decodeCdrDocument;

export const afCodec = {};
afCodec.isLayered = true;
afCodec.decode = decodeAfDocument;

export const dxfCodec = {};
dxfCodec.noPreviewAvailable = true;
dxfCodec.isLayered = true;
dxfCodec.encode = encodeDxfDocument;
dxfCodec.decode = decodeDxfDocument;

installAiZstdWasmModule();
