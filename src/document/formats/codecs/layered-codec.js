/**
 * Layered document codecs: PSD, PXD, Sketch, XD, Figma, XCF, Fireworks (FPNG), PDN.
 * Each export is `{ encode?, decode?, isLayered? }`; wired in `file-format-registry.js`.
 */

import { TextEngineData } from "../../../features/text/text-engine.js";
import { Rect } from "../../../core/math/rect.js";
import { Matrix2D } from "../../../core/math/matrix2d.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { BlendModes } from "../../model/blend-modes.js";
import { RenderBuffer } from "../../../core/render-buffer.js";
import { codecLoaders } from "../registry/registry-helpers.js";
import { LayerEffectDefs } from "../psd/effect-defs.js";
import { Layer } from "../../model/layer.js";
import { Mask } from "../../model/layer-masks.js";
import { allocBuffer } from "../../../engine/compositing/buffer-utils.js";
import { toRGBDesc } from "../../../engine/compositing/psd-color-utils.js";

/* global pako */

// ---------------------------------------------------------------------------
// PXD (Pixelmator-style layered) decode
// ---------------------------------------------------------------------------

const PXD_BLEND_MODES =
  "norm,lddg,norm,dark,diff,norm,hLit,norm,norm,lite,mul ,over,scrn,fsub".split(",");

/** Maps PXD effect type bytes to LayerEffectDefs index slots. */
const PXD_EFFECT_TYPE_TO_DEF_INDEX = {
  102: 9,
  101: 2,
  103: 0,
  104: 3,
  105: 8,
};

/**
 * Builds a TySh text layer from PXD v4+ embedded JSON.
 * @returns {number} updated read offset
 */
function applyPxdModernTextLayer(layer, inflatedBytes, readOffset, textJsonLength) {
  if (textJsonLength === 0) return readOffset;
  var textPayload = JSON.parse(BinaryUtils.readUtf8(inflatedBytes, readOffset, textJsonLength));
  readOffset += textJsonLength;
  var textContent = textPayload.text;
  var textSettings = textPayload.textSettings;
  var fontName = textSettings.font;
  var fontSize = textSettings.size;
  var textPadding = textSettings.padding;
  var textColorPacked = parseInt(textSettings.color.slice(1), 16);
  layer.add.lnsr = "rend";
  layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
  layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
  layer.add.TySh.transform = new Matrix2D(1, 0, 0, 1, layer.rect.x + textPadding, layer.rect.y + textPadding);
  var engineData = layer.add.TySh.engineData;
  TextEngineData.setTextType(engineData, 1);
  TextEngineData.setBoxBounds(engineData, [0, 0, layer.rect.width - textPadding * 2, layer.rect.height]);
  TextEngineData.insertText(engineData, 0, textContent);
  var styleRun = TextEngineData.getTextStyle(engineData, 0, 1);
  styleRun.textStyle.FontSize = fontSize;
  styleRun.textStyle.FillColor = {
    Type: 1,
    Values: [1, (textColorPacked >>> 16 & 255) / 255, (textColorPacked >>> 8 & 255) / 255, (textColorPacked >>> 0 & 255) / 255],
  };
  if (textSettings.bold) fontName += "-Bold";
  TextEngineData.setTextFont(styleRun, fontName);
  styleRun.paraStyle.Justification = ["left", "right", "center"].indexOf(textSettings.align);
  TextEngineData.applyStyle(engineData, 0, textContent.length, styleRun);
  return readOffset;
}

/**
 * Reads PXD layer-effect chunks into `layer.add.lmfx`.
 * @returns {number} updated read offset
 */
