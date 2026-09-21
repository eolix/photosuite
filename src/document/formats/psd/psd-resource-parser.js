/**
 * PSD image-resource and additional-layer-info parser: reads and writes the
 * tagged blocks attached to layers and the document (effects, masks, text,
 * smart objects, patterns, etc.). Dispatches on FourCC tag to per-tag handlers.
 */

import { Point } from "../../../core/math/point.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../../core/render-buffer.js";

import { AdjustmentEngine } from "../../../features/adjustments/adjustment-engine.js";
import { FilterDefs } from "../../../features/filters/filter-registry.js";
import { LayerEffectDefs } from "./effect-defs.js";
import { TextEngineData } from "../../../features/text/text-engine.js";

import { CurvesParser, HueSaturationParser, LevelsParser, SelectiveColorParser } from "./adjustment-parsers.js";
import { EngineDataParser, BinaryTreeParser } from "./engine-binary-parsers.js";
import { ChannelImageCodec } from "./channel-image-codec.js";
import { DescriptorCodec } from "./descriptor-codec.js";
import {
  PatternParser,
  GradientParser,
  cloneLayerAdditionalValue,
} from "./layer-data-parsers.js";
import { PathRecordCodec } from "./path-record-codec.js";
import {
  normalizeLayerEffectsOnRead,
  normalizeLayerEffectsOnWrite,
  applyGradientFillDefaults,
} from "./psd-layer-effects.js";
import { LinkedFileItem } from "../../model/placed-layer.js";
import { Mask, VectorMask } from "../../model/layer-masks.js";
import { TrackerRegistry } from "../../../features/trackers/tracker-registry.js";
import { PlanarRgbaBuffer, allocBuffer, interleavedToPlanar, planarToInterleaved } from "../../../engine/compositing/buffer-utils.js";
import { copyChannel, trimRgbaToContent } from "../../../engine/compositing/pixel-ops.js";
import { assignKeyOriginIndices } from "../../../engine/compositing/key-origins.js";
import { xyzToLab } from "../../../engine/compositing/color-math.js";

/** Additional layer info tags that use a 64-bit payload size in PSB files. */
const PSB_EXTENDED_SIZE_TAGS = new Set(
  "LMsk Lr16 Lr32 Layr Mt16 Mt32 Mtrn Alph FMsk lnk2 lnkE FEid FXid PxSD extn cinf artd pths".split(" "),
);

/** Tags skipped entirely while reading additional layer information. */
const SKIP_ON_READ_TAGS = new Set(["lrFX", "PlLd"]);

/** Tags whose written payload size is not padded to a four-byte boundary. */
const WRITE_UNPADDED_TAGS = new Set(["Txt2", "artd", "extd", "pths"]);

/** Tags whose read payload size may be padded to a four-byte boundary. */
const READ_PAD_EXEMPT_TAGS = new Set([
  "Lr16",
  "LMsk",
  "Txt2",
  "artd",
  "extd",
  "luni",
  "pths",
  "extn",
  "tySh",
  "lfx2",
  "cinf",
  "phry",
]);

function usesPsbExtendedSize(tagFourCC, isPSB) {
  return isPSB && PSB_EXTENDED_SIZE_TAGS.has(tagFourCC);
}

/**
 * @typedef {object} ReadLayerTagContext
 * @property {Uint8Array} data
 * @property {number} pos
 * @property {number} chunkSize
 * @property {Record<string, unknown>} targetAdd
 * @property {boolean} isPSB
 * @property {{ width: number, height: number, dpi?: number }} context
 * @property {string} tag
 */

/**
 * @typedef {object} WriteLayerTagContext
 * @property {object} buf
 * @property {number} pos
 * @property {Record<string, unknown>} sourceAdd
 * @property {string} tag
 * @property {number} tagWritePos
 * @property {{ width: number, height: number, dpi?: number }} context
 */

// ---------------------------------------------------------------------------
// Read handlers (one function per additional layer info tag group)
// ---------------------------------------------------------------------------

function readLayerTag_iOpa(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = data[pos];
}

function readLayerTag_brst(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = [1, 1, 1];
  for (let idx = 0; idx < chunkSize; idx += 4) targetAdd[tag][BinaryUtils.readUint32BE(data, pos + idx)] = 0;
}

function readLayerTag_knko(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = data[pos];
}

function readLayerTag_infx(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = data[pos];
}

function readLayerTag_clbl(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = data[pos];
}

function readLayerTag_lmgm(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = data[pos];
}

function readLayerTag_vmgm(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = data[pos];
}

function readLayerTag_lyid(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = BinaryUtils.readUint32BE(data, pos);
}

function readLayerTag_lsct(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {
    type: BinaryUtils.readUint32BE(data, pos)
  };
  if (chunkSize >= 12) targetAdd[tag].blendMode = BinaryUtils.readString(data, pos + 8, 4);
}

function readLayerTag_lsdk(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd.lsct = {
    type: BinaryUtils.readUint32BE(data, pos)
  };
}

function readLayerTag_lyvr(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = BinaryUtils.readUint32BE(data, pos);
}

function readLayerTag_lnsr(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = BinaryUtils.readString(data, pos, 4);
}

function readLayerTag_lspf(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = BinaryUtils.readUint32BE(data, pos);
}

function readLayerTag_lclr(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = BinaryUtils.readUint16(data, pos);
}

function readLayerTag_luni(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = BinaryUtils.readUnicodeString(data, pos);
}

function readLayerTag_fxrp(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = new Point(BinaryUtils.readFloat64BE(data, pos), BinaryUtils.readFloat64BE(data, pos + 8));
}

function readLayerTag_phry_artb_artd(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  chunkSize = 4 + DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 4);
  ctx.chunkSize = chunkSize;
}

function readLayerTag_SoCo(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 4);
}

function readLayerTag_GdFl(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 4);
  applyGradientFillDefaults(targetAdd[tag], tag);
}

function readLayerTag_PtFl(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 4);
  applyGradientFillDefaults(targetAdd[tag], tag);
}

function readLayerTag_CgEd(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var britDesc = targetAdd.brit = FilterDefs.create("brit"),
    descriptorScratch = {};
  DescriptorCodec.parseDescriptor(data, descriptorScratch, pos + 4);
  britDesc.Brgh.v = descriptorScratch.Brgh ? descriptorScratch.Brgh.v : 0;
  britDesc.Cntr.v = descriptorScratch.Cntr ? descriptorScratch.Cntr.v : 0;
  britDesc.useLegacy.v = descriptorScratch.useLegacy ? descriptorScratch.useLegacy.v : 0;
}

function readLayerTag_brit(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  if (targetAdd.brit == null) {
    var britDesc = targetAdd.brit = FilterDefs.create("brit"),
      descriptorScratch = {};
    britDesc.Brgh.v = BinaryUtils.readInt16BE(data, pos);
    britDesc.Cntr.v = BinaryUtils.readInt16BE(data, pos + 2);
    britDesc.useLegacy.v = false
  }
}

function readLayerTag_levl(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var levelBytes = data.buffer.slice(pos, pos + chunkSize);
  targetAdd[tag] = LevelsParser.parse(levelBytes);
}

function readLayerTag_curv(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = CurvesParser.parseLegacy(data, pos, chunkSize);
}

