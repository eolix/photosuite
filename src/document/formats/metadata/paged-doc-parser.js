// Sketch paged-document parser. Resolves a Sketch document into a plain object
// graph from either the zip form (document.json + MSJSONFileReference links to
// per-page JSON and image files) or the SQLite form (an NSKeyedArchiver plist
// graph stored in the Sketch database).
/* global UZIP */
import { BinaryUtils } from "../../../core/binary/binary-utils.js";

import { FileFormatRegistry } from "../registry/file-format-registry.js";
import { BinaryPlistParser } from "./plist-parser.js";
import { SqliteParser } from "./sqlite-parser.js";
import { allocBuffer } from "../../../engine/compositing/buffer-utils.js";

/** Sketch class name → the short `_class` tag the loader uses. */
const SKETCH_CLASS_ALIASES = {
  MSPage: "page",
  MSArtboardGroup: "artboard",
  MSShapeGroup: "shapeGroup",
  MSLayerGroup: "group",
  MSBitmapLayer: "bitmap",
  MSTextLayer: "text",
  MSSliceLayer: "slice",
  MSSymbolMaster: "symbolMaster",
  MSSymbolInstance: "symbolInstance",
  MSStyleFill: "fill",
  MSShapePathLayer: "shapePath",
  MSRectangleShape: "rectangle",
  MSOvalShape: "oval",
  MSTriangleShape: "triangle",
};

/** Archive classes that wrap a single `array_do` list. */
const ARRAY_WRAPPER_CLASSES = ["MSArray", "MSFillStyleCollection", "MSBorderStyleCollection", "MSShadowStyleCollection", "MSInnerShadowStyleCollection"];

/** Archive classes materialized as-is (children not walked). */
const PASSTHROUGH_CLASSES = "MSArchivedColor MSLayoutGrid MSSimpleGrid MSColor MSRect MSStyleColorControls MSGraphicsContextSettings NSMutableString NSMutableData NSDecimalNumberPlaceholder MSStyleReflection".split(" ");