function applyPxdLayerEffects(layer, inflatedBytes, readOffset, effectCount) {
  if (effectCount === 0) return readOffset;
  var effectsRoot = LayerEffectDefs.createLmfxRootTemplate();
  layer.add.lmfx = effectsRoot;
  for (var effectSlotIndex = 0; effectSlotIndex < LayerEffectDefs.order.length; effectSlotIndex++) {
    effectsRoot[LayerEffectDefs.effectKeys[effectSlotIndex]] = { t: "VlLs", v: [] };
  }
  for (var effectIndex = 0; effectIndex < effectCount; effectIndex++) {
    var effectChunkLength = BinaryUtils.readUint16(inflatedBytes, readOffset);
    var effectChunkEnd = readOffset + effectChunkLength + 4;
    var effectTypeByte = inflatedBytes[readOffset + 2];
    readOffset += 3;
    var effectDefIndex = PXD_EFFECT_TYPE_TO_DEF_INDEX[effectTypeByte + ""];
    var effectDescriptorDefaults = LayerEffectDefs.getEffectDefaultByOrderIndex(effectDefIndex);
    effectsRoot[LayerEffectDefs.effectKeys[effectDefIndex]].v.push({ t: "Objc", v: effectDescriptorDefaults });
    if (effectDefIndex !== 0) {
      effectDescriptorDefaults.Md.v.blendMode = BlendModes.toPSD("norm");
      effectDescriptorDefaults.Opct.v.val = inflatedBytes[readOffset];
      readOffset++;
      if (effectDefIndex === 9 || effectDefIndex === 2) {
        effectDescriptorDefaults.Dstn.v.val = inflatedBytes[readOffset + 1];
        readOffset += 2;
      } else {
        readOffset += 2;
      }
      effectDescriptorDefaults.blur.v.val = Math.round(inflatedBytes[readOffset] * 1.2);
      readOffset++;
      if (effectDefIndex === 9 || effectDefIndex === 2) {
        effectDescriptorDefaults.uglg.v = false;
        effectDescriptorDefaults.lagl.v.val = 180 - BinaryUtils.readUint16(inflatedBytes, readOffset);
        readOffset += 2;
      }
      effectDescriptorDefaults.Clr.v = toRGBDesc({
        h: inflatedBytes[readOffset + 1],
        l: inflatedBytes[readOffset + 2],
        O: inflatedBytes[readOffset + 3],
      });
    } else {
      effectDescriptorDefaults.hglM.v.blendMode = effectDescriptorDefaults.sdwM.v.blendMode = BlendModes.toPSD("norm");
      readOffset += 2;
      var bevelHighlightSize = inflatedBytes[readOffset++];
      var bevelShadowSize = inflatedBytes[readOffset++];
      effectDescriptorDefaults.blur.v.val = Math.round(Math.sqrt(bevelShadowSize * bevelHighlightSize) * 1.3);
      effectDescriptorDefaults.srgR.v.val = Math.round(100 * bevelHighlightSize / bevelShadowSize);
      effectDescriptorDefaults.uglg.v = false;
      effectDescriptorDefaults.lagl.v.val = 180 - BinaryUtils.readUint16(inflatedBytes, readOffset);
      readOffset += 2;
      effectDescriptorDefaults.hglO.v.val = inflatedBytes[readOffset++];
      effectDescriptorDefaults.hglC.v = toRGBDesc({
        h: inflatedBytes[readOffset + 1],
        l: inflatedBytes[readOffset + 2],
        O: inflatedBytes[readOffset + 3],
      });
      readOffset += 4;
      effectDescriptorDefaults.sdwO.v.val = inflatedBytes[readOffset++];
      effectDescriptorDefaults.sdwC.v = toRGBDesc({
        h: inflatedBytes[readOffset + 1],
        l: inflatedBytes[readOffset + 2],
        O: inflatedBytes[readOffset + 3],
      });
      readOffset += 4;
    }
    readOffset = effectChunkEnd;
  }
  return readOffset;
}

/**
 * Parses the pre-v4 PXD text tail when the layer block length did not match.
 * @returns {number} updated read offset
 */
