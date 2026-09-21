/**
 * Document: open file state — layer stack, dimensions, color mode, guides,
 * history, selection, and compositing entry points. Each tab owns one `Document`
 * instance; tools and trackers mutate it directly.
 */

import { Point } from "../../core/math/point.js";
import { generateUuid } from "../../core/uid.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { Locale } from "../../core/i18n/locale.js";
import { replaceFileExtension } from "../../core/file-names.js";

import { BlendModes } from "./blend-modes.js";
import { LayerSystem } from "../../engine/layer-system.js";
import { EventChannel } from "./tool-base.js";
import { detectFormat, getFormat } from "../formats/registry/registry-helpers.js";
import { LayerEffectDefs } from "../formats/psd/effect-defs.js";
import { Layer } from "./layer.js";
import { LayerSectionType } from "./layer.js";
import { LayerGroup } from "./layer-group.js";
import { CanvasViewport } from "./canvas-viewport.js";
import { Mask, VectorMask } from "./layer-masks.js";
import { EventType } from "../../core/event-bus.js";
import { promptConfirmUser, tryNativeConfirmSync } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { packDoublesList } from "../formats/psd/descriptor-codec.js";
import { resizeDocumentCanvas } from "./layer-translate.js";
import { allocBuffer, copyBuffer, equals, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyAlphaToChannel, copyPixels, getZeroBuffer, isBufferUniform, multiplyBuffers } from "../../engine/compositing/pixel-ops.js";
import { rectToPathOutline } from "../../engine/compositing/anti-alias.js";
import { countSubpaths } from "../../engine/compositing/path-records.js";
import { createEmptyKeyOrigin } from "../../engine/compositing/key-origins.js";
import { defaultWarpDescriptor, isIdentityWarp } from "../../engine/compositing/warp.js";

import {
  compositeLayerGpu,
  renderThumbnailCanvases,
} from "../render/layer-compositor.js";

/**
 * One undo/redo history step for `Document.history`.
 *
 * `name` is the locale key, `routingChannel` scopes the originating tool/tracker,
 * `excludeFromHistoryUI` hides internal steps, and `data` holds the payload.
 */
export class HistoryEntry {
  constructor(name, routingChannel, excludeFromHistoryUI = false) {
    this.name = name;
    this.routingChannel = routingChannel;
    this.excludeFromHistoryUI = excludeFromHistoryUI;
    this.data = null;
  }
}

const MAX_VISIBLE_HISTORY_ENTRIES = 100;

/** PSD image-resource block IDs the document stores in `resources`. */
const RESOURCE_LAYER_ID_BASE = 1044;
const RESOURCE_ROTATION_ANGLE = 1037;
const RESOURCE_GLOBAL_LIGHT_ANGLE = 1049;

/**
 * Trim history to the newest visible entries and return adjusted index.
 */
function trimVisibleHistoryStack(history, historyIndex, maxVisible = MAX_VISIBLE_HISTORY_ENTRIES) {
  let visibleCount = 0;
  for (let historyIdx = history.length - 1; historyIdx >= 0; historyIdx--) {
    const entry = history[historyIdx];
    if (entry.excludeFromHistoryUI) continue;
    visibleCount++;
    if (visibleCount === maxVisible) {
      return {
        history: history.slice(historyIdx),
        historyIndex: historyIndex - historyIdx,
      };
    }
  }
  return { history, historyIndex };
}

/** Write the linked/placed/pattern resource lists onto `addBag`, or delete empty ones. */
function applyFilteredMeta(addBag, meta) {
  if (meta.links) addBag.lnk2 = meta.links;
  else delete addBag.lnk2;
  if (meta.placedItems) addBag.FEid = meta.placedItems;
  else delete addBag.FEid;
  if (meta.patterns) addBag.Patt = meta.patterns;
  else delete addBag.Patt;
}


/**
 * Clear the composite buffer (or GL target) for the dirty intersection.
 */
function clearCompositeDirtyRegion(doc, fullRect, dirtyIntersect) {
  if (!dirtyIntersect.equals(fullRect)) {
    if (!LayerSystem.webglEnabled) {
      const zeroBuffer = getZeroBuffer(dirtyIntersect.area() * 4);
      copyPixels(zeroBuffer, dirtyIntersect, doc.buffer, fullRect);
    } else {
      LayerSystem.bindRenderTarget(doc.glTexture, dirtyIntersect);
      LayerSystem.clearWithColor(0);
    }
    return;
  }
  if (LayerSystem.webglEnabled) {
    doc.glTexture.set(null);
  } else {
    doc.buffer.fill(0);
  }
}

/** Build the smart-object `placedData` descriptor for a newly placed layer. */
function buildPlacedDataDescriptor(layer, linkedTag, placedId) {
  return {
    classID: "null",
    Idnt: { t: "TEXT", v: linkedTag },
    Impr: { t: "Objc", v: { __name: "None", classID: "none" } },
    placed: { t: "TEXT", v: placedId },
    PgNm: { t: "long", v: 1 },
    totalPages: { t: "long", v: 1 },
    frameStep: {
      t: "Objc",
      v: { classID: "null", numerator: { t: "long", v: 0 }, denominator: { t: "long", v: 600 } },
    },
    duration: {
      t: "Objc",
      v: { classID: "null", numerator: { t: "long", v: 0 }, denominator: { t: "long", v: 600 } },
    },
    frameCount: { t: "long", v: 1 },
    Annt: { t: "long", v: 16 },
    Type: { t: "long", v: 2 },
    Trnf: null,
    nonAffineTransform: null,
    warp: { t: "Objc", v: defaultWarpDescriptor(layer.rect) },
    Sz: {
      t: "Objc",
      v: {
        classID: "Pnt",
        Wdth: { t: "doub", v: layer.rect.width },
        Hght: { t: "doub", v: layer.rect.height },
      },
    },
    Rslt: { t: "UntF", v: { type: "#Rsl", val: 72 } },
  };
}

/** Derive a unique " copy"/" copy N" layer name from an existing name. */
/**
 * Push the linked-file tags that Displace smart filters on `placedData` read
 * their maps from onto `tagsOut`, so a map no placed layer references is still
 * written out with the document.
 */
