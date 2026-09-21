/* global UTIF, alert */
/**
 * RAW decode / develop pipeline: camera lookup, vendor normalize, pixel unpack,
 * DNG opcodes, CFA demosaic hooks, orientation, white-balance, and tone curves.
 *
 * Camera model matrices live in raw-camera-db.js.
 */

import { BinaryUtils } from '../../core/binary/binary-utils.js';
import { copyBuffer } from "./buffer-utils.js";
import { CAMERA_DATABASE } from "./raw-camera-db.js";
import { grayscaleToRgb, seamColorSample, upsampleBlock } from "./pixel-ops.js";
import { linearToSrgb } from "./color-math.js";
import { colorScaleMatrix, from3x3, invertColorMatrix, multiplyColorMatrices, multiplyVec4, xyzToRgb } from "./color-matrix.js";
import {
  D50_CHROMATICITY,
  chromaticityFromTemperatureAndTint,
  planckianLocusFromChromaticity,
  xyToNormalizedXyz
} from './color-temperature.js';

const BITS_PER_PIXEL_CANDIDATES = [8, 10, 12, 14, 16];
const FALLBACK_SENSOR_SIZES = [
  [4e3, 3e3]
];

/**
 * Four 2×2 CFA phase layouts (channel indices: 0=R, 1=G, 2=B). The Nikon raw
 * IFD's t50656 tag selects one by index.
 */
export const BAYER_PATTERNS = [
  [2, 1, 1, 0],
  [0, 1, 1, 2],
  [1, 0, 2, 1],
  [1, 2, 0, 1]
];

/** DNG tags whose values are rational pairs and should become floats. */
const DNG_RATIONAL_TAG_IDS = [50714, 50718, 50719, 50720, 50721, 50722, 50723, 50724, 50727, 50728, 50730, 50731, 50732, 50734, 50736, 50738, 50739, 50780, 50964, 50965];

/** Nikon encrypted maker-note format table: [tagId, magicPrefix, lengthOr0, variant, payloadOffset|null]. */
export const NIKON_FORMAT_ENTRIES = 
[
    [145, "0208", 0, 0, 4],
    [145, "0209", 0, 1, 4],
    [145, "0210", 5291, 2, 4],
    [145, "0210", 5303, 3, 4],
    [145, "02", 0, 4, 4],
    [145, "01", 0, 5, null],
    [151, "0100", 0, 0, null],
    [151, "0102", 0, 1, null],
    [151, "0103", 0, 4, null],
    [151, "0204", 0, 3, 284],
    [151, "0205", 0, 2, 4],
    [151, "0206", 0, 3, 284],
    [151, "0207", 0, 3, 284],
    [151, "0208", 0, 3, 284],
    [151, "0209", 0, 5, 284],
    [151, "02", 0, 3, 284],
    [152, "0100", 0, 0, null],
    [152, "0101", 0, 1, null],
    [152, "0201", 0, 1, 4],
    [152, "0202", 0, 1, 4],
    [152, "0203", 0, 1, 4],
    [152, "0204", 0, 2, 4],
    [168, "0100", 0, 0, null],
    [168, "0101", 0, 0, null],
    [168, "0102", 0, 1, null],
    [168, "0103", 0, 2, null]
  ];

export const NIKON_ENCRYPTION_LUT_A = [193, 191, 109, 13, 89, 197, 19, 157, 131, 97, 107, 79, 199, 127, 61, 61, 83, 89, 227, 199, 233, 47, 149, 167, 149, 31, 223, 127, 43, 41, 199, 13, 223, 7, 239, 113, 137, 61, 19, 61, 59, 19, 251, 13, 137, 193, 101, 31, 179, 13, 107, 41, 227, 251, 239, 163, 107, 71, 127, 149, 53, 167, 71, 79, 199, 241, 89, 149, 53, 17, 41, 97, 241, 61, 179, 43, 13, 67, 137, 193, 157, 157, 137, 101, 241, 233, 223, 191, 61, 127, 83, 151, 229, 233, 149, 23, 29, 61, 139, 251, 199, 227, 103, 167, 7, 241, 113, 167, 83, 181, 41, 137, 229, 43, 167, 23, 41, 233, 79, 197, 101, 109, 107, 239, 13, 137, 73, 47, 179, 67, 83, 101, 29, 73, 163, 19, 137, 89, 239, 107, 239, 101, 29, 11, 89, 19, 227, 79, 157, 179, 41, 67, 43, 7, 29, 149, 89, 89, 71, 251, 229, 233, 97, 71, 47, 53, 127, 23, 127, 239, 127, 149, 149, 113, 211, 163, 11, 113, 163, 173, 11, 59, 181, 251, 163, 191, 79, 131, 29, 173, 233, 47, 113, 101, 163, 229, 7, 53, 61, 13, 181, 233, 229, 71, 59, 157, 239, 53, 163, 191, 179, 223, 83, 211, 151, 83, 73, 113, 7, 53, 97, 113, 47, 67, 47, 17, 223, 23, 151, 251, 149, 59, 127, 107, 211, 37, 191, 173, 199, 197, 197, 181, 139, 239, 47, 211, 7, 107, 37, 73, 149, 37, 73, 109, 113, 199];
export const NIKON_ENCRYPTION_LUT_B = [167, 188, 201, 173, 145, 223, 133, 229, 212, 120, 213, 23, 70, 124, 41, 76, 77, 3, 233, 37, 104, 17, 134, 179, 189, 247, 111, 97, 34, 162, 38, 52, 42, 190, 30, 70, 20, 104, 157, 68, 24, 194, 64, 244, 126, 95, 27, 173, 11, 148, 182, 103, 180, 11, 225, 234, 149, 156, 102, 220, 231, 93, 108, 5, 218, 213, 223, 122, 239, 246, 219, 31, 130, 76, 192, 104, 71, 161, 189, 238, 57, 80, 86, 74, 221, 223, 165, 248, 198, 218, 202, 144, 202, 1, 66, 157, 139, 12, 115, 67, 117, 5, 148, 222, 36, 179, 128, 52, 229, 44, 220, 155, 63, 202, 51, 69, 208, 219, 95, 245, 82, 195, 33, 218, 226, 34, 114, 107, 62, 208, 91, 168, 135, 140, 6, 93, 15, 221, 9, 25, 147, 208, 185, 252, 139, 15, 132, 96, 51, 28, 155, 69, 241, 240, 163, 148, 58, 18, 119, 51, 77, 68, 120, 40, 60, 158, 253, 101, 87, 22, 148, 107, 251, 89, 208, 200, 34, 54, 219, 210, 99, 152, 67, 161, 4, 135, 134, 247, 166, 38, 187, 214, 89, 77, 191, 106, 46, 170, 43, 239, 230, 120, 182, 78, 224, 47, 220, 124, 190, 87, 25, 50, 126, 42, 208, 184, 186, 41, 0, 60, 82, 125, 168, 73, 59, 45, 235, 37, 73, 250, 163, 170, 57, 167, 197, 167, 80, 17, 54, 251, 198, 103, 74, 245, 165, 18, 101, 126, 176, 223, 175, 78, 179, 97, 127, 47];

const CANON_TABLE_LAYOUTS = [
  null,
  [25, 166],
  [34, 286],
  [63, 196],
  [63],
  null, // filled per tableKind at call site
  [63, 251],
  null, // filled per tableKind at call site
  [63, 326]
];

const CANON_VARIANT4_LENGTHS = [692, 674, 702, 1227, 1250, 1251, 1337, 1338, 1346];
const CANON_VARIANT7_LENGTHS = [1312, 1313, 1316, 1506];
const CANON_VARIANT8_LENGTHS = [1560, 1592, 1353, 1602];
const OPCODE_LIST_TAGS = [51008, 51009, 51022];

// --- small pure helpers ----------------------------------------------------

export function rationalsToFloats(tagValues) {
  if (tagValues == null || tagValues.length == 0 || typeof tagValues[0] == "number") return tagValues;
  var floats = [];
  for (var idx = 0; idx < tagValues.length; idx++) floats[idx] = tagValues[idx][1] == 0 ? 0 : tagValues[idx][0] / tagValues[idx][1];
  return floats;
}

function swapBytePairs(bytes) {
  for (var off = 0; off < bytes.length; off += 2) {
    var tmp = bytes[off];
    bytes[off] = bytes[off + 1];
    bytes[off + 1] = tmp;
  }
}

export function applyExposureCurve(value, adjustment) {
  var midtoneBlend = .5 - .5 * Math.cos(value * 3.2),
    curved = 0;
  if (adjustment > 0) {
    var highlightWeight = value * .2;
    curved = highlightWeight * value + (1 - highlightWeight) * midtoneBlend;
  } else {
    var shadowLift = Math.pow(value, .33);
    curved = (1 - shadowLift) * shadowLift + shadowLift * (value + (value - midtoneBlend) * .63);
  }
  var blend = Math.abs(adjustment);
  return blend * curved + (1 - blend) * value;
}