function applyPxdLegacyTextTail(layer, inflatedBytes, readOffset) {
  var legacyTextFlags = BinaryUtils.readUint32BE(inflatedBytes, readOffset);
  var legacyTextJustification = 0;
  readOffset += 4;
  readOffset++;
  var legacyNameLength = BinaryUtils.readUint16(inflatedBytes, readOffset);
  readOffset += 2;
  var legacyTextContent = BinaryUtils.readUtf8(inflatedBytes, readOffset, legacyNameLength);
  readOffset += legacyNameLength;
  legacyTextContent = legacyTextContent.replace(/\r/g, "\n");
  var legacyFontNameLength = BinaryUtils.readUint16(inflatedBytes, readOffset);
  readOffset += 2;
  var legacyFontName = BinaryUtils.readUtf8(inflatedBytes, readOffset, legacyFontNameLength);
  readOffset += legacyFontNameLength;
  var legacyFontSize = BinaryUtils.readUint16(inflatedBytes, readOffset);
  readOffset += 2;
  var legacyTextLeft = layer.rect.x;
  var legacyTextWidth = layer.rect.width;
  if (legacyTextFlags & 4) legacyTextJustification = 1;
  if (legacyTextFlags & 2) legacyTextJustification = 2;
  var outlinePadding = Math.round(legacyFontSize * 0.4);
  if (legacyTextJustification === 0 || legacyTextJustification === 2) legacyTextWidth += outlinePadding;
  if (legacyTextJustification === 1 || legacyTextJustification === 2) {
    legacyTextWidth += outlinePadding;
    legacyTextLeft -= outlinePadding;
  }
  layer.add.lnsr = "rend";
  layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
  layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
  layer.add.TySh.transform = new Matrix2D(1, 0, 0, 1, legacyTextLeft, layer.rect.y + legacyFontSize * 0.25);
  var legacyEngineData = layer.add.TySh.engineData;
  TextEngineData.setTextType(legacyEngineData, 1);
  TextEngineData.setBoxBounds(legacyEngineData, [0, 0, legacyTextWidth, layer.rect.height]);
  TextEngineData.insertText(legacyEngineData, 0, legacyTextContent);
  var legacyStyleRun = TextEngineData.getTextStyle(legacyEngineData, 0, 1);
  legacyStyleRun.textStyle.FontSize = legacyFontSize;
  legacyStyleRun.textStyle.FillColor = {
    Type: 1,
    Values: [1, inflatedBytes[readOffset + 1] / 255, inflatedBytes[readOffset + 2] / 255, inflatedBytes[readOffset + 3] / 255],
  };
  readOffset += 4;
  if (inflatedBytes[readOffset + 5]) legacyFontName += "-Bold";
  if (inflatedBytes[readOffset + 6]) legacyFontName += "-Italic";
  TextEngineData.setTextFont(legacyStyleRun, legacyFontName);
  legacyStyleRun.paraStyle.Justification = legacyTextJustification;
  readOffset += 8;
  TextEngineData.applyStyle(legacyEngineData, 0, legacyTextContent.length, legacyStyleRun);
  return readOffset;
}