function readLayerTag_expA(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var formatWord = BinaryUtils.readUint16(data, pos),
    adjDesc = targetAdd[tag] = FilterDefs.create("expA");
  adjDesc.Exps.v = BinaryUtils.readFloat32BE(data, pos + 2);
  adjDesc.Ofst.v = BinaryUtils.readFloat32BE(data, pos + 6);
  adjDesc.gammaCorrection.v = BinaryUtils.readFloat32BE(data, pos + 10);
}

function readLayerTag_vibA(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 4);
}

function readLayerTag_hue2(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = HueSaturationParser.parse(data, pos, chunkSize);
}

function readLayerTag_blnc(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var adjDesc = targetAdd[tag] = FilterDefs.create(tag);
  adjDesc.PrsL.v = data[pos + 18] == 1;
  var toneKeys = ["ShdL", "MdtL", "HghL"];
  for (let idx = 0; idx < 3; idx++)
    for (let channelIdx = 0; channelIdx < 3; channelIdx++) adjDesc[toneKeys[idx]].v[channelIdx].v = BinaryUtils.readInt16BE(data, pos + idx * 6 + channelIdx * 2);
}

function readLayerTag_blwh(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var descriptorScratch = {};
  DescriptorCodec.parseDescriptor(data, descriptorScratch, pos + 4);
  var adjDesc = FilterDefs.create(tag),
    blwhFieldKeys = "Bl Cyn Grn Mgnt Rd Yllw tintColor useTint".split(" ");
  for (let idx = 0; idx < blwhFieldKeys.length; idx++) {
    adjDesc[blwhFieldKeys[idx]] = descriptorScratch[blwhFieldKeys[idx]];
    delete descriptorScratch[blwhFieldKeys[idx]]
  }
  targetAdd[tag] = adjDesc;
}

function readLayerTag_phfl(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var adjDesc = targetAdd[tag] = FilterDefs.create(tag),
    filterColor = adjDesc.Clr.v,
    formatWord = BinaryUtils.readUint16(data, pos);
  if (formatWord == 3) {
    var xyzPacked = [BinaryUtils.readUint32BE(data, pos + 2), BinaryUtils.readUint32BE(data, pos + 6), BinaryUtils.readUint32BE(data, pos + 10)],
      labTriplet = 32768,
      labParsed = xyzToLab(xyzPacked[0] / labTriplet, xyzPacked[1] / labTriplet, xyzPacked[2] / labTriplet);
    filterColor.Lmnc.v = labParsed.labL;
    filterColor.A.v = labParsed.labA;
    filterColor.B.v = labParsed.labB
  }
  if (formatWord == 2) {
    var colorSpaceId = BinaryUtils.readUint16(data, pos + 2);
    if (colorSpaceId != 7) throw new Error("unsupported phfl color space");
    filterColor.Lmnc.v = BinaryUtils.readInt16BE(data, pos + 4) / 100;
    filterColor.A.v = BinaryUtils.readInt16BE(data, pos + 6) / 100;
    filterColor.B.v = BinaryUtils.readInt16BE(data, pos + 8) / 100
  }
  var cursor = pos + 2 + (formatWord == 3 ? 12 : 10);
  adjDesc.Dnst.v = BinaryUtils.readUint32BE(data, cursor);
  cursor += 4;
  adjDesc.PrsL.v = data[cursor] == 1;
}

function readLayerTag_mixr(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var channelMixerRaw = {
    isMonochrome: BinaryUtils.readUint16(data, pos + 2) == 1,
    channelValues: []
  };
  for (let idx = 0; idx < 20; idx++) channelMixerRaw.channelValues.push(BinaryUtils.readInt16BE(data, pos + 4 + idx * 2));
  targetAdd[tag] = AdjustmentEngine.channelMixerToDescriptor(channelMixerRaw);
}

function readLayerTag_clrL_rplc(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 6);
}

function readLayerTag_nvrt(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
}

function readLayerTag_post(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = FilterDefs.create("post");
  targetAdd[tag].Lvls.v = BinaryUtils.readUint16(data, pos);
}

function readLayerTag_thrs(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = FilterDefs.create("thrs");
  targetAdd[tag].Lvl.v = BinaryUtils.readUint16(data, pos);
}

function readLayerTag_grdm(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var gradientMapMeta = {
      rev: data[pos + 2] == 1,
      a1s: data[pos + 3] == 1
    },
    readCursor = pos + 4,
    gradientName = BinaryUtils.readUnicodeString(data, readCursor);
  readCursor += 4 + gradientName.length * 2;
  var gradientEntry = GradientParser.readGradientEntry(data, readCursor, gradientName),
    gradientDesc = gradientEntry[0];
  readCursor = gradientEntry[1];
  var colorCount = BinaryUtils.readUint16(data, readCursor);
  readCursor += 2;
  gradientDesc.Intr.v = BinaryUtils.readUint16(data, readCursor);
  readCursor += 2;
  var colorMode = BinaryUtils.readUint16(data, readCursor);
  readCursor += 2;
  gradientMapMeta.mode = BinaryUtils.readUint16(data, readCursor);
  readCursor += 2;
  gradientMapMeta.Nz = BinaryUtils.readUint32BE(data, readCursor);
  readCursor += 4;
  gradientMapMeta.ajM = BinaryUtils.readUint16(data, readCursor) == 1;
  readCursor += 2;
  gradientMapMeta.amK = BinaryUtils.readUint16(data, readCursor) == 1;
  readCursor += 2;
  gradientMapMeta.a8Z = BinaryUtils.readUint32BE(data, readCursor);
  readCursor += 4;
  gradientMapMeta.aoQ = BinaryUtils.readUint16(data, readCursor);
  readCursor += 2;
  gradientMapMeta.Ne = [];
  for (let idx = 0; idx < 4; idx++) gradientMapMeta.Ne.push(BinaryUtils.readUint16(data, readCursor + idx * 2));
  readCursor += 8;
  gradientMapMeta.hu = [];
  for (let idx = 0; idx < 4; idx++) gradientMapMeta.hu.push(BinaryUtils.readUint16(data, readCursor + idx * 2));
  readCursor += 8;
  var gradAdjDesc = BinaryUtils.readUint16(data, readCursor);
  readCursor += 2;
  var grdmDesc = FilterDefs.create("grdm");
  grdmDesc.Rvrs.v = gradientMapMeta.rev;
  grdmDesc.Grad.v = gradientDesc;
  targetAdd[tag] = grdmDesc;
}

function readLayerTag_selc(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = SelectiveColorParser.decode(data, pos, chunkSize);
}

function readLayerTag_vmsk_vsms(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var vectorMask = targetAdd.vmsk = new VectorMask,
    maskFlags = BinaryUtils.readInt32BE(data, pos + 4),
    maskInvert = (maskFlags >> 0 & 1) == 1;
  vectorMask.enabled = (maskFlags >> 1 & 1) == 0;
  vectorMask.isEnabled = (maskFlags >> 2 & 1) == 0;
  vectorMask.pathRecords = PathRecordCodec.readPathPoints(data, pos + 8, chunkSize - 8, context.width, context.height);
}