/** Archive class → the object-reference fields to recursively materialize. */
const ARCHIVE_CLASS_FIELD_MAP = {
  MSAssetCollection: ["gradients", "colors", "imageCollection", "images"],
  MSImageCollection: ["images"],
  MSSharedStyleContainer: ["objects"],
  MSSharedTextStyleContainer: ["objects"],
  MSSharedLayerStyleContainer: ["objects"],
  MSSharedLayerTextStyleContainer: ["objects"],
  MSSharedLayerContainer: ["objects"],
  MSSymbolContainer: ["objects"],
  MSGradient: ["stops", "from", "to", "points"],
  MSGradientStop: ["color"],
  MSStyleFill: ["color", "gradient", "contextSettings", "image", "imageSHA"],
  MSExportFormat: ["fileFormat", "name"],
  MSExportOptions: ["exportFormats", "includedLayerIds", "sizes"],
  MSRulerData: ["guides"],
  MSStyle: "textStyle fills contextSettings sharedObjectID borders blur shadows innerShadows borderOptions colorControls reflection".split(" "),
  MSSharedStyle: ["name", "value"],
  MSSymbol: ["name", "value"],
  MSAttributedString: ["archivedAttributedString"],
  MSSharedLayerStyle: ["name", "value", "instances"],
  MSSharedLayer: ["name", "value", "instances"],
  MSDocumentData: "assets layerStyles pages layerTextStyles layerSymbols images userInfo".split(" "),
  MSShapePathLayer: "exportOptions frame name userInfo path originalObjectID".split(" "),
  MSOvalShape: "exportOptions frame name userInfo path originalObjectID".split(" "),
  MSRectangleShape: "exportOptions frame name userInfo path originalObjectID".split(" "),
  MSPolygonShape: "exportOptions frame name userInfo path originalObjectID".split(" "),
  MSTriangleShape: "exportOptions frame name userInfo path originalObjectID".split(" "),
  MSStarShape: "exportOptions frame name userInfo path originalObjectID".split(" "),
  MSBitmapLayer: "exportOptions frame name userInfo style imageSHA nineSliceCenterRect nineSliceScale image clippingMask originalObjectID".split(" "),
  MSTextLayer: "exportOptions frame name userInfo style originalObjectID attributedString glyphBounds storage".split(" "),
  MSShapeGroup: "exportOptions frame name userInfo style originalObjectID layers".split(" "),
  MSLayerGroup: "exportOptions frame name userInfo style originalObjectID layers sharedObjectID".split(" "),
  MSArtboardGroup: "exportOptions frame name userInfo style layers horizontalRulerData verticalRulerData layout grid backgroundColor".split(" "),
  MSPage: "exportOptions frame name userInfo style layers horizontalRulerData verticalRulerData layout grid scrollOrigin".split(" "),
  MSSymbolMaster: "exportOptions frame name userInfo style layers horizontalRulerData verticalRulerData layout grid originalObjectID symbolID backgroundColor".split(" "),
  MSSymbolInstance: "exportOptions frame name userInfo style symbolID overrides masterInfluenceBounds originalObjectID".split(" "),
  MSSliceLayer: ["exportOptions", "frame", "name", "userInfo", "backgroundColor"],
  MSTextStyle: ["attributes", "encodedAttributes"],
  MSShapePath: ["points"],
  MSPointArray: ["points"],
  MSImageData: ["data", "sha1", "name"],
  MSCurvePoint: ["curveFrom", "curveTo", "point"],
  MSImageProxy: ["sha1"],
  MSStyleBorder: ["color", "gradient", "contextSettings"],
  MSStyleBlur: ["center"],
  MSStyleShadow: ["color", "contextSettings"],
  MSStyleInnerShadow: ["color", "contextSettings"],
  MSExportSize: ["format", "name"],
  MSStyleBorderOptions: ["dashPattern"],
  NSFont: ["NSName", "NSDescriptor"],
  NSColor: ["NSCustomColorSpace"],
  NSFontDescriptor: ["NSFontDescriptorAttributes"],
  NSMutableParagraphStyle: ["NSTextBlocks", "NSTabStops", "NSTextLists"],
  NSAttributedString: ["NSAttributes", "NSString", "NSAttributeInfo"],
  NSTextStorage: ["NSAttributeInfo", "NSAttributes", "NSString"],
  NSColorSpace: ["NSICC"],
  NSParagraphStyle: ["NSTabStops", "NSTextBlocks", "NSTextLists"],
  NSTextList: ["NSMarkerFormat"],
  NSTextTab: ["NSTabOptions"],
  UIFontDescriptor: ["UIFontDescriptorAttributes"],
};

/** Decode `length` bytes as a latin1 (per-byte char code) string. */
function decodeLatin1(bytes, offset, length) {
  var acc = "";
  for (var byteIdx = 0; byteIdx < length; byteIdx++) acc += String.fromCharCode(bytes[offset + byteIdx]);
  return acc;
}

/**
 * Parse a Sketch document buffer into a plain object graph.
 * @param {ArrayBuffer} bytes
 * @returns {object}
 */
function parse(bytes) {
  var byteView = new Uint8Array(bytes);
  if (byteView[0] == 80 && byteView[1] == 75) {
    var zipEntries = UZIP.parse(byteView.buffer);
    var documentJson = zipEntries["document.json"];
    var parsedDoc = JSON.parse(BinaryUtils.readUtf8(documentJson, 0, documentJson.length));
    resolveArchivedJsonRefs(parsedDoc, zipEntries);
    return parsedDoc;
  }
  var sqliteRows = SqliteParser.parse(bytes);
  return decodeKeyedArchive(sqliteRows[2][0][1]);
}