/** Inflates and parses a PXD buffer into document layers. */
function decodePxdDocument(buffer, doc) {
  var inflatedBytes = pako.inflate(new Uint8Array(buffer));
  var formatVersion = BinaryUtils.readUint16(inflatedBytes, 0);
  var blockOffset = 4;
  doc.width = BinaryUtils.readUint32BE(inflatedBytes, blockOffset);
  blockOffset += 4;
  doc.height = BinaryUtils.readUint32BE(inflatedBytes, blockOffset);
  blockOffset += 4;
  doc.buffer = allocBuffer(doc.width * doc.height * 4);
  var layerCount = BinaryUtils.readUint16(inflatedBytes, blockOffset);
  blockOffset += 2;
  blockOffset += 4;
  for (var layerIndex = 0; layerIndex < layerCount; layerIndex++) {
    var layer = doc.newLayer();
    var channelOffsetR = 1;
    var channelOffsetG = 2;
    var channelOffsetB = 3;
    var channelOffsetA = 0;
    doc.layers.push(layer);
    var layerBlockLength = BinaryUtils.readUint32BE(inflatedBytes, blockOffset);
    blockOffset += 4;
    var readOffset = blockOffset;
    var nameLength = BinaryUtils.readUint16(inflatedBytes, readOffset);
    readOffset += 2;
    var layerName = BinaryUtils.readUtf8(inflatedBytes, readOffset, nameLength);
    readOffset += nameLength;
    layer.setName(layerName);
    readOffset++;
    layer.rect.x = BinaryUtils.readInt32BE(inflatedBytes, readOffset);
    readOffset += 4;
    layer.rect.y = BinaryUtils.readInt32BE(inflatedBytes, readOffset);
    readOffset += 4;
    layer.rect.width = BinaryUtils.readUint32BE(inflatedBytes, readOffset);
    readOffset += 4;
    layer.rect.height = BinaryUtils.readUint32BE(inflatedBytes, readOffset);
    readOffset += 4;
    if (formatVersion > 3) readOffset += 4;
    layer.Opct = Math.round(255 * inflatedBytes[readOffset] / 100);
    readOffset++;
    layer.setVisible(inflatedBytes[readOffset] !== 0);
    readOffset++;
    layer.blendMode = PXD_BLEND_MODES[inflatedBytes[readOffset]];
    readOffset++;
    readOffset++;
    if (formatVersion > 3) {
      var textJsonLength = BinaryUtils.readUint16(inflatedBytes, readOffset);
      readOffset += 2;
      readOffset = applyPxdModernTextLayer(layer, inflatedBytes, readOffset, textJsonLength);
    }
    var pixelByteLength = BinaryUtils.readUint32BE(inflatedBytes, readOffset);
    readOffset += 4;
    if (pixelByteLength !== layer.rect.area() * 4) throw "pdn: layer pixel byte length mismatch";
    layer.buffer = allocBuffer(pixelByteLength);
    if (formatVersion > 3) {
      channelOffsetR = 0;
      channelOffsetG = 1;
      channelOffsetB = 2;
      channelOffsetA = 3;
    }
    for (var pixelIndex = 0; pixelIndex < pixelByteLength; pixelIndex += 4) {
      layer.buffer[pixelIndex] = inflatedBytes[readOffset + pixelIndex + channelOffsetR];
      layer.buffer[pixelIndex + 1] = inflatedBytes[readOffset + pixelIndex + channelOffsetG];
      layer.buffer[pixelIndex + 2] = inflatedBytes[readOffset + pixelIndex + channelOffsetB];
      layer.buffer[pixelIndex + 3] = inflatedBytes[readOffset + pixelIndex + channelOffsetA];
    }
    readOffset += pixelByteLength;
    var maskByteLength = BinaryUtils.readUint32BE(inflatedBytes, readOffset);
    readOffset += 4;
    if (maskByteLength === 0 && formatVersion > 3) {
      blockOffset += layerBlockLength;
      continue;
    }
    var effectCount = inflatedBytes[readOffset];
    readOffset++;
    readOffset += 2;
    if (maskByteLength !== 0) {
      layer.d = new Mask();
      layer.d.rect = layer.rect.clone();
      layer.d.channel = allocBuffer(layer.rect.area());
      for (var maskPixelIndex = 0; maskPixelIndex < maskByteLength; maskPixelIndex += 4) {
        layer.d.channel[maskPixelIndex >>> 2] = inflatedBytes[readOffset + maskPixelIndex + 1];
      }
      readOffset += maskByteLength;
    }
    readOffset = applyPxdLayerEffects(layer, inflatedBytes, readOffset, effectCount);
    if (readOffset - blockOffset !== layerBlockLength) {
      readOffset = applyPxdLegacyTextTail(layer, inflatedBytes, readOffset);
    }
    blockOffset += layerBlockLength;
  }
}

// ---------------------------------------------------------------------------
// PDN (Paint.NET) binary serializer decode
// ---------------------------------------------------------------------------

const PDN_TYPE_BOOLEAN = 0;
const PDN_TYPE_INT8 = 1;
const PDN_TYPE_INT16 = 2;
const PDN_TYPE_STRING = 3;
const PDN_TYPE_STRUCT = 4;
const PDN_TYPE_ARRAY = 5;
const PDN_TYPE_VOID = 6;
const PDN_FIELD_BOOL = 1;
const PDN_FIELD_BYTE = 2;
const PDN_FIELD_INT32 = 7;
const PDN_FIELD_INT64 = 8;
const PDN_FIELD_PAIR = 9;

/** @typedef {{ byteView: Uint8Array, readOffset: number, structTypeRegistry: Record<string, object>, objectRegistry: Record<string, unknown>, pendingRefRegistry: Record<string, boolean> }} PdnParseState */

/** @returns {PdnParseState} */
function createPdnParseState(buffer) {
  return {
    byteView: new Uint8Array(buffer),
    readOffset: 0,
    structTypeRegistry: {},
    objectRegistry: {},
    pendingRefRegistry: {},
  };
}