export function applyHighlightCurve(value, adjustment) {
  var curved = 0;
  if (adjustment > 0) {
    var softRoll = value * 1.47,
      powerBlend = Math.pow(value, 2.4);
    curved = Math.min(1, powerBlend * value + (1 - powerBlend) * softRoll);
  } else {
    var softRoll = value * .68,
      powerBlend = Math.pow(value, 3);
    curved = powerBlend * value * .5 + (1 - powerBlend) * softRoll;
  }
  var blend = Math.abs(adjustment);
  return blend * curved + (1 - blend) * value;
}

export function applyShadowCurve(value, adjustment) {
  var curved = 0;
  if (adjustment > 0) {
    var shadowCurve = Math.pow(value, .3),
      linear = value;
    curved = (1 - value) * shadowCurve + value * linear;
  } else {
    var shadowCurve = Math.pow(value, 2.5),
      weight = value,
      linear = value;
    curved = Math.min(1, (1 - weight) * shadowCurve + weight * linear);
  }
  var blend = Math.abs(adjustment);
  return blend * curved + (1 - blend) * value;
}

export function orientationMatrix(orientation, width, height) {
  if (orientation == 2) return [width, height, -1, 0, width - 1, 0, 1, 0];
  if (orientation == 3) return [width, height, -1, 0, width - 1, 0, -1, height - 1];
  if (orientation == 4) return [width, height, 1, 0, 0, 0, -1, height - 1];
  if (orientation == 5) return [height, width, 0, 1, 0, 1, 0, 0];
  if (orientation == 6) return [height, width, 0, 1, 0, -1, 0, height - 1];
  if (orientation == 8) return [height, width, 0, -1, width - 1, 1, 0, 0];
  throw "unknown orientation " + orientation;
}

export function getBlackLevel(rawMeta) {
  var blackTag = rawMeta.t50714,
    blackLevel = blackTag ? blackTag[0] : 0,
    blackDelta = rawMeta.t50715,
    blackOffset = rawMeta.t50716;
  if (blackDelta) blackLevel += blackDelta[0][0] / blackDelta[0][1];
  if (blackOffset) blackLevel += blackOffset[0][0] / blackOffset[0][1];
  return Math.round(blackLevel);
}

export function getWhiteLevel(rawMeta) {
  var linearizationLut = null,
    lutMaxIndex = 0;
  if (rawMeta.t50712) {
    linearizationLut = rawMeta.t50712;
    lutMaxIndex = linearizationLut.length - 1;
  }
  var whiteLevel = rawMeta.t50717 ? rawMeta.t50717[0] : (1 << rawMeta.t258[0]) - 1;
  if (linearizationLut) whiteLevel = Math.min(whiteLevel, linearizationLut[lutMaxIndex]);
  return whiteLevel;
}

export function getPixelRange(rawMeta) {
  return getWhiteLevel(rawMeta) - getBlackLevel(rawMeta);
}

export function interpolateColorMatrix(lowMatrix, highMatrix, lowTemp, highTemp, correlatedTemp) {
  if (!lowMatrix && !highMatrix) {
    return null;
  } else if (lowMatrix && !highMatrix) {
    return lowMatrix;
  } else if (correlatedTemp < lowTemp) {
    return lowMatrix;
  } else if (correlatedTemp > highTemp) {
    return highMatrix;
  } else {
    var lowWeight = (1 / correlatedTemp - 1 / highTemp) / (1 / lowTemp - 1 / highTemp),
      highWeight = 1 - lowWeight,
      blended = [];
    for (var coeffIdx = 0; coeffIdx < 9; coeffIdx++) blended[coeffIdx] = lowMatrix[coeffIdx] * lowWeight + highMatrix[coeffIdx] * highWeight;
    return blended;
  }
}

function chromaticityFromRgb(rgb) {
  var sum = rgb[0] + rgb[1] + rgb[2];
  return {
    x: rgb[0] / sum,
    y: rgb[1] / sum
  };
}

function bradfordAdaptationBetween(sourceXyz, targetXyz) {
  var bradford = from3x3([.8951, .2664, -.1614, -.7502, 1.7135, .0367, .0389, -.0685, 1.0296]),
    sourceBradford = [sourceXyz.x, sourceXyz.y, sourceXyz.zChannel, 0],
    targetBradford = [targetXyz.x, targetXyz.y, targetXyz.zChannel, 0];
  sourceBradford = multiplyVec4(bradford, sourceBradford);
  targetBradford = multiplyVec4(bradford, targetBradford);
  var scaleR = targetBradford[0] / sourceBradford[0],
    scaleG = targetBradford[1] / sourceBradford[1],
    scaleB = targetBradford[2] / sourceBradford[2],
    scaleMatrix = from3x3([scaleR, 0, 0, 0, scaleG, 0, 0, 0, scaleB]),
    invertedBradford = invertColorMatrix(bradford);
  return multiplyColorMatrices(multiplyColorMatrices(invertedBradford, scaleMatrix), bradford);
}

// --- camera lookup / Sigma -------------------------------------------------

export function lookupCameraBySize(byteLength) {
  byteLength *= 8;
  var cameraDatabase = CAMERA_DATABASE;
  for (var modelKey in cameraDatabase) {
    var entry = cameraDatabase[modelKey];
    if (entry.length == 4) continue;
    var width = entry[4],
      height = entry[5];
    for (var bppIdx = 0; bppIdx < BITS_PER_PIXEL_CANDIDATES.length; bppIdx++)
      if (width * height * BITS_PER_PIXEL_CANDIDATES[bppIdx] == byteLength) return [modelKey, BITS_PER_PIXEL_CANDIDATES[bppIdx]];
  }
  for (var sizeIdx = 0; sizeIdx < FALLBACK_SENSOR_SIZES.length; sizeIdx++) {
    var dims = FALLBACK_SENSOR_SIZES[sizeIdx],
      width = dims[0],
      height = dims[1];
    for (var bppIdx = 0; bppIdx < BITS_PER_PIXEL_CANDIDATES.length; bppIdx++)
      if (width * height * BITS_PER_PIXEL_CANDIDATES[bppIdx] == byteLength) return [dims, BITS_PER_PIXEL_CANDIDATES[bppIdx]];
  }
  return null;
}

export function decodeSigmaRaw(rawBytes) {
  var pixelData = new Uint8Array(rawBytes);
  swapBytePairs(pixelData);
  var sizeMatch = lookupCameraBySize(pixelData.length),
    camEntry = CAMERA_DATABASE[sizeMatch[0]];
  if (camEntry == null) camEntry = [
    [8489, -2583, -1036, -8051, 15583, 2643, -1307, 1407, 7354], 0, 1e3, 64383, sizeMatch[0][0], sizeMatch[0][1]
  ];
  var width = camEntry[4],
    height = camEntry[5],
    blackLevel = Math.max(camEntry[2], 116),
    rawMeta = {
      data: pixelData,
      orientation: 1,
      width: width,
      height: height,
      t256: [width],
      t257: [height],
      t258: [sizeMatch[1]],
      t277: [1],
      t33421: [2, 2],
      t33422: BAYER_PATTERNS[camEntry[1]],
      t50706: [1, 2, 0, 0],
      t50714: [blackLevel, blackLevel, blackLevel, blackLevel],
      t50717: [camEntry[3]],
      t50721: camEntry[0].slice(0),
      t50723: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      t50728: [.64, 1, .46],
      t50778: [17]
    };
  for (var coeffIdx = 0; coeffIdx < 9; coeffIdx++) rawMeta.t50721[coeffIdx] /= 1e4;
  return rawMeta;
}

// --- Nikon encryption ------------------------------------------------------

export function decryptNikonData(cipherWords, plainBytes, wordCount, rngSeed) {
  if (0 == wordCount) return;
  var keystream = new Uint32Array(128),
    keystreamBytes = new Uint8Array(keystream.buffer),
    streamIdx = 127,
    cipherIdx = 0,
    plainIdx = 0;
  for (var streamIdx = 0; streamIdx < 4; streamIdx++) keystream[streamIdx] = rngSeed = (rngSeed * 15625 >>> 0) * 3125 + 1 >>> 0;
  keystream[3] = keystream[3] << 1 | (keystream[0] ^ keystream[2]) >>> 31;
  for (var streamIdx = 4; streamIdx < 127; streamIdx++) keystream[streamIdx] = (keystream[streamIdx - 4] ^ keystream[streamIdx - 2]) << 1 | (keystream[streamIdx - 3] ^ keystream[streamIdx - 1]) >>> 31;
  for (var streamIdx = 0; streamIdx < 127; streamIdx++) keystream[streamIdx] = BinaryUtils.readUint32BE(keystreamBytes, streamIdx * 4);
  for (; wordCount > 0; wordCount--) {
    keystream[streamIdx & 127] = keystream[streamIdx + 1 & 127] ^ keystream[streamIdx + 1 + 64 & 127];
    var keyWord = keystream[streamIdx & 127],
      plainByte = cipherWords[cipherIdx];
    plainByte ^= keyWord;
    plainBytes[plainIdx] = plainByte;
    cipherIdx++;
    plainIdx++;
    streamIdx++;
  }
}

