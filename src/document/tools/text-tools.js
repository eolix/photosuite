/**
 * Type tool: create and edit point/paragraph text layers, selection, warp, and style.
 */

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { Locale } from "../../core/i18n/locale.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { Matrix2D, scaleIgnoringRotation } from "../../core/math/matrix2d.js";
import { HistoryEntry } from "../model/document.js";
import { readClipboardText, writeClipboardText } from "../../core/system-clipboard.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { TextLayout } from "../../features/text/text-layout.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio, isInDOM } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolBase, ToolId } from "../model/tool-base.js";
import { TransformBox } from "../transform/transform-box.js";
import { snapPointToGuides } from "../model/guide-snapping.js";
import { appendPath, distanceFromPointToRect, findNearestVertexIndex, normalizePathToCubics, rectToPathOutline, subdividePathByFlatness, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { cornersToHomography, toMatrix2D } from "../../engine/compositing/homography.js";
import { hitTestPoint } from "../../engine/compositing/selection-utils.js";
import { knotCountInSubpath, recordIndexForSubpath } from "../../engine/compositing/path-records.js";
import { createForSubpaths } from "../../engine/compositing/key-origins.js";
import { nearestUvOnMesh, warpCoordsThroughMesh } from "../../engine/compositing/image-renderer.js";
import { getWarpControlPoints, isIdentityWarp } from "../../engine/compositing/warp.js";


/** Characters that terminate a word for double-click / ctrl-arrow selection. */
const WORD_DELIMITERS = " \t\n,.?!_-+=@#$%^&*'\"(){}[]\\/<>:;|";

function dispatchCursorOverlay(dispatcher, cursorOverlayId) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId,
  };
  dispatcher.dispatch(cursorEvent);
}

function buildCaretOutline(caretRect, rotation) {
  const pivotX = caretRect.x;
  const pivotY = caretRect.y + caretRect.height;
  const caretMatrix = new Matrix2D();
  caretMatrix.translate(-pivotX, -pivotY);
  caretMatrix.rotate(-rotation);
  caretMatrix.translate(pivotX, pivotY);
  caretRect.y += caretRect.height * 0.27;
  const caretOutline = rectToPathOutline(caretRect);
  transformCoordPairs(caretOutline.coords, caretMatrix, caretOutline.coords);
  return caretOutline;
}

export function TextTool() {
  ToolBase.call(this, "tools.typeTool", ToolId.TOOL_TYPE, "tools/htype");
  this.trackedModifierKeyCodes = [];
  this.textDocument = null;
  this.textAppState = null;
  this.appController = null;
  this.textWritingMode = 1;
  this.restoreToolIdAfterEdit = null;
  this.lastCaretClickTimeMs = 0;
  this.caretClickCount = 0;
  this.clipboardStyleJson = null;
  this.clipboardTextSlice = null;
  this.activeLayer = null;
  this.editingLayerIndices = null;
  this.textCurveData = null;
  this.editSessionSnapshot = null;
  this.warpMeshBackup = null;
  this.textCursorStyle = null;
  this.activeOp = null;
  this.textWarpTransform = null;
  this.textWarpBoundsSnapshot = null;
  this.isTransformDragging = false;
  this.needsOverlayRefresh = false;
  this.awaitingTextLayerOnDrag = false;
  this.textDragStartPointer = null;
  this.textTransformDragOrigin = null;
  this.layerMatrixAtDragStart = null;
  this.pendingMultiLayerStyleApply = false;
  this.isWarpDialogActive = false;
  this.selAnchor = -1;
  this.selectionEndIndex = -1;
  this.fontRetryTimer = null;
  this.textArea = document.createElement("textarea");
  this.textArea.setAttribute("style", "font-family:Arial; font-size:14px; z-index:-1; " + " position:absolute; top:0px; left:0px;  pointer-events: none; opacity:0; width:" + (window.innerWidth - 10) + "px; height:150px;");
  this.textArea.addEventListener("input", this.syncTextAreaFromEngine.bind(this), false);
  this.textArea.addEventListener("keydown", this.onTextAreaKeyDown.bind(this), false)
};

function installTextToolPrototype() {
TextTool.prototype.wantsInput = function(pointerState) {
  return pointerState.isDown;
};
TextTool.prototype.onDocumentStateChange = function(doc, dispatcher, appData, keyboard) {
  if (this.activeLayer != null) return;
  this.appController = dispatcher;
  this.textDocument = doc;
  var textLayerIndices = this.listTextLayerIndices(doc);
  if (textLayerIndices.length == 0) return;
  var fontTable = null,
    textStyles = [],
    paraStyles = [],
    lastTextShape = null;
  for (var layerIdx = 0; layerIdx < textLayerIndices.length; layerIdx++) {
    var layer = doc.layers[textLayerIndices[layerIdx]],
      textShape = lastTextShape = layer.add.TySh,
      styleStart = 0,
      styleEnd = TextEngineData.getLayerText(textShape.engineData).length - 2,
      layerStyle = TextEngineData.getTextStyle(textShape.engineData, styleStart, styleEnd);
    TextEngineData.scaleTextStyle(layerStyle, scaleIgnoringRotation(textShape.transform));
    if (layerStyle.textStyle.Font != null) layerStyle.textStyle.Font = layerStyle.fontSet[layerStyle.textStyle.Font].Name;
    fontTable = layerStyle.fontSet;
    textStyles.push(layerStyle.textStyle);
    paraStyles.push(layerStyle.paraStyle)
  }
  var mergedStyle = {
    fontSet: fontTable,
    textStyle: TextEngineData.intersectStyles(textStyles),
    paraStyle: TextEngineData.intersectStyles(paraStyles)
  };
  if (mergedStyle.textStyle.Font != null) TextEngineData.setTextFont(mergedStyle, mergedStyle.textStyle.Font);
  // The AA-mode sync in the panel dispatch reads per-shape state; the last
  // selected text layer's shape is the representative one.
  this.dispatchTextStylePanel(dispatcher, mergedStyle, lastTextShape)
};
TextTool.prototype.listTextLayerIndices = function(doc) {
  var layerIndices = [];
  for (var layerIdx = 0; layerIdx < doc.selectedLayerIndices.length; layerIdx++)
    if (doc.layers[doc.selectedLayerIndices[layerIdx]] && doc.layers[doc.selectedLayerIndices[layerIdx]].add.TySh) layerIndices.push(doc.selectedLayerIndices[layerIdx]);
  return layerIndices
};
TextTool.prototype.syncTextSelectionFromTextArea = function() {
  var textArea = this.textArea;
  var start = Math.min(textArea.selectionStart, textArea.selectionEnd);
  var end = Math.max(textArea.selectionStart, textArea.selectionEnd);
  this.selAnchor = start;
  this.selectionEndIndex = end;
};

TextTool.prototype.insertTextAtSelection = function(text) {
  if (!text || text.length === 0 || this.activeLayer == null) return;
  var textArea = this.textArea;
  var selStart = Math.min(this.selAnchor, this.selectionEndIndex);
  var selEnd = Math.max(this.selAnchor, this.selectionEndIndex);
  var value = textArea.value;
  textArea.value = value.slice(0, selStart) + text + value.slice(selEnd);
  textArea.selectionStart = textArea.selectionEnd = selStart + text.length;
  this.selAnchor = selStart;
  this.selectionEndIndex = selEnd;
  this.syncTextAreaFromEngine(null);
  textArea.focus();
};

TextTool.prototype.copyTextSelection = function(appData) {
  if (this.activeLayer == null || this.isWarpDialogActive) return;
  if (this.activeLayer.add == null || this.activeLayer.add.TySh == null) return;
  this.syncTextSelectionFromTextArea();
  var textArea = this.textArea;
  var selStart = Math.min(textArea.selectionStart, textArea.selectionEnd);
  var selEnd = Math.max(textArea.selectionStart, textArea.selectionEnd);
  if (selStart === selEnd) return;
  var selected = textArea.value.slice(selStart, selEnd);
  this.clipboardTextSlice = selected;
  this.clipboardStyleJson = JSON.stringify(this.textAppState.currentTextStyle);
  if (appData) {
    appData.clipboardPixelPayload = null;
    appData.pathClipboard = null;
    appData.isInternalClipboardCopy = false;
  }
  writeClipboardText(selected);
};

TextTool.prototype.cutTextSelection = function(appData) {
  if (this.activeLayer == null || this.isWarpDialogActive) return;
  if (this.activeLayer.add == null || this.activeLayer.add.TySh == null) return;
  this.syncTextSelectionFromTextArea();
  var textArea = this.textArea;
  var selStart = Math.min(textArea.selectionStart, textArea.selectionEnd);
  var selEnd = Math.max(textArea.selectionStart, textArea.selectionEnd);
  if (selStart === selEnd) return;
  this.copyTextSelection(appData);
  var value = textArea.value;
  textArea.value = value.slice(0, selStart) + value.slice(selEnd);
  textArea.selectionStart = textArea.selectionEnd = selStart;
  this.selAnchor = selStart;
  this.selectionEndIndex = selStart;
  this.syncTextAreaFromEngine(null);
  textArea.focus();
  if (this.textDocument) this.refreshTextOverlays(this.textDocument);
};

TextTool.prototype.pasteTextFromClipboard = function(appData) {
  if (this.activeLayer == null || this.isWarpDialogActive) return;
  if (this.activeLayer.add == null || this.activeLayer.add.TySh == null) return;
  var self = this;
  var applyText = function(text) {
    if (!text || text.length === 0) return;
    if (appData) appData.clipboardPixelPayload = null;
    self.insertTextAtSelection(text);
  };
  readClipboardText().then(function(text) {
    if (text && text.length > 0) applyText(text);
    else if (self.clipboardTextSlice != null) applyText(self.clipboardTextSlice);
  });
};

TextTool.prototype.selectAllText = function() {
  if (this.activeLayer == null || this.isWarpDialogActive) return;
  if (this.activeLayer.add == null || this.activeLayer.add.TySh == null) return;
  var textArea = this.textArea,
    engineText = TextEngineData.getLayerText(this.activeLayer.add.TySh.engineData);
  this.selAnchor = 0;
  this.selectionEndIndex = Math.max(0, engineText.length - 1);
  textArea.selectionStart = 0;
  textArea.selectionEnd = textArea.value.length;
  textArea.focus();
  this.refreshTextSelectionOverlay();
  if (this.textDocument) this.refreshTextOverlays(this.textDocument)
};
/**
 * Route a text action event (menu, panel, script, or warp dialog) to its
 * handler. Text-area editing events arrive through the DOM listeners instead.
 */
TextTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, appData) {
  var actionKind = event.actionKind;
  if (actionKind == "insertText" && this.activeLayer) this.insertTextReplacingDomSelection(event.insertText);
  if (actionKind == "insertGlyph" && this.activeLayer) this.insertGlyphAtDomSelection(event.insertGlyphId);
  if (actionKind == "selectAll" && this.activeLayer) this.selectAllText();
  if (actionKind == "textCopy" && this.activeLayer) this.copyTextSelection(appData);
  if (actionKind == "textCut" && this.activeLayer) this.cutTextSelection(appData);
  if (actionKind == "textPaste" && this.activeLayer) this.pasteTextFromClipboard(appData);
  if (actionKind == "updateStyles") this.applyPanelStyles(doc, dispatcher, appData);
  if (actionKind.startsWith("warp")) this.handleWarpDialogAction(event, dispatcher, appData);
  if (actionKind == "editCurr") this.beginEditingLayer(event.targetLayerIndex, dispatcher, doc, keyboard, appData);
  if (actionKind == "switchPntPrgr") this.togglePointParagraphText(dispatcher, doc, keyboard, appData);
  if (actionKind == "newED") this.replaceEngineData(event, doc, appData);
  if (actionKind == "fromAction") this.createTextLayerFromScriptedAction(event, dispatcher, doc, keyboard, appData);
};