/** @param {PdnParseState} state */
function pdnReadInt32Le(state) {
  var value = BinaryUtils.readInt32LE(state.byteView, state.readOffset);
  state.readOffset += 4;
  return value;
}

/** @param {PdnParseState} state */
function pdnReadVarUInt(state) {
  var value = 0;
  var shift = 0;
  for (var byteIndex = 0; byteIndex < 5; byteIndex++) {
    var chunkByte = state.byteView[state.readOffset++];
    value += (chunkByte & 127) << shift;
    shift += 7;
    if ((chunkByte & 128) === 0) break;
  }
  return value;
}

/** @param {PdnParseState} state */
function pdnReadUtf8String(state) {
  var byteLength = pdnReadVarUInt(state);
  var text = BinaryUtils.readUtf8(state.byteView, state.readOffset, byteLength);
  state.readOffset += byteLength;
  return text;
}

/** @param {PdnParseState} state */
function pdnReadInlineTypeDef(state) {
  return { typeName: pdnReadUtf8String(state), fieldCount: pdnReadInt32Le(state) };
}

/** @param {PdnParseState} state */
function pdnReadStructTypeDef(state) {
  var structId = pdnReadInt32Le(state);
  var typeName = pdnReadUtf8String(state);
  var fieldDefs = [];
  var fieldDefCount = pdnReadInt32Le(state);
  for (var fieldDefIndex = 0; fieldDefIndex < fieldDefCount; fieldDefIndex++) {
    fieldDefs.push([pdnReadUtf8String(state)]);
  }
  return { id: structId, typeName: typeName, fieldDefs: fieldDefs };
}

/** @param {PdnParseState} state @param {ReturnType<typeof pdnReadStructTypeDef>} structDef */
function pdnHydrateStructFieldTypes(state, structDef) {
  var fieldDefs = structDef.fieldDefs;
  for (var fieldIndex = 0; fieldIndex < fieldDefs.length; fieldIndex++) {
    fieldDefs[fieldIndex].push(state.byteView[state.readOffset++]);
  }
  for (var fieldIndex = 0; fieldIndex < fieldDefs.length; fieldIndex++) {
    var fieldTypeId = fieldDefs[fieldIndex][1];
    fieldDefs[fieldIndex].push(pdnReadScalarValue(state, fieldTypeId));
  }
}

/** @param {PdnParseState} state */
function pdnReadScalarValue(state, typeId) {
  var value;
  if (typeId === PDN_TYPE_BOOLEAN) value = state.byteView[state.readOffset++];
  else if (typeId === PDN_TYPE_STRING) value = pdnReadUtf8String(state);
  else if (typeId === PDN_TYPE_STRUCT) value = pdnReadInlineTypeDef(state);
  else if (typeId === PDN_TYPE_INT8 || typeId === PDN_TYPE_INT16 || typeId === PDN_TYPE_VOID || typeId === PDN_TYPE_ARRAY) {
  } else throw typeId;
  return value;
}

/** @param {PdnParseState} state */
function pdnReadTypedFieldValue(state, typeId, fieldKind, depth) {
  var value;
  if (typeId === PDN_TYPE_BOOLEAN) {
    if (fieldKind === PDN_FIELD_BOOL) value = state.byteView[state.readOffset++] === 1;
    else if (fieldKind === PDN_FIELD_BYTE) value = state.byteView[state.readOffset++];
    else if (fieldKind === PDN_FIELD_INT64) value = pdnReadInt32Le(state);
    else if (fieldKind === PDN_FIELD_PAIR) {
      value = pdnReadInt32Le(state);
      pdnReadInt32Le(state);
    } else throw fieldKind;
  } else if (typeId === PDN_TYPE_STRING || typeId === PDN_TYPE_STRUCT || typeId === PDN_TYPE_ARRAY || typeId === PDN_TYPE_INT8 || typeId === PDN_TYPE_VOID) {
    value = pdnReadSerializedValue(state, depth + 1);
  } else throw typeId;
  return value;
}