export function lookupFormatEntry(tagId, blob) {
  var magic = BinaryUtils.readString(blob, 0, 4),
    entries = NIKON_FORMAT_ENTRIES;
  for (var idx = 0; idx < entries.length; idx++)
    if (entries[idx][0] == tagId && magic.startsWith(entries[idx][1]) && (entries[idx][2] == 0 || entries[idx][2] == blob.length)) return entries[idx];
  throw new Error("no Nikon maker-note format entry for tag " + tagId + " magic " + magic);
}

export function computeEncryptionKeys(makerNote) {
  if (makerNote.t29 == null) return [];
  var lutA = NIKON_ENCRYPTION_LUT_A,
    lutB = NIKON_ENCRYPTION_LUT_B,
    serial = makerNote.t29[0],
    serialHash = 0,
    xorKey = 0;
  for (var chIdx = 0; chIdx < serial.length; chIdx++) {
    var chCode = serial.charCodeAt(chIdx);
    serialHash = serialHash * 10 + (48 <= chCode && chCode <= 57 ? chCode - 48 : chCode % 10);
  }
  var keySeed = makerNote.t167[0];
  for (var byteIdx = 0; byteIdx < 4; byteIdx++) xorKey ^= keySeed >>> (byteIdx << 3) & 255;
  var keyA = lutA[serialHash & 255],
    keyB = lutB[xorKey & 255];
  return [keyA, keyB, 96];
}

export function readEncryptedBlock(makerNote, tagId) {
  var blob = makerNote["t" + tagId],
    blobLen = blob.length,
    formatEntry = lookupFormatEntry(tagId, blob),
    magic = BinaryUtils.readString(blob, 0, 4),
    payload, payloadOff = formatEntry[4];
  if (payloadOff == null) payload = blob.slice(4);
  else {
    payload = new Uint8Array(blobLen - payloadOff);
    var keys = computeEncryptionKeys(makerNote),
      keyA = keys[0],
      keyB = keys[1],
      step = keys[2];
    for (var idx = 0; idx < payload.length; idx++) {
      keyB = keyB + keyA * step++ & 255;
      payload[idx] = blob[payloadOff++] ^ keyB;
    }
  }
  return [magic, blobLen, payload];
}

// --- vendor normalize phases -----------------------------------------------

function convertDngRationalTags(rawMeta) {
  for (var tagIdx = 0; tagIdx < DNG_RATIONAL_TAG_IDS.length; tagIdx++)
    if (rawMeta["t" + DNG_RATIONAL_TAG_IDS[tagIdx]] != null) rawMeta["t" + DNG_RATIONAL_TAG_IDS[tagIdx]] = rationalsToFloats(rawMeta["t" + DNG_RATIONAL_TAG_IDS[tagIdx]]);
}

function applyHasselbladDefaults(rawMeta) {
  rawMeta.t50706 = [1, 2, 0, 0];
  rawMeta.t33422 = BAYER_PATTERNS[1];
  rawMeta.t50723 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  rawMeta.t50778 = [17];
  if (!rawMeta.isLE) swapBytePairs(rawMeta.data);
}

function resolveCameraDbEntry(cameraModel) {
  var cameraDb = CAMERA_DATABASE,
    camEntry = cameraDb[cameraModel.toLowerCase()];
  if (camEntry == null)
    for (var modelKey in cameraDb)
      if (cameraModel.toLowerCase().startsWith(modelKey)) camEntry = cameraDb[modelKey];
  if (camEntry == null) throw cameraModel;
  return camEntry;
}

function applyCameraDbMatrices(rawMeta, camEntry) {
  var blackLevel = camEntry[2];
  rawMeta.t50714 = [blackLevel, blackLevel, blackLevel, blackLevel];
  rawMeta.t50717 = [camEntry[3]];
  rawMeta.t50721 = camEntry[0].slice(0);
  for (var coeffIdx = 0; coeffIdx < 9; coeffIdx++) rawMeta.t50721[coeffIdx] = rawMeta.t50721[coeffIdx] * (1 / 1e4);
  rawMeta.t50723 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (rawMeta.t50728 == null) rawMeta.t50728 = [.35, 1, .6];
  rawMeta.t50778 = [17];
  return blackLevel;
}

function normalizeSony(rawMeta, exifBuf, bitsPerSample, camEntry, blackLevel, exifIFD) {
  var utifBin = UTIF["_bin" + (rawMeta.isLE ? "LE" : "BE")],
    sonyCurve = rawMeta.t28688;
  if (sonyCurve) {
    var curveBounds = [0, 0, 0, 0, 0, 4095],
      lut = new Uint16Array(16385);
    for (var segIdx = 0; segIdx < 4; segIdx++) {
      var bound = sonyCurve[segIdx] >>> 2;
      curveBounds[segIdx + 1] = bound;
      if (bound > 4095) throw new Error("Sony tone-curve bound exceeds 12-bit range: " + bound);
    }
    for (var lutIdx = 0; lutIdx < 16385; lutIdx++) lut[lutIdx] = lutIdx;
    for (var segIdx = 0; segIdx < 5; segIdx++)
      for (var val = curveBounds[segIdx] + 1; val <= curveBounds[segIdx + 1]; val++) lut[val] = lut[val - 1] + (1 << segIdx);
    var useEmbeddedCurve = exifBuf.length * 8 < rawMeta.width * rawMeta.height * bitsPerSample;
    if (useEmbeddedCurve) rawMeta.t50712 = lut;
  }
  var dngPrivate = rawMeta.dngPrvt;
  if (dngPrivate) {
    var privOff = dngPrivate.t29184[0],
      privLen = dngPrivate.t29185[0],
      decryptSeed = (rawMeta.isLE ? BinaryUtils.readFloat32 : BinaryUtils.readUint32BE)(dngPrivate.t29217, 0),
      cipherWords = new Uint32Array(exifBuf.slice(privOff, privOff + (privLen & 4294967292)).buffer),
      plainWords = new Uint32Array(privLen >>> 2);
    decryptNikonData(cipherWords, plainWords, privLen >>> 2, decryptSeed);
    var privBlob = new Uint8Array(privOff + privLen);
    privBlob.set(new Uint8Array(plainWords.buffer), privOff);
    var ifdStack = [];
    UTIF._readIFD(utifBin, privBlob, privOff, ifdStack, 0, false);
    var privIfd = ifdStack.pop(),
      wbCoeffs = privIfd.t29458;
    rawMeta.t50728 = [wbCoeffs[1] / wbCoeffs[0], 1, wbCoeffs[1] / wbCoeffs[3]];
    rawMeta.t50730 = [.5];
    var cropRect = privIfd.t29891;
    rawMeta.t50829 = [cropRect[1], cropRect[0], cropRect[3], cropRect[2]];
  } else if (exifIFD.makerNote && exifIFD.makerNote.t8208) {
    var makerNote = exifIFD.makerNote,
      wbBlob = makerNote.t8208,
      wbLen = wbBlob.length,
      wbOff = 0,
      decodeLut = new Uint8Array(256);
    for (var idx = 249; idx < 256; idx++) decodeLut[idx] = idx;
    for (var idx = 0; idx < 249; idx++) decodeLut[idx * idx * idx % 249] = idx;
    for (var idx = 0; idx < wbLen; idx++) wbBlob[idx] = decodeLut[wbBlob[idx]];
    if (wbLen == 6604) wbOff = 612;
    else throw new Error("unexpected Sony white-balance blob length: " + wbLen);
    var wbRatios = [];
    for (var idx = 0; idx < 3; idx++) wbRatios.push(BinaryUtils.readInt16LE(wbBlob, wbOff + idx * 2));
    rawMeta.t50728 = [wbRatios[1] / wbRatios[0], 1, wbRatios[1] / wbRatios[2]];
  }
  if (rawMeta.width * rawMeta.height * 1.5 == rawMeta.t279[0]) {
    blackLevel = blackLevel >>> 2;
    rawMeta.t50714 = [blackLevel, blackLevel, blackLevel, blackLevel];
    rawMeta.t50717 = [camEntry[3] >>> 2];
  }
}