/** Insert text at the DOM text-area selection (used by scripted insertText). */
TextTool.prototype.insertTextReplacingDomSelection = function(insertText, alternateGlyphId) {
  var textArea = this.textArea,
    textValue = textArea.value,
    selStart = textArea.selectionStart,
    selEnd = textArea.selectionEnd;
  textArea.value = textValue.slice(0, selStart) + insertText + textValue.slice(selEnd);
  textArea.selectionStart = textArea.selectionEnd = selStart + insertText.length;
  this.syncTextAreaFromEngine(null, alternateGlyphId);
  textArea.focus();
};

/**
 * Insert a glyph the font's cmap does not reach — an OpenType alternate or
 * ligature picked in the Glyphs panel. The text carries U+FFFD as a
 * placeholder character and the glyph id rides alongside it in the layer's
 * alternate-glyph run, which is what the shaper and the PSD writer read.
 */
TextTool.prototype.insertGlyphAtDomSelection = function(glyphId) {
  this.insertTextReplacingDomSelection("\uFFFD", glyphId);
};

/**
 * Apply the style panel's current style: to the active selection while
 * editing, otherwise to every selected text layer in one edit session.
 */
TextTool.prototype.applyPanelStyles = function(doc, dispatcher, appData) {
  if (this.activeLayer != null) {
    this.applyStyleToTextSelection(appData);
    return;
  }
  var textLayerIndices = this.listTextLayerIndices(doc),
    awaitingFonts = false;
  if (textLayerIndices.length == 0) return;
  this.activateTextLayers(doc, dispatcher, appData, textLayerIndices);
  for (var layerIdx = 0; layerIdx < textLayerIndices.length; layerIdx++) {
    var layer = doc.layers[textLayerIndices[layerIdx]],
      textShape = layer.add.TySh;
    TextEngineData.setAntiAliasMode(textShape, this.textWritingMode);
    this.activeLayer = layer;
    var layerText = TextEngineData.getLayerText(textShape.engineData);
    this.selAnchor = 0;
    this.selectionEndIndex = layerText.length - 1;
    TextEngineData.applyStyle(textShape.engineData, this.selAnchor, this.selectionEndIndex, this.scaleParagraphStyleForTransform(appData, textShape));
    var curveReady = this.ensureTextCurveData(doc, appData);
    if (curveReady == false) awaitingFonts = true;
  }
  if (awaitingFonts) {
    this.pendingMultiLayerStyleApply = true;
    return;
  }
  this.commitTextEdit(doc, dispatcher);
};

/** Warp dialog lifecycle: live-preview mesh, confirm commits, cancel restores. */
TextTool.prototype.handleWarpDialogAction = function(event, dispatcher, appData) {
  var actionKind = event.actionKind,
    wasWarpDialogActive = this.isWarpDialogActive;
  if (actionKind == "warp" || actionKind == "warpCancel") {
    if (actionKind == "warp") this.activeLayer.add.TySh.warpDescriptor = event.warpMesh;
    else this.activeLayer.add.TySh.warpDescriptor = this.warpMeshBackup;
    var warpDoc = this.textDocument;
    this.ensureTextCurveData(warpDoc, appData);
    if (!wasWarpDialogActive) this.refreshTextOverlays(warpDoc);
  }
  if (actionKind != "warp") this.textArea.focus();
  if ((actionKind == "warpConfirm" || actionKind == "warpCancel") && wasWarpDialogActive) {
    this.isWarpDialogActive = false;
    if (actionKind == "warpConfirm") this.commitTextEdit(this.textDocument, dispatcher);
    else this.cancel(this.textDocument, dispatcher);
  }
};

/** Enter edit mode on a specific text layer (double-click from another tool). */
TextTool.prototype.beginEditingLayer = function(targetLayerIndex, dispatcher, doc, keyboard, appData) {
  if (appData.activeToolId != ToolId.TOOL_TYPE) {
    this.restoreToolIdAfterEdit = appData.activeToolId;
    var activateToolEvent = new AppEvent(EventType.uiDispatch, true);
    activateToolEvent.data = {
      dispatchKind: UiCommand.setActiveToolPanelMode,
      documentModelType: ToolId.TOOL_TYPE
    };
    dispatcher.dispatch(activateToolEvent);
  }
  if (this.activeLayer != null) this.disable(doc, dispatcher, appData, keyboard);
  this.textDocument = doc;
  this.textAppState = appData;
  this.appController = dispatcher;
  this.activateTextLayers(doc, dispatcher, appData, [targetLayerIndex]);
  var layerText = TextEngineData.getLayerText(this.activeLayer.add.TySh.engineData);
  this.selAnchor = 0;
  this.selectionEndIndex = layerText.length - 1;
  this.refreshTextOverlays(doc);
  this.refreshTextSelectionOverlay();
  this.textArea.focus();
};

/**
 * Convert the selected layer between point and paragraph text by rebuilding
 * its engine data with a compensating origin offset, then routing through the
 * newED action for history.
 */
TextTool.prototype.togglePointParagraphText = function(dispatcher, doc, keyboard, appData) {
  if (this.activeLayer) return;
  var layer = doc.layers[doc.selectedLayerIndices[0]],
    textShape = layer.add.TySh,
    layerScale = textShape.transform.getScale(),
    engineDataClone = JSON.parse(JSON.stringify(textShape.engineData)),
    textType = TextEngineData.getTextType(engineDataClone),
    boxBounds = textType == 1 ? TextEngineData.getBoxBounds(engineDataClone) : [0, 0, Math.round(layer.rect.width * 1.05 / layerScale), Math.round(layer.rect.height * 1.25 / layerScale)],
    defaultStyle = TextEngineData.getTextStyle(engineDataClone, 0, 0),
    fontName = defaultStyle.fontSet[defaultStyle.textStyle.Font].Name,
    fontFace = appData.fontRegistry.loadFontFace(fontName),
    originOffsetX = [0, boxBounds[2], boxBounds[2] / 2][defaultStyle.paraStyle.Justification % 3],
    originOffsetY = fontFace ? TextLayout.computeAscenderHeight(fontFace, fontName, defaultStyle.textStyle) : defaultStyle.textStyle.FontSize * .8;
  TextEngineData.setTextType(engineDataClone, 1 - textType);
  if (textType == 0) {
    originOffsetX = -originOffsetX;
    originOffsetY = -originOffsetY;
    TextEngineData.setBoxBounds(engineDataClone, [0, 0, boxBounds[2], boxBounds[3]]);
  }
  var textMatrix = new Matrix2D(1, 0, 0, 1, originOffsetX, originOffsetY);
  textMatrix.concat(textShape.transform);
  this.handleInput({
    targetLayerIndex: doc.selectedLayerIndices[0],
    actionKind: "newED",
    engineData: engineDataClone,
    transformMatrix: textMatrix,
    historyLabelKey: textType == 1 ? "text.convertToPointText" : "text.convertToParagraphText"
  }, dispatcher, doc, keyboard, appData);
};