/** @param {PdnParseState} state */
function pdnInstantiateStruct(state, structId, depth) {
  var structDef = state.structTypeRegistry["c" + structId];
  var fieldDefs = structDef.fieldDefs;
  var instance = { _class: structDef.typeName };
  for (var fieldIndex = 0; fieldIndex < fieldDefs.length; fieldIndex++) {
    var fieldDef = fieldDefs[fieldIndex];
    var fieldTypeId = fieldDef[1];
    var fieldKind = fieldDef[2];
    var fieldValue = pdnReadTypedFieldValue(state, fieldTypeId, fieldKind, depth);
    var fieldName = fieldDef[0];
    instance[fieldName] = fieldValue;
  }
  return instance;
}

/** @param {PdnParseState} state */
function pdnReadValueList(state, itemCount, typeId, fieldKind, depth) {
  var values = [];
  for (var itemIndex = 0; itemIndex < itemCount; itemIndex++) {
    var itemValue = pdnReadTypedFieldValue(state, typeId, fieldKind, depth);
    if (itemValue.markerTag && itemValue.markerTag === "null_count") {
      var nullRunLength = itemValue.markerPayload;
      for (var nullIndex = 0; nullIndex < nullRunLength; nullIndex++) values.push(null);
      itemIndex += nullRunLength - 1;
    } else values.push(itemValue);
  }
  return values;
}

/** @param {PdnParseState} state */
function pdnReadTypeCountPair(state) {
  return [pdnReadInt32Le(state), pdnReadInt32Le(state)];
}

/** @param {PdnParseState} state */
function pdnReadSerializedValue(state, depth) {
  if (depth == null) throw "pdn: missing recursion depth";
  var value = null;
  var tagByte = state.byteView[state.readOffset];
  var objectId = null;
  state.readOffset++;
  if (tagByte === 0) {
    value = [pdnReadInt32Le(state), pdnReadInt32Le(state), pdnReadInt32Le(state), pdnReadInt32Le(state)];
  } else if (tagByte === 1) {
    objectId = pdnReadInt32Le(state);
    var structId = pdnReadInt32Le(state);
    value = pdnInstantiateStruct(state, structId, depth);
  } else if (tagByte === 4) {
    var structDefInline = pdnReadStructTypeDef(state);
    objectId = structDefInline.id;
    pdnHydrateStructFieldTypes(state, structDefInline);
    state.structTypeRegistry["c" + structDefInline.id] = structDefInline;
    value = pdnInstantiateStruct(state, structDefInline.id, depth);
  } else if (tagByte === 5) {
    var structDefExtended = pdnReadStructTypeDef(state);
    objectId = structDefExtended.id;
    pdnHydrateStructFieldTypes(state, structDefExtended);
    pdnReadInt32Le(state);
    state.structTypeRegistry["c" + structDefExtended.id] = structDefExtended;
    value = pdnInstantiateStruct(state, structDefExtended.id, depth);
  } else if (tagByte === 6) {
    objectId = pdnReadInt32Le(state);
    value = pdnReadUtf8String(state);
  } else if (tagByte === 7) {
    objectId = pdnReadInt32Le(state);
    var arrayHeaderByte = state.byteView[state.readOffset++];
    if (arrayHeaderByte !== 0) throw arrayHeaderByte;
    var arrayKind = pdnReadInt32Le(state);
    if (arrayKind !== 1) throw arrayKind;
    var arrayLength = pdnReadInt32Le(state);
    var elementTypeId = state.byteView[state.readOffset++];
    var elementFieldKind = pdnReadScalarValue(state, elementTypeId);
    value = pdnReadValueList(state, arrayLength, elementTypeId, elementFieldKind, depth);
  } else if (tagByte === 9) {
    var refId = pdnReadInt32Le(state);
    value = { markerTag: "ref", markerPayload: refId };
    state.pendingRefRegistry["o" + refId] = true;
  } else if (tagByte === 10) {
    value = { markerTag: "null_count", markerPayload: 1 };
  } else if (tagByte === 11) {
    value = { markerTag: "end" };
  } else if (tagByte === 12) {
    pdnReadInt32Le(state);
    pdnReadUtf8String(state);
  } else if (tagByte === 13) {
    var nullCountByte = state.byteView[state.readOffset++];
    value = { markerTag: "null_count", markerPayload: nullCountByte };
  } else if (tagByte === 16) {
    var structArrayHeader = pdnReadTypeCountPair(state);
    objectId = structArrayHeader[0];
    value = pdnReadValueList(state, structArrayHeader[1], PDN_TYPE_STRUCT, null, depth);
  } else if (tagByte === 17) {
    var int8ArrayHeader = pdnReadTypeCountPair(state);
    objectId = int8ArrayHeader[0];
    value = pdnReadValueList(state, int8ArrayHeader[1], PDN_TYPE_INT8, null, depth);
  } else throw "pdn: unknown serialized type tag";
  if (objectId != null && objectId > 0) {
    if (state.objectRegistry["o" + objectId] != null) throw "pdn: duplicate object id";
    state.objectRegistry["o" + objectId] = value;
  }
  return value;
}