function unpackCanonSlicedRows(rawMeta) {
  var pixelData = rawMeta.data,
    packedCopy = pixelData.slice(0),
    sliceTags = rawMeta.t50752,
    sliceWidths = [],
    sliceStart = 0;
  if (sliceTags == null || sliceTags[0] == 0 && sliceTags[1] == 0) sliceWidths.push(rawMeta.width);
  else {
    for (var sliceIdx = 0; sliceIdx < sliceTags[0]; sliceIdx++) sliceWidths.push(sliceTags[1]);
    sliceWidths.push(sliceTags[2]);
  }
  var rowStride = rawMeta.width * 2;
  for (var bandIdx = 0; bandIdx < sliceWidths.length; bandIdx++) {
    var bandWidth = sliceWidths[bandIdx],
      dstOff = 2 * sliceStart,
      srcBandWidth = 2 * bandWidth;
    for (var row = 0; row < rawMeta.height; row += 2) {
      var dstRowOff = row * rowStride + dstOff,
        srcRowOff = rawMeta.height * dstOff + (row >> 1) * srcBandWidth * 2;
      for (var col = 0; col < srcBandWidth; col++) {
        pixelData[dstRowOff + col] = packedCopy[srcRowOff + col];
        pixelData[dstRowOff + col + rowStride] = packedCopy[srcRowOff + col + srcBandWidth];
      }
    }
    sliceStart += bandWidth;
  }
}

function resolveCanonTableVariant(canonTable) {
  var tableLen = canonTable.length;
  if (tableLen == 582) return 1;
  if (tableLen == 653) return 2;
  if (tableLen == 796) return 3;
  if (CANON_VARIANT4_LENGTHS.indexOf(tableLen) != -1) return 4;
  if (tableLen == 5120) return 5;
  if (tableLen == 1273 || tableLen == 1275) return 6;
  if (CANON_VARIANT7_LENGTHS.indexOf(tableLen) != -1) return 7;
  if (CANON_VARIANT8_LENGTHS.indexOf(tableLen) != -1) return 8;
  throw new Error("unrecognized Canon color-table length: " + tableLen);
}

function normalizeCanon(rawMeta, exifIFD) {
  unpackCanonSlicedRows(rawMeta);
  var makerNote = exifIFD.makerNote;
  if (makerNote.t16385) {
    var canonCrop = makerNote.t224;
    if (canonCrop) {
      rawMeta.t50719 = [canonCrop[5], canonCrop[6]];
      rawMeta.t50720 = [canonCrop[7] + 1 - canonCrop[5], canonCrop[8] + 1 - canonCrop[6]];
    }
    var canonTable = makerNote.t16385,
      tableVariant = resolveCanonTableVariant(canonTable);
    if (tableVariant == 5) canonTable = new Int16Array(canonTable.slice(0).buffer);
    var tableKind = canonTable[0],
      layout = CANON_TABLE_LAYOUTS[tableVariant];
    if (tableVariant == 5) layout = [71, tableKind == -4 ? 333 : 264];
    if (tableVariant == 7) layout = [63, tableKind == 10 ? 504 : 728];
    var wbOff = layout[0],
      blackOff = layout[1];
    if (tableVariant == 4) {
      if (canonTable[0] == 2) blackOff = 231;
      else if (canonTable[0] == 3) blackOff = 231;
      else if (canonTable[0] == 4) blackOff = 231;
      else if (canonTable[0] == 5) blackOff = 231;
      else if (canonTable[0] == 6) blackOff = 231;
      else if (canonTable[0] == 7) blackOff = 231;
      else if (canonTable[0] == 9) blackOff = 231;
      else throw new Error("unrecognized Canon color-table kind: " + canonTable[0]);
    }
    rawMeta.t50728 = [canonTable[wbOff + 1] / canonTable[wbOff], 1, canonTable[wbOff + 1] / canonTable[wbOff + 3]];
    var canonBlack = blackOff == null ? 1024 : canonTable[blackOff];
    rawMeta.t50714 = [canonBlack, canonBlack, canonBlack, canonBlack];
  } else {
    rawMeta.t50728 = [.4, 1, .6];
  }
}


function applyNikonCropTags(rawMeta, makerNote, bitsPerSample, readI16) {
  var cropW = 0,
    cropH = 0;
  if (makerNote.t61) {
    var nikonBlacks = makerNote.t61,
      blackLevels = [];
    for (var chIdx = 0; chIdx < 4; chIdx++) blackLevels[chIdx] = nikonBlacks[chIdx] / Math.pow(2, 14 - bitsPerSample);
    rawMeta.t50714 = blackLevels;
  }
  if (makerNote.t3585) {
    var nikonMeta = makerNote.t3585,
      chunkSkip = 0,
      metaOff = 22;
    while (metaOff < nikonMeta.length && chunkSkip != -4) {
      var chunkType = BinaryUtils.readFloat32(nikonMeta, metaOff);
      metaOff += 4;
      metaOff += 14;
      chunkSkip = BinaryUtils.readFloat32(nikonMeta, metaOff) - 4;
      metaOff += 4;
      if (chunkType == 1990472198) {
        if (nikonMeta[metaOff] != 0) throw "Flip";
      }
      if (chunkType == 1990472199) {
        var orientation = BinaryUtils.readInt16LE(nikonMeta, metaOff);
        if (orientation == 0) rawMeta.orientation = 1;
        else if (orientation == 270) rawMeta.orientation = 8;
        else throw new Error("unhandled Nikon orientation value: " + orientation);
      }
      metaOff += chunkSkip;
    }
  }
  if (makerNote.t183) {
    var nikonCrop = makerNote.t183,
      cropVals = [];
    for (var idx = 0; idx < 6; idx++) cropVals.push(readI16(nikonCrop, 16 + idx * 2));
    cropW = cropVals[0];
    cropH = cropVals[1];
  }
  if (makerNote.t3614) {
    var nikonCrop2 = makerNote.t3614;
    cropW = BinaryUtils.readFloat32(nikonCrop2, 8);
    cropH = BinaryUtils.readFloat32(nikonCrop2, 12);
  }
  if (cropW != 0) {
    if (cropW < cropH) {
      var tmp = cropW;
      cropW = cropH;
      cropH = tmp;
    }
    var cropLeft = rawMeta.width - cropW >>> 1,
      cropTop = rawMeta.height - cropH >>> 1;
    rawMeta.t50829 = [cropTop, cropLeft, cropTop + cropH, cropLeft + cropW];
  }
}

function readNikonWhiteBalance(makerNote, readI16, cameraModel) {
  var wbGains;
  if (makerNote.t12) {
    var wbRationals = rationalsToFloats(makerNote.t12);
    wbGains = [1 / wbRationals[0], 1, 1 / wbRationals[1]];
  } else if (makerNote.t151) {
    var encrypted = readEncryptedBlock(makerNote, 151),
      encMagic = encrypted[0],
      encLen = encrypted[1],
      encPayload = encrypted[2];
    if (encMagic == "0100" && encLen >= 80) throw new Error("unsupported Nikon white-balance format 0100");
    else if (encMagic == "0102") {
      var wbSamples = [];
      for (var idx = 0; idx < 4; idx++) wbSamples.push(readI16(encPayload, 6 + idx * 2));
      wbGains = [wbSamples[1] / wbSamples[0], 1, wbSamples[1] / wbSamples[3]];
    } else if (encMagic == "0103" && encLen >= 26) {
      var wbSamples = [];
      for (var idx = 0; idx < 4; idx++) wbSamples.push(readI16(encPayload, 16 + idx * 2));
      wbGains = [wbSamples[1] / wbSamples[0], 1, wbSamples[3] / wbSamples[2]];
    } else if (encMagic == "0204" && encLen >= 564 || encMagic == "0205" && encLen >= 284) {
      var payloadOff = encMagic == "0204" ? 6 : 14,
        wbSamples = [];
      for (var idx = 0; idx < 4; idx++) wbSamples.push(readI16(encPayload, payloadOff + idx * 2));
      wbGains = [wbSamples[1] / wbSamples[0], 1, wbSamples[1] / wbSamples[3]];
    } else throw new Error("unsupported Nikon white-balance maker-note format " + encMagic);
  }
  if (cameraModel == "NIKON D1") wbGains = [1, 1, 1];
  return wbGains;
}