function readLayerTag_shmd(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  var shmdCount = BinaryUtils.readUint32BE(data, pos),
    cursor = pos + 4;
  for (let idx = 0; idx < shmdCount; idx++) {
    var token4 = BinaryUtils.readString(data, cursor, 4);
    cursor += 4;
    var shmdKey = BinaryUtils.readString(data, cursor, 4);
    cursor += 4;
    var shmdFlags = data[cursor];
    cursor++;
    if (Math.max(data[cursor], data[cursor + 1], data[cursor + 2]) != 0) {
      throw new Error("invalid shmd reserved bytes");
    }
    cursor += 3;
    var shmdPayloadSize = BinaryUtils.readUint32BE(data, cursor);
    cursor += 4;
    if (shmdKey == "cust" || shmdKey == "cmls" || shmdKey == "extn" || shmdKey == "mlst") {
      var shmdVersion = BinaryUtils.readUint32BE(data, cursor);
      if (shmdVersion != 16) cursor += 4;
      if (BinaryUtils.readUint32BE(data, cursor) == 16) {
        var descriptorScratch = {};
        DescriptorCodec.parseDescriptor(data, descriptorScratch, cursor + 4, false);
        targetAdd[tag][shmdKey] = descriptorScratch;
        if (shmdKey == "cmls") TrackerRegistry.LayerCompTracker.normalizeCompLayerSettings(targetAdd[tag][shmdKey])
      }
    } else {
      console.log("unknown shmd key: " + shmdKey + ", size: " + shmdPayloadSize)
    }
    cursor += shmdPayloadSize
  }
}

function readLayerTag_shpa(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var formatWord = BinaryUtils.readUint32BE(data, pos),
    patternCount = BinaryUtils.readUint32BE(data, pos + 4);
  if (patternCount != 0) console.log("some patterns present!");
}

function readLayerTag_TySh(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var tyShRoot = targetAdd[tag] = {},
    formatWord = BinaryUtils.readUint16(data, pos);
  tyShRoot.transform = BinaryUtils.readMatrix2D(data, pos + 2);
  var tyShVersion = BinaryUtils.readUint16(data, pos + 2 + 48);
  tyShRoot.textDescriptor = {};
  var descriptorBytesRead = DescriptorCodec.parseDescriptor(data, tyShRoot.textDescriptor, pos + 56),
    txLrTemplate = TextEngineData.createTxLrDescriptor();
  for (let kmGradLen in txLrTemplate)
    if (tyShRoot.textDescriptor[kmGradLen] == null) tyShRoot.textDescriptor[kmGradLen] = txLrTemplate[kmGradLen];
  tyShRoot.warpDescriptor = {};
  var kmGradBytes = DescriptorCodec.parseDescriptor(data, tyShRoot.warpDescriptor, pos + 56 + descriptorBytesRead + 6);
  tyShRoot.boundsRect = BinaryUtils.readFloat32Rect(data, pos + 56 + descriptorBytesRead + 6 + kmGradBytes);
  tyShRoot.engineData = EngineDataParser.parse(tyShRoot.textDescriptor.EngineData.v);
  TextEngineData.normalizeFillColors(tyShRoot.engineData.EngineDict.StyleRun.RunArray);
  if (tyShRoot.engineData.ResourceDict == null) tyShRoot.engineData.ResourceDict = JSON.parse(JSON.stringify(tyShRoot.engineData.DocumentResources));
  delete tyShRoot.textDescriptor.EngineData;
}

function readLayerTag_lfx2_lmfx_lfxs(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var fxVersion = BinaryUtils.readUint32BE(data, pos),
    fxDescVersion = BinaryUtils.readUint32BE(data, pos + 4);
  targetAdd.lmfx = {};
  var descriptorBytesRead = DescriptorCodec.parseDescriptor(data, targetAdd.lmfx, pos + 8);
  normalizeLayerEffectsOnRead(targetAdd.lmfx);
}

function readLayerTag_FMsk(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = BinaryUtils.readBytes(data, pos, chunkSize);
}

function readLayerTag_Txt2(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = {};
  targetAdd[tag].raw = BinaryUtils.readBytes(data, pos, chunkSize);
  targetAdd[tag].parsedTree = BinaryTreeParser.parse(targetAdd[tag].raw);
}

function readLayerTag_Patt(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = PatternParser.extract(data, pos, chunkSize);
}

function readLayerTag_SoLd(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var soLdSig = BinaryUtils.readString(data, pos, 4),
    soLdReadSize = BinaryUtils.readUint32BE(data, pos + 4),
    soLdReserved = BinaryUtils.readUint32BE(data, pos + 8);
  targetAdd[tag] = {};
  var soLdBytesRead = DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 12);
  if (targetAdd[tag].nonAffineTransform == null) targetAdd[tag].nonAffineTransform = JSON.parse(JSON.stringify(targetAdd[tag].Trnf));
  if (targetAdd[tag].Impr == null) targetAdd[tag].Impr = {
    t: "Objc",
    v: {
      __name: "None",
      classID: "none"
    }
  };
}

function readLayerTag_vstk_pths(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var soLdReadSize = BinaryUtils.readUint32BE(data, pos);
  targetAdd[tag] = {};
  var soLdBytesRead = DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 4);
}

function readLayerTag_vscg(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var shmdKey = BinaryUtils.readString(data, pos, 4),
    soLdReadSize = BinaryUtils.readUint32BE(data, pos + 4);
  targetAdd[shmdKey] = {};
  var soLdBytesRead = DescriptorCodec.parseDescriptor(data, targetAdd[shmdKey], pos + 8);
  applyGradientFillDefaults(targetAdd[shmdKey], shmdKey);
}

function readLayerTag_vogk(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var vogkCount = BinaryUtils.readUint32BE(data, pos),
    soLdReadSize = BinaryUtils.readUint32BE(data, pos + 4);
  targetAdd[tag] = {};
  var soLdBytesRead = DescriptorCodec.parseDescriptor(data, targetAdd[tag], pos + 8);
  targetAdd[tag] = targetAdd[tag].keyDescriptorList.v;

}

function readLayerTag_lnk2_lnkDx_lnk3x(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  targetAdd[tag] = [];
  var readCursor = pos;
  while (readCursor < pos + chunkSize) {
    var linkedFileItem = new LinkedFileItem;
    targetAdd[tag].push(linkedFileItem);
    var colorMode = BinaryUtils.readInt64BE(data, readCursor);
    readCursor += 8;
    var linkBlockStart = readCursor;
    linkedFileItem.type = BinaryUtils.readString(data, readCursor, 4);
    readCursor += 4;
    if (linkedFileItem.type != "liFD") {
      alert("Unknown Linked Layer type: " + linkedFileItem.type);
      throw linkedFileItem.type
    }
    linkedFileItem.descriptorVersion = BinaryUtils.readUint32BE(data, readCursor);
    readCursor += 4;
    var pascalTagRead = BinaryUtils.readPascalString(data, readCursor);
    readCursor += 1 + pascalTagRead.str.length;
    linkedFileItem.tag = pascalTagRead.str;
    linkedFileItem.fileName = BinaryUtils.readUnicodeName(data, readCursor);
    readCursor += 4 + linkedFileItem.fileName.length * 2 + 2;
    linkedFileItem.fileTypeFourCC = BinaryUtils.readString(data, readCursor, 4);
    readCursor += 4;
    linkedFileItem.creatorFourCC = BinaryUtils.readString(data, readCursor, 4);
    readCursor += 4;
    var bb = BinaryUtils.readInt64BE(data, readCursor);
    readCursor += 8;
    linkedFileItem.open = data[readCursor];
    readCursor += 1;
    if (linkedFileItem.open != 0) {
      var gx = {},
        descriptorBytesRead = DescriptorCodec.parseDescriptor(data, gx, readCursor + 4);
      if (descriptorBytesRead % 4 != 0) descriptorBytesRead += 4 - descriptorBytesRead % 4;
      console.log(gx);
      readCursor += descriptorBytesRead + 4
    }
    linkedFileItem.open = 0;
    linkedFileItem.raw = BinaryUtils.readBytes(data, readCursor, bb);
    readCursor = linkBlockStart + colorMode;
    if (colorMode % 4 != 0) readCursor += 4 - colorMode % 4
  }
}