/** @param {unknown} node @param {Record<string, unknown>} refTable */
function pdnResolveMarkerRef(node, refTable) {
  if (node && node.markerTag && node.markerTag === "ref") return refTable["o" + node.markerPayload];
  return node;
}

/** @param {unknown} node @param {Record<string, unknown>} refTable */
function pdnResolveObjectRefsDeep(node, refTable) {
  if (node instanceof Array) {
    for (var nodeIndex = 0; nodeIndex < node.length; nodeIndex++) {
      node[nodeIndex] = pdnResolveMarkerRef(node[nodeIndex], refTable);
    }
  } else if (node instanceof Object) {
    for (var propertyName in node) node[propertyName] = pdnResolveMarkerRef(node[propertyName], refTable);
  }
}

/** @param {PdnParseState} state */
function pdnReadDeflatedTileChunk(state) {
  var tileIndex = BinaryUtils.readUint32BE(state.byteView, state.readOffset);
  state.readOffset += 4;
  var chunkByteLength = BinaryUtils.readUint32BE(state.byteView, state.readOffset);
  state.readOffset += 4;
  var inflatedTileBytes = pako.inflateRaw(state.byteView.slice(state.readOffset + 10));
  state.readOffset += chunkByteLength;
  return [tileIndex, inflatedTileBytes];
}

const PDN_BLEND_MODE_TOKEN_TO_PSD = {
  Normal: "norm",
  Multiply: "mul ",
  Additive: "lddg",
  ColorBurn: "idiv",
  ColorDodge: "div ",
  Reflect: "lddg",
  Glow: "hMix",
  Overlay: "over",
  Difference: "diff",
  Negation: "smud",
  Lighten: "lite",
  Darken: "dark",
  Screen: "scrn",
  Xor: "smud",
};

/** Parses a Paint.NET PDN3 document into layers. */
function decodePdnDocument(buffer, doc, unusedParam) {
  var state = createPdnParseState(buffer);
  var magic = BinaryUtils.readString(state.byteView, 0, 4);
  if (magic !== "PDN3") throw magic;
  state.readOffset += 4;
  var headerNameLength = BinaryUtils.readUint16LE(state.byteView, state.readOffset) + state.byteView[state.readOffset + 2] * 256 * 256;
  state.readOffset += 3;
  state.readOffset += headerNameLength;
  state.readOffset += 2;
  while (true) {
    var rootValue = pdnReadSerializedValue(state, 0);
    if (rootValue && rootValue.markerTag && rootValue.markerTag === "end") break;
  }
  for (var refKey in state.pendingRefRegistry) {
    if (state.objectRegistry[refKey] == null) throw refKey;
  }
  for (var objectKey in state.objectRegistry) {
    pdnResolveObjectRefsDeep(state.objectRegistry[objectKey], state.objectRegistry);
  }
  var documentRoot = state.objectRegistry.o1;
  doc.width = documentRoot.width;
  doc.height = documentRoot.height;
  doc.buffer = allocBuffer(doc.width * doc.height * 4);
  var layerList = documentRoot.layers["ArrayList+_items"];
  for (var layerIndex = 0; layerIndex < layerList.length; layerIndex++) {
    var layerRecord = layerList[layerIndex];
    if (layerRecord == null) continue;
    var layerWidth = layerRecord["Layer+width"];
    var layerHeight = layerRecord["Layer+height"];
    var layerProperties = layerRecord["Layer+properties"];
    var layerProps = layerRecord.properties;
    var blendModeToken = layerProps.blendOp._class.split("+").pop();
    blendModeToken = blendModeToken.slice(0, blendModeToken.length - 7);
    var psdBlendMode = PDN_BLEND_MODE_TOKEN_TO_PSD[blendModeToken];
    var layer = doc.newLayer();
    layer.setName(layerProperties.name);
    layer.Opct = layerProperties.Opct;
    layer.setVisible(layerProperties.visible);
    layer.blendMode = psdBlendMode;
    var tilePixelCapacity = 1 << 16;
    var tileCount = Math.ceil(layerWidth * layerHeight / tilePixelCapacity);
    layer.rect = new Rect(0, 0, layerWidth, layerHeight);
    layer.buffer = allocBuffer(layerWidth * layerHeight * 4);
    var layerPixels = layer.buffer;
    state.readOffset += 5;
    for (var tileIndex = 0; tileIndex < tileCount; tileIndex++) {
      var tileChunk = pdnReadDeflatedTileChunk(state);
      layerPixels.set(tileChunk[1], tileChunk[0] * tilePixelCapacity * 4);
    }
    for (var pixelIndex = 0; pixelIndex < layerPixels.length; pixelIndex += 4) {
      var redChannel = layerPixels[pixelIndex + 0];
      layerPixels[pixelIndex + 0] = layerPixels[pixelIndex + 2];
      layerPixels[pixelIndex + 2] = redChannel;
    }
    doc.layers.push(layer);
  }
}