/** Recursively inline MSJSONFileReference links and MSAttributedString archives. */
function resolveArchivedJsonRefs(node, zipEntries) {
  var nodeType = typeof node;
  if (nodeType == "string" || nodeType == "number" || nodeType == "boolean") return node;
  if (node instanceof Array) {
    for (var idx = 0; idx < node.length; idx++) node[idx] = resolveArchivedJsonRefs(node[idx], zipEntries);
    return node;
  }
  var className = node._class;
  if (className == null) return node;

  if (className == "MSJSONFileReference") {
    var refPath = node._ref;
    if (zipEntries[refPath + ".json"] != null) {
      node = JSON.parse(readReferencedJson(zipEntries[refPath + ".json"]));
    } else {
      return resolveBinaryFileReference(refPath, zipEntries, node);
    }
  } else if (className == "MSAttributedString") {
    node.archivedAttributedString = decodeKeyedArchive(base64ToBytes(atob(node.archivedAttributedString._archive)));
  }

  for (var propKey in node) node[propKey] = resolveArchivedJsonRefs(node[propKey], zipEntries);
  return node;
}

/** Read a referenced JSON blob, normalizing embedded VT/ETX control bytes. */
function readReferencedJson(jsonBytes) {
  for (var byteIdx = 0; byteIdx < jsonBytes.length; byteIdx++) {
    if (jsonBytes[byteIdx] == 11 || jsonBytes[byteIdx] == 3) jsonBytes[byteIdx] = 32;
  }
  return BinaryUtils.readUtf8(jsonBytes, 0, jsonBytes.length);
}

/** Resolve a file reference to embedded image/PDF bytes, or undefined. */
function resolveBinaryFileReference(refPath, zipEntries, node) {
  var extensions = [".png", ".jpg", ".pdf", ""];
  for (var extIdx = 0; extIdx < extensions.length; extIdx++) {
    var entry = zipEntries[refPath + extensions[extIdx]];
    if (entry != null) return { key: refPath.split("/").pop(), bdata: entry };
  }
  console.log(node, zipEntries);
  return undefined;
}

/** Decode a latin1 string (from atob) into a trailing-trimmed byte array. */
function base64ToBytes(binaryString) {
  var len = binaryString.length - 1;
  var out = new Uint8Array(len);
  for (var byteIdx = 0; byteIdx < len; byteIdx++) out[byteIdx] = binaryString.charCodeAt(byteIdx);
  return out;
}

/** Log the object path from `rootGraph` to `searchTarget` (debug diagnostic). */
function debugFindObjectPath(currentNode, searchTarget, pathStack, visitedNodes) {
  if (currentNode instanceof Uint8Array) return null;
  if (visitedNodes.indexOf(currentNode) != -1) return null;
  visitedNodes.push(currentNode);
  if (currentNode == searchTarget) return pathStack;
  for (var propName in currentNode) {
    pathStack.push(propName);
    var foundPath = debugFindObjectPath(currentNode[propName], searchTarget, pathStack, visitedNodes);
    if (foundPath) {
      console.log(currentNode, foundPath);
      throw "paged-doc: reached orphan archive object";
    }
    pathStack.pop();
  }
}

/** Materialize an NSKeyedArchiver plist into a plain object graph. */
function decodeKeyedArchive(archiveBytes) {
  var plist = BinaryPlistParser.parse(archiveBytes, 0);
  var objects = plist.$objects;
  var visitedFlags = new Uint8Array(objects.length);
  var rootGraph = materializeArchiveGraph(objects, visitedFlags, plist.$top.root);
  for (var objIdx = 0; objIdx < objects.length; objIdx++) {
    if (visitedFlags[objIdx] == 0 && objIdx != 0) {
      console.log(objIdx, objects[objIdx]);
      debugFindObjectPath(rootGraph, objIdx, [], []);
    }
  }
  resolveArchivedImages(objects, rootGraph);
  return rootGraph;
}