/** Swap a layer's engine data (and optionally transform), with history. */
TextTool.prototype.replaceEngineData = function(event, doc, appData) {
  var layer = doc.layers[event.targetLayerIndex],
    textShape = layer.add.TySh,
    snapshotsBefore = this.captureTextLayerSnapshots(doc, [event.targetLayerIndex]);
  textShape.engineData = event.engineData;
  if (event.transformMatrix) textShape.transform = event.transformMatrix;
  this.renderTextIntoLayer(layer, textShape, doc, appData);
  var historyEntry = new HistoryEntry(event.historyLabelKey ? event.historyLabelKey : this.name, this);
  historyEntry.data = {
    snapshotsBefore: snapshotsBefore,
    snapshotsAfter: this.captureTextLayerSnapshots(doc, [event.targetLayerIndex])
  };
  doc.pushHistory(historyEntry);
};

/** Re-layout and re-render a text layer's pixels from its engine data. */
TextTool.prototype.renderTextIntoLayer = function(layer, textShape, doc, appData) {
  if (!TextRenderer.checkFonts(textShape, appData.fontRegistry)) {
    doc.pendingTextRasterization = true;
    layer.markDirty();
    doc.markDirty();
    return;
  }
  var curveData = new TextLayout(textShape.engineData, appData.fontRegistry),
    textRender = TextRenderer.renderText(curveData, textShape);
  layer.rect = textRender.rect;
  layer.buffer = textRender.buffer;
  layer.markDirty();
  doc.markDirty();
};