function collectDisplacementMapTags(placedData, tagsOut) {
  const filterFx = placedData.filterFX;
  if (filterFx == null) return;
  const fxList = filterFx.v.filterFXList.v;
  for (let fxIdx = 0; fxIdx < fxList.length; fxIdx++) {
    const filterDescriptor = fxList[fxIdx].v.Fltr;
    if (filterDescriptor && filterDescriptor.v.classID == "Dspl" && filterDescriptor.v.DspF) {
      tagsOut.push(filterDescriptor.v.DspF.v.pth);
    }
  }
}

function computeDuplicateName(originalName, usedNames) {
  let suffixStart = originalName.length;
  while (48 <= originalName.charCodeAt(suffixStart - 1) && originalName.charCodeAt(suffixStart - 1) <= 57) suffixStart--;
  let copyNumber = parseInt(originalName.slice(suffixStart));
  let nameBase;
  if (isNaN(copyNumber)) {
    if (originalName.endsWith(" copy")) {
      copyNumber = 1;
      nameBase = originalName.slice(0, originalName.length - 5);
    } else {
      copyNumber = 0;
      nameBase = originalName;
    }
  } else if (originalName.slice(0, suffixStart).endsWith(" copy ")) {
    nameBase = originalName.slice(0, suffixStart - 6);
  } else {
    copyNumber = 0;
    nameBase = originalName;
  }
  copyNumber++;
  let duplicateName;
  while (true) {
    duplicateName = nameBase + " copy" + (copyNumber === 1 ? "" : " " + copyNumber);
    if (usedNames[duplicateName] == null) break;
    copyNumber++;
  }
  return duplicateName;
}

export class Document {
  constructor(documentName) {
    this.formatType = "psd";
    this.name = documentName;
    this.activeArtboardIndex = -1;
    this.scriptHostData = null;
    this.sourceUrl = null;
    this.parentDocRef = null;
    this.nativeFilePath = null;
    this.width = 0;
    this.height = 0;
    this.layers = [];
    this.resources = {};
    this.add = {};
    this.buffer = null;
    this.channelCount = 4;
    this.indexedColorTable = null;
    this.dpi = 72;
    this.xmpMetadata = {};
    this.selectedLayerIndices = [];
    this.guides = [[], []];
    this.slices = [];
    this.selectedSliceIndices = [];
    this.paths = [Document.createPathEntry("Work Path")];
    this.selectedWorkPaths = [];
    this.selectedLayerPaths = null;
    this.layerComps = { classID: "CompList", list: { t: "VlLs", v: [] } };
    this.root = null;
    this.glTexture = null;
    this.pendingTextRasterization = false;
    /** When true, Layer.invalidate skips renderFillContent (format import builds structure only). */
    this.deferFillRasterization = false;
    /** Set by importers that deferred fills; fills rasterize on first composite. */
    this.needsFillRasterization = false;
    this.needsBufferInit = false;
    this.isInitialized = false;
    this.layerCompsModified = false;
    this.needsComposite = false;
    this.dirty = false;
    this.panelsDirty = false;
    this.stateChanged = false;
    this.allowViewUpdate = false;
    this.needsScrollToSelected = false;
    this.dirtyRect = null;
    this.lastGLDirtyRect = null;
    this.pixCache = {};
    this.selectionMask = null;
    this.extraChannels = [];
    this.activeChannels = [];
    this.toolOverlayState = {
      perToolOverlays: {},
      squareMarkerCoords: [],
      circleMarkerCoords: [],
      pinMarkerCoords: [],
      selectedPinIndices: [],
      overlayTransform: null,
      /** Closed path whose outside a tool shades, to show what it will discard. */
      discardShadeOverlay: null,
      textSelectionPath: null,
      snapGuides: null,
      measureOverlay: null,
      brushStampOverlays: [],
      floatingBitmapOverlays: [],
    };
    this.history = [new HistoryEntry("file.open", null)];
    this.historyIndex = 0;
    this.savedHistoryIndex = 0;
    this.pathViewport = new CanvasViewport(this);
  }

  setMeta(meta) {
    applyFilteredMeta(this.add, meta);
  }

  /**
   * Collect the linked-file, placed-item, and pattern resources actually
   * referenced by `layers`, returning `{ links, placedItems, patterns }`
   * (each list is null when nothing references it).
   */
  filterLinkedResources(layers) {
    const placedIdentityIds = [];
    const placedItemIds = [];
    const patternIdentityIds = [];
    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layer = layers[layerIdx];
      if (layer.add.placedData) {
        placedIdentityIds.push(layer.add.placedData.Idnt.v);
        placedItemIds.push(layer.add.placedData.placed.v);
        collectDisplacementMapTags(layer.add.placedData, placedIdentityIds);
      }
      if (layer.add.PtFl) patternIdentityIds.push(layer.add.PtFl.Ptrn.v.Idnt.v);
      if (layer.add.lmfx) {
        for (let effectKeyIdx = 0; effectKeyIdx < LayerEffectDefs.effectKeys.length; effectKeyIdx++) {
          const effectVariantList = layer.add.lmfx[LayerEffectDefs.effectKeys[effectKeyIdx]].v;
          for (let effectVariantIdx = 0; effectVariantIdx < effectVariantList.length; effectVariantIdx++)
            if (effectVariantList[effectVariantIdx].v.Ptrn) patternIdentityIds.push(effectVariantList[effectVariantIdx].v.Ptrn.v.Idnt.v);
        }
      }
      const vectorStroke = layer.add.vstk;
      if (vectorStroke && vectorStroke.strokeStyleContent.v.classID == "patternLayer") {
        patternIdentityIds.push(vectorStroke.strokeStyleContent.v.Ptrn.v.Idnt.v);
      }
    }