/** Inline bitmap / image-fill pixel data referenced by SHA into the graph. */
function resolveArchivedImages(objects, rootGraph) {
  for (var objIdx = 0; objIdx < objects.length; objIdx++) {
    var obj = objects[objIdx];
    if (!(obj._class && (obj._class == "bitmap" || obj._class == "fill" && obj.fillType == 4 && (obj.image || obj.imageSHA)))) continue;
    var imageRef = obj.image == "$null" ? null : obj.image;
    var imageSha = obj.imageSHA == "$null" ? null : obj.imageSHA;
    var pixelBytes = null;
    var sha1B64 = null;
    if (imageRef && imageRef.data) {
      sha1B64 = btoa(BinaryUtils.readString(imageRef.sha1["NS.bytes"], 0, imageRef.sha1["NS.bytes"].length));
      pixelBytes = imageRef.data instanceof Uint8Array ? imageRef.data : imageRef.data["NS.bytes"];
    } else if (imageRef == null && imageSha == null) {
      pixelBytes = new Uint8Array(FileFormatRegistry.getFormat("PNG").encode([[allocBuffer(4).buffer]], 1, 1));
    } else {
      var imageTable = (rootGraph.assets ? rootGraph.assets.imageCollection : rootGraph.images).images;
      var shaBytes = imageSha ? (imageSha instanceof Uint8Array ? imageSha : imageSha["NS.bytes"]) : imageRef.sha1["NS.bytes"];
      sha1B64 = btoa(BinaryUtils.readString(shaBytes, 0, shaBytes.length));
      pixelBytes = imageTable[sha1B64].data;
      if (pixelBytes["NS.bytes"]) pixelBytes = pixelBytes["NS.bytes"];
    }
    pixelBytes = new Uint8Array(pixelBytes.buffer.slice(pixelBytes.byteOffset, pixelBytes.byteOffset + pixelBytes.length));
    delete obj.imageSHA;
    obj.image = { key: sha1B64, bdata: pixelBytes };
  }
}

/** GIMP-style immutable class names (MSImmutableFoo) map to their MSFoo class. */
function stripImmutablePrefix(className) {
  return className.slice(0, 11) == "MSImmutable" ? "MS" + className.slice(11) : className;
}

/** Materialize object at `objectIndex` (resolving its $class and children). */
function materializeArchiveGraph(objects, visitedFlags, objectIndex) {
  var obj = objects[objectIndex];
  if (visitedFlags[objectIndex] == 1) return obj;
  visitedFlags[objectIndex] = 1;
  if (typeof obj == "string" || typeof obj == "number" || typeof obj == "boolean") return obj;
  if (obj instanceof Array || obj instanceof Uint8Array) return obj;

  if (objects[obj.$class] == null) {
    if (obj.$class == null && obj["NS.data"] != null) return obj;
    console.log(objectIndex, obj);
    throw "paged-doc: archive object has no class";
  }
  var className = stripImmutablePrefix(objects[obj.$class].$classname);
  visitedFlags[obj.$class] = 1;
  obj.$class = className;
  if (SKETCH_CLASS_ALIASES[className]) {
    delete obj.$class;
    obj._class = SKETCH_CLASS_ALIASES[className];
  }

  if (className == "NSMutableArray" || className == "NSArray") return materializeArray(objects, visitedFlags, obj, objectIndex);
  if (className == "NSDictionary" || className == "NSMutableDictionary") return materializeDictionary(objects, visitedFlags, obj, className);
  if (className == "NSURL") {
    return {
      $class: className,
      base: materializeArchiveGraph(objects, visitedFlags, obj["NS.base"]),
      relative: materializeArchiveGraph(objects, visitedFlags, obj["NS.relative"]),
    };
  }
  if (ARRAY_WRAPPER_CLASSES.indexOf(className) != -1) {
    objects[objectIndex] = materializeArchiveGraph(objects, visitedFlags, obj.array_do);
    return objects[objectIndex];
  }
  if (obj.do_objectID != null) obj.do_objectID = materializeArchiveGraph(objects, visitedFlags, obj.do_objectID);
  if (PASSTHROUGH_CLASSES.indexOf(className) != -1) return obj;

  var fieldMap = ARCHIVE_CLASS_FIELD_MAP[className];
  if (fieldMap == null) {
    console.log(objects, obj);
    throw "unknown class " + className;
  }
  for (var idx = 0; idx < fieldMap.length; idx++) {
    if (obj[fieldMap[idx]] != null) obj[fieldMap[idx]] = materializeArchiveGraph(objects, visitedFlags, obj[fieldMap[idx]]);
  }
  if (className == "MSTextLayer") materializeTextLayer(obj);
  return obj;
}