function readLayerTag_FEid(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  var readCursor = pos;
  targetAdd[tag] = [];
  var feEnd = readCursor + chunkSize,
    formatWord = BinaryUtils.readUint32BE(data, readCursor);
  readCursor += 4;
  while (readCursor < feEnd) {
    readCursor += 4;
    var colorMode = BinaryUtils.readUint32BE(data, readCursor);
    readCursor += 4;
    var gradientEntry = {};
    targetAdd[tag].push(gradientEntry);
    gradientEntry.id = BinaryUtils.readPascalString(data, readCursor).str;
    readCursor += gradientEntry.id.length + 1;
    var formatWord = BinaryUtils.readUint32BE(data, readCursor);
    readCursor += 4;
    readCursor += 4;
    var feFlags = BinaryUtils.readUint32BE(data, readCursor);
    readCursor += 4;
    gradientEntry.rect = BinaryUtils.readRect(data, readCursor);
    readCursor += 16;
    var feChannelDepth = BinaryUtils.readUint32BE(data, readCursor);
    readCursor += 4;
    var fePlaneCount = BinaryUtils.readUint32BE(data, readCursor);
    readCursor += 4;
    var planarBuf = new PlanarRgbaBuffer(0);
    for (let idx = 0; idx < fePlaneCount + 2; idx++) {
      var planeId = BinaryUtils.readUint32BE(data, readCursor);
      readCursor += 4;
      if (planeId != 0) {
        readCursor += 4;
        var planeSize = BinaryUtils.readUint32BE(data, readCursor),
          planeBuf = null;
        readCursor += 4;
        if (idx < 3 || idx == 25) planeBuf = ChannelImageCodec.readChannelBuffer(true, feChannelDepth, data, gradientEntry.rect.width, gradientEntry.rect.height, readCursor, planeSize);
        if (idx == 0) planarBuf.h = planeBuf;
        if (idx == 1) planarBuf.l = planeBuf;
        if (idx == 2) planarBuf.O = planeBuf;
        if (idx == 25) planarBuf.w = planeBuf;
        readCursor += planeSize
      }
    }
    gradientEntry.buffer = allocBuffer(gradientEntry.rect.area() * 4);
    planarToInterleaved(planarBuf, gradientEntry.buffer);
    trimRgbaToContent(gradientEntry);
    var hasMaskFlag = data[readCursor];
    readCursor++;
    if (hasMaskFlag != 0) {
      gradientEntry.d = new Mask;
      gradientEntry.d.rect = BinaryUtils.readRect(data, readCursor);
      readCursor += 16;
      readCursor += 4;
      var maskDataSize = BinaryUtils.readUint32BE(data, readCursor);
      readCursor += 4;
      gradientEntry.d.channel = ChannelImageCodec.readChannelBuffer(true, feChannelDepth, data, gradientEntry.d.rect.width, gradientEntry.d.rect.height, readCursor, maskDataSize);
      gradientEntry.d.color = 255;
      gradientEntry.d.trimToContent();
      readCursor += maskDataSize
    }
    if (colorMode % 4 != 0) readCursor += 4 - colorMode % 4
  }
}

function readLayerTag_Lr16(ctx) {
  const { data, pos, targetAdd, context } = ctx;
  let { chunkSize } = ctx;
  const tag = ctx.tag;
  PSDResourceParser.layerRecordHandler(context, data, pos);
}

const READ_LAYER_TAG_HANDLERS = {
  "iOpa": readLayerTag_iOpa,
  "brst": readLayerTag_brst,
  "knko": readLayerTag_knko,
  "infx": readLayerTag_infx,
  "clbl": readLayerTag_clbl,
  "lmgm": readLayerTag_lmgm,
  "vmgm": readLayerTag_vmgm,
  "lyid": readLayerTag_lyid,
  "lsct": readLayerTag_lsct,
  "lsdk": readLayerTag_lsdk,
  "lyvr": readLayerTag_lyvr,
  "lnsr": readLayerTag_lnsr,
  "lspf": readLayerTag_lspf,
  "lclr": readLayerTag_lclr,
  "luni": readLayerTag_luni,
  "fxrp": readLayerTag_fxrp,
  "phry": readLayerTag_phry_artb_artd,
  "artb": readLayerTag_phry_artb_artd,
  "artd": readLayerTag_phry_artb_artd,
  "SoCo": readLayerTag_SoCo,
  "GdFl": readLayerTag_GdFl,
  "PtFl": readLayerTag_PtFl,
  "CgEd": readLayerTag_CgEd,
  "brit": readLayerTag_brit,
  "levl": readLayerTag_levl,
  "curv": readLayerTag_curv,
  "expA": readLayerTag_expA,
  "vibA": readLayerTag_vibA,
  "hue2": readLayerTag_hue2,
  "blnc": readLayerTag_blnc,
  "blwh": readLayerTag_blwh,
  "phfl": readLayerTag_phfl,
  "mixr": readLayerTag_mixr,
  "clrL": readLayerTag_clrL_rplc,
  "rplc": readLayerTag_clrL_rplc,
  "nvrt": readLayerTag_nvrt,
  "post": readLayerTag_post,
  "thrs": readLayerTag_thrs,
  "grdm": readLayerTag_grdm,
  "selc": readLayerTag_selc,
  "vmsk": readLayerTag_vmsk_vsms,
  "vsms": readLayerTag_vmsk_vsms,
  "shmd": readLayerTag_shmd,
  "shpa": readLayerTag_shpa,
  "TySh": readLayerTag_TySh,
  "lfx2": readLayerTag_lfx2_lmfx_lfxs,
  "lmfx": readLayerTag_lfx2_lmfx_lfxs,
  "lfxs": readLayerTag_lfx2_lmfx_lfxs,
  "FMsk": readLayerTag_FMsk,
  "Txt2": readLayerTag_Txt2,
  "Patt": readLayerTag_Patt,
  "SoLd": readLayerTag_SoLd,
  "vstk": readLayerTag_vstk_pths,
  "pths": readLayerTag_vstk_pths,
  "vscg": readLayerTag_vscg,
  "vogk": readLayerTag_vogk,
  "lnk2": readLayerTag_lnk2_lnkDx_lnk3x,
  "lnkD__": readLayerTag_lnk2_lnkDx_lnk3x,
  "lnk3__": readLayerTag_lnk2_lnkDx_lnk3x,
  "FEid": readLayerTag_FEid,
  "Lr16": readLayerTag_Lr16,
};

function readLayerInfoTag(ctx) {
  const handler = READ_LAYER_TAG_HANDLERS[ctx.tag];
  if (handler) {
    handler(ctx);
    return;
  }
  if (ctx.tag === "Lr16") {
    PSDResourceParser.layerRecordHandler(ctx.context, ctx.data, ctx.pos);
  }
}

// ---------------------------------------------------------------------------
// Write handlers
// ---------------------------------------------------------------------------