    const linkEntries = this.add.lnk2;
    const placedIdEntries = this.add.FEid;
    const patternEntries = this.add.Patt;
    let filteredLinks = null;
    let filteredPlacedItems = null;
    let filteredPatterns = null;
    if (linkEntries) {
      filteredLinks = [];
      for (let linkIdx = 0; linkIdx < linkEntries.length; linkIdx++)
        if (placedIdentityIds.indexOf(linkEntries[linkIdx].tag) != -1) filteredLinks.push(linkEntries[linkIdx]);
      if (filteredLinks.length == 0) filteredLinks = null;
    }
    if (placedIdEntries) {
      filteredPlacedItems = [];
      for (let placedIdx = 0; placedIdx < placedIdEntries.length; placedIdx++)
        if (placedItemIds.indexOf(placedIdEntries[placedIdx].id) != -1) filteredPlacedItems.push(placedIdEntries[placedIdx]);
      if (filteredPlacedItems.length == 0) filteredPlacedItems = null;
    }
    if (patternEntries) {
      filteredPatterns = [];
      for (let patternIdx = 0; patternIdx < patternEntries.length; patternIdx++)
        if (patternIdentityIds.indexOf(patternEntries[patternIdx].id) != -1) filteredPatterns.push(patternEntries[patternIdx]);
      if (filteredPatterns.length == 0) filteredPatterns = null;
    }
    return { links: filteredLinks, placedItems: filteredPlacedItems, patterns: filteredPatterns };
  }

  getQuickMask() {
    const extraChannels = this.extraChannels;
    const channelCount = this.extraChannels.length;
    if (channelCount != 0 && extraChannels[channelCount - 1].name == "Quick Mask") return extraChannels[channelCount - 1];
  }

  isDesignAppFormat() {
    return this.formatType == "sketch" || this.formatType == "xd";
  }

  initArtboardDocument(artboardCount) {
    this.add.artd = {
      classID: "null",
      Cnt: { t: "long", v: artboardCount },
      autoExpandOffset: {
        t: "Objc",
        v: { classID: "Pnt", Hrzn: { t: "doub", v: 0 }, Vrtc: { t: "doub", v: 0 } },
      },
      origin: {
        t: "Objc",
        v: { classID: "Pnt", Hrzn: { t: "doub", v: 0 }, Vrtc: { t: "doub", v: 0 } },
      },
      canvasColorMode: { t: "enum", v: { canvasColorType: "Cstm" } },
      canvasColor: {
        t: "Objc",
        v: {
          classID: "RGBC",
          Rd: { t: "doub", v: 220 },
          Grn: { t: "doub", v: 220 },
          Bl: { t: "doub", v: 220 },
        },
      },
      autoExpandEnabled: { t: "bool", v: true },
      autoNestEnabled: { t: "bool", v: true },
      autoPositionEnabled: { t: "bool", v: true },
    };
  }

  addPlacedItemId(placedItem) {
    if (this.add.FEid == null) this.add.FEid = [];
    if (this.add.FEid.indexOf(placedItem) == -1) this.add.FEid.push(placedItem);
  }

  removePlacedItemId(placedItem) {
    const itemIndex = this.add.FEid.indexOf(placedItem);
    this.add.FEid.splice(itemIndex, 1);
    if (this.add.FEid.length == 0) delete this.add.FEid;
  }

  markDirty(dirtyRect) {
    if (dirtyRect == null) dirtyRect = new Rect(0, 0, this.width, this.height);
    if (this.dirtyRect == null) this.dirtyRect = dirtyRect;
    else this.dirtyRect = this.dirtyRect.union(dirtyRect);
  }

  hasDirtyRect() {
    return this.dirtyRect != null;
  }

  canMoveLayerUp(layerIndex) {
    const layer = this.layers[layerIndex];
    const section = this.root.getSectionByIndex(layerIndex);
    if (section == null) return false;
    if (layer.isGroup() || section.parent.children.indexOf(section) == 0) return false;
    return true;
  }

  extractLayersAsPSD(layerIndices, clipRect, unionRect) {
    layerIndices.sort((layerIndexA, layerIndexB) => layerIndexA - layerIndexB);
    const topIndex = layerIndices[layerIndices.length - 1];
    const savedLayers = this.layers.slice(0);
    const savedSelection = this.selectedLayerIndices.slice(0);
    const removedLayers = [];
    const selectedLayers = [];
    for (let layerIdx = 0; layerIdx < this.layers.length; layerIdx++) {
      if (layerIndices.indexOf(layerIdx) != -1) selectedLayers.push(this.layers[layerIdx]);
      else removedLayers.push(this.layers[layerIdx]);
    }
    this.setLayers(selectedLayers);
    this.selectedLayerIndices = [];
    let selectionRect = this.root.getSelectionRect(this, true);
    if (clipRect) selectionRect = selectionRect.intersect(clipRect);
    if (unionRect) selectionRect = selectionRect.union(unionRect);
    if (selectionRect.isEmpty()) selectionRect = new Rect(0, 0, 100, 100);
    const encodedPsdBytes = new Uint8Array(getFormat("PSD").encode(this, 0, 0, [true, false]));
    this.setLayers(savedLayers);
    this.selectedLayerIndices = savedSelection;
    const extractedDoc = new Document(this.layers[topIndex].getName());
    getFormat("PSD").decode(encodedPsdBytes.buffer, extractedDoc);
    delete extractedDoc.add.artd;
    extractedDoc.guides = [[], []];
    extractedDoc.slices = [];
    extractedDoc.setLayers(extractedDoc.layers);
    Document.regenerateLinkedUIDs(extractedDoc);
    resizeDocumentCanvas(extractedDoc, selectionRect);
    extractedDoc.markDirty();
    extractedDoc.composite();
    extractedDoc.getRasterData();
    return { doc: extractedDoc, selectionRect, removedLayers, topIndex };
  }

  mergeLayersToSmartObject(layerIndices, keepSourceLayers, exportFormat) {
    const extracted = this.extractLayersAsPSD(layerIndices);
    const extractedDoc = extracted.doc;
    const selectionRect = extracted.selectionRect;
    const topIndex = extracted.topIndex;
    let layerStack = extracted.removedLayers;
    let embeddedBytes;
    if (exportFormat == "jpg") {
      embeddedBytes = new Uint8Array(getFormat("JPG").encode([[extractedDoc.getRasterData().buffer]], extractedDoc.width, extractedDoc.height, [80]));
    } else {
      embeddedBytes = new Uint8Array(getFormat("PSD").encode(extractedDoc, null, null, [true, false]));
    }
    if (keepSourceLayers) layerStack = this.layers.slice(0);
    const smartObjectLayer = this.createSmartObjectLayer(embeddedBytes, extractedDoc.name, selectionRect.x, selectionRect.y);
    if (topIndex == this.layers.length - 1) layerStack.push(smartObjectLayer);
    else layerStack.splice(keepSourceLayers ? topIndex + 1 : topIndex - layerIndices.length + 1, 0, smartObjectLayer);
    this.setLayers(layerStack);
    this.selectedLayerIndices = [layerStack.indexOf(smartObjectLayer)];
  }

  registerPattern(patternEntry) {
    if (patternEntry == null) return;
    if (this.add.Patt == null) this.add.Patt = [];
    const patternList = this.add.Patt;
    for (let patternIdx = 0; patternIdx < patternList.length; patternIdx++)
      if (patternList[patternIdx].id == patternEntry.id) return;
    patternList.push(patternEntry);
  }

  /**
   * Embed `rawBytes` as a linked-file item (`lnk2`) and return its tag. Bytes
   * identical to an item already embedded reuse that item's tag, so placing the
   * same source twice — or reusing it as a Displace map — stores it once.
   * @param {Uint8Array} rawBytes Encoded file bytes (PSD, PNG, JPEG, SVG, PDF, …).
   * @param {string} sourceName Display name; the extension is set from the bytes.
   * @returns {string} The linked item's tag.
   */
  registerLinkedFile(rawBytes, sourceName) {
    if (this.add.lnk2 == null) this.add.lnk2 = [];
    for (let linkIdx = 0; linkIdx < this.add.lnk2.length; linkIdx++)
      if (equals(rawBytes, this.add.lnk2[linkIdx].raw)) return this.add.lnk2[linkIdx].tag;
    const detectedFormat = detectFormat(rawBytes.buffer);
    const linkedFileItem = new Layer.LinkedFileItem();
    linkedFileItem.tag = Document.generateUID();
    linkedFileItem.creatorFourCC = detectedFormat == "psd" ? "8BIM" : "    ";
    linkedFileItem.fileName = replaceFileExtension(sourceName, detectedFormat);
    linkedFileItem.fileTypeFourCC = detectedFormat == "psd" ? "8BPB" : "    ";
    linkedFileItem.open = 0;
    linkedFileItem.raw = rawBytes;
    linkedFileItem.type = "liFD";
    linkedFileItem.descriptorVersion = 2;
    this.add.lnk2.push(linkedFileItem);
    return linkedFileItem.tag;
  }

  createSmartObjectLayer(rawBytes, layerName, offsetX, offsetY, fitToCanvas) {
    const linkedTag = this.registerLinkedFile(rawBytes, layerName);

    const rasterItem = this.resolveLinkedItemRaster(linkedTag);
    const placedId = Document.generateUID();
    const layer = this.newLayer();
    layer.setName(layerName);
    let needsRasterize = false;
    if (rasterItem != null) {
      const layerRect = (layer.rect = rasterItem.rasterCache[1].clone());
      layerRect.offset(offsetX, offsetY);
      const scaleFactor = Math.max(layerRect.width / this.width, layerRect.height / this.height);
      needsRasterize = fitToCanvas && scaleFactor > 1.0001;
      if (needsRasterize) {
        layerRect.width = Math.round(layerRect.width / scaleFactor);
        layerRect.height = Math.round(layerRect.height / scaleFactor);
        layerRect.x = Math.round((this.width - layerRect.width) / 2);
        layerRect.y = Math.round((this.height - layerRect.height) / 2);
      } else if (fitToCanvas && detectFormat(rawBytes.buffer) == "pdf" && this.dpi != 144) {
        const pdfScaleFactor = 144 / this.dpi;
        layerRect.width = Math.round(layerRect.width / pdfScaleFactor);
        layerRect.height = Math.round(layerRect.height / pdfScaleFactor);
        needsRasterize = true;
      }
      layer.buffer = allocBuffer(layer.rect.area() * 4);
      if (!needsRasterize) copyBuffer(rasterItem.rasterCache[0], layer.buffer);
    }
    layer.add.placedData = buildPlacedDataDescriptor(layer, linkedTag, placedId);
    const pathCoords = rectToPathOutline(layer.rect).coords;
    layer.add.placedData.Trnf = packDoublesList(pathCoords);
    layer.add.placedData.nonAffineTransform = packDoublesList(pathCoords);
    if (needsRasterize) layer.rasterizeSmartObject(this, false);
    return layer;
  }

  getRasterData(compositeDepth) {
    if (compositeDepth != null) {
      this.markDirty();
      this.composite(compositeDepth);
      let bufferSnapshot = this.buffer;
      if (LayerSystem.webglEnabled) this.glTexture.get(bufferSnapshot);
      else bufferSnapshot = bufferSnapshot.slice(0);
      this.markDirty();
      this.composite();
      return bufferSnapshot;
    }
    if (this.dirtyRect) {
      this.composite();
      this.dirtyRect = null;
    }
    if (LayerSystem.webglEnabled && this.lastGLDirtyRect) {
      this.glTexture.get(this.buffer);
      this.lastGLDirtyRect = null;
      this.panelsDirty = true;
    }
    return this.buffer;
  }

  invalidateAllLayers() {
    for (let layerIdx = 0; layerIdx < this.layers.length; layerIdx++) this.layers[layerIdx].invalidateAlignedFills();
    this.markDirty();
  }

  invalidateLayerEffects() {
    for (let layerIdx = 0; layerIdx < this.layers.length; layerIdx++)
      if (this.layers[layerIdx].add.lmfx) this.layers[layerIdx].renderCache.dirty = true;
  }

  generateLayerId() {
    let layerIdBytes = this.resources["r" + RESOURCE_LAYER_ID_BASE];
    if (layerIdBytes == null) {
      layerIdBytes = this.resources["r" + RESOURCE_LAYER_ID_BASE] = new Uint8Array(4);
      let maxLayerId = 0;
      for (let layerIdx = 0; layerIdx < this.layers.length; layerIdx++) maxLayerId = Math.max(maxLayerId, this.layers[layerIdx].add.lyid);
      BinaryUtils.writeUint32BE(layerIdBytes, 0, maxLayerId);
    }
    const currentId = BinaryUtils.readUint32BE(layerIdBytes, 0);
    BinaryUtils.writeUint32BE(layerIdBytes, 0, currentId + 1);
    return currentId + 1;
  }

  ensureLayerEditableForTools(showFeedback, requirePixelSurface, returnRasterizeConfirm, onComplete) {
    if (showFeedback == null) showFeedback = true;
    if (this.activeChannels.length != 0) {
      if (onComplete) onComplete(true);
      return true;
    }
    if (this.selectedLayerIndices.length != 1) {
      if (showFeedback) alert(this.selectedLayerIndices.length == 0 ? "Select a layer first." : "More than one layer selected.");
      if (onComplete) onComplete(false);
      return false;
    }
    return this.ensureSelectedLayersPixelEditable(showFeedback, requirePixelSurface, returnRasterizeConfirm, onComplete);
  }

  ensureSelectedLayersPixelEditable(showFeedback, requirePixelSurface, returnRasterizeConfirm, onComplete) {
    if (showFeedback == null) showFeedback = true;
    if (requirePixelSurface == null) requirePixelSurface = false;

    function finish(allowed) {
      if (onComplete) onComplete(allowed);
    }
    if (this.activeChannels.length != 0) {
      finish(true);
      return true;
    }
    for (let layerIdx = 0; layerIdx < this.selectedLayerIndices.length; layerIdx++) {
      const layer = this.layers[this.selectedLayerIndices[layerIdx]];
      const checkPixelSurface = requirePixelSurface || layer.pixelContent <= 0;
      if (layer.add.lsct != null && layer.add.lsct != LayerSectionType.Normal && layer.pixelContent != 1) {
        if (showFeedback) alert(Locale.get("brushAndMessages.toolHints.layerIsNotEditable"));
        finish(false);
        return false;
      }
      if (checkPixelSurface && !layer.hasPixelData()) {
        if (showFeedback) alert(Locale.get("brushAndMessages.toolHints.layerIsNotEditable"));
        finish(false);
        return false;
      }
      if (layer.add.TySh) {
        return this.promptRasterizeLayer(showFeedback, "brushAndMessages.toolHints.textLayerMustBeRasterizedFirst", returnRasterizeConfirm, onComplete);
      }
      if (layer.add.placedData) {
        return this.promptRasterizeLayer(showFeedback, "brushAndMessages.toolHints.smartObjectMustBeRasterizedFirst", returnRasterizeConfirm, onComplete);
      }
      if (layer.isLockBitSet(1) || layer.isLockBitSet(31)) {
        if (showFeedback) alert(Locale.get("layer.thisLayerIsLocked"));
        finish(false);
        return false;
      }
    }
    finish(true);
    return true;
  }

  promptRasterizeLayer(showFeedback, messageKey, returnRasterizeConfirm, onComplete) {
    const message = Locale.get(messageKey);
    const confirmMessage = message + ". " + Locale.get("layer.rasterise") + "?";

    function finish(confirmed) {
      if (onComplete) onComplete(returnRasterizeConfirm ? !!confirmed : false);
    }
    if (showFeedback && typeof showFeedback == "object") {
      const dispatcher = showFeedback;
      const dispatchRasterize = function () {
        const rasterizeEvent = new AppEvent(EventType.historyGrouped, true);
        rasterizeEvent.data = {
          uf: "rasterizeLayer",
          actionDescriptor: {
            classID: "rasterizeLayer",
            null: {
              t: "obj ",
              v: [{ t: "Enmr", v: { classID: "Lyr", typeID: "Ordn", enum: "Trgt" } }],
            },
          },
        };
        dispatcher.dispatch(rasterizeEvent);
      };
      const onConfirm = function (confirmed) {
        if (confirmed) dispatchRasterize();
        finish(confirmed);
      };
      const syncConfirmed = tryNativeConfirmSync(confirmMessage);
      if (syncConfirmed !== null) {
        onConfirm(syncConfirmed);
        return returnRasterizeConfirm ? syncConfirmed : false;
      }
      const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
      if (tauri && tauri.core && typeof tauri.core.invoke == "function") {
        promptConfirmUser(confirmMessage, { title: "PhotoSuite" }, onConfirm);
      } else {
        alert(message);
        onConfirm(false);
      }
      return false;
    }
    if (showFeedback) alert(message);
    finish(false);
    return false;
  }

  isLayerVisible(layerIndex) {
    const section = this.root.getSectionByIndex(layerIndex);
    if (section.parent) return section.layer.isVisible() && this.isLayerVisible(section.parent.index);
    else return section.layer.isVisible();
  }

  getArtboardForLayer(layerIndex) {
    const section = this.root.getSectionByIndex(layerIndex);
    if (section == null) return null;
    const layer = section.layer;
    if (layer.add.artb) return layer.getArtboardRect();
    if (section.parent) return this.getArtboardForLayer(section.parent.index);
    return null;
  }

  checkSelectionNonEmpty() {
    const selectedLayer = this.layers[this.selectedLayerIndices[0]];
    if (selectedLayer.pixelContent <= 0 && !selectedLayer.rect.overlaps(this.selectionMask.rect)) {
      alert("Selected area is empty.");
      return false;
    }
    if (this.selectedLayerIndices.length == 1 && this.selectionMask) {
      const alphaScratch = allocBuffer(this.selectionMask.channel.length);
      copyAlphaToChannel(selectedLayer.buffer, selectedLayer.rect, alphaScratch, this.selectionMask.rect);
      multiplyBuffers(this.selectionMask.channel, alphaScratch);
      if (isBufferUniform(alphaScratch, 0)) {
        alert("Selected area is empty.");
        return false;
      }
    }
    return true;
  }

  getRotationAngle() {
    const key = "r" + RESOURCE_ROTATION_ANGLE;
    if (this.resources[key] == null) this.setRotationAngle(30);
    return BinaryUtils.readInt32BE(this.resources[key], 0);
  }

  setRotationAngle(angleDegrees) {
    const key = "r" + RESOURCE_ROTATION_ANGLE;
    if (this.resources[key] == null) this.resources[key] = new Uint8Array(4);
    if (BinaryUtils.readInt32BE(this.resources[key], 0) == angleDegrees) return;
    BinaryUtils.writeInt32BE(this.resources[key], 0, angleDegrees);
    this.invalidateLayerEffects();
  }

  getGlobalLightAngle() {
    const key = "r" + RESOURCE_GLOBAL_LIGHT_ANGLE;
    if (this.resources[key] == null) this.setGlobalLightAngle(30);
    return BinaryUtils.readInt32BE(this.resources[key], 0);
  }

  setGlobalLightAngle(angleDegrees) {
    const key = "r" + RESOURCE_GLOBAL_LIGHT_ANGLE;
    if (this.resources[key] == null) this.resources[key] = new Uint8Array(4);
    if (BinaryUtils.readInt32BE(this.resources[key], 0) == angleDegrees) return;
    BinaryUtils.writeInt32BE(this.resources[key], 0, angleDegrees);
    this.invalidateLayerEffects();
  }

  findLinkedItemByTag(linkedTag) {
    if (this.add.lnk2 == null) return null;
    for (let linkIdx = 0; linkIdx < this.add.lnk2.length; linkIdx++)
      if (this.add.lnk2[linkIdx].tag == linkedTag) return this.add.lnk2[linkIdx];
    return null;
  }

  isLinkedItemEditable(linkedTag) {
    const linkedItem = this.findLinkedItemByTag(linkedTag);
    if (linkedItem == null) return false;
    const formatId = detectFormat(linkedItem.raw.buffer);
    if (formatId == null) return false;
    if (getFormat(formatId) != null || formatId == "psd") return true;
    return false;
  }

  resolveLinkedItemRaster(linkedTag, cropMode, targetSize, decodeMode) {
    const linkedItem = this.findLinkedItemByTag(linkedTag);
    if (linkedItem == null) return null;
    linkedItem.getRasterData(cropMode, targetSize, decodeMode);
    if (linkedItem.rasterCache) return linkedItem;
  }

  ensureCompositeBuffer() {
    const docWidth = this.width;
    const docHeight = this.height;
    if (LayerSystem.webglEnabled && this.glTexture == null) this.glTexture = new LayerSystem.RgbaTexture(docWidth, docHeight, true);
    if (this.buffer == null || this.buffer.length != docWidth * docHeight * 4 || (LayerSystem.webglEnabled && (this.glTexture.width != docWidth || this.glTexture.height != docHeight))) {
      this.buffer = allocBuffer(docWidth * docHeight * 4);
      if (this.glTexture) this.glTexture.delete();
      if (LayerSystem.webglEnabled) this.glTexture = new LayerSystem.RgbaTexture(docWidth, docHeight, true);
    }
  }

  initCompositeBuffer() {
    this.ensureCompositeBuffer();
    if (LayerSystem.webglEnabled) {
      this.glTexture.set(this.buffer);
    }
  }

  composite(maxLayerDepth) {
    const docWidth = this.width;
    const docHeight = this.height;
    const fullRect = new Rect(0, 0, docWidth, docHeight);
    const dirtyIntersect = fullRect.intersect(this.dirtyRect);
    this.ensureCompositeBuffer();
    if (dirtyIntersect.isEmpty()) return;
    clearCompositeDirtyRegion(this, fullRect, dirtyIntersect);
    const renderTarget = LayerSystem.webglEnabled ? this.glTexture : this.buffer;
    if (maxLayerDepth == null) maxLayerDepth = 1e9;
    compositeLayerGpu(this.root, renderTarget, fullRect, dirtyIntersect, this, [], maxLayerDepth);
    this.lastGLDirtyRect = this.dirtyRect.clone();
  }

  newLayer(skipLayerId) {
    const layer = new Layer();
    layer.rect = new Rect(0, 0, 0, 0);
    layer.buffer = allocBuffer(1);
    layer.add.luni = new Point(0, 0);
    if (skipLayerId != true) layer.add.lyid = this.generateLayerId();
    layer.add.lsct = LayerSectionType.Normal;
    layer.add.lclr = 0;
    layer.add.fxrp = new Point(0, 0);
    return layer;
  }

  createGroupEndLayer(skipLayerId) {
    const groupEndLayer = this.newLayer(skipLayerId);
    groupEndLayer.setName("</Layer group>");
    groupEndLayer.add.lsct = LayerSectionType.BoundingDivider;
    groupEndLayer.layerFlags = 24;
    return groupEndLayer;
  }

  isModified() {
    return this.historyIndex != this.savedHistoryIndex;
  }

  pushHistory(historyEntry) {
    while (this.history.length > this.historyIndex + 1) this.history.pop();
    if (this.savedHistoryIndex > this.historyIndex) this.savedHistoryIndex = -1;
    if (historyEntry.routingChannel.id != EventChannel.EVENT_FILTER_STACK) {
      this.layerCompsModified = true;
      if (this.layerComps.lastAppliedComp) {
        delete this.layerComps.lastAppliedComp;
        this.panelsDirty = true;
      }
    }
    this.history.push(historyEntry);
    this.historyIndex++;
    this.panelsDirty = true;
    const trimmed = trimVisibleHistoryStack(this.history, this.historyIndex);
    this.history = trimmed.history;
    this.historyIndex = trimmed.historyIndex;
  }

  getLastHistoryEntry() {
    if (this.historyIndex != this.history.length - 1) return null;
    return this.history[this.history.length - 1];
  }

  resolveLayerSelection(includeNestedGroups, singleLayerIndex, includeGroupSectionNodes, includeGroupAncestors) {
    if (includeNestedGroups == null) includeNestedGroups = false;
    const layerIndices = singleLayerIndex != null ? [singleLayerIndex] : this.selectedLayerIndices.slice(0);
    if (includeGroupAncestors) {
      const groupAnchorIndices = [];
      for (let layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) {
        const groupIndex = this.layers[layerIndices[layerIdx]].groupIndex;
        if (groupIndex != 0 && groupAnchorIndices.indexOf(groupIndex) == -1) groupAnchorIndices.push(groupIndex);
      }
      for (let layerIdx = 0; layerIdx < this.layers.length; layerIdx++) {
        const groupIndex = this.layers[layerIdx].groupIndex;
        if (groupIndex != 0 && groupAnchorIndices.indexOf(groupIndex) != -1 && layerIndices.indexOf(layerIdx) == -1) layerIndices.push(layerIdx);
      }
    }
    const resolvedIndices = [];
    for (let layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) {
      const groupLayerIndices = this.collectGroupLayers(layerIndices[layerIdx], includeNestedGroups);
      for (let innerIdx = 0; innerIdx < groupLayerIndices.length; innerIdx++)
        if (resolvedIndices.indexOf(groupLayerIndices[innerIdx]) == -1) resolvedIndices.push(groupLayerIndices[innerIdx]);
      if (includeGroupSectionNodes) {
        let sectionNode = this.root.getSectionByIndex(layerIndices[layerIdx]);
        while (sectionNode.parent != null && sectionNode.parent.parent != null) {
          sectionNode = sectionNode.parent;
          if (resolvedIndices.indexOf(sectionNode.index) == -1) {
            resolvedIndices.push(sectionNode.index, sectionNode.groupEndIndex);
          }
        }
      }
    }
    return resolvedIndices;
  }

  duplicateLayers(singleLayerIndex, skipRename, includeGroupAncestors) {
    const layerIndicesToDuplicate = this.resolveLayerSelection(false, singleLayerIndex, null, includeGroupAncestors);
    layerIndicesToDuplicate.sort((indexA, indexB) => indexA - indexB);
    const usedNames = {};
    for (let layerIdx = 0; layerIdx < this.layers.length; layerIdx++) {
      usedNames[this.layers[layerIdx].getName()] = true;
    }
    const clonedLayers = [];
    for (let selectionIdx = 0; selectionIdx < layerIndicesToDuplicate.length; selectionIdx++) {
      const clonedLayer = this.layers[layerIndicesToDuplicate[selectionIdx]].clone();
      clonedLayer.add.lyid = this.generateLayerId();
      clonedLayer.add.lspf = 0;
      if (clonedLayer.hasSmartFilters()) {
        const smartObjectLinkedItem = clonedLayer.getLinkedPlacedItem(this);
        const clonedLinkedItem = Document.cloneLinkedItem(smartObjectLinkedItem);
        this.addPlacedItemId(clonedLinkedItem);
        clonedLayer.add.placedData.placed.v = clonedLinkedItem.id;
      }
      clonedLayer.invalidate(this);
      const duplicateName = computeDuplicateName(clonedLayer.getName(), usedNames);
      const parentAlsoSelected = layerIndicesToDuplicate.indexOf(this.root.getSectionByIndex(layerIndicesToDuplicate[selectionIdx]).parent.index) != -1;
      if (skipRename != true && !parentAlsoSelected) clonedLayer.setName(duplicateName);
      usedNames[duplicateName] = true;
      clonedLayers.push(clonedLayer);
    }
    return clonedLayers;
  }

  getPaths(forPathEdit) {
    const pathEntries = [];
    const selectedPathIndices = [];
    let layerPathOrdinal = 0;
    for (let pathIdx = 1; pathIdx < this.paths.length; pathIdx++) {
      const pathEntry = this.paths[pathIdx];
      pathEntry.idx = -1 - pathIdx;
      pathEntries.push(pathEntry);
      if (this.selectedWorkPaths.indexOf(pathIdx) != -1) selectedPathIndices.push(pathEntries.length - 1);
    }
    if (this.paths[0].add.vmsk.pathRecords.length > 2) {
      const workPathEntry = this.paths[0];
      workPathEntry.idx = -1;
      pathEntries.push(workPathEntry);
      if (this.selectedWorkPaths.indexOf(0) != -1) selectedPathIndices.push(pathEntries.length - 1);
    }
    const useDefaultLayerPathSelection = this.selectedLayerPaths == null;
    if (useDefaultLayerPathSelection) this.selectedLayerPaths = [];
    for (let selectionIdx = this.selectedLayerIndices.length - 1; selectionIdx >= 0; selectionIdx--) {
      const layer = this.layers[this.selectedLayerIndices[selectionIdx]];
      const textShape = layer.add.TySh;
      if (layer.add.vmsk != null && (layer.pathLayerActive || layer.hasFillContent())) {
        const shapePathEntry = Document.createPathEntry("\"" + layer.getName() + "\" Shape Path", layer.add);
        shapePathEntry.idx = this.selectedLayerIndices[selectionIdx];
        pathEntries.push(shapePathEntry);
        if (useDefaultLayerPathSelection) this.selectedLayerPaths.push(layerPathOrdinal);
        if (this.selectedLayerPaths.indexOf(layerPathOrdinal) != -1) selectedPathIndices.push(pathEntries.length - 1);
        layerPathOrdinal++;
      }
      if (forPathEdit != true && textShape && textShape.add && isIdentityWarp(textShape.warpDescriptor)) {
        const textPathEntry = Document.createPathEntry("\"" + layer.getName().slice(0, 10) + "..\" Text Path", textShape.add);
        textPathEntry.idx = 1e6 + this.selectedLayerIndices[selectionIdx];
        pathEntries.push(textPathEntry);
        selectedPathIndices.push(pathEntries.length - 1);
        layerPathOrdinal++;
      }
    }
    if (selectedPathIndices.length == 0 && forPathEdit) {
      this.paths[0].idx = -1;
      this.selectedWorkPaths = [0];
      selectedPathIndices.push(pathEntries.length);
      pathEntries.push(this.paths[0]);
    }
    return [pathEntries, selectedPathIndices];
  }

  collectGroupLayers(layerIndex, includeNestedGroups) {
    const layerIndices = [];
    const sectionNode = this.root.getSectionByIndex(layerIndex);
    if (sectionNode) sectionNode.collectLayerIndices(layerIndices, includeNestedGroups);
    return layerIndices;
  }

  recalculateBounds() {
    renderThumbnailCanvases(this.root, this, new Rect(0, 0, this.width, this.height), 32);
  }

  finishImportFillDeferred() {
    if (!this.needsFillRasterization) return;
    this.needsFillRasterization = false;
    this.markDirty();
  }

  setLayers(layers) {
    for (let layerIdx = 0; layerIdx < this.layers.length; layerIdx++) {
      const existingLayer = this.layers[layerIdx];
      if (layers.indexOf(existingLayer) == -1) {
        existingLayer.renderCache.dispose();
        existingLayer.markDirty();
      }
    }
    this.layers = layers.slice(0);
    this.rebuildLayerTree();
  }

  rebuildLayerTree() {
    const layers = this.layers;
    const layerCount = layers.length;
    this.root = new LayerGroup();
    const rootAnchorLayer = this.newLayer(true);
    rootAnchorLayer.blendMode = "pass";
    rootAnchorLayer.add.lsct = LayerSectionType.OpenGroup;
    const groupEndLayer = this.createGroupEndLayer(true);
    const layerStack = [groupEndLayer, ...layers, rootAnchorLayer];
    this.root.buildFromLayers(layerStack, 0, 0);
    if (this.selectedLayerIndices.length === 0) this.selectedLayerIndices = [layerCount - 1];
  }

  expandParentGroups() {
    if (this.selectedLayerIndices.length != 1) return;
    let selectedSection = this.root.getSectionByIndex(this.selectedLayerIndices[0]);
    while (selectedSection.parent != null) {
      selectedSection.parent.layer.add.lsct = LayerSectionType.OpenGroup;
      selectedSection = selectedSection.parent;
    }
    this.dirty = this.layerTreeExpansionDirty = true;
  }

  sanitizeGroupDepth() {
    this.rebuildLayerTree();
    const sectionStack = [this.root];
    let depthCount = 0;
    while (sectionStack.length != 0) {
      const topSection = sectionStack.pop();
      depthCount++;
      if (topSection.layer.add.lsct == LayerSectionType.OpenGroup)
        for (let childIdx = 0; childIdx < topSection.children.length; childIdx++) sectionStack.push(topSection.children[childIdx]);
    }
    if (depthCount > 1e3) {
      const rootChildren = this.root.children;
      for (let childIdx = 0; childIdx < rootChildren.length; childIdx++)
        if (rootChildren[childIdx].layer.add.lsct == LayerSectionType.OpenGroup) rootChildren[childIdx].layer.add.lsct = LayerSectionType.ClosedGroup;
    }
  }

  static regenerateLinkedUIDs(doc) {
    if (doc.add.lnk2)
      for (let linkIdx = 0; linkIdx < doc.add.lnk2.length; linkIdx++) {
        const oldTag = doc.add.lnk2[linkIdx].tag;
        doc.add.lnk2[linkIdx].tag = Document.generateUID();
        for (let layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
          const placedData = doc.layers[layerIdx].add.placedData;
          if (placedData && placedData.Idnt.v == oldTag) placedData.Idnt.v = doc.add.lnk2[linkIdx].tag;
        }
      }
  }

  static generateUID() {
    return generateUuid();
  }

  static cloneLinkedItem(linkedItem) {
    return {
      id: Document.generateUID(),
      buffer: linkedItem.buffer.slice(0),
      rect: linkedItem.rect.clone(),
      d: linkedItem.d ? linkedItem.d.clone() : null,
    };
  }

  static createBlankLinkedItem(placedItemId) {
    return {
      id: placedItemId,
      rect: new Rect(),
      buffer: allocBuffer(1),
      d: new Mask(),
    };
  }

  static createPathEntry(pathName, layerAddPayload) {
    if (layerAddPayload == null) layerAddPayload = { vmsk: new VectorMask() };
    if (layerAddPayload.vogk == null) {
      layerAddPayload.vogk = [];
      const subpathCount = countSubpaths(layerAddPayload.vmsk.pathRecords);
      for (let subpathIdx = 0; subpathIdx < subpathCount; subpathIdx++) layerAddPayload.vogk.push(createEmptyKeyOrigin());
    }
    return { name: pathName, idx: 0, add: layerAddPayload };
  }

  static buildMakeDocumentEvent(width, height, dpi, documentName, fillMode) {
    const makeDescriptor = {
      __name: "Make",
      classID: "Mk",
      Nw: {
        t: "Objc",
        v: {
          classID: "Dcmn",
          Nm: { t: "TEXT", v: documentName },
          Md: { t: "type", v: { classID: "RGBM" } },
          Wdth: { t: "UntF", v: { type: "#Rlt", val: width } },
          Hght: { t: "UntF", v: { type: "#Rlt", val: height } },
          Rslt: { t: "UntF", v: { type: "#Rsl", val: dpi } },
          pixelScaleFactor: { t: "doub", v: 1 },
          Fl: { t: "enum", v: { Fl: fillMode } },
          Dpth: { t: "long", v: 8 },
          profile: { t: "TEXT", v: "sRGB IEC61966-2.1" },
        },
      },
    };
    return { uf: "make", actionDescriptor: makeDescriptor };
  }

  static createNewDocument(descriptor, creationOptions) {
    let docWidth = 0;
    let docHeight = 0;
    let docDpi = 72;
    const clipboardSize = creationOptions.clipboardCopyRect;
    const useClipboardPreset = descriptor.preset && descriptor.preset.v == "Clipboard";
    if (useClipboardPreset) {
      docWidth = clipboardSize.width;
      docHeight = clipboardSize.height;
    } else {
      docWidth = descriptor.Wdth.v.val;
      docHeight = descriptor.Hght.v.val;
      docDpi = descriptor.Rslt.v.val;
    }
    const doc = new Document((descriptor.Nm ? descriptor.Nm.v : Locale.get("dialogs.newProject")) + ".psd");
    doc.width = docWidth;
    doc.height = docHeight;
    doc.dpi = docDpi;
    const backgroundLayer = doc.newLayer();
    backgroundLayer.setName("Background");
    doc.setLayers([backgroundLayer]);
    backgroundLayer.add.lspf = 1 << 2;
    const fillMode = descriptor.Fl ? descriptor.Fl.v.Fl : "Wht";
    if (fillMode != "Trns") {
      let bgColorRgb = creationOptions.bgColor;
      bgColorRgb = (bgColorRgb & 255) << 16 | (bgColorRgb >>> 8 & 255) << 8 | bgColorRgb >>> 16;
      backgroundLayer.rect = new Rect(0, 0, docWidth, docHeight);
      backgroundLayer.buffer = allocBuffer(docWidth * docHeight * 4);
      fillBuffer(backgroundLayer.buffer, { Wht: 4294967295, BckC: 255 << 24 | bgColorRgb }[fillMode]);
    }
    doc.buffer = allocBuffer(docWidth * docHeight * 4);
    return doc;
  }
}
