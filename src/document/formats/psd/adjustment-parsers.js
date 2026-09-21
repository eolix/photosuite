/**
 * PSD adjustment layers: which kinds exist, and the binary codecs for the ones
 * with their own block format — Curves, Hue/Saturation, Levels and Selective
 * Color ↔ action descriptors.
 *
 * The default descriptor for each of those four kinds lives here too, beside
 * the codec that reads and writes it; the filter registry offers them as its
 * `curv` / `hue2` / `levl` / `selc` defaults.
 */

import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { createCurvePoint } from "../../../engine/compositing/tone-curves.js";

/**
 * The adjustment kinds a layer can carry, mapped to their display-name keys.
 * The key is the id Photoshop stores in `layer.add` (`brit`, `levl`, …), so a
 * layer is an adjustment layer exactly when one of these is present on it.
 */
export const ADJUSTMENT_NAMES = {
  brit: "adjustments.brightnessContrast",
  levl: "adjustments.levels",
  curv: "adjustments.curves",
  expA: "adjustments.exposure",
  vibA: "adjustments.vibrance",
  hue2: "adjustments.hueSaturation",
  blnc: "adjustments.colourBalance",
  blwh: "adjustments.blackWhite",
  phfl: "adjustments.photoFilter",
  mixr: "adjustments.channelMixer",
  clrL: "adjustments.colourLookup",
  nvrt: "adjustments.invert",
  post: "adjustments.posterise",
  thrs: "adjustments.threshold",
  grdm: "adjustments.gradientMap",
  selc: "adjustments.selectiveColour",
  rplc: "adjustments.replaceColour",
};

/**
 * The adjustment key present on a layer's `add` block, or null when the layer
 * is not an adjustment layer.
 */
export function adjustmentKeyOf(layerAdd) {
  for (const key in ADJUSTMENT_NAMES) if (layerAdd[key] != null) return key;
  return null;
}

/** Channel enum names indexed by composite/red/green/blue channel index. */
const CHANNEL_ENUMS = ["Cmps", "Rd", "Grn", "Bl"];

/** Build a channel-scoped adjustment descriptor referencing channel `channelIdx`. */
function createChnlChannelDesc(classID, channelIdx) {
  return {
    classID: classID,
    Chnl: {
      t: "obj ",
      v: [{ t: "Enmr", v: { classID: "Chnl", typeID: "Chnl", enum: CHANNEL_ENUMS[channelIdx] } }],
    },
  };
}