function applyNikonToneCurve(rawMeta, makerNote, bitsPerSample, readI16) {
  var curveBlob = makerNote.t150 ? makerNote.t150 : makerNote.t140;
  if (!curveBlob) return;
  var curveOff = 0,
    curveMagicA = curveBlob[curveOff++],
    curveMagicB = curveBlob[curveOff++],
    sampleStep;
  if (curveMagicA == 73 || curveMagicB == 88) curveOff += 2110;
  curveOff += 8;
  var maxSample = 1 << bitsPerSample & 32767,
    sampleCount = readI16(curveBlob, curveOff);
  curveOff += 2;
  var curveSamples = [];
  if (sampleCount > 1) sampleStep = Math.floor(maxSample / (sampleCount - 1));
  if (curveMagicA == 68 && curveMagicB == 32 && sampleStep > 0) {
    for (var sampleIdx = 0; sampleIdx < sampleCount; sampleIdx++) {
      curveSamples[sampleIdx * sampleStep] = readI16(curveBlob, curveOff);
      curveOff += 2;
    }
    for (var sampleIdx = 0; sampleIdx < maxSample; sampleIdx++) curveSamples[sampleIdx] = Math.floor((curveSamples[sampleIdx - sampleIdx % sampleStep] * (sampleStep - sampleIdx % sampleStep) + curveSamples[sampleIdx - sampleIdx % sampleStep + sampleStep] * (sampleIdx % sampleStep)) / sampleStep);
  } else if (curveMagicA != 70 && sampleCount <= 16385) {
    maxSample = sampleCount;
    for (var sampleIdx = 0; sampleIdx < sampleCount; sampleIdx++) curveSamples[sampleIdx] = readI16(curveBlob, curveOff + 2 * sampleIdx);
    curveOff += 2 * sampleCount;
  }
  if (curveSamples.length != 0) rawMeta.t50712 = new Uint16Array(curveSamples);
  else if (rawMeta.t272[0] == "NIKON D750") rawMeta.t50717[0] *= 4;
}

function normalizeNikon(rawMeta, exifIFD, bitsPerSample, cameraModel) {
  var makerNote = exifIFD.makerNote,
    readI16 = rawMeta.isLE ? BinaryUtils.readInt16LE : BinaryUtils.readInt16BE;
  applyNikonCropTags(rawMeta, makerNote, bitsPerSample, readI16);
  var wbGains = readNikonWhiteBalance(makerNote, readI16, cameraModel);
  if (wbGains) rawMeta.t50728 = wbGains;
  applyNikonToneCurve(rawMeta, makerNote, bitsPerSample, readI16);
}

export function normalize(rawMeta, exifBytes) {
  if (rawMeta.t50706 != null || rawMeta.t271[0].startsWith("Hasselblad")) {
    convertDngRationalTags(rawMeta);
    if (rawMeta.t271 && rawMeta.t271[0].startsWith("Hasselblad")) applyHasselbladDefaults(rawMeta);
    return;
  }
  var bitsPerSample = rawMeta.t258[0],
    exifIFD = rawMeta.exifIFD,
    exifBuf = new Uint8Array(exifBytes);
  rawMeta.t50706 = [1, 2, 0, 0];
  var cameraModel = rawMeta.t272[0].trim();
  if (cameraModel.indexOf(" ") == -1) cameraModel = rawMeta.t271[0].trim() + " " + cameraModel;
  if (rawMeta.t50708 == null) rawMeta.t50708 = [cameraModel];
  var camEntry = resolveCameraDbEntry(cameraModel),
    blackLevel = applyCameraDbMatrices(rawMeta, camEntry);
  if (rawMeta.t271[0].startsWith("SONY")) {
    normalizeSony(rawMeta, exifBuf, bitsPerSample, camEntry, blackLevel, exifIFD);
  } else if (rawMeta.t271[0].startsWith("Canon")) {
    normalizeCanon(rawMeta, exifIFD);
  } else if (rawMeta.t271[0].startsWith("NIKON")) {
    normalizeNikon(rawMeta, exifIFD, bitsPerSample, cameraModel);
  } else if (cameraModel.startsWith("FujiFilm")) {} else alert("Unknown camera " + cameraModel);
}

// --- unpack / levels -------------------------------------------------------

export function unpackPixels(rawMeta, outSamples) {
  var sampleCount = outSamples.length,
    rawBytes = rawMeta.data,
    bitsPerSample = rawMeta.t258[0];
  if (bitsPerSample != 16 && bitsPerSample != 14 && bitsPerSample != 12 && bitsPerSample != 10 && bitsPerSample != 8) throw "Unsupported Bits Per Sample:" + bitsPerSample;
  bitsPerSample = Math.round(rawBytes.length * 8 / sampleCount);
  if (bitsPerSample == 16 && rawMeta.isLE) {
    copyBuffer(rawBytes, outSamples);
    return;
  }
  for (var idx = 0; idx < sampleCount; idx += 2) {
    var byteOff = 0,
      sampleA = 0,
      sampleB = 0;
    if (bitsPerSample == 16) {
      byteOff = idx << 1;
      sampleA = rawBytes[byteOff] << 8 | rawBytes[byteOff + 1];
      sampleB = rawBytes[byteOff + 2] << 8 | rawBytes[byteOff + 3];
    } else if (bitsPerSample == 14) {
      var bitOff = idx * 14,
        byteIdx = bitOff >>> 3,
        word = rawBytes[byteIdx] << 24 | rawBytes[byteIdx + 1] << 16 | rawBytes[byteIdx + 2] << 8 | rawBytes[byteIdx + 3];
      if ((bitOff & 7) == 0) {
        sampleA = word >>> 18;
        sampleB = word >>> 4 & 16383;
      } else {
        sampleA = word >>> 14 & 16383;
        sampleB = word & 16383;
      }
    } else if (bitsPerSample == 12) {
      byteOff = idx + (idx >>> 1);
      sampleA = rawBytes[byteOff] << 4 | rawBytes[byteOff + 1] >> 4;
      sampleB = (rawBytes[byteOff + 1] & 15) << 8 | rawBytes[byteOff + 2];
    } else if (bitsPerSample == 10) {
      var bitOff = idx * 10,
        byteIdx = bitOff >>> 3;
      if ((bitOff & 7) == 0) {
        sampleA = (rawBytes[byteIdx] << 2 | rawBytes[byteIdx + 1] >> 6) & 1023;
        sampleB = (rawBytes[byteIdx + 1] << 4 | rawBytes[byteIdx + 2] >> 4) & 1023;
      } else {
        sampleA = (rawBytes[byteIdx] << 6 | rawBytes[byteIdx + 1] >> 2) & 1023;
        sampleB = (rawBytes[byteIdx + 1] << 8 | rawBytes[byteIdx + 2] >> 0) & 1023;
      }
    } else if (bitsPerSample == 8) {
      byteOff = idx;
      sampleA = rawBytes[byteOff];
      sampleB = rawBytes[byteOff + 1];
    }
    outSamples[idx] = sampleA;
    outSamples[idx + 1] = sampleB;
  }
}

export function readRawPixels(rawMeta) {
  var width = rawMeta.width,
    height = rawMeta.height,
    sampleCount = width * height * rawMeta.t277,
    outSamples = new Uint16Array(sampleCount),
    linearizationLut = null,
    lutMaxIndex = 0;
  unpackPixels(rawMeta, outSamples);
  applyOpcodeList(1, rawMeta, outSamples, width, height);
  if (rawMeta.t50712) {
    linearizationLut = rawMeta.t50712;
    lutMaxIndex = linearizationLut.length - 1;
    if (linearizationLut[lutMaxIndex] > 65535) throw "too big values";
  }
  var blackLevel = getBlackLevel(rawMeta),
    whiteLevel = getWhiteLevel(rawMeta);
  if (linearizationLut == null)
    for (var idx = 0; idx < sampleCount; idx++) outSamples[idx] = Math.max(0, outSamples[idx] - blackLevel);
  else
    for (var idx = 0; idx < sampleCount; idx++) {
      var sample = outSamples[idx];
      if (sample > lutMaxIndex) sample = lutMaxIndex;
      sample = linearizationLut[sample];
      outSamples[idx] = Math.max(0, sample - blackLevel);
    }
  return outSamples;
}

// --- DNG opcode handlers ---------------------------------------------------