// ---------------------------------------------------------------------------
// Codec exports
// ---------------------------------------------------------------------------

export const psdCodec = {};
psdCodec.isLayered = true;
psdCodec.decode = function (buffer, doc) {
  codecLoaders.PSDParser.parse(buffer, doc);
};
psdCodec.encodeFlatRaster = function (doc, width, height, encodeOptions) {
  if (encodeOptions == null) encodeOptions = [false, false, false, false];
  if (!encodeOptions[0]) doc.getRasterData();
  var renderBuffer = new RenderBuffer();
  var serializedByteLength = codecLoaders.PSDParser.serialize(doc, renderBuffer, encodeOptions);
  return [renderBuffer.data.buffer, serializedByteLength];
};
psdCodec.encode = function (doc, width, height, encodeOptions) {
  var rasterResult = psdCodec.encodeFlatRaster(doc, width, height, encodeOptions);
  var outputBuffer = rasterResult[0];
  var byteLength = rasterResult[1];
  return outputBuffer.byteLength === byteLength ? outputBuffer : outputBuffer.slice(0, byteLength);
};

/**
 * Large Document Format: the PSD writer with 64-bit length fields switched on
 * (`encodeOptions[3]`). PSB files carry the same magic as PSD and are read by
 * the PSD parser, so this codec writes only.
 */
export const psbCodec = {};
psbCodec.isLayered = true;
psbCodec.encode = function (doc, width, height, encodeOptions) {
  var psbOptions = (encodeOptions || []).slice(0, 3);
  psbOptions[3] = true;
  return psdCodec.encode(doc, width, height, psbOptions);
};

export const pxdCodec = {};
pxdCodec.isLayered = true;
pxdCodec.decode = decodePxdDocument;

export const sketchCodec = {};
sketchCodec.isLayered = true;
sketchCodec.decode = function (buffer, doc) {
  codecLoaders.SketchLoader.parse(buffer, doc);
};

export const xdCodec = {};
xdCodec.isLayered = true;
xdCodec.decode = function (buffer, doc) {
  codecLoaders.XDLoader.parse(buffer, doc);
};

export const figCodec = {};
figCodec.isLayered = true;
figCodec.decode = function (buffer, doc) {
  codecLoaders.FigmaLoader.parse(buffer, doc);
};

export const xcfCodec = {};
xcfCodec.isLayered = true;
xcfCodec.decode = function (buffer, doc) {
  codecLoaders.XCFParser.parse(buffer, doc);
};

export const fpngCodec = {};
fpngCodec.isLayered = true;
fpngCodec.decode = function (buffer, doc) {
  codecLoaders.FpngLoader.parse(buffer, doc);
};

export const pdnCodec = {};
pdnCodec.isLayered = true;
pdnCodec.decode = decodePdnDocument;