/** Index of the adjustment entry for `channelIdx` in a Chnl-keyed list, or -1. */
function findChnlChannelIndex(adjList, channelIdx) {
  var enumToIdx = { Cmps: 0, Rd: 1, Grn: 2, Bl: 3 };
  for (var i = 0; i < adjList.length; i++) {
    if (enumToIdx[adjList[i].v.Chnl.v[0].v.enum] == channelIdx) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

function parseCurves(rawBuffer) {
  var data = new Uint8Array(rawBuffer);
  var curves = [];
  var pos = 0;
  var version = BinaryUtils.readUint16(data, pos);
  pos += 2;
  if (version != 4) throw "Unknown version of curves: " + version;
  var channelCount = BinaryUtils.readUint16(data, pos);
  pos += 2;
  for (var i = 0; i < channelCount; i++) {
    var pts = readCurvePoints(data, pos);
    pos += 2 + 2 * pts.length;
    curves.push(pts);
  }
  if (pos == data.length) return curves;
  var extraSig = BinaryUtils.readString(data, pos, 4);
  pos += 4;
  var extraVersion = BinaryUtils.readUint16(data, pos);
  pos += 2;
  var extraChannels = BinaryUtils.readUint16(data, pos);
  pos += 2;
  if (extraChannels != 0) throw "extra curves for channels";
  return curves;
}

function parseCurvesLegacy(data, pos, size) {
  var channels = [];
  var curveType = data[pos];
  pos += 3;
  var channelMask = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  for (var i = 0; i < 4; i++) {
    if (channelMask >>> i & 1) {
      if (curveType == 0) {
        var pts = readCurvePoints(data, pos);
        pos += 2 + 2 * pts.length;
      } else {
        var pts = readMappingCurve(data, pos);
        pos += 256;
      }
      channels.push(pts);
    } else {
      channels.push(curveType == 0 ? [0, 0, 255, 255] : createIdentityCurve());
    }
  }
  var filterDesc = createCurvesDefault();
  for (var i = 0; i < 4; i++) {
    if (curveType == 0) {
      var rawPts = channels[i];
      var curvePoints = [];
      for (var j = 0; j < rawPts.length; j += 2) curvePoints.push(createCurvePoint(rawPts[j], rawPts[j + 1], true));
      setChannelCurve(filterDesc, i, curvePoints);
    } else {
      setChannelCurve(filterDesc, i, channels[i]);
    }
  }
  return filterDesc;
}

function createIdentityCurve() {
  var curve = [];
  for (var i = 0; i < 256; i++) curve.push(i);
  return curve;
}

function setChannelCurve(filterDesc, channelIdx, curveData) {
  var channel = createChnlChannelDesc("CrvA", channelIdx);
  if (curveData.length < 256) {
    channel.Crv = { t: "VlLs", v: curveData };
  } else {
    channel.Mpng = { t: "VlLs", v: [] };
    for (var i = 0; i < 256; i++) channel.Mpng.v[i] = { t: "long", v: curveData[i] };
  }
  channel = { t: "Objc", v: channel };
  var adjList = filterDesc.Adjs.v;
  var existingIdx = findChnlChannelIndex(adjList, channelIdx);
  if (existingIdx == -1) adjList.push(channel);
  else adjList[existingIdx] = channel;
}

function getChannelCurve(filterDesc, channelIdx) {
  var adjList = filterDesc.Adjs.v;
  var idx = findChnlChannelIndex(adjList, channelIdx);
  if (idx == -1) {
    if (adjList.length == 0 || adjList[0].v.Crv) return [createCurvePoint(0, 0, true), createCurvePoint(255, 255, true)];
    var mapping = [];
    for (var i = 0; i < 256; i++) mapping.push(i);
    return mapping;
  }
  var entry = adjList[idx].v;
  if (entry.Crv) return entry.Crv.v;
  var mapping = [];
  for (var i = 0; i < 256; i++) mapping.push(entry.Mpng.v[i].v);
  return mapping;
}

function readCurvePoints(data, pos) {
  var pts = [];
  var count = BinaryUtils.readUint16(data, pos);
  pos += 2;
  for (var i = 0; i < count; i++) {
    var x = BinaryUtils.readUint16(data, pos);
    pos += 2;
    var y = BinaryUtils.readUint16(data, pos);
    pos += 2;
    pts.push(y, x);
  }
  return pts;
}

function writeCurvePoints(buf, pos, pts) {
  var count = pts.length / 2;
  BinaryUtils.writeUint16(buf, pos, count);
  pos += 2;
  for (var i = 0; i < count; i++) {
    BinaryUtils.writeUint16(buf, pos, pts[i * 2 + 1]);
    pos += 2;
    BinaryUtils.writeUint16(buf, pos, pts[i * 2 + 0]);
    pos += 2;
  }
}

function readMappingCurve(data, pos) {
  var curve = [];
  for (var i = 0; i < 256; i++) curve.push(data[pos + i]);
  return curve;
}

function writeMappingCurve(buf, pos, curve) {
  buf.ensureCapacity(pos, 256);
  for (var i = 0; i < 256; i++) buf.data[pos + i] = curve[i];
}

function serializeCurves(buf, pos, filterDesc) {
  var channels = [];
  for (var i = 0; i < 4; i++) {
    var curve = getChannelCurve(filterDesc, i);
    if (curve.length == 256) {
      channels.push(curve);
    } else {
      var flatPts = [];
      for (var j = 0; j < curve.length; j++) flatPts.push(curve[j].v.Hrzn.v, curve[j].v.Vrtc.v);
      channels.push(flatPts);
    }
  }
  var startPos = pos;
  var isMappingCurve = channels[0].length == 256 ? 1 : 0;
  buf.ensureCapacity(pos, 3);
  buf.data[pos] = isMappingCurve;
  buf.data[pos + 1] = 0;
  buf.data[pos + 2] = 1;
  pos += 3;
  BinaryUtils.writeSize(buf, pos, 15);
  pos += 4;
  for (var i = 0; i < 4; i++) {
    var ch = channels[i];
    if (isMappingCurve == 0) {
      writeCurvePoints(buf, pos, ch);
      pos += 2 + 2 * ch.length;
    } else {
      writeMappingCurve(buf, pos, ch);
      pos += 256;
    }
  }
  return pos - startPos;
}

const CurvesParser = {
  parse: parseCurves,
  parseLegacy: parseCurvesLegacy,
  createIdentityCurve,
  setChannelCurve,
  getChannelCurve,
  readCurvePoints,
  writeCurvePoints,
  readMappingCurve,
  writeMappingCurve,
  serialize: serializeCurves,
};

// ---------------------------------------------------------------------------
// Hue / Saturation (hue2)
// ---------------------------------------------------------------------------

function parseHueSaturation(data, pos, size) {
  var raw = {};
  var version = BinaryUtils.readUint16(data, pos);
  pos += 2;
  raw.colorize = data[pos] == 1;
  pos++;
  pos++;
  raw.masterWhenColorize = [BinaryUtils.readInt16BE(data, pos), BinaryUtils.readInt16BE(data, pos + 2), BinaryUtils.readInt16BE(data, pos + 4)];
  pos += 6;
  raw.masterDefault = [BinaryUtils.readInt16BE(data, pos), BinaryUtils.readInt16BE(data, pos + 2), BinaryUtils.readInt16BE(data, pos + 4)];
  pos += 6;
  raw.colorRanges = [];
  for (var i = 0; i < 6; i++) {
    var range = {};
    range.bounds = [BinaryUtils.readInt16BE(data, pos), BinaryUtils.readInt16BE(data, pos + 2), BinaryUtils.readInt16BE(data, pos + 4), BinaryUtils.readInt16BE(data, pos + 6)];
    pos += 8;
    range.hslShift = [BinaryUtils.readInt16BE(data, pos), BinaryUtils.readInt16BE(data, pos + 2), BinaryUtils.readInt16BE(data, pos + 4)];
    pos += 6;
    raw.colorRanges.push(range);
  }
  var filterDesc = createHueSaturationDefault();
  if (filterDesc.Clrz == null) filterDesc.Clrz = { t: "bool", v: false };
  filterDesc.Clrz.v = raw.colorize;
  for (var i = 0; i < 7; i++) {
    var channelData = i == 0 ? (raw.colorize ? raw.masterWhenColorize : raw.masterDefault) : raw.colorRanges[i - 1];
    setChannelData(filterDesc, i, channelData);
  }
  return filterDesc;
}

function createColorDesc(hslValues) {
  return {
    classID: "Hst2",
    H: { t: "long", v: hslValues[0] },
    Strt: { t: "long", v: hslValues[1] },
    Lght: { t: "long", v: hslValues[2] },
  };
}

function findHueSatChannelIndex(adjList, channelIdx) {
  for (var i = 0; i < adjList.length; i++) {
    var localRange = adjList[i].v.LclR;
    if (channelIdx == 0 && localRange == null || localRange != null && localRange.v == channelIdx) return i;
  }
  return -1;
}

function setChannelData(filterDesc, channelIdx, channelData) {
  var hslShift = channelIdx == 0 ? channelData : channelData.hslShift;
  var desc = createColorDesc(hslShift);
  if (channelIdx != 0) {
    var bounds = channelData.bounds;
    desc.LclR = { t: "long", v: channelIdx };
    desc.BgnR = { t: "long", v: bounds[0] };
    desc.BgnS = { t: "long", v: bounds[1] };
    desc.EndS = { t: "long", v: bounds[2] };
    desc.EndR = { t: "long", v: bounds[3] };
  }
  desc = { t: "Objc", v: desc };
  var adjList = filterDesc.Adjs.v;
  var existingIdx = findHueSatChannelIndex(adjList, channelIdx);
  if (existingIdx == -1) adjList.push(desc);
  else adjList[existingIdx] = desc;
}

function getChannelData(filterDesc, channelIdx) {
  var adjList = filterDesc.Adjs.v;
  var idx = findHueSatChannelIndex(adjList, channelIdx);
  if (idx == -1) {
    if (channelIdx == 0) return [0, 0, 0];
    return [
      { bounds: [315, 345, 15, 45], hslShift: [0, 0, 0] },
      { bounds: [15, 45, 75, 105], hslShift: [0, 0, 0] },
      { bounds: [75, 105, 135, 165], hslShift: [0, 0, 0] },
      { bounds: [135, 165, 195, 225], hslShift: [0, 0, 0] },
      { bounds: [195, 225, 255, 285], hslShift: [0, 0, 0] },
      { bounds: [255, 285, 315, 345], hslShift: [0, 0, 0] },
    ][channelIdx - 1];
  }
  var entry = adjList[idx].v;
  var hslValues = [entry.H.v, entry.Strt.v, entry.Lght.v];
  if (channelIdx == 0) return hslValues;
  return { hslShift: hslValues, bounds: [entry.BgnR.v, entry.BgnS.v, entry.EndS.v, entry.EndR.v] };
}

function serializeHueSaturation(buf, pos, filterDesc) {
  var raw = { colorize: filterDesc.Clrz.v, colorRanges: [] };
  raw.masterWhenColorize = raw.masterDefault = getChannelData(filterDesc, 0);
  for (var i = 1; i < 7; i++) raw.colorRanges.push(getChannelData(filterDesc, i));
  var totalSize = 2 + 2 + 12 + 6 * 14;
  var dataArr = buf.data;
  buf.ensureCapacity(pos, totalSize);
  BinaryUtils.writeUint16Raw(dataArr, pos, 2);
  pos += 2;
  dataArr[pos] = raw.colorize ? 1 : 0;
  pos++;
  pos++;
  BinaryUtils.writeUint16Raw(dataArr, pos + 0, raw.masterWhenColorize[0]);
  BinaryUtils.writeUint16Raw(dataArr, pos + 2, raw.masterWhenColorize[1]);
  BinaryUtils.writeUint16Raw(dataArr, pos + 4, raw.masterWhenColorize[2]);
  pos += 6;
  BinaryUtils.writeUint16Raw(dataArr, pos + 0, raw.masterDefault[0]);
  BinaryUtils.writeUint16Raw(dataArr, pos + 2, raw.masterDefault[1]);
  BinaryUtils.writeUint16Raw(dataArr, pos + 4, raw.masterDefault[2]);
  pos += 6;
  for (var i = 0; i < 6; i++) {
    var bounds = raw.colorRanges[i].bounds;
    var hslShift = raw.colorRanges[i].hslShift;
    BinaryUtils.writeUint16Raw(dataArr, pos + 0, bounds[0]);
    BinaryUtils.writeUint16Raw(dataArr, pos + 2, bounds[1]);
    BinaryUtils.writeUint16Raw(dataArr, pos + 4, bounds[2]);
    BinaryUtils.writeUint16Raw(dataArr, pos + 6, bounds[3]);
    pos += 8;
    BinaryUtils.writeUint16Raw(dataArr, pos + 0, hslShift[0]);
    BinaryUtils.writeUint16Raw(dataArr, pos + 2, hslShift[1]);
    BinaryUtils.writeUint16Raw(dataArr, pos + 4, hslShift[2]);
    pos += 6;
  }
  return totalSize;
}

const HueSaturationParser = {
  parse: parseHueSaturation,
  createColorDesc,
  findChannelIndex: findHueSatChannelIndex,
  setChannelData,
  getChannelData,
  serialize: serializeHueSaturation,
};

// ---------------------------------------------------------------------------
// Levels (levl)
// ---------------------------------------------------------------------------

function parseLevels(rawBuffer) {
  var data = new Uint8Array(rawBuffer);
  var pos = 2;
  var channelLevels = [];
  for (var i = 0; i < 29; i++) {
    var levelVals = [];
    channelLevels.push(levelVals);
    for (var j = 0; j < 5; j++) levelVals.push(BinaryUtils.readUint16(data, pos + i * 10 + j * 2));
  }
  pos += 29 * 10;
  if (pos < data.length) {
    var extraSig = BinaryUtils.readString(data, pos, 4);
    pos += 4;
    var extraVersion = BinaryUtils.readUint16(data, pos);
    pos += 2;
    var totalChannels = BinaryUtils.readUint16(data, pos);
    pos += 2;
    var extraCount = totalChannels - 29;
    for (var i = 0; i < extraCount; i++) {
      var levelVals = [];
      channelLevels.push(levelVals);
      for (var j = 0; j < 5; j++) levelVals.push(BinaryUtils.readUint16(data, pos + i * 10 + j * 2));
    }
  }
  var filterDesc = createLevelsDefault();
  for (var i = 0; i < 4; i++) setChannelLevel(filterDesc, i, channelLevels[i]);
  return filterDesc;
}

function setChannelLevel(filterDesc, channelIdx, levelVals) {
  var channel = createChnlChannelDesc("LvlA", channelIdx);
  channel.Inpt = { t: "VlLs", v: [{ t: "long", v: levelVals[0] }, { t: "long", v: levelVals[1] }] };
  channel.Otpt = { t: "VlLs", v: [{ t: "long", v: levelVals[2] }, { t: "long", v: levelVals[3] }] };
  channel.Gmm = { t: "doub", v: levelVals[4] / 100 };
  channel = { t: "Objc", v: channel };
  var adjList = filterDesc.Adjs.v;
  var existingIdx = findChnlChannelIndex(adjList, channelIdx);
  if (existingIdx == -1) adjList.push(channel);
  else adjList[existingIdx] = channel;
}

function getChannelLevel(filterDesc, channelIdx) {
  var defaults = [0, 255, 0, 255, 100];
  var adjList = filterDesc.Adjs.v;
  var idx = findChnlChannelIndex(adjList, channelIdx);
  if (idx == -1) return defaults;
  var entry = adjList[idx].v;
  if (entry.Inpt) {
    defaults[0] = entry.Inpt.v[0].v;
    defaults[1] = entry.Inpt.v[1].v;
  }
  if (entry.Otpt) {
    defaults[2] = entry.Otpt.v[0].v;
    defaults[3] = entry.Otpt.v[1].v;
  }
  if (entry.Gmm) defaults[4] = Math.round(entry.Gmm.v * 100);
  return defaults;
}

function serializeLevels(buf, filterDesc) {
  var channels = [];
  var pos = 0;
  for (var i = 0; i < 4; i++) channels.push(getChannelLevel(filterDesc, i));
  while (channels.length < 29) channels.push([0, 255, 0, 255, 100]);
  buf.ensureCapacity(0, 2 + 10 * 29);
  BinaryUtils.writeUint16Raw(buf.data, pos, 2);
  pos += 2;
  for (var i = 0; i < 29; i++) {
    var levelVals = channels[i];
    for (var j = 0; j < 5; j++) BinaryUtils.writeUint16Raw(buf.data, pos + i * 10 + j * 2, levelVals[j]);
  }
  pos += 29 * 10;
  if (channels.length == 29) return pos;
  buf.ensureCapacity(pos, 8 + 10 * (channels.length - 29));
  BinaryUtils.writeAsciiRaw(buf.data, pos, "Lvls");
  pos += 4;
  BinaryUtils.writeUint16Raw(buf.data, pos, 3);
  pos += 2;
  BinaryUtils.writeUint16Raw(buf.data, pos, channels.length);
  pos += 2;
  var extraCount = channels.length - 29;
  for (var i = 0; i < extraCount; i++) {
    var levelVals = channels[29 + i];
    for (var j = 0; j < 5; j++) BinaryUtils.writeUint16Raw(buf.data, pos + i * 10 + j * 2, levelVals[j]);
  }
  pos += 10 * extraCount;
  return pos;
}

const LevelsParser = {
  parse: parseLevels,
  createChannelDesc: createChnlChannelDesc,
  findChannelIndex: findChnlChannelIndex,
  setChannelLevel,
  getChannelLevel,
  serialize: serializeLevels,
};

// ---------------------------------------------------------------------------
// Selective Color (selc)
// ---------------------------------------------------------------------------

/** Color-range names indexed as stored in a Selective Color descriptor. */
const SELECTIVE_COLOR_RANGES = "Rds Ylws Grns Cyns Bls Mgnt Whts Ntrl Blks".split(" ");
/** CMYK component descriptor keys. */
const CMYK_KEYS = ["Cyn", "Mgnt", "Ylw", "Blck"];

function decodeSelectiveColor(data, pos, size) {
  var version = BinaryUtils.readUint16(data, pos);
  pos += 2;
  var raw = {};
  raw.isAbsolute = BinaryUtils.readUint16(data, pos) == 1;
  pos += 2;
  raw.colorData = [];
  for (var i = 0; i < 10; i++) {
    var cmykVals = [];
    raw.colorData.push(cmykVals);
    for (var j = 0; j < 4; j++) cmykVals.push(BinaryUtils.readInt16BE(data, pos + j * 2));
    pos += 8;
  }
  var filterDesc = createSelectiveColorDefault();
  filterDesc.Mthd.v.CrcM = raw.isAbsolute ? "Absl" : "Rltv";
  for (var i = 1; i < 10; i++) applyColorAdjustment(filterDesc, i - 1, raw.colorData[i]);
  return filterDesc;
}

function findColorIndex(adjList, colorIdx) {
  for (var i = 0; i < adjList.length; i++) {
    if (SELECTIVE_COLOR_RANGES.indexOf(adjList[i].v.Clrs.v.Clrs) == colorIdx) return i;
  }
  return -1;
}

function applyColorAdjustment(filterDesc, colorIdx, cmykVals) {
  var colorAdj = {
    classID: "ClrC",
    Clrs: { t: "enum", v: { Clrs: SELECTIVE_COLOR_RANGES[colorIdx] } },
  };
  for (var i = 0; i < 4; i++) colorAdj[CMYK_KEYS[i]] = { t: "UntF", v: { type: "#Prc", val: cmykVals[i] } };
  colorAdj = { t: "Objc", v: colorAdj };
  var adjList = filterDesc.ClrC.v;
  var existingIdx = findColorIndex(adjList, colorIdx);
  if (existingIdx == -1) adjList.push(colorAdj);
  else adjList[existingIdx] = colorAdj;
}

function extractColorAdjustment(filterDesc, colorIdx) {
  var cmykVals = [0, 0, 0, 0];
  var adjList = filterDesc.ClrC.v;
  var idx = findColorIndex(adjList, colorIdx);
  if (idx == -1) return cmykVals;
  for (var i = 0; i < 4; i++) {
    if (adjList[idx].v[CMYK_KEYS[i]]) cmykVals[i] = adjList[idx].v[CMYK_KEYS[i]].v.val;
  }
  return cmykVals;
}

function serializeSelectiveColor(buf, pos, filterDesc) {
  var raw = { isAbsolute: filterDesc.Mthd.v.CrcM == "Absl", colorData: [[0, 0, 0, 0]] };
  for (var i = 0; i < 9; i++) raw.colorData.push(extractColorAdjustment(filterDesc, i));
  buf.ensureCapacity(pos, 84);
  BinaryUtils.writeUint16Raw(buf.data, pos, 1);
  pos += 2;
  BinaryUtils.writeUint16Raw(buf.data, pos, raw.isAbsolute ? 1 : 0);
  pos += 2;
  for (var i = 0; i < 10; i++) {
    var cmykVals = raw.colorData[i];
    for (var j = 0; j < 4; j++) BinaryUtils.writeUint16Raw(buf.data, pos + j * 2, cmykVals[j]);
    pos += 8;
  }
  return 84;
}

const SelectiveColorParser = {
  decode: decodeSelectiveColor,
  colorRanges: SELECTIVE_COLOR_RANGES,
  findColorIndex,
  apply: applyColorAdjustment,
  extract: extractColorAdjustment,
  serialize: serializeSelectiveColor,
};

export { CurvesParser, HueSaturationParser, LevelsParser, SelectiveColorParser };

/** A fresh `createLevelsDefault` descriptor at its Photoshop defaults. */
export function createLevelsDefault() {
  return {
    __name: "Levels",
    classID: "Lvls",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindCustom"
      }
    },
    Adjs: {
      t: "VlLs",
      v: []
    }
  }
}

/** A fresh `createCurvesDefault` descriptor at its Photoshop defaults. */
export function createCurvesDefault() {
  return {
    __name: "Curves",
    classID: "Crvs",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindCustom"
      }
    },
    Adjs: {
      t: "VlLs",
      v: []
    }
  }
}

/** A fresh `createHueSaturationDefault` descriptor at its Photoshop defaults. */
export function createHueSaturationDefault() {
  return {
    __name: "Hue/Saturation",
    classID: "HStr",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindCustom"
      }
    },
    Clrz: {
      t: "bool",
      v: false
    },
    Adjs: {
      t: "VlLs",
      v: []
    }
  }
}

/** A fresh `createSelectiveColorDefault` descriptor at its Photoshop defaults. */
export function createSelectiveColorDefault() {
  return {
    __name: "Selective Color",
    classID: "SlcC",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindCustom"
      }
    },
    Mthd: {
      t: "enum",
      v: {
        CrcM: "Rltv"
      }
    },
    ClrC: {
      t: "VlLs",
      v: []
    }
  }
}