/** Create and style a text layer from a scripted make-text action descriptor. */
TextTool.prototype.createTextLayerFromScriptedAction = function(event, dispatcher, doc, keyboard, appData) {
  var actionPayload = event.scriptActionPayload.actionDescriptor.Usng.v,
    textCoords = actionPayload.TxtC.v,
    docPointComponents = [];
  for (var axisIdx = 0; axisIdx < 2; axisIdx++) {
    var coordUnit = textCoords[axisIdx == 0 ? "Hrzn" : "Vrtc"].v,
      coordValue = coordUnit.val;
    if (coordUnit.type == "#Prc") coordValue = (axisIdx == 0 ? doc.width : doc.height) * (coordValue / 100);
    docPointComponents[axisIdx] = coordValue;
  }
  this.createTextLayerAtPoint(doc, dispatcher, appData, keyboard, doc.pathViewport.docToScreenPoint(docPointComponents[0], docPointComponents[1]));
  var layer = doc.layers[doc.selectedLayerIndices[0]],
    textShape = layer.add.TySh,
    engineData = textShape.engineData,
    layerText = TextEngineData.getLayerText(engineData);
  TextEngineData.deleteText(engineData, 0, layerText.length - 1);
  TextEngineData.insertText(engineData, 0, actionPayload.Txt.v.replace(/\r/g, "\n"));
  layerText = TextEngineData.getLayerText(engineData);
  for (var rangeKindIdx = 0; rangeKindIdx < 2; rangeKindIdx++) {
    var styleRanges = actionPayload[rangeKindIdx == 0 ? "Txtt" : "paragraphStyleRange"].v;
    for (var rangeIdx = 0; rangeIdx < styleRanges.length; rangeIdx++) {
      var rangeEntry = styleRanges[rangeIdx].v,
        rangeStart = rangeEntry.From.v,
        rangeEnd = Math.min(rangeEntry.T.v - 1, layerText.length - 1);
      rangeEntry = rangeEntry[rangeKindIdx == 0 ? "TxtS" : "paragraphStyle"].v;
      var layerStyle = TextEngineData.getTextStyle(engineData, rangeStart, rangeEnd),
        styleTarget = rangeKindIdx == 0 ? layerStyle.textStyle : layerStyle.paraStyle;
      for (var styleKey in rangeEntry) {
        var styleValue = rangeEntry[styleKey].v;
        if (styleKey == "Sz") styleTarget.FontSize = Math.round(styleValue.val);
        else if (styleKey == "fontPostScriptName") TextEngineData.setTextFont(layerStyle, styleValue);
        else if (styleKey == "Algn") styleTarget.Justification = {
          Cntr: 2
        } [styleValue.Alg];
        else if (styleKey == "Clr") styleTarget.FillColor.Values = [1, styleValue.Rd.v / 255, styleValue.Grn.v / 255, styleValue.Bl.v / 255]
      }
      TextEngineData.applyStyle(engineData, rangeStart, rangeEnd, layerStyle);
    }
  }
  this.renderTextIntoLayer(layer, textShape, doc, appData);
  this.commitTextEdit(doc, dispatcher);
};
TextTool.prototype.applyStyleToTextSelection = function(appData) {
  var selStart = Math.min(this.selAnchor, this.selectionEndIndex),
    selEnd = Math.max(this.selAnchor, this.selectionEndIndex),
    textShape = this.activeLayer.add.TySh;
  TextEngineData.setAntiAliasMode(textShape, this.textWritingMode);
  TextEngineData.applyStyle(textShape.engineData, selStart, selEnd - 1, this.scaleParagraphStyleForTransform(appData, textShape));
  var doc = this.textDocument,
    curveReady = this.ensureTextCurveData(doc, appData);
  if (curveReady) this.refreshTextOverlays(doc);
  if (document.activeElement.tagName.toLowerCase() != "input") this.textArea.focus()
};
TextTool.prototype.isModifierKey = function(keyCode) {
  return this.trackedModifierKeyCodes.indexOf(keyCode) != -1
};
TextTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
  var textArea = this.textArea;
  if (!isInDOM(textArea)) dispatcher.el.appendChild(textArea);
  this.textCursorStyle = "default";
  this.updateCursor(dispatcher)
};
TextTool.prototype.isActive = function() {
  return this.activeLayer != null;
};
TextTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.textDocument = doc;
  this.textAppState = appData;
  this.appController = dispatcher;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    isInactive = this.activeLayer == null;
  if (isInactive) {
    var layerAtPoint = TextTool.findTextLayerAtPoint(doc, docPoint);
    if (layerAtPoint == -2) {
      alert(Locale.get("layer.thisLayerIsLocked"));
      return
    }
    if (layerAtPoint >= 0) {
      if (!TextRenderer.checkFonts(doc.layers[layerAtPoint].add.TySh, appData.fontRegistry)) {
        // Fonts may still be loading asynchronously (system fonts / PDF fonts).
        // Don't block the UI with an alert; retry activation shortly.
        clearTimeout(this.fontRetryTimer);
        this.fontRetryTimer = setTimeout(() => {
          try {
            if (!this.textDocument || !this.textAppState) return;
            if (TextRenderer.checkFonts(this.textDocument.layers[layerAtPoint].add.TySh, this.textAppState.fontRegistry)) {
              this.activateTextLayers(this.textDocument, this.appController, this.textAppState, [layerAtPoint]);
              this.refreshTextOverlays(this.textDocument);
            }
          } catch (_) {}
        }, 80);
        return;
      }
      this.activateTextLayers(doc, dispatcher, appData, [layerAtPoint])
    } else {
      this.awaitingTextLayerOnDrag = true;
      this.textDragStartPointer = pointerState;
      return
    }
  }
  var textType = isInactive ? -1 : TextEngineData.getTextType(this.activeLayer.add.TySh.engineData),
    transformHandle = this.textWarpTransform ? this.textWarpTransform : this.activeOp;
  if (transformHandle && transformHandle.onMouseDown(doc, appData, keyboard, docPoint) && isIdentityWarp(this.activeLayer.add.TySh.warpDescriptor) || !isInactive && distanceFromPointToRect(docPoint, this.activeLayer.rect) > 20 / doc.pathViewport.zoomScale && (textType == 0 || textType == 1)) {
    this.isTransformDragging = true;
    this.textTransformDragOrigin = docPoint;
    this.layerMatrixAtDragStart = this.activeLayer.add.TySh.transform.clone();
    if (this.selAnchor == -1 && this.selectionEndIndex == -1) this.selAnchor = this.selectionEndIndex = this.hitTestTextCaretIndex(docPoint)
  } else {
    if (this.textCurveData == null) {
      // Ensure `TextLayout` exists; avoid hard fail if fonts are still loading.
      try {
        this.ensureTextCurveData(doc, appData, true);
      } catch (_) {}
      if (this.textCurveData == null) return;
    }
    this.needsOverlayRefresh = true;
    this.selAnchor = this.selectionEndIndex = this.hitTestTextCaretIndex(docPoint);
    var clickTimeMs = Date.now();
    if (clickTimeMs - this.lastCaretClickTimeMs > 300) this.caretClickCount = 0;
    this.caretClickCount++;
    this.lastCaretClickTimeMs = clickTimeMs;
    if (this.caretClickCount == 2) this.expandSelectionToWordBoundaries();
    if (this.caretClickCount == 3) this.syncSelectionFromCurveData();
    if (this.caretClickCount > 1) {
      this.needsOverlayRefresh = false
    }
  }
  this.refreshTextSelectionOverlay();
  this.refreshTextOverlays(doc)
};
TextTool.prototype.activateTextLayers = function(doc, dispatcher, appData, layerIndices) {
  var layer = doc.layers[layerIndices[0]];
  this.activeLayer = layer;
  this.emitEvent(dispatcher, EventType.uiDispatch, {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    subAction: "showactive"
  });
  this.editingLayerIndices = layerIndices;
  doc.selectedLayerIndices = layerIndices.slice(0);
  doc.expandParentGroups();
  doc.needsScrollToSelected = true;
  this.editSessionSnapshot = this.captureTextLayerSnapshots(doc, layerIndices);
  this.initTextTransformHandles(layer.add.TySh);
  this.ensureTextCurveData(doc, appData)
};
TextTool.prototype.initTextTransformHandles = function(textShape) {
  if (TextEngineData.getTextType(textShape.engineData) != 1) return;
  var boxBounds = TextEngineData.getBoxBounds(textShape.engineData);
  boxBounds = new Rect(0, 0, boxBounds[2] - boxBounds[0], boxBounds[3] - boxBounds[1]);
  var cornerCoords = [boxBounds.x, boxBounds.y, boxBounds.x + boxBounds.width, boxBounds.y, boxBounds.x + boxBounds.width, boxBounds.y + boxBounds.height, boxBounds.x, boxBounds.y + boxBounds.height];
  transformCoordPairs(cornerCoords, textShape.transform, cornerCoords);
  this.activeOp = new TransformBox(cornerCoords, false, false, false, true)
};
TextTool.prototype.expandSelectionToWordBoundaries = function() {
  var layerText = TextEngineData.getLayerText(this.activeLayer.add.TySh.engineData);
  this.selAnchor = this.findWordStartIndex(layerText, this.selAnchor);
  this.selectionEndIndex = this.findWordEndIndex(layerText, this.selAnchor)
};
TextTool.prototype.findWordStartIndex = function(layerText, fromIndex) {
  var inWord = WORD_DELIMITERS.indexOf(layerText[fromIndex]) == -1;
  for (var charIdx = fromIndex - 1; charIdx >= 0; charIdx--)
    if (WORD_DELIMITERS.indexOf(layerText.charAt(charIdx)) != -1 == inWord) return charIdx + 1;
  return 0
};
TextTool.prototype.findWordEndIndex = function(layerText, fromIndex) {
  var inWord = WORD_DELIMITERS.indexOf(layerText[fromIndex]) == -1;
  for (var charIdx = fromIndex + 1; charIdx < layerText.length; charIdx++)
    if (WORD_DELIMITERS.indexOf(layerText.charAt(charIdx)) != -1 == inWord) return charIdx;
  return layerText.length - 1
};
TextTool.prototype.syncSelectionFromCurveData = function() {
  var wordBounds = this.textCurveData.getWordBounds(this.selAnchor);
  this.selAnchor = wordBounds[0];
  this.selectionEndIndex = wordBounds[1]
};
TextTool.prototype.updateCursor = function(dispatcher) {
  dispatchCursorOverlay(dispatcher, this.textCursorStyle);
};
TextTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    layer = this.activeLayer;
  if (!pointerState.isDown) {
    var cursorStyle = "default",
      boxTransformHandle = this.activeOp,
      transformHandle = this.textWarpTransform ? this.textWarpTransform : boxTransformHandle;
    if (transformHandle && isIdentityWarp(layer.add.TySh.warpDescriptor)) {
      var hitCursor = transformHandle.getHandleCursor(docPoint, doc.pathViewport.zoomScale);
      if (hitCursor) cursorStyle = hitCursor;
      else if (transformHandle == boxTransformHandle && boxTransformHandle.containsDocPoint(docPoint)) cursorStyle = "text"
    } else if (layer && distanceFromPointToRect(docPoint, layer.rect) > 20 / doc.pathViewport.zoomScale) cursorStyle = "move";
    else if (TextTool.findTextLayerAtPoint(doc, docPoint) >= 0) cursorStyle = "text";
    if (cursorStyle != this.textCursorStyle) {
      this.textCursorStyle = cursorStyle;
      this.updateCursor(dispatcher)
    }
  }
  var dragStartPointer = this.textDragStartPointer;
  if (this.awaitingTextLayerOnDrag && Math.max(Math.abs(pointerState.x - dragStartPointer.x), Math.abs(pointerState.y - dragStartPointer.y)) > 4 / doc.pathViewport.zoomScale) {
    this.awaitingTextLayerOnDrag = false;
    this.createTextLayerAtPoint(doc, dispatcher, appData, keyboard, pointerState);
    layer = this.activeLayer;
    this.isTransformDragging = true;
    this.activeOp = new TransformBox(null, false, false, false, true);
    var dragStartDocPoint = doc.pathViewport.screenToDocPoint(this.textDragStartPointer.x, this.textDragStartPointer.y);
    dragStartDocPoint.x = Math.round(dragStartDocPoint.x);
    dragStartDocPoint.y = Math.round(dragStartDocPoint.y);
    this.activeOp.onMouseDown(doc, appData, keyboard, dragStartDocPoint)
  }
  if (this.isTransformDragging) {
    var textShape = layer.add.TySh;
    if (this.textWarpTransform) {
      this.textWarpTransform.onMouseMove(doc, appData, keyboard, docPoint);
      var warpMatrix = toMatrix2D(cornersToHomography(this.textWarpTransform.getCornerCoords(), this.textWarpBoundsSnapshot));
      textShape.transform = warpMatrix;
      this.ensureTextCurveData(doc, appData);
      TextEngineData.syncVmskToCurve(textShape)
    } else if (this.activeOp) {
      this.activeOp.onMouseMove(doc, appData, keyboard, docPoint);
      var layerMatrixClone = textShape.transform.clone(),
        layerAngle = Math.atan2(layerMatrixClone.b, layerMatrixClone.a);
      layerMatrixClone.rotate(layerAngle);
      var opMatrix = toMatrix2D(cornersToHomography(this.activeOp.getCornerCoords())),
        opAngle = Math.atan2(opMatrix.b, opMatrix.a);
      opMatrix.rotate(opAngle);
      if (!isNaN(opMatrix.a) && opMatrix.a * opMatrix.d - opMatrix.b * opMatrix.c != 0) {
        var scaleRect = new Rect(0, 0, opMatrix.a / layerMatrixClone.a, opMatrix.d / layerMatrixClone.d),
          newWidth = Math.round(scaleRect.width),
          newHeight = Math.round(scaleRect.height),
          curvePoints = textShape.engineData.Curve;
        if (curvePoints) {
          var boxBounds = TextEngineData.getBoxBounds(textShape.engineData),
            scaleMatrix = new Matrix2D(newWidth / boxBounds[2], 0, 0, newHeight / boxBounds[3], 0, 0);
          transformCoordPairs(curvePoints.Points, scaleMatrix, curvePoints.Points);
          TextEngineData.syncVmskToCurve(textShape)
        }
        TextEngineData.setBoxBounds(textShape.engineData, [0, 0, newWidth, newHeight]);
        textShape.transform = toMatrix2D(cornersToHomography(this.activeOp.getCornerCoords(), scaleRect));
        this.ensureTextCurveData(doc, appData);
        TextEngineData.syncVmskToCurve(textShape)
      }
    } else {
      var deltaX = docPoint.x - this.textTransformDragOrigin.x,
        deltaY = docPoint.y - this.textTransformDragOrigin.y;
      textShape.transform = this.layerMatrixAtDragStart.clone();
      var snappedPoint = new Point(textShape.transform.tx + deltaX, textShape.transform.ty + deltaY);
      snappedPoint = snapPointToGuides(doc, snappedPoint, appData);
      textShape.transform.tx = snappedPoint.x;
      textShape.transform.ty = snappedPoint.y;
      this.ensureTextCurveData(doc, appData)
    }
  }
  if (this.needsOverlayRefresh) this.selectionEndIndex = this.hitTestTextCaretIndex(docPoint);
  if (this.isTransformDragging || this.needsOverlayRefresh) this.refreshTextOverlays(doc)
};
TextTool.prototype.createTextLayerAtPoint = function(doc, dispatcher, appData, keyboard, pointerState) {
  var pathLayers = doc.getPaths(),
    firstPathLayer = pathLayers[0],
    pathStack = pathLayers[1],
    newLayer = doc.newLayer();
  newLayer.add.lnsr = "rend";
  var layersCopy = doc.layers.slice(0);
  newLayer.setName("Text layer " + layersCopy.length);
  this.activeLayer = newLayer;
  var insertAfterIndex = doc.selectedLayerIndices.length == 0 ? doc.layers.length - 1 : doc.selectedLayerIndices[doc.selectedLayerIndices.length - 1],
    insertIndex = insertAfterIndex + 1;
  if (layersCopy[insertAfterIndex].add.lsct == LayerSectionType.OpenGroup) insertIndex--;
  this.editSessionSnapshot = {
    layersBefore: layersCopy.slice(0),
    selectionBefore: doc.selectedLayerIndices.slice(0)
  };
  layersCopy.splice(insertIndex, 0, newLayer);
  doc.selectedLayerIndices = [insertIndex];
  this.selAnchor = this.selectionEndIndex = 0;
  doc.setLayers(layersCopy);
  this.editSessionSnapshot.layersAfter = layersCopy.slice(0);
  this.editSessionSnapshot.selectionAfter = doc.selectedLayerIndices.slice(0);
  this.emitEvent(dispatcher, EventType.uiDispatch, {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    subAction: "showactive"
  });
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  newLayer.add.TySh = TextEngineData.createTextLayerData(docPoint.x, docPoint.y, appData.currentTextStyle);
  var textShape = newLayer.add.TySh,
    engineData = textShape.engineData;
  TextEngineData.setAntiAliasMode(textShape, this.textWritingMode);
  if (pointerState.isDown) TextEngineData.setTextType(engineData, 1);
  else {
    TextEngineData.setTextType(engineData, 0);
    var pathEntry = firstPathLayer[pathStack.pop()],
      vectorMask = pathEntry ? pathEntry.add.vmsk : null;
    if (vectorMask) {
      vectorMask = vectorMask.clone();
      var knotRecords = vectorMask.pathRecords,
        hitResult;
      for (var pathIdx = 0; pathIdx < knotRecords.length; pathIdx++)
        if (knotRecords[pathIdx].fillRule != null) knotRecords[pathIdx].fillRule = 0;
      var hitTolerance = 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale;
      hitResult = hitTestPoint(vectorMask.pathRecords, docPoint, true, hitTolerance);
      if (hitResult.idx == -1) hitResult = hitTestPoint(vectorMask.pathRecords, docPoint);
      if (hitResult.idx != -1) {
        TextEngineData.setTextType(engineData, 1);
        var subpathStart = recordIndexForSubpath(knotRecords, hitResult.idx),
          knotCount = knotCountInSubpath(knotRecords, hitResult.idx) - 1;
        knotRecords = vectorMask.pathRecords = knotRecords.slice(0, 2).concat(knotRecords.slice(subpathStart, subpathStart + knotCount + 1));
        vectorMask.C = [];
        textShape.add = {
          vmsk: vectorMask,
          vogk: createForSubpaths(knotRecords)
        };
        engineData.Curve = {};
        TextEngineData.syncCurveToVmsk(textShape);
        if (hitResult.segmentIndex != null) {
          var pathData = TextLayout.computePathData(engineData.Curve);
          transformCoordPairs(pathData[0], textShape.transform, pathData[0]);
          var nearestVertexIdx = findNearestVertexIndex(pathData[0], docPoint.x, docPoint.y),
            justification = appData.currentTextStyle.paraStyle.Justification;
          if (justification == 2 || justification == 5) {
            var pathParam = (pathData[2][nearestVertexIdx] + pathData[3] * .5) % pathData[3];
            nearestVertexIdx = TextLayout.findPathIndex(pathParam, pathData[2])
          }
          var knotIndex = pathData[1][nearestVertexIdx];
          knotIndex = knotIndex % knotCount;
          vectorMask.textOnPathParams = [knotIndex, knotIndex];
          TextEngineData.syncCurveToVmsk(textShape)
        } else this.initTextTransformHandles(textShape)
      }
    }
  }
  return newLayer
};
TextTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    wasAwaitingLayerDrag = this.awaitingTextLayerOnDrag;
  if (this.awaitingTextLayerOnDrag) {
    this.awaitingTextLayerOnDrag = false;
    this.createTextLayerAtPoint(doc, dispatcher, appData, keyboard, pointerState);
    this.needsOverlayRefresh = true
  }
  if (this.isTransformDragging || this.needsOverlayRefresh) {
    this.refreshTextOverlays(doc);
    this.refreshTextSelectionOverlay();
    if (wasAwaitingLayerDrag) this.applyStyleToTextSelection(appData)
  }
  if (this.isTransformDragging && this.activeOp) this.activeOp.onMouseUp(doc, appData, keyboard, docPoint);
  this.isTransformDragging = this.needsOverlayRefresh = false;
  this.finishWarpEditSession(doc, appData, keyboard);
  this.textArea.focus()
};
TextTool.prototype.refreshTextSelectionOverlay = function() {
  var textShape = this.activeLayer.add.TySh,
    selStart = Math.min(this.selAnchor, this.selectionEndIndex),
    selEnd = Math.max(this.selAnchor, this.selectionEndIndex),
    styleStart, styleEnd;
  if (selStart == selEnd) {
    var layerText = TextEngineData.getLayerText(textShape.engineData);
    if (selStart == 0 || layerText.charAt(selStart - 1) == "\n") styleStart = styleEnd = selStart;
    else styleStart = styleEnd = selStart - 1
  } else {
    styleStart = selStart;
    styleEnd = selEnd - 1
  }
  var textStyle = TextEngineData.getTextStyle(textShape.engineData, styleStart, styleEnd);
  TextEngineData.scaleTextStyle(textStyle, scaleIgnoringRotation(textShape.transform));
  this.dispatchTextStylePanel(this.appController, textStyle, textShape)
};
TextTool.prototype.dispatchTextStylePanel = function(dispatcher, textStyle, textShape) {
  this.emitEvent(dispatcher, EventType.uiDispatch, {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.EXPORT_AS,
    currentTextStyle: textStyle
  });
  var antiAliasMode = this.textWritingMode = TextEngineData.getAntiAliasMode(textShape);
  this.emitEvent(this.appController, EventType.uiDispatch, {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    subAction: "changeAA",
    antialiasMode: antiAliasMode
  })
};
TextTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  if (keyboard.isPressed(KeyboardHandler.Escape)) this.cancel(doc, dispatcher);
  var activeLayerRef = this.activeLayer;
  if (activeLayerRef)
    if (this.textWarpTransform == null && keyboard.isPressed(KeyboardHandler.Ctrl)) {
      var textShape = activeLayerRef.add.TySh,
        textType = TextEngineData.getTextType(textShape.engineData),
        boundsRect;
      if (textType == 1) {
        boundsRect = TextEngineData.getBoxBounds(textShape.engineData);
        boundsRect = new Rect(0, 0, boundsRect[2] - boundsRect[0], boundsRect[3] - boundsRect[1])
      } else {
        // `this.textCurveData` can be null if the tool becomes active before ensureTextCurveData() initializes it.
        if (this.textCurveData == null) {
          try {
            this.textCurveData = new TextLayout(textShape.engineData, this.textAppState ? this.textAppState.fontRegistry : null);
          } catch (_) {}
        }
        boundsRect = this.textCurveData ? this.textCurveData.getBounds() : new Rect(0, 0, 1, 1);
      }
      var cornerCoords = [boundsRect.x, boundsRect.y, boundsRect.x + boundsRect.width, boundsRect.y, boundsRect.x + boundsRect.width, boundsRect.y + boundsRect.height, boundsRect.x, boundsRect.y + boundsRect.height];
      transformCoordPairs(cornerCoords, textShape.transform, cornerCoords);
      this.textWarpTransform = new TransformBox(cornerCoords, true, true, false, false);
      this.textWarpBoundsSnapshot = boundsRect;
      this.refreshTextOverlays(this.textDocument)
    } else this.finishWarpEditSession(doc, appData, keyboard)
};
TextTool.prototype.finishWarpEditSession = function(doc, appData, keyboard) {
  var activeLayerRef = this.activeLayer;
  if (activeLayerRef && !this.isTransformDragging && this.textWarpTransform != null && !keyboard.isPressed(KeyboardHandler.Ctrl)) {
    this.textWarpTransform.onMouseUp(doc, appData, keyboard, null);
    this.textWarpTransform = null;
    this.initTextTransformHandles(activeLayerRef.add.TySh);
    this.refreshTextOverlays(this.textDocument)
  }
};
TextTool.prototype.disable = function(doc, dispatcher, appData, keyboard) {
  var activeLayerRef = this.activeLayer;
  this.commitTextEdit(doc, dispatcher)
};
TextTool.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard, appData) {
  if (this.isWarpDialogActive) return;
  if (actionPayload.subAction == "commit") this.commitTextEdit(doc, dispatcher);
  if (actionPayload.subAction == "cancel") this.cancel(doc, dispatcher);
  if (actionPayload.subAction == "changeAA") {
    this.textWritingMode = actionPayload.antialiasMode;
    if (doc != null) this.handleInput({
      actionKind: "updateStyles"
    }, dispatcher, doc, keyboard, appData)
  }
  if (actionPayload.subAction == "showwarp") {
    if (doc == null) return;
    if (this.activeLayer == null) {
      var layer = doc.layers[doc.selectedLayerIndices[0]],
        textShape = layer.add.TySh;
      if (textShape == null) return;
      this.activateTextLayers(doc, dispatcher, appData, [doc.selectedLayerIndices[0]]);
      this.textArea.focus();
      this.isWarpDialogActive = true
    }
    this.warpMeshBackup = this.activeLayer.add.TySh.warpDescriptor;
    var warpDialogEvent = new AppEvent(EventType.uiDispatch, true);
    warpDialogEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "textwarp"
    };
    dispatcher.dispatch(warpDialogEvent)
  }
};
TextTool.prototype.onUpdate = function(appData, popupType) {
  if (popupType != PopupTypes.OPEN_RECENT) return;
  if (this.pendingMultiLayerStyleApply) {
    this.pendingMultiLayerStyleApply = false;
    var doc = this.textDocument,
      editingIndices = this.editingLayerIndices;
    for (var layerIdx = 0; layerIdx < editingIndices.length; layerIdx++) {
      this.activeLayer = doc.layers[editingIndices[layerIdx]];
      this.ensureTextCurveData(doc, appData)
    }
    this.commitTextEdit(doc, this.appController);
    return
  }
  if (this.activeLayer) this.applyStyleToTextSelection(appData)
};
TextTool.prototype.scaleParagraphStyleForTransform = function(appData, textShape) {
  var scaledStyle = JSON.parse(JSON.stringify(appData.currentTextStyle));
  TextEngineData.scaleTextStyle(scaledStyle, 1 / scaleIgnoringRotation(textShape.transform));
  return scaledStyle
};
TextTool.prototype.redo = function(historyData, doc) {
  if (historyData.snapshotsBefore != null) this.restoreTextLayerSnapshots(doc, historyData.snapshotsAfter);
  else this.restoreTextLayerStack(doc, historyData.layersAfter, historyData.selectionAfter)
};
TextTool.prototype.undo = function(historyData, doc) {
  if (historyData.snapshotsBefore != null) this.restoreTextLayerSnapshots(doc, historyData.snapshotsBefore);
  else this.restoreTextLayerStack(doc, historyData.layersBefore, historyData.selectionBefore)
};
TextTool.prototype.restoreTextLayerSnapshots = function(doc, snapshots) {
  for (var snapshotIdx = 0; snapshotIdx < snapshots.length; snapshotIdx++) {
    var snapshot = snapshots[snapshotIdx],
      layerIndex = snapshot.layerIndex,
      layer = doc.layers[layerIndex];
    layer.buffer = snapshot.pixBuf;
    layer.rect = snapshot.layerRect.clone();
    layer.markDirty();
    var textShape = layer.add.TySh;
    textShape.warpDescriptor = snapshot.warpMesh;
    textShape.boundsRect = snapshot.boundsRect.clone();
    textShape.transform = snapshot.transform.clone();
    textShape.engineData = JSON.parse(JSON.stringify(snapshot.engineData));
    layer.syncTextName()
  }
  doc.markDirty()
};
TextTool.prototype.captureTextLayerSnapshots = function(doc, layerIndices) {
  var snapshots = [];
  for (var layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) {
    var layerIndex = layerIndices[layerIdx],
      layer = doc.layers[layerIndex],
      textShape = layer.add.TySh;
    snapshots.push({
      layerIndex: layerIndex,
      transform: textShape.transform.clone(),
      warpMesh: JSON.parse(JSON.stringify(textShape.warpDescriptor)),
      boundsRect: textShape.boundsRect.clone(),
      engineData: JSON.parse(JSON.stringify(textShape.engineData)),
      pixBuf: layer.buffer.slice(0),
      layerRect: layer.rect.clone()
    })
  }
  return snapshots
};
TextTool.prototype.restoreTextLayerStack = function(doc, layers, selection) {
  doc.selectedLayerIndices = selection;
  doc.setLayers(layers);
  doc.markDirty();
  doc.stateChanged = true
};
TextTool.prototype.ensureTextCurveData = function(doc, appData, skipTextAreaSync) {
  if (skipTextAreaSync == null) skipTextAreaSync = false;
  var textShape = this.activeLayer.add.TySh;
  if (!TextRenderer.checkFonts(textShape, appData.fontRegistry)) return false;
  this.activeLayer.textHasEmbeddedBuffer = false;
  this.textCurveData = new TextLayout(textShape.engineData, appData.fontRegistry);
  if (!skipTextAreaSync) {
    var layerText = TextEngineData.getLayerText(textShape.engineData);
    this.textArea.value = layerText.slice(0, layerText.length - 1)
  }
  var textRender = TextRenderer.renderText(this.textCurveData, textShape);
  if (isIdentityWarp(textShape.warpDescriptor)) textShape.boundsRect = new Rect;
  else {
    if (TextEngineData.getTextType(textShape.engineData) == 1) {
      var boxBounds = TextEngineData.getBoxBounds(textShape.engineData),
        ascentOffset = textRender.layoutBounds.y;
      textShape.boundsRect = new Rect(0, ascentOffset, boxBounds[2] - boxBounds[0], boxBounds[3] - boxBounds[1] - ascentOffset)
    } else {
      textShape.boundsRect = textRender.layoutBounds
    }
  }
  var prevRect = this.activeLayer.rect;
  this.activeLayer.rect = textRender.rect;
  this.activeLayer.buffer = textRender.buffer;
  this.activeLayer.markDirty();
  doc.rebuildLayerTree();
  doc.markDirty(doc.root.getExpandedDirtyRect(textRender.rect.union(prevRect), doc, doc.layers.indexOf(this.activeLayer)));
  return true
};
TextTool.prototype.syncTextAreaFromEngine = function(_inputEvent, alternateGlyphId) {
  if (this.activeLayer == null || this.isWarpDialogActive) return;
  var textAreaSelStart = this.textArea.selectionStart,
    textShape = this.activeLayer.add.TySh,
    engineText = TextEngineData.getLayerText(textShape.engineData),
    textAreaValueWithNewline = this.textArea.value + "\n",
    selStart = Math.min(this.selAnchor, this.selectionEndIndex),
    selEnd = Math.max(this.selAnchor, this.selectionEndIndex),
    styleChanged = false;
  this.selAnchor = Math.min(textAreaSelStart, selStart);
  if (textAreaValueWithNewline.length - textAreaSelStart < engineText.length - this.selectionEndIndex) this.selectionEndIndex = engineText.length - textAreaValueWithNewline.length + textAreaSelStart;
  if (engineText != textAreaValueWithNewline) {
    while (this.selAnchor > 0 && engineText.charAt(this.selAnchor - 1) != textAreaValueWithNewline.charAt(this.selAnchor - 1)) this.selAnchor--
  }
  var prefixText = engineText.substring(0, this.selAnchor),
    suffixText = engineText.substring(this.selectionEndIndex, engineText.length),
    insertedText = textAreaValueWithNewline.substring(this.selAnchor, textAreaValueWithNewline.length - suffixText.length);
  TextEngineData.deleteText(textShape.engineData, this.selAnchor, this.selectionEndIndex);
  TextEngineData.insertText(textShape.engineData, this.selAnchor, insertedText);
  if (alternateGlyphId != null) TextEngineData.setAlternateGlyph(textShape.engineData, this.selAnchor, alternateGlyphId);
  var scaledStyle = this.scaleParagraphStyleForTransform(this.textAppState, textShape),
    maxCodePoint = -1,
    insertedChars = Array.from(insertedText);
  for (var charIdx = 0; charIdx < insertedChars.length; charIdx++) maxCodePoint = Math.max(maxCodePoint, insertedChars[charIdx].codePointAt(0));
  // U+FFFD is the placeholder behind an alternate-glyph insertion, not a
  // character needing script coverage — swapping the font would drop the glyph.
  if (maxCodePoint != -1 && maxCodePoint > 128 && maxCodePoint != 0xFFFD && scaledStyle.textStyle.Font != null) {
    var fontName = scaledStyle.fontSet[scaledStyle.textStyle.Font].Name,
      fallbackFont = this.textAppState.fontRegistry.findScriptFallback(maxCodePoint, fontName, scaledStyle.fontSet);
    if (fontName != fallbackFont) {
      TextEngineData.setTextFont(scaledStyle, fallbackFont);
      styleChanged = true
    }
  }
  if (this.clipboardTextSlice != null && insertedText == this.clipboardTextSlice) {
    var pastedStyle = JSON.parse(this.clipboardStyleJson);
    scaledStyle.textStyle = pastedStyle.textStyle;
    scaledStyle.fontSet = pastedStyle.fontSet;
    styleChanged = true
  }
  TextEngineData.applyStyle(textShape.engineData, this.selAnchor, this.selAnchor + insertedText.length - 1, scaledStyle);
  this.selAnchor = this.selectionEndIndex = prefixText.length + insertedText.length;
  var doc = this.textDocument,
    curveReady = this.ensureTextCurveData(doc, this.textAppState, true);
  if (curveReady) this.refreshTextOverlays(doc, true);
  if (styleChanged) this.refreshTextSelectionOverlay()
};
TextTool.prototype.onTextAreaKeyDown = function(keydownEvent) {
  if (this.activeLayer == null || this.isWarpDialogActive) return;
  if (this.activeLayer.add == null || this.activeLayer.add.TySh == null) return;
  keydownEvent.stopPropagation();
  var keyboardHandler = KeyboardHandler,
    horizDelta = 0,
    vertDelta = 0,
    shouldRefresh = false;
  if (keyboardHandler.hasKeyCode(keydownEvent.code, keyboardHandler.ArrowRight)) horizDelta = 1;
  if (keyboardHandler.hasKeyCode(keydownEvent.code, keyboardHandler.ArrowLeft)) horizDelta = -1;
  if (keyboardHandler.hasKeyCode(keydownEvent.code, keyboardHandler.ArrowUp)) vertDelta = -1;
  if (keyboardHandler.hasKeyCode(keydownEvent.code, keyboardHandler.ArrowDown)) vertDelta = 1;
  var metaOrCtrl = keydownEvent.ctrlKey || keydownEvent.metaKey,
    isHome = keyboardHandler.hasKeyCode(keydownEvent.code, KeyboardHandler.Home),
    isEnd = keyboardHandler.hasKeyCode(keydownEvent.code, KeyboardHandler.End);
  if (keyboardHandler.hasKeyCode(keydownEvent.code, KeyboardHandler.Enter) && metaOrCtrl) {
    this.commitTextEdit(this.textDocument, this.appController);
    return
  }
  if (keyboardHandler.hasKeyCode(keydownEvent.code, KeyboardHandler.Tab)) {
    keydownEvent.preventDefault();
    var textArea = this.textArea,
      textAreaValue = textArea.value,
      selStart = textArea.selectionStart,
      selEnd = textArea.selectionEnd;
    textArea.value = textAreaValue.substring(0, selStart) + "\t" + textAreaValue.substring(selEnd);
    textArea.selectionStart = textArea.selectionEnd = selStart + 1;
    this.syncTextAreaFromEngine(null);
    return
  }
  if (keyboardHandler.hasKeyCode(keydownEvent.code, keyboardHandler.KeyC) && metaOrCtrl) {
    keydownEvent.preventDefault();
    this.copyTextSelection(this.appController && this.appController.appData);
  }
  if (keyboardHandler.hasKeyCode(keydownEvent.code, keyboardHandler.KeyX) && metaOrCtrl) {
    keydownEvent.preventDefault();
    this.cutTextSelection(this.appController && this.appController.appData);
  }
  if (keyboardHandler.hasKeyCode(keydownEvent.code, keyboardHandler.KeyV) && metaOrCtrl) {
    keydownEvent.preventDefault();
    this.pasteTextFromClipboard(this.appController && this.appController.appData);
    return;
  }
  var layerText = TextEngineData.getLayerText(this.activeLayer.add.TySh.engineData);
  if (horizDelta != 0 || vertDelta != 0 || isHome || isEnd) {
    keydownEvent.preventDefault();
    var caretIndex = this.selAnchor;
    if (horizDelta != 0) {
      if (metaOrCtrl && horizDelta == -1) caretIndex = this.findWordStartIndex(layerText, this.selAnchor - 1);
      else if (metaOrCtrl && horizDelta == 1) caretIndex = this.findWordEndIndex(layerText, this.selAnchor);
      else {
        var textArea = this.textArea,
          textAreaValue = textArea.value;
        caretIndex = this.selAnchor + horizDelta;
        if (caretIndex != 0 && textAreaValue.codePointAt(caretIndex - 1) > 65535) caretIndex += horizDelta
      }
    } else if (vertDelta != 0) {
      var glyphBounds = this.textCurveData.getGlyphBounds(this.selAnchor);
      if (vertDelta == -1 && glyphBounds.lineIndex == 0) caretIndex = 0;
      else if (vertDelta == 1 && glyphBounds.lineIndex == this.textCurveData.getLineCount() - 1) caretIndex = 99999999999;
      else caretIndex = this.textCurveData.hitTestChar(new Point(glyphBounds.bounds.x + glyphBounds.bounds.width / 2, 0), glyphBounds.lineIndex + vertDelta)
    } else if (isHome) {
      var scanIdx = this.selAnchor - 1;
      while (scanIdx > 0 && layerText.charCodeAt(scanIdx) != 10) scanIdx--;
      caretIndex = scanIdx == 0 ? 0 : scanIdx + 1
    } else if (isEnd) {
      var scanIdx = this.selAnchor;
      while (scanIdx < layerText.length - 1 && layerText.charCodeAt(scanIdx) != 10) scanIdx++;
      caretIndex = scanIdx
    }
    caretIndex = Math.max(0, Math.min(layerText.length - 1, caretIndex));
    if (keydownEvent.shiftKey) this.selAnchor = caretIndex;
    else this.selAnchor = this.selectionEndIndex = caretIndex;
    shouldRefresh = true
  }
  if (keyboardHandler.hasKeyCode(keydownEvent.code, KeyboardHandler.KeyA) && metaOrCtrl) {
    keydownEvent.preventDefault();
    this.selectAllText();
    return
  }
  if (shouldRefresh) {
    this.refreshTextSelectionOverlay();
    this.refreshTextOverlays(this.textDocument)
  }
};
TextTool.prototype.commitTextEdit = function(doc, dispatcher) {
  if (this.activeLayer == null) return;
  this.activeLayer.syncTextName();
  var editSnapshot = this.editSessionSnapshot;
  if (editSnapshot instanceof Array) {
    var snapshotsAfter = this.captureTextLayerSnapshots(doc, this.editingLayerIndices),
      lastHistory = doc.getLastHistoryEntry();
    if (lastHistory != null && lastHistory.routingChannel == this && lastHistory.data.snapshotsBefore && TextTool.textSnapshotsMatchLayerOrder(lastHistory.data.snapshotsBefore, editSnapshot)) lastHistory.data.snapshotsAfter = snapshotsAfter;
    else {
      var historyEntry = new HistoryEntry(this.name, this);
      historyEntry.data = {
        snapshotsBefore: editSnapshot,
        snapshotsAfter: snapshotsAfter
      };
      doc.pushHistory(historyEntry)
    }
  } else {
    var historyEntry = new HistoryEntry(this.name, this);
    historyEntry.data = {
      layersBefore: editSnapshot.layersBefore,
      layersAfter: editSnapshot.layersAfter,
      selectionBefore: editSnapshot.selectionBefore,
      selectionAfter: editSnapshot.selectionAfter
    };
    doc.pushHistory(historyEntry)
  }
  this.escape(doc, dispatcher)
};
TextTool.prototype.cancel = function(doc, dispatcher) {
  if (this.activeLayer == null) return;
  if (this.editSessionSnapshot instanceof Array) {
    this.restoreTextLayerSnapshots(doc, this.editSessionSnapshot);
    if (this.activeLayer) TextEngineData.syncVmskToCurve(this.activeLayer.add.TySh)
  } else {
    doc.selectedLayerIndices = this.editSessionSnapshot.selectionBefore;
    doc.setLayers(this.editSessionSnapshot.layersBefore)
  }
  doc.markDirty();
  this.escape(doc, dispatcher)
};
TextTool.prototype.escape = function(doc, dispatcher) {
  this.activeLayer = null;
  this.editingLayerIndices = null;
  this.textCurveData = null;
  this.activeOp = null;
  this.pendingMultiLayerStyleApply = false;
  this.textArea.blur();
  doc.toolOverlayState.overlayTransform = null;
  doc.toolOverlayState.textSelectionPath = null;
  doc.toolOverlayState.squareMarkerCoords = [];
  doc.dirty = true;
  this.isTransformDragging = false;
  this.needsOverlayRefresh = false;
  this.selAnchor = this.selectionEndIndex = -1;
  this.emitEvent(dispatcher, EventType.uiDispatch, {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    subAction: "hideactive"
  });
  if (this.restoreToolIdAfterEdit) {
    var restoreToolEvent = new AppEvent(EventType.uiDispatch, true);
    restoreToolEvent.data = {
      dispatchKind: UiCommand.setActiveToolPanelMode,
      routingChannel: this.restoreToolIdAfterEdit
    };
    dispatcher.dispatch(restoreToolEvent);
    this.restoreToolIdAfterEdit = null
  }
};
TextTool.prototype.emitEvent = function(dispatcher, eventType, data, routingChannel) {
  var appEvent = new AppEvent(eventType, true);
  appEvent.data = data;
  if (routingChannel) appEvent.routingChannel = routingChannel;
  dispatcher.dispatch(appEvent)
};
TextTool.prototype.hitTestTextCaretIndex = function(docPoint) {
  var textShape = this.activeLayer.add.TySh,
    curveData = this.textCurveData,
    invertedMatrix = textShape.transform.clone();
  invertedMatrix.invert();
  var localPoint = invertedMatrix.transformPoint(docPoint),
    selectionRect = TextEngineData.getSelectionRect(textShape, curveData),
    warpPoints = getWarpControlPoints(textShape.warpDescriptor, selectionRect),
    homographyPoint = nearestUvOnMesh(warpPoints, localPoint);
  if (homographyPoint == null) homographyPoint = new Float64Array(2);
  localPoint = new Point(selectionRect.x + homographyPoint[0] * selectionRect.width, selectionRect.y + homographyPoint[1] * selectionRect.height);
  var hitResult = curveData.hitTestChar(localPoint);
  return hitResult
};
TextTool.prototype.refreshTextOverlays = function(doc, skipTextAreaSync) {
  if (skipTextAreaSync == null) skipTextAreaSync = false;
  var textShape = this.activeLayer.add.TySh,
    textType = TextEngineData.getTextType(textShape.engineData),
    curveData = this.textCurveData,
    selectionRect = curveData ? TextEngineData.getSelectionRect(textShape, curveData) : null;
  doc.toolOverlayState.squareMarkerCoords = [];
  doc.toolOverlayState.overlayTransform = null;
  doc.toolOverlayState.textSelectionPath = null;
  var transformHandle = this.textWarpTransform ? this.textWarpTransform : this.activeOp;
  if (transformHandle) {
    transformHandle.redrawOverlay(doc, this.textAppState, !isIdentityWarp(textShape.warpDescriptor));
    var invertedLayerMatrix = textShape.transform.clone();
    invertedLayerMatrix.invert();
    transformCoordPairs(doc.toolOverlayState.squareMarkerCoords, invertedLayerMatrix, doc.toolOverlayState.squareMarkerCoords);
    transformCoordPairs(doc.toolOverlayState.overlayTransform.coords, invertedLayerMatrix, doc.toolOverlayState.overlayTransform.coords);
    if (curveData && curveData.isBoxFull()) {
      var resizeHandleX = selectionRect.width - 20,
        resizeHandleY = selectionRect.height + 8;
      doc.toolOverlayState.overlayTransform.coords.push(resizeHandleX, resizeHandleY, resizeHandleX + 10, resizeHandleY, resizeHandleX + 5, resizeHandleY - 5, resizeHandleX + 5, resizeHandleY + 5);
      doc.toolOverlayState.overlayTransform.commands.push("M", "L", "M", "L")
    }
  } else if (textType == 0) this.drawPointTextLineBounds(doc, textShape, curveData);
  else doc.toolOverlayState.overlayTransform = {
    coords: [],
    commands: []
  };
  var selStart = Math.min(this.selAnchor, this.selectionEndIndex),
    selEnd = Math.max(this.selAnchor, this.selectionEndIndex);
  if (!skipTextAreaSync) {
    this.textArea.selectionStart = selStart;
    this.textArea.selectionEnd = selEnd
  }
  if (curveData != null) {
    if (selStart == selEnd) {
      selStart = Math.max(selStart, 0);
      var glyphBounds = curveData.getGlyphBounds(selStart);
      if (glyphBounds) {
        var caretRect = glyphBounds.bounds,
          fontSize = this.textAppState.currentTextStyle.textStyle.FontSize;
        if (fontSize != null && fontSize != 0) {
          fontSize /= textShape.transform.getScale();
          caretRect.y += caretRect.height - fontSize;
          caretRect.height = fontSize
        }
        var styleAtCaret = curveData.getTextStyleAt(selStart);
        if (styleAtCaret != null && styleAtCaret.bidiLevel == 1) caretRect.x += caretRect.width;
        var caretCoords = buildCaretOutline(caretRect, glyphBounds.pathTangent).coords;
        doc.toolOverlayState.overlayTransform.commands.push("M", "L");
        doc.toolOverlayState.overlayTransform.coords.push(caretCoords[0], caretCoords[1], caretCoords[6], caretCoords[7])
      }
    } else {
      doc.toolOverlayState.textSelectionPath = {
        coords: [],
        commands: []
      };
      for (var charIdx = selStart; charIdx < selEnd; charIdx++) {
        var glyphBounds = curveData.getGlyphBounds(charIdx),
          selectionOutline = buildCaretOutline(glyphBounds.bounds, glyphBounds.pathTangent);
        appendPath(doc.toolOverlayState.textSelectionPath, selectionOutline)
      }
    }
  }
  if (curveData != null) {
    if (!selectionRect.isEmpty()) {
      var warpControlPoints = getWarpControlPoints(textShape.warpDescriptor, selectionRect),
        flatness = Math.min(selectionRect.width, selectionRect.height) / 10;
      if (flatness < 1) flatness = 1;
      if (doc.toolOverlayState.overlayTransform) {
        doc.toolOverlayState.overlayTransform = normalizePathToCubics(doc.toolOverlayState.overlayTransform);
        doc.toolOverlayState.overlayTransform = subdividePathByFlatness(doc.toolOverlayState.overlayTransform, flatness);
        warpCoordsThroughMesh(warpControlPoints, doc.toolOverlayState.overlayTransform.coords, selectionRect)
      }
      if (doc.toolOverlayState.textSelectionPath) {
        doc.toolOverlayState.textSelectionPath = normalizePathToCubics(doc.toolOverlayState.textSelectionPath);
        doc.toolOverlayState.textSelectionPath = subdividePathByFlatness(doc.toolOverlayState.textSelectionPath, flatness);
        warpCoordsThroughMesh(warpControlPoints, doc.toolOverlayState.textSelectionPath.coords, selectionRect)
      }
      warpCoordsThroughMesh(warpControlPoints, doc.toolOverlayState.squareMarkerCoords, selectionRect)
    }
  }
  if (doc.toolOverlayState.overlayTransform) transformCoordPairs(doc.toolOverlayState.overlayTransform.coords, textShape.transform, doc.toolOverlayState.overlayTransform.coords);
  if (doc.toolOverlayState.textSelectionPath) transformCoordPairs(doc.toolOverlayState.textSelectionPath.coords, textShape.transform, doc.toolOverlayState.textSelectionPath.coords);
  transformCoordPairs(doc.toolOverlayState.squareMarkerCoords, textShape.transform, doc.toolOverlayState.squareMarkerCoords);
  doc.dirty = true
};
TextTool.prototype.drawPointTextLineBounds = function(doc, textShape, curveData) {
  if (curveData == null) return;
  doc.toolOverlayState.squareMarkerCoords.push(0, 0);
  if (doc.toolOverlayState.overlayTransform == null) doc.toolOverlayState.overlayTransform = {
    commands: [],
    coords: []
  };
  for (var paraIdx = 0; paraIdx < curveData.paraStyle.length; paraIdx++) {
    var paraStyle = curveData.paraStyle[paraIdx];
    for (var nodeIdx = 0; nodeIdx < paraStyle.nodes.length; nodeIdx++) {
      var node = paraStyle.nodes[nodeIdx],
        lineLeft = paraStyle.offset.x + node.offset.x + node.bounds.x,
        lineBottom = paraStyle.offset.y + node.offset.y + node.bounds.y + node.bounds.height;
      doc.toolOverlayState.overlayTransform.commands.push("M", "L");
      doc.toolOverlayState.overlayTransform.coords.push(lineLeft, lineBottom, lineLeft + node.bounds.width, lineBottom)
    }
  }
  doc.dirty = true
};
}

TextTool.findTextLayerAtPoint = function(doc, docPoint) {
  for (var layerIdx = doc.layers.length - 1; layerIdx >= 0; layerIdx--) {
    var layer = doc.layers[layerIdx];
    if (layer.add.TySh && layer.rect.containsPoint(docPoint) && doc.isLayerVisible(layerIdx)) {
      var isLocked = layer.isLockBitSet(2) || layer.isLockBitSet(31);
      return isLocked ? -2 : layerIdx
    }
  }
  return -1
};

TextTool.textSnapshotsMatchLayerOrder = function(snapshotsA, snapshotsB) {
  var length = snapshotsA.length;
  if (length != snapshotsB.length) return false;
  for (var snapshotIdx = 0; snapshotIdx < length; snapshotIdx++)
    if (snapshotsA[snapshotIdx].layerIndex != snapshotsB[snapshotIdx].layerIndex) return false;
  return true
};


// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
TextTool.prototype = Object.create(ToolBase.prototype);
installTextToolPrototype();