function applyWarpRectilinearOpcode(opcodeBytes, byteOffset, buffer, width, height) {
  var payloadOff = byteOffset,
    planeCount = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var warpCoeff0 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var warpCoeff1 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var warpCoeff2 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var warpCoeff3 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var warpCoeff4 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var warpCoeff5 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  payloadOff += (planeCount - 1) * 8 * 6;
  var centerX = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var centerY = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var centerXPx = centerX * width,
    centerYPx = centerY * height,
    maxDistX = Math.max(centerXPx, width - centerXPx),
    maxDistY = Math.max(centerYPx, height - centerYPx),
    maxRadius = Math.sqrt(maxDistX * maxDistX + maxDistY * maxDistY),
    invMaxRadius = 1 / maxRadius,
    bufferCopy = buffer.slice(0);
  for (var row = 0; row < height; row++)
    for (var col = 0; col < width; col++) {
      var normX = (col + .5 - centerXPx) * invMaxRadius,
        normY = (row + .5 - centerYPx) * invMaxRadius,
        radiusSq = normX * normX + normY * normY,
        radial = warpCoeff0 + warpCoeff1 * radiusSq + warpCoeff2 * (radiusSq * radiusSq) + warpCoeff3 * (radiusSq * radiusSq) * radiusSq,
        tangentialX = warpCoeff4 * (2 * normX * normY) + warpCoeff5 * (radiusSq + 2 * normX * normX),
        tangentialY = warpCoeff5 * (2 * normX * normY) + warpCoeff4 * (radiusSq + 2 * normY * normY),
        srcX = ~~(centerXPx + maxRadius * (radial * normX + tangentialX)),
        srcY = ~~(centerYPx + maxRadius * (radial * normY + tangentialY)),
        srcIdx = (srcY * width + srcX) * 3,
        dstIdx = (row * width + col) * 3;
      buffer[dstIdx] = bufferCopy[srcIdx];
      buffer[dstIdx + 1] = bufferCopy[srcIdx + 1];
      buffer[dstIdx + 2] = bufferCopy[srcIdx + 2];
    }
}

function applyVignetteOpcode(opcodeBytes, byteOffset, buffer, width, height) {
  var payloadOff = byteOffset,
    vignetteCoeff0 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var vignetteCoeff1 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var vignetteCoeff2 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var vignetteCoeff3 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var vignetteCoeff4 = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var centerX = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var centerY = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff);
  payloadOff += 8;
  var centerXPx = centerX * width,
    centerYPx = centerY * height,
    maxDistX = Math.max(centerXPx, width - centerXPx),
    maxDistY = Math.max(centerYPx, height - centerYPx),
    maxRadius = Math.sqrt(maxDistX * maxDistX + maxDistY * maxDistY),
    invMaxRadius = 1 / maxRadius;
  for (var row = 0; row < height; row++)
    for (var col = 0; col < width; col++) {
      var normX = (col + .5 - centerXPx) * invMaxRadius,
        normY = (row + .5 - centerYPx) * invMaxRadius,
        radiusSq = normX * normX + normY * normY,
        vignetteScale = 1 + (vignetteCoeff0 + (vignetteCoeff1 + (vignetteCoeff2 + (vignetteCoeff3 + vignetteCoeff4 * radiusSq) * radiusSq) * radiusSq) * radiusSq) * radiusSq,
        dstIdx = (row * width + col) * 3;
      buffer[dstIdx] = vignetteScale * buffer[dstIdx];
      buffer[dstIdx + 1] = vignetteScale * buffer[dstIdx + 1];
      buffer[dstIdx + 2] = vignetteScale * buffer[dstIdx + 2];
    }
}

function applyFixBadPixelsConstant(opcodeBytes, byteOffset, buffer, pixelCount) {
  var payloadOff = byteOffset,
    badPixelValue = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var repairCount = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  for (var idx = 0; idx < pixelCount; idx++)
    if (buffer[idx] == badPixelValue) buffer[idx] = buffer[idx - 2] + buffer[idx + 2] >> 1;
}

function applyFixBadPixelsList(opcodeBytes, byteOffset, buffer, width) {
  var payloadOff = byteOffset,
    badPixelValue = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var repairCount = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var planeCount = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  for (var repairIdx = 0; repairIdx < repairCount; repairIdx++) {
    var repairRow = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
    payloadOff += 4;
    var repairCol = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
    payloadOff += 4;
    var pixelIdx = repairRow * width + repairCol;
    buffer[pixelIdx] = buffer[pixelIdx - 2] + buffer[pixelIdx + 2] >> 1;
  }
}

function applyTrimBoundsMapOpcode(opcodeBytes, byteOffset, buffer, width) {
  var payloadOff = byteOffset,
    repairRect = BinaryUtils.readRect(opcodeBytes, payloadOff);
  payloadOff += 16;
  var planeCount = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var opcodeFlags2 = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var rowStep = BinaryUtils.readUint32BE(opcodeBytes, payloadOff),
    colStep = BinaryUtils.readUint32BE(opcodeBytes, payloadOff + 4);
  payloadOff += 8;
  var lutLength = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var repairLut = new Uint16Array(lutLength);
  for (var lutIdx = 0; lutIdx < lutLength; lutIdx++) repairLut[lutIdx] = BinaryUtils.readUint16(opcodeBytes, payloadOff + 2 * lutIdx);
  var rectWidth = repairRect.width,
    rectHeight = repairRect.height;
  for (var row = 0; row < rectHeight; row += rowStep)
    for (var col = 0; col < rectWidth; col += colStep) {
      var pixelIdx = (repairRect.y + row) * width + (repairRect.x + col);
      buffer[pixelIdx] = repairLut[buffer[pixelIdx]];
    }
}

function applyGainMapOpcode(opcodeBytes, byteOffset, buffer, width) {
  var payloadOff = byteOffset,
    repairRect = BinaryUtils.readRect(opcodeBytes, payloadOff),
    mapIsUniform = true;
  payloadOff += 16;
  var planeCount = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var opcodeFlags2 = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  var rowStep = BinaryUtils.readUint32BE(opcodeBytes, payloadOff),
    colStep = BinaryUtils.readUint32BE(opcodeBytes, payloadOff + 4);
  payloadOff += 8;
  var mapWidth = BinaryUtils.readUint32BE(opcodeBytes, payloadOff),
    mapHeight = BinaryUtils.readUint32BE(opcodeBytes, payloadOff + 4);
  payloadOff += 8;
  var mapOriginX = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff),
    mapOriginY = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff + 8);
  payloadOff += 16;
  var mapScaleX = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff),
    mapScaleY = BinaryUtils.readFloat64BE(opcodeBytes, payloadOff + 8);
  payloadOff += 16;
  var mapPlaneCount = BinaryUtils.readUint32BE(opcodeBytes, payloadOff);
  payloadOff += 4;
  if (mapPlaneCount != 1) throw "more than one map plane";
  var mapSampleCount = mapWidth * mapHeight,
    gainMap = new Float32Array(mapSampleCount);
  for (var mapIdx = 0; mapIdx < mapSampleCount; mapIdx++) gainMap[mapIdx] = BinaryUtils.readFloat32BE(opcodeBytes, payloadOff + mapIdx * 4);
  for (var mapIdx = 0; mapIdx < mapSampleCount; mapIdx++)
    if (gainMap[mapIdx] != 1) mapIsUniform = false;
  if (!mapIsUniform) {
    var rectWidth = repairRect.width,
      rectHeight = repairRect.height,
      mapStepX = .9999 * (mapWidth - 1) / rectWidth,
      mapStepY = .9999 * (mapHeight - 1) / rectHeight;
    for (var row = 0; row < rectHeight; row += rowStep)
      for (var col = 0; col < rectWidth; col += colStep) {
        var pixelIdx = (repairRect.y + row) * width + (repairRect.x + col),
          mapX = col * mapStepX,
          mapY = row * mapStepY,
          mapColFloor = Math.floor(mapX),
          mapRowFloor = Math.floor(mapY),
          fracX = mapX - mapColFloor,
          fracY = mapY - mapRowFloor,
          mapIdx = mapRowFloor * mapWidth + mapColFloor,
          topBlend = gainMap[mapIdx] * (1 - fracX) + gainMap[mapIdx + 1] * fracX,
          bottomBlend = gainMap[mapIdx + mapWidth] * (1 - fracX) + gainMap[mapIdx + 1 + mapWidth] * fracX,
          gain = topBlend * (1 - fracY) + bottomBlend * fracY;
        buffer[pixelIdx] = ~~(buffer[pixelIdx] * gain + .5);
      }
  }
}

export function applyOpcodeList(phaseIdx, rawMeta, buffer, width, height) {
  var opcodeBlob = rawMeta["t" + OPCODE_LIST_TAGS[phaseIdx - 1]],
    byteOffset = 0;
  if (opcodeBlob == null) return;
  var pixelCount = width * height,
    opcodeBytes = new Uint8Array(opcodeBlob),
    opcodeCount = BinaryUtils.readUint32BE(opcodeBytes, byteOffset);
  byteOffset += 4;
  for (var opcodeIdx = 0; opcodeIdx < opcodeCount; opcodeIdx++) {
    var opcodeId = BinaryUtils.readUint32BE(opcodeBytes, byteOffset);
    byteOffset += 4;
    var opcodeVersion = BinaryUtils.readUint32BE(opcodeBytes, byteOffset);
    byteOffset += 4;
    var opcodeFlags = BinaryUtils.readUint32BE(opcodeBytes, byteOffset);
    byteOffset += 4;
    var opcodePayloadLength = BinaryUtils.readUint32BE(opcodeBytes, byteOffset);
    byteOffset += 4;
    if (opcodeId == 1 && phaseIdx == 3) {
      applyWarpRectilinearOpcode(opcodeBytes, byteOffset, buffer, width, height);
    } else if (opcodeId == 3 && phaseIdx == 3) {
      applyVignetteOpcode(opcodeBytes, byteOffset, buffer, width, height);
    } else if (opcodeId == 4 && phaseIdx == 1) {
      applyFixBadPixelsConstant(opcodeBytes, byteOffset, buffer, pixelCount);
    } else if (opcodeId == 5 && phaseIdx == 1) {
      applyFixBadPixelsList(opcodeBytes, byteOffset, buffer, width);
    } else if (opcodeId == 7 && phaseIdx == 1) {
      applyTrimBoundsMapOpcode(opcodeBytes, byteOffset, buffer, width);
    } else if (opcodeId == 9 && phaseIdx == 2) {
      applyGainMapOpcode(opcodeBytes, byteOffset, buffer, width);
    }
    // Unsupported opcodes are skipped by advancing past their payload.
    byteOffset += opcodePayloadLength;
  }
}