/** Materialize an NSArray archive node into a plain array. */
function materializeArray(objects, visitedFlags, obj, objectIndex) {
  var arrayOut = [];
  if (obj["NS.objects"] != null) {
    for (var idx = 0; idx < obj["NS.objects"].length; idx++) arrayOut.push(materializeArchiveGraph(objects, visitedFlags, obj["NS.objects"][idx]));
  } else {
    for (var idx = 0; obj["NS.object." + idx] != null; idx++) arrayOut.push(materializeArchiveGraph(objects, visitedFlags, obj["NS.object." + idx]));
  }
  objects[objectIndex] = arrayOut;
  return arrayOut;
}

/** Materialize an NSDictionary archive node in place into `obj`. */
function materializeDictionary(objects, visitedFlags, obj, className) {
  var dictOut = { $class: className };
  if (obj["NS.keys"] != null) {
    for (var idx = 0; idx < obj["NS.keys"].length; idx++) {
      dictOut[dictKeyString(materializeArchiveGraph(objects, visitedFlags, obj["NS.keys"][idx]))] = materializeArchiveGraph(objects, visitedFlags, obj["NS.objects"][idx]);
    }
  } else {
    for (var idx = 0; obj["NS.key." + idx] != null; idx++) {
      dictOut[dictKeyString(materializeArchiveGraph(objects, visitedFlags, obj["NS.key." + idx]))] = materializeArchiveGraph(objects, visitedFlags, obj["NS.object." + idx]);
    }
  }
  for (var dictProp in obj) delete obj[dictProp];
  for (var dictProp in dictOut) obj[dictProp] = dictOut[dictProp];
  return obj;
}

/** Coerce a materialized dictionary key to a string (base64 for byte keys). */
function dictKeyString(dictKey) {
  if (dictKey instanceof Uint8Array) return btoa(decodeLatin1(dictKey, 0, dictKey.length));
  if (typeof dictKey != "string" && typeof dictKey != "number") return btoa(decodeLatin1(dictKey["NS.bytes"], 0, dictKey["NS.bytes"].length));
  return dictKey;
}

/** Normalize an MSTextLayer's archived string into a canonical shape. */
function materializeTextLayer(textLayer) {
  var archivedString = textLayer.attributedString ? textLayer.attributedString.archivedAttributedString : textLayer.storage;
  var attrString = archivedString.NSString;
  if (typeof attrString != "string") attrString = BinaryUtils.readUtf8(attrString["NS.bytes"], 0, attrString["NS.bytes"].length);

  var attrInfoBytes;
  if (archivedString.NSAttributeInfo) {
    attrInfoBytes = archivedString.NSAttributeInfo["NS.bytes"];
  } else {
    var remainingLen = attrString.length;
    var runChunk = [];
    while (remainingLen > 0) {
      var chunkLen = Math.min(100, remainingLen);
      runChunk.push(chunkLen, 0);
      remainingLen -= chunkLen;
    }
    attrInfoBytes = new Uint8Array(runChunk);
  }
  var attrRuns = archivedString.NSAttributes instanceof Array ? archivedString.NSAttributes : [archivedString.NSAttributes];
  var attributed = { $class: "NSAttributedString", NSString: attrString, NSAttributes: attrRuns };
  textLayer.attributedString = { _class: "MSAttributedString", archivedAttributedString: attributed };
  attributed.NSAttributeInfo = { $class: "NSMutableData", "NS.data": attrInfoBytes };
  delete textLayer.storage;
}

const PagedDocParser = { parse, stripImmutablePrefix, resolveBinaryFileReference, decodeLatin1 };

export { PagedDocParser };