function writeLayerTag_iOpa(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.fillBytes(buf, pos, sourceAdd[tag], 1);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_brst(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = 0;
  for (let idx = 0; idx < 3; idx++)
    if (sourceAdd[tag][idx] == 0) {
      BinaryUtils.writeSize(buf, pos + writtenSize, idx);
      writtenSize += 4
    }
  return writtenSize;
}

function writeLayerTag_knko(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.fillBytes(buf, pos, sourceAdd[tag], 1);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_infx(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.fillBytes(buf, pos, sourceAdd[tag], 1);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_clbl(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.fillBytes(buf, pos, sourceAdd[tag], 1);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_lmgm(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.fillBytes(buf, pos, sourceAdd[tag], 1);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_vmgm(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.fillBytes(buf, pos, sourceAdd[tag], 1);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_lyid(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, sourceAdd[tag]);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_lsct(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, sourceAdd[tag].type);
  writtenSize = 4;
  if (sourceAdd[tag].blendMode) {
    BinaryUtils.writeAscii(buf, pos + 4, "8BIM");
    BinaryUtils.writeAscii(buf, pos + 8, sourceAdd[tag].blendMode);
    writtenSize = 12
  }
  return writtenSize;
}

function writeLayerTag_lyvr(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, sourceAdd[tag]);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_lnsr(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeAscii(buf, pos, sourceAdd[tag]);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_lspf(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, sourceAdd[tag]);
  writtenSize = 4;
  return writtenSize;
}

function writeLayerTag_lclr(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeUint16(buf, pos, sourceAdd[tag]);
  writtenSize = 8;
  return writtenSize;
}

function writeLayerTag_luni(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeUnicodeString(buf, pos, sourceAdd[tag]);
  writtenSize = 4 + 2 * sourceAdd[tag].length;
  return writtenSize;
}

function writeLayerTag_fxrp(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeFloat64BE(buf, pos, sourceAdd[tag].x);
  BinaryUtils.writeFloat64BE(buf, pos + 8, sourceAdd[tag].y);
  writtenSize = 16;
  return writtenSize;
}

function writeLayerTag_phry_artb_artd(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_SoCo(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_GdFl(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_PtFl(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_CgEd(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var descriptor = {
      classID: "null",
      Vrsn: {
        t: "long",
        v: 1
      },
      Brgh: {
        t: "long",
        v: 24
      },
      Cntr: {
        t: "long",
        v: 54
      },
      means: {
        t: "long",
        v: 127
      },
      Lab: {
        t: "bool",
        v: false
      },
      useLegacy: {
        t: "bool",
        v: false
      },
      Auto: {
        t: "bool",
        v: true
      }
    },
    descCopy = descriptor,
    srcBrit = sourceAdd[tag];
  descCopy.Brgh.v = srcBrit.Brgh.v;
  descCopy.Cntr.v = srcBrit.Cntr.v;
  descCopy.useLegacy.v = srcBrit.useLegacy.v;
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, descriptor, pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_brit(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  buf.ensureCapacity(pos, 8);
  writtenSize = 8;
  return writtenSize;
}

function writeLayerTag_levl(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var renderBuf = new RenderBuffer;
  writtenSize = LevelsParser.serialize(renderBuf, sourceAdd[tag]);
  BinaryUtils.writeBytes(buf, pos, renderBuf.data);
  return writtenSize;
}

function writeLayerTag_curv(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = CurvesParser.serialize(buf, pos, sourceAdd[tag]);
  return writtenSize;
}

function writeLayerTag_expA(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = 14;
  buf.ensureCapacity(pos, 14);
  BinaryUtils.writeUint16Raw(buf.data, pos, 1);
  BinaryUtils.writeFloat32BERaw(buf.data, pos + 2, sourceAdd[tag].Exps.v);
  BinaryUtils.writeFloat32BERaw(buf.data, pos + 6, sourceAdd[tag].Ofst.v);
  BinaryUtils.writeFloat32BERaw(buf.data, pos + 10, sourceAdd[tag].gammaCorrection.v);
  return writtenSize;
}

function writeLayerTag_vibA(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_hue2(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = HueSaturationParser.serialize(buf, pos, sourceAdd[tag]);
  return writtenSize;
}

function writeLayerTag_blnc(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = 19;
  buf.ensureCapacity(pos, writtenSize);
  var toneKey = ["ShdL", "MdtL", "HghL"];
  for (let idx = 0; idx < 3; idx++) {
    var toneValues = sourceAdd[tag][toneKey[idx]].v;
    for (let channelIdx = 0; channelIdx < 3; channelIdx++) toneValues.push(BinaryUtils.writeUint16Raw(buf.data, pos + idx * 6 + channelIdx * 2, toneValues[channelIdx].v))
  }
  buf.data[pos + 18] = sourceAdd[tag].PrsL.v ? 1 : 0;
  return writtenSize;
}

function writeLayerTag_blwh(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var descriptor = {
      classID: "null",
      bwPresetKind: {
        t: "long",
        v: 1
      },
      blackAndWhitePresetFileName: {
        t: "TEXT",
        v: ""
      }
    },
    blwhFieldKeys = "Bl Cyn Grn Mgnt Rd Yllw tintColor useTint".split(" ");
  for (let idx = 0; idx < blwhFieldKeys.length; idx++) {
    descriptor[blwhFieldKeys[idx]] = sourceAdd[tag][blwhFieldKeys[idx]]
  }
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, descriptor, pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_phfl(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeUint16(buf, pos, 2);
  var labColor = sourceAdd[tag].Clr.v;
  BinaryUtils.writeUint16(buf, pos + 2, 7);
  BinaryUtils.writeUint16(buf, pos + 4, Math.round(labColor.Lmnc.v * 100));
  BinaryUtils.writeUint16(buf, pos + 6, Math.round(labColor.A.v * 100));
  BinaryUtils.writeUint16(buf, pos + 8, Math.round(labColor.B.v * 100));
  BinaryUtils.writeUint16(buf, pos + 10, 0);
  var writePos = pos + 2 + 10;
  buf.ensureCapacity(writePos, 5);
  BinaryUtils.writeUint32BE(buf.data, writePos, sourceAdd[tag].Dnst.v);
  writePos += 4;
  buf.data[writePos] = sourceAdd[tag].PrsL.v ? 1 : 0;
  writePos++;
  writtenSize = writePos - pos;
  return writtenSize;
}

function writeLayerTag_mixr(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = 44;
  buf.ensureCapacity(pos, writtenSize);
  var channelMixerParsed = AdjustmentEngine.parseChannelMixer(sourceAdd[tag]);
  BinaryUtils.writeUint16Raw(buf.data, pos, 1);
  BinaryUtils.writeUint16Raw(buf.data, pos + 2, channelMixerParsed.isMonochrome ? 1 : 0);
  for (let idx = 0; idx < 20; idx++) BinaryUtils.writeUint16Raw(buf.data, pos + 4 + idx * 2, channelMixerParsed.channelValues[idx]);
  return writtenSize;
}

function writeLayerTag_clrL_rplc(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeUint16(buf, pos, 1);
  BinaryUtils.writeSize(buf, pos + 2, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 6) + 6;
  return writtenSize;
}

function writeLayerTag_nvrt(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = 0;
  return writtenSize;
}

function writeLayerTag_post(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeUint16(buf, pos, sourceAdd[tag].Lvls.v);
  writtenSize = 2;
  return writtenSize;
}

function writeLayerTag_thrs(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeUint16(buf, pos, sourceAdd[tag].Lvl.v);
  writtenSize = 2;
  return writtenSize;
}

function writeLayerTag_grdm(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var gradientMapWriteMeta = {
      rev: sourceAdd[tag].Rvrs.v,
      legacySmooth: false,
      colorModel: 0,
      tableEntryCount: 867527939,
      ditherEdited: false,
      reverseLocked: true,
      tableByteSize: 2048,
      interpolationCount: 3,
      rampWeights: [0, 0, 0, 0],
      rampPositions: [32768, 32768, 32768, 32768],
    },
    gradStops = sourceAdd[tag].Grad.v;
  buf.ensureCapacity(pos, 4);
  BinaryUtils.writeUint16Raw(buf.data, pos, 1);
  buf.data[pos + 2] = gradientMapWriteMeta.rev ? 1 : 0;
  buf.data[pos + 3] = gradientMapWriteMeta.legacySmooth ? 1 : 0;
  var writeCursor = pos + 4;
  BinaryUtils.writeUnicodeString(buf, writeCursor, gradStops.Nm.v);
  writeCursor += 4 + gradStops.Nm.v.length * 2;
  writeCursor = GradientParser.writeGradientStops(buf, writeCursor, gradStops);
  BinaryUtils.writeUint16(buf, writeCursor, 2);
  writeCursor += 2;
  BinaryUtils.writeUint16(buf, writeCursor, gradStops.Intr.v);
  writeCursor += 2;
  BinaryUtils.writeUint16(buf, writeCursor, 32);
  writeCursor += 2;
  BinaryUtils.writeUint16(buf, writeCursor, gradientMapWriteMeta.colorModel);
  writeCursor += 2;
  BinaryUtils.writeSize(buf, writeCursor, gradientMapWriteMeta.tableEntryCount);
  writeCursor += 4;
  BinaryUtils.writeUint16(buf, writeCursor, gradientMapWriteMeta.ditherEdited ? 1 : 0);
  writeCursor += 2;
  BinaryUtils.writeUint16(buf, writeCursor, gradientMapWriteMeta.reverseLocked ? 1 : 0);
  writeCursor += 2;
  BinaryUtils.writeSize(buf, writeCursor, gradientMapWriteMeta.tableByteSize);
  writeCursor += 4;
  BinaryUtils.writeUint16(buf, writeCursor, gradientMapWriteMeta.interpolationCount);
  writeCursor += 2;
  for (let idx = 0; idx < 4; idx++) {
    BinaryUtils.writeUint16(buf, writeCursor + idx * 2, gradientMapWriteMeta.rampWeights[idx]);
  }
  writeCursor += 8;
  for (let idx = 0; idx < 4; idx++) {
    BinaryUtils.writeUint16(buf, writeCursor + idx * 2, gradientMapWriteMeta.rampPositions[idx]);
  }
  writeCursor += 8;
  writeCursor += 2;
  writtenSize = writeCursor - pos;
  return writtenSize;
}

function writeLayerTag_selc(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  writtenSize = SelectiveColorParser.serialize(buf, pos, sourceAdd[tag]);
  return writtenSize;
}

function writeLayerTag_FMsk(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeBytes(buf, pos, sourceAdd[tag]);
  writtenSize = sourceAdd[tag].length;
  return writtenSize;
}

function writeLayerTag_Txt2(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var treeBuf = new RenderBuffer,
    serializedLen = BinaryTreeParser.serialize(sourceAdd[tag].parsedTree, treeBuf),
    treeBytes = allocBuffer(serializedLen, true);
  for (let idx = 0; idx < serializedLen; idx++) treeBytes[idx] = treeBuf.data[idx];
  BinaryUtils.writeBytes(buf, pos, treeBytes);
  writtenSize = treeBytes.length;
  return writtenSize;
}

function writeLayerTag_vmsk(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var vmsk = sourceAdd[tag],
    vmskFlags = 0;
  BinaryUtils.writeSize(buf, pos, 3);
  if (!vmsk.enabled) vmskFlags += 1 << 1;
  if (!vmsk.isEnabled) vmskFlags += 1 << 2;
  BinaryUtils.writeSize(buf, pos + 4, vmskFlags);
  writtenSize = 8;
  var pathCount = vmsk.pathRecords.length;
  buf.ensureCapacity(pos + 8, pathCount * 26);
  PathRecordCodec.writePathPoints(buf.data, pos + 8, vmsk.pathRecords, context.width, context.height);
  writtenSize += pathCount * 26;
  return writtenSize;
}

function writeLayerTag_shmd(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, Object.keys(sourceAdd[tag]).length);
  var writePos = pos + 4;
  for (let shmdKey in sourceAdd[tag]) {
    BinaryUtils.writeAscii(buf, writePos, "8BIM");
    writePos += 4;
    BinaryUtils.writeAscii(buf, writePos, shmdKey);
    writePos += 4;
    BinaryUtils.writeSize(buf, writePos, 0);
    writePos += 4;
    BinaryUtils.writeSize(buf, writePos, 0);
    writePos += 4;
    BinaryUtils.writeSize(buf, writePos, 16);
    writePos += 4;
    var shmdWritten = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag][shmdKey], writePos);
    if (shmdWritten % 4 != 0) shmdWritten += 4 - shmdWritten % 4;
    BinaryUtils.writeSize(buf, writePos - 8, shmdWritten + 4);
    writePos += shmdWritten
  }
  writtenSize = writePos - pos;
  return writtenSize;
}

function writeLayerTag_TySh(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var writePos = pos;
  BinaryUtils.writeUint16(buf, writePos, 1);
  writePos += 2;
  var tySh = sourceAdd[tag],
    treeBuf = new RenderBuffer;
  tySh.engineData.DocumentResources = JSON.parse(JSON.stringify(tySh.engineData.ResourceDict));
  var serializedLen = EngineDataParser.serialize(tySh.engineData, treeBuf),
    treeBytes = allocBuffer(serializedLen, true);
  for (let idx = 0; idx < serializedLen; idx++) treeBytes[idx] = treeBuf.data[idx];
  tySh.textDescriptor.EngineData = {
    t: "tdta",
    v: treeBytes
  };
  var textContent = tySh.engineData.EngineDict.Editor.Text;
  tySh.textDescriptor.Txt.v = textContent.substring(0, textContent.length - 1);
  BinaryUtils.writeMatrix2D(buf, writePos, tySh.transform);
  writePos += 48;
  BinaryUtils.writeUint16(buf, writePos, 50);
  writePos += 2;
  BinaryUtils.writeSize(buf, writePos, 16);
  writePos += 4;
  writePos += DescriptorCodec.writeDescriptor(buf, tySh.textDescriptor, writePos);
  BinaryUtils.writeUint16(buf, writePos, 1);
  writePos += 2;
  BinaryUtils.writeSize(buf, writePos, 16);
  writePos += 4;
  writePos += DescriptorCodec.writeDescriptor(buf, tySh.warpDescriptor, writePos);
  BinaryUtils.writeFloat32Rect(buf, writePos, tySh.boundsRect);
  writePos += 16;
  writtenSize = writePos - pos;
  return writtenSize;
}

function writeLayerTag_lmfx(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 0);
  BinaryUtils.writeSize(buf, pos + 4, 16);
  var descriptor = JSON.parse(JSON.stringify(sourceAdd[tag])),
    hasEffects = false;
  normalizeLayerEffectsOnWrite(descriptor);
  for (let idx = 0; idx < LayerEffectDefs.effectKeys.length; idx++)
    if (descriptor[LayerEffectDefs.effectKeys[idx]] != null) hasEffects = true;
  BinaryUtils.writeAscii(buf, tagWritePos, hasEffects ? "lmfx" : "lfx2");
  writtenSize = DescriptorCodec.writeDescriptor(buf, descriptor, pos + 8) + 8;
  return writtenSize;
}

function writeLayerTag_Patt(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var writePos = PatternParser.writeEntries(buf, pos, sourceAdd[tag]);
  writtenSize = writePos - pos;
  return writtenSize;
}

function writeLayerTag_SoLd(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeAscii(buf, pos, "soLD");
  BinaryUtils.writeSize(buf, pos + 4, 4);
  BinaryUtils.writeSize(buf, pos + 8, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 12) + 12;
  return writtenSize;
}

function writeLayerTag_vstk_pths(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag], pos + 4) + 4;
  return writtenSize;
}

function writeLayerTag_vscgx(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeAscii(buf, pos, sourceAdd[tag].key);
  BinaryUtils.writeSize(buf, pos + 4, 16);
  writtenSize = DescriptorCodec.writeDescriptor(buf, sourceAdd[tag].value, pos + 8) + 8;
  return writtenSize;
}

function writeLayerTag_vogk(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  BinaryUtils.writeSize(buf, pos, 1);
  BinaryUtils.writeSize(buf, pos + 4, 16);
  assignKeyOriginIndices(sourceAdd[tag]);
  for (let idx = 0; idx < sourceAdd[tag].length; idx++) {
    var keyOriginRes = sourceAdd[tag][idx].v.keyOriginResolution;
    if (keyOriginRes) keyOriginRes.v = context.dpi
  }
  var vogkWrapper = {
    classID: "null",
    keyDescriptorList: {
      t: "VlLs",
      v: sourceAdd[tag]
    }
  };
  writtenSize = DescriptorCodec.writeDescriptor(buf, vogkWrapper, pos + 8) + 8;
  return writtenSize;
}

function writeLayerTag_lnkD_lnk2_lnk3(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var writeCursor = pos;
  for (let idx = 0; idx < sourceAdd[tag].length; idx++) {
    var linkItem = sourceAdd[tag][idx],
      blockStart = writeCursor;
    BinaryUtils.writeInt64BE(buf, writeCursor, 0);
    writeCursor += 8;
    BinaryUtils.writeAscii(buf, writeCursor, linkItem.type);
    writeCursor += 4;
    BinaryUtils.writeSize(buf, writeCursor, linkItem.descriptorVersion);
    writeCursor += 4;
    buf.ensureCapacity(writeCursor, 1);
    buf.data[writeCursor] = linkItem.tag.length;
    writeCursor++;
    BinaryUtils.writeAscii(buf, writeCursor, linkItem.tag);
    writeCursor += linkItem.tag.length;
    BinaryUtils.writeUnicodeString(buf, writeCursor, linkItem.fileName + "\0");
    writeCursor += 4 + linkItem.fileName.length * 2 + 2;
    BinaryUtils.writeAscii(buf, writeCursor, linkItem.fileTypeFourCC);
    writeCursor += 4;
    BinaryUtils.writeAscii(buf, writeCursor, linkItem.creatorFourCC);
    writeCursor += 4;
    BinaryUtils.writeInt64BE(buf, writeCursor, linkItem.raw.length);
    writeCursor += 8;
    buf.ensureCapacity(writeCursor, 1);
    buf.data[writeCursor] = linkItem.open;
    writeCursor++;
    BinaryUtils.writeBytes(buf, writeCursor, linkItem.raw);
    writeCursor += linkItem.raw.length;
    BinaryUtils.writeSize(buf, writeCursor, 1);
    writeCursor += 4;
    writeCursor += 11;
    var blockSize = writeCursor - blockStart - 8;
    BinaryUtils.writeInt64BE(buf, blockStart, blockSize);
    if (blockSize % 4 != 0) {
      buf.ensureCapacity(writeCursor, 4 - blockSize % 4);
      writeCursor += 4 - blockSize % 4
    }
  }
  writtenSize = writeCursor - pos;
  return writtenSize;
}

function writeLayerTag_FEid(ctx) {
  const { buf, pos, sourceAdd, tag, tagWritePos, context } = ctx;
  let writtenSize = 0;
  var writeCursor = pos;
  BinaryUtils.writeSize(buf, writeCursor, 3);
  writeCursor += 4;
  for (let feIdx = 0; feIdx < sourceAdd[tag].length; feIdx++) {
    var feEntry = sourceAdd[tag][feIdx];
    writeCursor += 4;
    var feBlockStart = writeCursor;
    writeCursor += 4;
    BinaryUtils.writePascalString(buf, writeCursor, feEntry.id);
    writeCursor += feEntry.id.length + 1;
    BinaryUtils.writeSize(buf, writeCursor, 1);
    writeCursor += 4;
    writeCursor += 4;
    var feHdrPos = writeCursor;
    writeCursor += 4;
    BinaryUtils.writePsdRect(buf, writeCursor, feEntry.rect);
    writeCursor += 16;
    BinaryUtils.writeSize(buf, writeCursor, 8);
    writeCursor += 4;
    BinaryUtils.writeSize(buf, writeCursor, 24);
    writeCursor += 4;
    var planarBuf = new PlanarRgbaBuffer(feEntry.rect.area());
    interleavedToPlanar(feEntry.buffer, planarBuf);
    for (let idx = 0; idx < 24 + 2; idx++) {
      var channelBuf = null;
      if (idx == 0) channelBuf = planarBuf.h;
      if (idx == 1) channelBuf = planarBuf.l;
      if (idx == 2) channelBuf = planarBuf.O;
      if (idx == 25) channelBuf = planarBuf.w;
      BinaryUtils.writeSize(buf, writeCursor, channelBuf != null ? 1 : 0);
      writeCursor += 4;
      if (channelBuf != null) {
        writeCursor += 4;
        var chWritePos = writeCursor;
        writeCursor += 4;
        buf.ensureCapacity(writeCursor, feEntry.rect.area() + 2);
        writeCursor = ChannelImageCodec.writeChannelBuffer(true, channelBuf, buf.data, feEntry.rect.width, feEntry.rect.height, writeCursor, 3);
        BinaryUtils.writeSize(buf, chWritePos, writeCursor - (chWritePos + 4))
      }
    }
    BinaryUtils.writeSize(buf, feHdrPos, writeCursor - (feHdrPos + 4));
    buf.ensureCapacity(writeCursor, 1);
    buf.data[writeCursor] = feEntry.d ? 1 : 0;
    writeCursor++;
    if (feEntry.d != null) {
      var maskRect = feEntry.d.rect,
        maskChannel = feEntry.d.channel;
      maskRect = feEntry.rect;
      maskChannel = allocBuffer(maskRect.area());
      maskChannel.fill(feEntry.d.color);
      copyChannel(feEntry.d.channel, feEntry.d.rect, maskChannel, maskRect);
      BinaryUtils.writePsdRect(buf, writeCursor, maskRect);
      writeCursor += 16;
      writeCursor += 4;
      var maskWritePos = writeCursor;
      writeCursor += 4;
      buf.ensureCapacity(writeCursor, maskRect.area() + 2);
      writeCursor = ChannelImageCodec.writeChannelBuffer(true, maskChannel, buf.data, maskRect.width, maskRect.height, writeCursor, 3);
      BinaryUtils.writeSize(buf, maskWritePos, writeCursor - (maskWritePos + 4))
    }
    var blockSize = writeCursor - (feBlockStart + 4);
    BinaryUtils.writeSize(buf, feBlockStart, blockSize);
    if (blockSize % 4 != 0) writeCursor += 4 - blockSize % 4
  }
  writtenSize = writeCursor - pos;
  return writtenSize;
}

const WRITE_LAYER_TAG_HANDLERS = {
  "iOpa": writeLayerTag_iOpa,
  "brst": writeLayerTag_brst,
  "knko": writeLayerTag_knko,
  "infx": writeLayerTag_infx,
  "clbl": writeLayerTag_clbl,
  "lmgm": writeLayerTag_lmgm,
  "vmgm": writeLayerTag_vmgm,
  "lyid": writeLayerTag_lyid,
  "lsct": writeLayerTag_lsct,
  "lyvr": writeLayerTag_lyvr,
  "lnsr": writeLayerTag_lnsr,
  "lspf": writeLayerTag_lspf,
  "lclr": writeLayerTag_lclr,
  "luni": writeLayerTag_luni,
  "fxrp": writeLayerTag_fxrp,
  "phry": writeLayerTag_phry_artb_artd,
  "artb": writeLayerTag_phry_artb_artd,
  "artd": writeLayerTag_phry_artb_artd,
  "SoCo": writeLayerTag_SoCo,
  "GdFl": writeLayerTag_GdFl,
  "PtFl": writeLayerTag_PtFl,
  "CgEd": writeLayerTag_CgEd,
  "brit": writeLayerTag_brit,
  "levl": writeLayerTag_levl,
  "curv": writeLayerTag_curv,
  "expA": writeLayerTag_expA,
  "vibA": writeLayerTag_vibA,
  "hue2": writeLayerTag_hue2,
  "blnc": writeLayerTag_blnc,
  "blwh": writeLayerTag_blwh,
  "phfl": writeLayerTag_phfl,
  "mixr": writeLayerTag_mixr,
  "clrL": writeLayerTag_clrL_rplc,
  "rplc": writeLayerTag_clrL_rplc,
  "nvrt": writeLayerTag_nvrt,
  "post": writeLayerTag_post,
  "thrs": writeLayerTag_thrs,
  "grdm": writeLayerTag_grdm,
  "selc": writeLayerTag_selc,
  "FMsk": writeLayerTag_FMsk,
  "Txt2": writeLayerTag_Txt2,
  "vmsk": writeLayerTag_vmsk,
  "shmd": writeLayerTag_shmd,
  "TySh": writeLayerTag_TySh,
  "lmfx": writeLayerTag_lmfx,
  "Patt": writeLayerTag_Patt,
  "SoLd": writeLayerTag_SoLd,
  "vstk": writeLayerTag_vstk_pths,
  "pths": writeLayerTag_vstk_pths,
  "vscg__": writeLayerTag_vscgx,
  "vogk": writeLayerTag_vogk,
  "lnkD": writeLayerTag_lnkD_lnk2_lnk3,
  "lnk2": writeLayerTag_lnkD_lnk2_lnk3,
  "lnk3": writeLayerTag_lnkD_lnk2_lnk3,
  "FEid": writeLayerTag_FEid,
};

function writeLayerInfoTag(ctx) {
  const handler = WRITE_LAYER_TAG_HANDLERS[ctx.tag];
  if (!handler) {
    console.log("unknown layer tag: " + ctx.tag + ", size: 0");
    return { skipBlock: true };
  }
  const writtenSize = handler(ctx);
  return { writtenSize };
}

/**
 * Parse Photoshop additional layer information blocks (8BIM / 8B64) into `targetAdd`.
 * @returns {number} byte offset after the last block
 */
function parseAdditionalLayerInfo(data, pos, endPos, targetAdd, isPSB, context) {
  while (pos < endPos) {
    const blockSignature = BinaryUtils.readString(data, pos, 4);
    pos += 4;
    if (blockSignature !== "8BIM" && blockSignature !== "8B64") {
      console.log("layer information signature error! " + blockSignature, "PSB = " + isPSB);
      alert("Error in PSD file: wrong signature.");
      return endPos;
    }
    const tag = BinaryUtils.readString(data, pos, 4);
    pos += 4;
    let chunkSize = BinaryUtils.readUint32BE(data, pos);
    pos += 4;
    const usesExtendedSize = usesPsbExtendedSize(tag, isPSB);
    if (usesExtendedSize) {
      chunkSize = (chunkSize << 32) | BinaryUtils.readInt32BE(data, pos);
      pos += 4;
    }
    if (SKIP_ON_READ_TAGS.has(tag)) {
      if (chunkSize % 4 !== 0) chunkSize += 4 - (chunkSize % 4);
      pos += chunkSize;
      continue;
    }
    const readCtx = { data, pos, chunkSize, targetAdd, isPSB, context, tag };
    readLayerInfoTag(readCtx);
    chunkSize = readCtx.chunkSize;
    if (!READ_PAD_EXEMPT_TAGS.has(tag) && chunkSize % 4 !== 0) {
      console.log("size not multiple of 4!!!", tag);
    }
    if (tag !== "luni" && tag !== "TySh" && tag !== "tySh" && tag !== "lfx2") {
      if (chunkSize % 4 !== 0 && pos + chunkSize < endPos) chunkSize += 4 - (chunkSize % 4);
    }
    if (pos + chunkSize > endPos) chunkSize = endPos - pos;
    pos += chunkSize;
  }
  return pos;
}

/**
 * Serialize `sourceAdd` additional layer information into `buf`.
 * @returns {number} byte offset after the last block
 */
function writeAdditionalLayerInfo(buf, pos, sourceAdd, isPSB, context) {
  for (const tag in sourceAdd) {
    if (sourceAdd[tag] == null) {
      alert("A bug occured (see console).");
      console.log('Please, report a bug, that "' + tag + '" tag was present with a null value.');
      delete sourceAdd[tag];
    }
  }
  for (const tag in sourceAdd) {
    const usesExtendedSize = usesPsbExtendedSize(tag, isPSB);
    BinaryUtils.writeAscii(buf, pos, usesExtendedSize ? "8B64" : "8BIM");
    pos += 4;
    const tagWritePos = pos;
    BinaryUtils.writeAscii(buf, pos, tag);
    pos += 4;
    BinaryUtils.writeInt32(buf, pos, 0);
    pos += usesExtendedSize ? 8 : 4;
    const writeCtx = { buf, pos, sourceAdd, tag, tagWritePos, context };
    const result = writeLayerInfoTag(writeCtx);
    if (result.skipBlock) {
      pos -= 12;
      continue;
    }
    let writtenSize = result.writtenSize;
    if (!WRITE_UNPADDED_TAGS.has(tag) && writtenSize % 4 !== 0) {
      writtenSize += 4 - (writtenSize % 4);
    }
    if (usesExtendedSize) BinaryUtils.writeInt64BE(buf, pos - 8, writtenSize);
    else BinaryUtils.writeSize(buf, pos - 4, writtenSize);
    if (tag !== "luni" && tag !== "TySh" && writtenSize % 4 !== 0) {
      writtenSize += 4 - (writtenSize % 4);
    }
    pos += writtenSize;
  }
  return pos;
}

const PSDResourceParser = {
  parseAdditionalLayerInfo,
  writeAdditionalLayerInfo,
  layerRecordHandler() {},
  clone: cloneLayerAdditionalValue,
};

// External call sites read these aliases on PSDResourceParser (trackers, action descriptors).
PSDResourceParser.mV = normalizeLayerEffectsOnRead;
PSDResourceParser.Wm = normalizeLayerEffectsOnWrite;
PSDResourceParser.b$ = applyGradientFillDefaults;

export { PSDResourceParser };