// --- decode / develop / color ----------------------------------------------

function resolveBayerPhase(cfaPatternKey) {
  if (cfaPatternKey == "0,1,1,2") return 0;
  if (cfaPatternKey == "1,0,2,1") return 1;
  if (cfaPatternKey == "2,1,1,0") return 2;
  if (cfaPatternKey == "1,2,0,1") return 3;
  throw "Unknown CFA pattern " + cfaPatternKey;
}

function demosaicOrCopyRgb(rawMeta, rawPixelBuffer, width, height, cropLeft, cropTop, outputWidth, outputHeight, linearRgbBuffer) {
  if (rawMeta.t277[0] == 1) {
    var cfaPatternSize = rawMeta.t33421;
    if (cfaPatternSize == null) {
      grayscaleToRgb(rawPixelBuffer, width, height, linearRgbBuffer, cropLeft, cropTop, outputWidth, outputHeight);
    } else if (cfaPatternSize.length != 2 || cfaPatternSize[0] != 2 || cfaPatternSize[1] != 2) {
      seamColorSample(rawPixelBuffer, width, height, linearRgbBuffer, cropLeft, cropTop, outputWidth, outputHeight, cfaPatternSize[0], rawMeta.t33422);
    } else {
      var bayerPhase = resolveBayerPhase(rawMeta.t33422.join(","));
      if ((outputWidth & 1) != 0 || (outputHeight & 1) != 0) throw new Error("Bayer demosaic requires even output dimensions");
      upsampleBlock(rawPixelBuffer, width, height, linearRgbBuffer, cropLeft, cropTop, outputWidth, outputHeight, bayerPhase);
    }
  } else {
    for (var row = 0; row < outputHeight; row++)
      for (var col = 0; col < outputWidth; col++) {
        var srcIdx = ((row + cropTop) * width + col + cropLeft) * 3,
          dstIdx = (row * outputWidth + col) * 3;
        linearRgbBuffer[dstIdx + 0] = rawPixelBuffer[srcIdx + 0];
        linearRgbBuffer[dstIdx + 1] = rawPixelBuffer[srcIdx + 1];
        linearRgbBuffer[dstIdx + 2] = rawPixelBuffer[srcIdx + 2];
      }
  }
}

function applyOrientationTransform(linearRgbBuffer, outputWidth, outputHeight, orientationTag) {
  if (orientationTag == 1 || orientationTag == 9) {
    return {
      linearRgbBuffer: linearRgbBuffer,
      rawWidth: outputWidth,
      rawHeight: outputHeight
    };
  }
  var orientMatrix = orientationMatrix(orientationTag, outputWidth, outputHeight),
    outIdx = 0,
    rawWidth = orientMatrix[0],
    rawHeight = orientMatrix[1],
    rotatedCopy = linearRgbBuffer.slice(0);
  for (var row = 0; row < rawHeight; row++)
    for (var col = 0; col < rawWidth; col++) {
      var mapX = orientMatrix[2] * col + orientMatrix[3] * row + orientMatrix[4],
        mapY = orientMatrix[5] * col + orientMatrix[6] * row + orientMatrix[7],
        srcIdx = (mapY * outputWidth + mapX) * 3;
      linearRgbBuffer[outIdx] = rotatedCopy[srcIdx];
      linearRgbBuffer[outIdx + 1] = rotatedCopy[srcIdx + 1];
      linearRgbBuffer[outIdx + 2] = rotatedCopy[srcIdx + 2];
      outIdx += 3;
    }
  return {
    linearRgbBuffer: linearRgbBuffer,
    rawWidth: rawWidth,
    rawHeight: rawHeight
  };
}

export function decodeRawImage(rawMeta) {
  var width = rawMeta.width,
    height = rawMeta.height,
    decodeStartMs = Date.now(),
    rawPixelBuffer = readRawPixels(rawMeta),
    cropLeft = 0,
    cropTop = 0;
  applyOpcodeList(2, rawMeta, rawPixelBuffer, width, height);
  var activeWidth = width,
    activeHeight = height;
  if (rawMeta.t50829) {
    var activeArea = rawMeta.t50829;
    cropTop = activeArea[1];
    cropLeft = activeArea[0];
    activeWidth = activeArea[3];
    activeHeight = activeArea[2];
  }
  if (rawMeta.t50719) {
    var defaultCropOrigin = rawMeta.t50719;
    cropLeft += defaultCropOrigin[0] >> 1 << 1;
    cropTop += defaultCropOrigin[1] >> 1 << 1;
  }
  if (rawMeta.t50720) {
    var defaultCropSize = rawMeta.t50720;
    activeWidth = cropLeft + defaultCropSize[0];
    activeHeight = cropTop + defaultCropSize[1];
  }
  var outputWidth = activeWidth - cropLeft,
    outputHeight = activeHeight - cropTop,
    linearRgbBuffer = new Float32Array(outputWidth * outputHeight * 3);
  demosaicOrCopyRgb(rawMeta, rawPixelBuffer, width, height, cropLeft, cropTop, outputWidth, outputHeight, linearRgbBuffer);
  var preNormBuffer = linearRgbBuffer,
    bufferLength = linearRgbBuffer.length,
    pixelRange = getPixelRange(rawMeta),
    invPixelRange = 1 / pixelRange;
  for (var idx = 0; idx < bufferLength; idx += 3) {
    linearRgbBuffer[idx] = Math.min(1, preNormBuffer[idx] * invPixelRange);
    linearRgbBuffer[idx + 1] = Math.min(1, preNormBuffer[idx + 1] * invPixelRange);
    linearRgbBuffer[idx + 2] = Math.min(1, preNormBuffer[idx + 2] * invPixelRange);
  }
  applyOpcodeList(3, rawMeta, linearRgbBuffer, outputWidth, outputHeight);
  return applyOrientationTransform(linearRgbBuffer, outputWidth, outputHeight, rawMeta.orientation);
}

export function computeCameraMatrix(rawMeta, chromaticity) {
  var planckianResult = planckianLocusFromChromaticity(chromaticity),
    lowTemp = rawMeta.t50778 ? rawMeta.t50778[0] : 0,
    highTemp = rawMeta.t50779 ? rawMeta.t50779[0] : 0,
    forwardMatrix = interpolateColorMatrix(rawMeta.t50721, rawMeta.t50722, lowTemp, highTemp, planckianResult.correlatedColorTemp),
    colorMatrix = interpolateColorMatrix(rawMeta.t50723, rawMeta.t50724, lowTemp, highTemp, planckianResult.correlatedColorTemp);
  forwardMatrix = forwardMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  colorMatrix = colorMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  var analogBalance = rawMeta.t50727 ? [rawMeta.t50727[0], 0, 0, 0, rawMeta.t50727[1], 0, 0, 0, rawMeta.t50727[2]] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return multiplyColorMatrices(from3x3(analogBalance), multiplyColorMatrices(from3x3(colorMatrix), from3x3(forwardMatrix)));
}

export function computeWhiteBalanceMatrix(rawMeta, chromaticity) {
  var sourceXyz = xyToNormalizedXyz(chromaticity),
    cameraMatrix = computeCameraMatrix(rawMeta, chromaticity),
    invertedCamera = invertColorMatrix(cameraMatrix),
    adaptation = bradfordAdaptationBetween(sourceXyz, xyToNormalizedXyz(D50_CHROMATICITY));
  return multiplyColorMatrices(adaptation, invertedCamera);
}

/**
 * Chromaticity of the illuminant under which `neutralCameraRgb` is neutral.
 *
 * The camera matrix depends on the illuminant it is being solved for, so the
 * two are found together by iterating until the chromaticity stops moving.
 *
 * @param {object} rawMeta Decoded camera metadata.
 * @param {number[]} neutralCameraRgb Camera-native linear RGB that should render grey.
 */
export function solveIlluminantForNeutral(rawMeta, neutralCameraRgb) {
  var wbVector = neutralCameraRgb.slice(0, 3),
    convergenceDelta = 1;
  wbVector.push(0);
  var illuminantChromaticity = {
    x: .34567,
    y: .3585
  };
  do {
    var invertedCamera = invertColorMatrix(computeCameraMatrix(rawMeta, illuminantChromaticity)),
      cameraResponse = multiplyVec4(invertedCamera, wbVector),
      nextChromaticity = chromaticityFromRgb(cameraResponse);
    convergenceDelta = Math.abs(illuminantChromaticity.x - nextChromaticity.x) + Math.abs(illuminantChromaticity.y - nextChromaticity.y);
    illuminantChromaticity = nextChromaticity;
  } while (convergenceDelta > 1e-7);
  return illuminantChromaticity;
}

/** As-shot illuminant: the one that neutralises the camera's recorded white. */
export function estimateIlluminant(rawMeta) {
  return solveIlluminantForNeutral(rawMeta, rawMeta.t50728 ? rawMeta.t50728 : [1, 1, 1]);
}

/**
 * Baseline tone curve for rendered raw output, on linear input.
 *
 * A raw file holds scene-linear light. Encoding that straight to sRGB gives a
 * flat, dark picture, because none of the tonal shaping a camera bakes into its
 * own JPEGs is present. These control points are the render curve measured from
 * a reference development of a Nikon D5100 frame — a scene spanning deep shadow
 * to clipped sun, on a body whose saturation point the decoder reproduces to
 * within one percent, so the curve is not entangled with a level error.
 *
 * The shape is what a raw renderer needs: a short toe, a steep lift through the
 * low midtones where linear data is otherwise unreadably dark, then a long
 * shoulder that reaches display white a little before sensor saturation, which
 * is the headroom highlight recovery spends.
 */
var BASELINE_TONE_CURVE_POINTS = [
  [0, 0],
  [.01, .00487],
  [.02, .01037],
  [.035, .03633],
  [.05, .07625],
  [.07, .13988],
  [.09, .2051],
  [.12, .28746],
  [.15, .35885],
  [.2, .47066],
  [.25, .56153],
  [.3, .64104],
  [.38, .73793],
  [.46, .82678],
  [.55, .87137],
  [.65, .94304],
  [.78, 1],
  [1, 1]
];
/** Samples in the linear-to-display table developRaw builds per call. */
var RAW_TONE_LUT_SIZE = 1e3;

/**
 * Sample a curve through `points` with monotone cubic interpolation, which
 * follows the control points smoothly without the overshoot a plain spline
 * would put into the shadows.
 *
 * @param {number[][]} points Ascending `[x, y]` pairs spanning 0…1.
 * @param {number} sampleCount Entries in the returned table.
 * @returns {Float64Array} `sampleCount` samples of y over an even x grid.
 */
function sampleMonotoneCurve(points, sampleCount) {
  var count = points.length,
    xs = [],
    ys = [],
    secants = [],
    tangents = [],
    idx = 0;
  for (idx = 0; idx < count; idx++) {
    xs.push(points[idx][0]);
    ys.push(points[idx][1]);
  }
  for (idx = 0; idx < count - 1; idx++) secants.push((ys[idx + 1] - ys[idx]) / (xs[idx + 1] - xs[idx]));
  tangents.push(secants[0]);
  for (idx = 1; idx < count - 1; idx++) {
    tangents.push(secants[idx - 1] * secants[idx] <= 0 ? 0 : (secants[idx - 1] + secants[idx]) / 2);
  }
  tangents.push(secants[count - 2]);
  for (idx = 0; idx < count - 1; idx++) {
    if (secants[idx] === 0) {
      tangents[idx] = 0;
      tangents[idx + 1] = 0;
      continue;
    }
    var leftRatio = tangents[idx] / secants[idx],
      rightRatio = tangents[idx + 1] / secants[idx],
      radius = Math.sqrt(leftRatio * leftRatio + rightRatio * rightRatio);
    if (radius > 3) {
      tangents[idx] = 3 / radius * leftRatio * secants[idx];
      tangents[idx + 1] = 3 / radius * rightRatio * secants[idx];
    }
  }
  var samples = new Float64Array(sampleCount),
    segment = 0;
  for (var sampleIdx = 0; sampleIdx < sampleCount; sampleIdx++) {
    var x = sampleIdx / (sampleCount - 1);
    while (segment < count - 2 && x > xs[segment + 1]) segment++;
    var span = xs[segment + 1] - xs[segment],
      t = (x - xs[segment]) / span,
      tSquared = t * t,
      tCubed = tSquared * t;
    samples[sampleIdx] =
      (2 * tCubed - 3 * tSquared + 1) * ys[segment] +
      (tCubed - 2 * tSquared + t) * span * tangents[segment] +
      (-2 * tCubed + 3 * tSquared) * ys[segment + 1] +
      (tCubed - tSquared) * span * tangents[segment + 1];
  }
  return samples;
}

/** The baseline curve sampled over the same grid developRaw's table uses. */
var BASELINE_TONE_LUT = sampleMonotoneCurve(BASELINE_TONE_CURVE_POINTS, RAW_TONE_LUT_SIZE);

export function developRaw(decodedDescriptor, rgbaOutput, rawMeta, sliderValues) {
  var linearRgbBuffer = decodedDescriptor.linearRgbBuffer,
    pixelCount = Math.round(linearRgbBuffer.length / 3),
    illuminantChromaticity = chromaticityFromTemperatureAndTint(sliderValues[0], sliderValues[1]),
    whiteBalanceMatrix = computeWhiteBalanceMatrix(rawMeta, illuminantChromaticity),
    colorMatrix = multiplyColorMatrices(xyzToRgb, whiteBalanceMatrix),
    exposureScale = Math.pow(2, sliderValues[2] + (rawMeta.t50730 ? rawMeta.t50730[0] : 0));
  colorMatrix = multiplyColorMatrices(colorMatrix, colorScaleMatrix(exposureScale, exposureScale, exposureScale));
  var wbCoeffs = rawMeta.t50728 ? rawMeta.t50728 : [1, 1, 1],
    channelGainRatios = [wbCoeffs[1] / wbCoeffs[0], wbCoeffs[2] / wbCoeffs[0], wbCoeffs[0] / wbCoeffs[1], wbCoeffs[2] / wbCoeffs[1], wbCoeffs[0] / wbCoeffs[2], wbCoeffs[1] / wbCoeffs[2]],
    exposureLut = new Float64Array(1e3);
  for (var lutIdx = 0; lutIdx < 1e3; lutIdx++) {
    var lutValue = lutIdx * (1 / 999);
    lutValue = lutIdx == 999 ? 1 : linearToSrgb(BASELINE_TONE_LUT[lutIdx]);
    lutValue = applyExposureCurve(lutValue, sliderValues[3] / 100);
    exposureLut[lutIdx] = lutValue;
  }
  var developStartMs = Date.now();
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var rgbaIdx = pixelIdx << 2,
      rgbIdx = rgbaIdx - pixelIdx,
      red = linearRgbBuffer[rgbIdx],
      green = linearRgbBuffer[rgbIdx + 1],
      blue = linearRgbBuffer[rgbIdx + 2];
    if (green >= .92) {
      var minChannel = Math.min(red, blue);
      if (minChannel == red) {
        green = Math.max(green, channelGainRatios[0] * red);
        blue = Math.max(blue, channelGainRatios[1] * red);
      } else {
        red = Math.max(red, channelGainRatios[4] * blue);
        green = Math.max(green, channelGainRatios[5] * blue);
      }
    }
    var outRed = colorMatrix[0] * red + colorMatrix[1] * green + colorMatrix[2] * blue,
      outGreen = colorMatrix[4] * red + colorMatrix[5] * green + colorMatrix[6] * blue,
      outBlue = colorMatrix[8] * red + colorMatrix[9] * green + colorMatrix[10] * blue;
    if (outRed < 0) outRed = 0;
    else if (outRed > 1) outRed = 1;
    if (outGreen < 0) outGreen = 0;
    else if (outGreen > 1) outGreen = 1;
    if (outBlue < 0) outBlue = 0;
    else if (outBlue > 1) outBlue = 1;
    outRed = exposureLut[~~(outRed * 999)];
    outGreen = exposureLut[~~(outGreen * 999)];
    outBlue = exposureLut[~~(outBlue * 999)];
    rgbaOutput[rgbaIdx] = ~~(.5 + outRed * 255);
    rgbaOutput[rgbaIdx + 1] = ~~(.5 + outGreen * 255);
    rgbaOutput[rgbaIdx + 2] = ~~(.5 + outBlue * 255);
  }
}

