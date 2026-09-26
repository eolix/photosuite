/**
 * Brush, tool-preset, and layer-style popup pickers — all PopupButton subclasses
 * that share its floating preset-grid mechanics and add their own header
 * controls and thumbnail rendering (live brush strokes, tool icons, and
 * rasterized layer-style swatches respectively).
 */

import { TextRangeInput } from "./number-inputs.js";
import { PopupButton } from "./popup-controls.js";
import { Checkbox } from "../form-controls.js";

import { Rect } from "../../../core/math/rect.js";
import { FileFormatRegistry } from "../../../document/formats/registry/file-format-registry.js";
import { TOOL_BRUSH_PRESET_MAP, ToolId, findToolIdForActionClass } from "../../../document/model/tool-base.js";
import { LayerSystem } from "../../../engine/layer-system.js";
import { BrushStroke } from "../../../features/brush/brush-stroke.js";
import { LayerStyleRenderer } from "../../../features/layer-styles/style-renderer.js";
import { Document } from "../../../document/model/document.js";
import { PopupTypes } from "../../config/popup-types.js";
import { BrushPresetUtil } from "../../../features/brush/brush-presets.js";
import { getIconUrl } from "../../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { addClass, getDevicePixelRatio, isInDOM, makeElement, removeClass, setElementCssSizeForDeviceRatio } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";
import { allocBuffer, fillBuffer } from "../../../engine/compositing/buffer-utils.js";
import { rgbToHex } from "../../../engine/compositing/color-math.js";

/** Extra brush libraries offered at the bottom of the brush picker's menu. */
const BUNDLED_BRUSH_PRESET_URLS = [
  "libraries/Markers.abr",
  "libraries/Paintbrush_Set.abr",
  "libraries/Pencil_Scribbles.abr",
];
const STYLE_PREVIEW_FILL_ARGB = 4284045657;

/**
 * Bundled ABR paths for the brush picker, relative to `resources/`.
 * @returns {string[]}
 */
function listBundledBrushPresetUrls() {
  return BUNDLED_BRUSH_PRESET_URLS.slice();
}

/** Editor payload wrapping a brush descriptor. */
function buildBrushEditorPresetPayload(brushDescriptor) {
  let brush = brushDescriptor;
  if (brush == null) brush = BrushPresetUtil.getDefaultBrushDescriptor();
  return {
    list: [{
      t: "Objc",
      v: brush
    }],
    samples: [],
    patterns: []
  }
}

/** Visible label for a brush preset (Nm after last "="). */
function brushPresetDisplayLabel(brushDescriptor) {
  if (brushDescriptor.Nm && brushDescriptor.Nm.v) return brushDescriptor.Nm.v.split("=").pop();
  return "Brush"
}

/**
 * Resolve the brush at a thumbnail-grid index, skipping null/group entries.
 * @returns {object|null}
 */
function resolveBrushAtVisibleMenuIndex(presetList, menuIndex) {
  let selectedBrush = null,
    visibleIndex = -1;
  for (let presetIdx = 0; presetIdx < presetList.length; presetIdx++) {
    selectedBrush = BrushPresetUtil.getBrushPresetFromListEntry(presetList[presetIdx]);
    if (selectedBrush == null) continue;
    visibleIndex++;
    if (visibleIndex == menuIndex) return selectedBrush;
    selectedBrush = null
  }
  return null
}

/** Cache key for solid-color tool-preset thumbnails ({ h, l, O }). */
function solidColorPreviewCacheKey(color) {
  return rgbToHex(color.h << 16 | color.l << 8 | color.O)
}

function findFirstBrushInPresetList(presetList) {
  if (!presetList) return null;
  for (let presetIdx = 0; presetIdx < presetList.length; presetIdx++) {
    const brush = BrushPresetUtil.getBrushPresetFromListEntry(presetList[presetIdx]);
    if (brush != null) return brush
  }
  return null
}

/**
 * Rasterize a layer-style thumbnail. Call sites pass the last two args as
 * (globalLightAngle, patternAngle); the body maps them to rotation then light.
 */
function renderStylePreviewDataUrl(layerStyle, width, height, patternList, patternAngle, globalLightAngle) {
  const scratchDoc = new Document();
  scratchDoc.width = width;
  scratchDoc.height = height;
  scratchDoc.buffer = allocBuffer(width * height * 4);
  scratchDoc.add.Patt = patternList;
  scratchDoc.setRotationAngle(patternAngle == null ? 90 : patternAngle);
  scratchDoc.setGlobalLightAngle(globalLightAngle == null ? 30 : globalLightAngle);
  const layerBounds = new Rect(0, 0, Math.round(width * 0.5), Math.round(height * 0.5));
  layerBounds.x = Math.round((width - layerBounds.width) / 2);
  layerBounds.y = Math.round((height - layerBounds.height) / 2);
  const previewLayer = scratchDoc.newLayer();
  previewLayer.rect = layerBounds;
  previewLayer.buffer = allocBuffer(layerBounds.area() * 4);
  fillBuffer(previewLayer.buffer, STYLE_PREVIEW_FILL_ARGB);
  LayerStyleRenderer.applyGlobalLightAngle(layerStyle, previewLayer, 0.5 * 100);
  scratchDoc.layers.push(previewLayer);
  scratchDoc.rebuildLayerTree();
  scratchDoc.markDirty();
  const webglWasEnabled = LayerSystem.webglEnabled;
  LayerSystem.webglEnabled = false;
  scratchDoc.composite();
  const rasterData = scratchDoc.getRasterData();
  LayerSystem.webglEnabled = webglWasEnabled;
  return FileFormatRegistry.bufferToDataUrl(rasterData.buffer, scratchDoc.width, scratchDoc.height)
}

// --- BrushPickerButton -------------------------------------------------------

/**
 * Popup brush preset picker with diameter / hardness header controls.
 * @param {string} [labelLocaleKey]
 */
function BrushPickerButton(labelLocaleKey) {
  PopupButton.call(this, labelLocaleKey, false, "brushbutton nopadding", 16.6, 10, PopupTypes.BRUSHES, true);
  this.diameterInput = new TextRangeInput("properties.size.title", 1, 1e3, " px", 0, true);
  this.diameterInput.on(EventType.widgetSelect, this.onSizeHardnessChange, this);
  this.popupHeader.appendChild(this.diameterInput.el);
  this.hardnessInput = new TextRangeInput("properties.hardness", 0, 100, "%");
  this.hardnessInput.on(EventType.widgetSelect, this.onSizeHardnessChange, this);
  this.popupHeader.appendChild(this.hardnessInput.el)
}

BrushPickerButton.prototype = Object.create(PopupButton.prototype);
BrushPickerButton.prototype.constructor = BrushPickerButton;

BrushPickerButton.prototype.listBundledPresetUrls = function() {
  return listBundledBrushPresetUrls()
};

BrushPickerButton.prototype.togglePopup = function() {
  const widgetRect = this.el.getBoundingClientRect();
  this.showPopupAt(widgetRect.left, widgetRect.top + widgetRect.height)
};

BrushPickerButton.prototype.showPopupAt = function(leftPx, topPx) {
  if (this.styleData == null) {
    const presets = this.presets,
      firstBrush = presets && presets.list ? findFirstBrushInPresetList(presets.list) : null;
    if (firstBrush != null) this.setValue(firstBrush, presets.samples, presets.patterns);
    else this.setValue(BrushPresetUtil.getDefaultBrushDescriptor(), [], [])
  }
  this.populatePopup();
  const overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: this.floatWrap,
    x: leftPx,
    y: topPx
  };
  this.dispatch(overlayEvent)
};

BrushPickerButton.prototype.setValue = function(brushDescriptor, samples, patterns) {
  this.styleData = JSON.parse(JSON.stringify(brushDescriptor));
  const previewThumbPx = Math.floor(20 * getDevicePixelRatio()),
    previewWidthPx = Math.floor(36 * getDevicePixelRatio()),
    previewHeightPx = Math.floor(24 * getDevicePixelRatio()),
    previewUrl = BrushStroke.renderPreview(brushDescriptor, samples, patterns, previewThumbPx, previewHeightPx, previewWidthPx);
  this.previewImageEl.setAttribute("src", previewUrl);
  setElementCssSizeForDeviceRatio(this.previewImageEl, previewWidthPx, previewHeightPx);
  const brushProps = brushDescriptor.Brsh.v;
  this.diameterInput.setValue(brushProps.diameter.v.val);
  if (brushProps.Hrdn != null) {
    this.hardnessInput.enable();
    this.hardnessInput.setValue(brushProps.Hrdn.v.val)
  } else this.hardnessInput.disable();
  this.menuList.highlightRowAtIndex(-1)
};

BrushPickerButton.prototype.getEditorPresetPayload = function() {
  return buildBrushEditorPresetPayload(this.getValue())
};

BrushPickerButton.prototype.getValue = function() {
  return this.styleData
};

BrushPickerButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  const presets = this.presets;
  if (presets == null || presets.list == null || presets.list.length === 0) return;
  const previewUrls = [],
    presetLabels = [],
    thumbHeightPx = Math.floor(33 * getDevicePixelRatio()),
    thumbWidthPx = Math.floor(40 * getDevicePixelRatio());
  for (let presetIdx = 0; presetIdx < presets.list.length; presetIdx++) {
    const brushDescriptor = BrushPresetUtil.getBrushPresetFromListEntry(presets.list[presetIdx]);
    if (brushDescriptor == null) continue;
    previewUrls.push(BrushStroke.renderPreview(brushDescriptor, presets.samples, presets.patterns, thumbHeightPx, thumbWidthPx));
    presetLabels.push(brushPresetDisplayLabel(brushDescriptor))
  }
  this.menuList.setThumbnailGrid(previewUrls, presetLabels, thumbHeightPx, thumbWidthPx);
  this.popupContentStale = false
};

BrushPickerButton.prototype.onPick = function() {
  const presets = this.presets,
    selectedBrush = resolveBrushAtVisibleMenuIndex(presets.list, this.menuList.getValue());
  if (selectedBrush == null) return;
  this.setValue(selectedBrush, presets.samples, presets.patterns);
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

BrushPickerButton.prototype.buildUI = function() {
  PopupButton.prototype.buildUI.call(this);
  this.diameterInput.buildUI();
  this.hardnessInput.buildUI()
};

BrushPickerButton.prototype.onSizeHardnessChange = function() {
  const presets = this.presets,
    brushDescriptor = this.styleData;
  brushDescriptor.Brsh.v.diameter.v.val = this.diameterInput.getValue();
  if (brushDescriptor.Brsh.v.Hrdn != null) brushDescriptor.Brsh.v.Hrdn.v.val = this.hardnessInput.getValue();
  this.setValue(brushDescriptor, presets.samples, presets.patterns);
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

BrushPickerButton.prototype.setPresets = function(presetBundle) {
  this.presets = presetBundle;
  this.popupContentStale = true;
  if (isInDOM(this.menuList.el)) this.populatePopup()
};

// --- ToolPresetButton --------------------------------------------------------

/**
 * Tool-preset popup filtered by current tool id.
 * @param {number} toolId
 */
function ToolPresetButton(toolId) {
  PopupButton.call(this, null, false, "tpresetbutton", 18, 24, PopupTypes.TOOL_PRESETS, true);
  removeClass(this.el, "fitem");
  this.menuList.setViewMode(1);
  this.id = toolId;
  this.renderPreview();
  this.currentToolOnlyCheckbox = new Checkbox("brushAndMessages.toolHints.currentToolOnly");
  this.currentToolOnlyCheckbox.setValue(true);
  this.currentToolOnlyCheckbox.on(EventType.widgetSelect, this.onCurrentToolOnlyToggle, this);
  this.popupToolbar.appendChild(this.currentToolOnlyCheckbox.el)
}

ToolPresetButton.prototype = Object.create(PopupButton.prototype);
ToolPresetButton.prototype.constructor = ToolPresetButton;

ToolPresetButton.prototype.setToolId = function(toolId) {
  if (this.id == toolId) return;
  this.id = toolId;
  this.setPresets(this.presets)
};

ToolPresetButton.prototype.onPick = function() {
  const presetPayload = this.presets[this.menuList.getValue()],
    uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    scriptHostData: "set",
    popupType: PopupTypes.TOOL_PRESETS,
    presetPayload: presetPayload
  };
  this.dispatch(uiEvent)
};

ToolPresetButton.prototype.buildUI = function() {
  PopupButton.prototype.buildUI.call(this);
  this.currentToolOnlyCheckbox.buildUI()
};

ToolPresetButton.prototype.onCurrentToolOnlyToggle = function() {
  this.popupContentStale = true;
  this.populatePopup()
};

ToolPresetButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  const iconWidthPx = Math.floor(16 * getDevicePixelRatio()),
    iconHeightPx = Math.floor(16 * getDevicePixelRatio()),
    iconUrls = [],
    presetLabels = [],
    presets = this.presets,
    currentToolOnly = this.currentToolOnlyCheckbox.getValue();
  for (let presetIdx = 0; presetIdx < presets.length; presetIdx++) {
    const presetToolId = findToolIdForActionClass(presets[presetIdx]);
    if (!currentToolOnly || presetToolId == this.id) {
      presetLabels.push(presets[presetIdx][0] ? presets[presetIdx][0].split("=").pop() : "");
      iconUrls.push(presetToolId == -1 ? "" : getIconUrl(TOOL_BRUSH_PRESET_MAP[presetToolId].iconPath))
    } else {
      iconUrls.push(null);
      presetLabels.push(null)
    }
  }
  this.menuList.setThumbnailGrid(iconUrls, presetLabels, iconWidthPx, iconHeightPx);
  this.popupContentStale = false
};

ToolPresetButton.prototype.renderPreview = function() {
  const previewImageEl = this.previewImageEl;
  previewImageEl.setAttribute("src", getIconUrl(TOOL_BRUSH_PRESET_MAP[this.id].iconPath));
  addClass(previewImageEl, "toolicon")
};

ToolPresetButton.prototype.getEditorPresetPayload = function() {
  return null
};

ToolPresetButton.previewDataUrlCache = {};

ToolPresetButton.renderSolidColorPreviewDataUrl = function(color, width, height) {
  const cache = ToolPresetButton.previewDataUrlCache,
    hexKey = solidColorPreviewCacheKey(color);
  if (cache[hexKey]) return cache[hexKey];
  let renderCtx = ToolPresetButton.previewRenderCtx;
  if (renderCtx == null) {
    const canvas = makeElement("canvas");
    renderCtx = ToolPresetButton.previewRenderCtx = canvas.getContext("2d")
  }
  const canvasEl = renderCtx.canvas;
  canvasEl.width = width;
  canvasEl.height = height;
  renderCtx.fillStyle = "#" + hexKey;
  renderCtx.fillRect(0, 0, width, height);
  return cache[hexKey] = canvasEl.toDataURL()
};

// --- StyleButton -------------------------------------------------------------

/**
 * Layer-style preset picker with rasterized style thumbnails.
 * @param {string} [labelLocaleKey]
 */
function StyleButton(labelLocaleKey) {
  PopupButton.call(this, labelLocaleKey, false, "patternbutton", 24.2, 17, PopupTypes.STYLES);
  this.previewCacheKey = ""
}

StyleButton.prototype = Object.create(PopupButton.prototype);
StyleButton.prototype.constructor = StyleButton;

StyleButton.prototype.onPick = function() {
  this.styleData = JSON.parse(JSON.stringify(this.presets[0][this.menuList.getValue()]));
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

StyleButton.prototype.populatePopup = function() {
  const presets = this.presets;
  if (presets == null || !this.popupContentStale) return;
  const thumbWidthPx = Math.floor(50 * getDevicePixelRatio()),
    thumbHeightPx = Math.floor(50 * getDevicePixelRatio()),
    previewUrls = [],
    presetLabels = [];
  for (let presetIdx = 0; presetIdx < presets[0].length; presetIdx++) {
    previewUrls.push(StyleButton.renderStylePreviewDataUrl(
      this.presets[0][presetIdx].styleEffects,
      thumbWidthPx,
      thumbHeightPx,
      this.presets[1]
    ));
    presetLabels.push(presets[0][presetIdx].styleInfo.Nm.v.split("=").pop())
  }
  this.menuList.setThumbnailGrid(previewUrls, presetLabels, thumbWidthPx, thumbHeightPx);
  this.popupContentStale = false
};

StyleButton.prototype.setValue = function(styleData, patternList, globalLightAngle, patternAngle) {
  const cacheKey = JSON.stringify(styleData.styleEffects) + "," + globalLightAngle + "," + patternAngle;
  if (this.previewCacheKey != cacheKey) {
    this.previewCacheKey = cacheKey;
    this.styleData = JSON.parse(JSON.stringify(styleData));
    this.renderPreview(patternList, globalLightAngle, patternAngle)
  }
  this.menuList.highlightRowAtIndex(-1)
};

StyleButton.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.styleData))
};

StyleButton.prototype.renderPreview = function(patternList, globalLightAngle, patternAngle) {
  const previewWidthPx = Math.floor(68 * getDevicePixelRatio()),
    previewHeightPx = Math.floor(68 * getDevicePixelRatio()),
    previewUrl = StyleButton.renderStylePreviewDataUrl(
      this.styleData.styleEffects,
      previewWidthPx,
      previewHeightPx,
      patternList ? patternList : this.presets[1],
      globalLightAngle,
      patternAngle
    );
  this.previewImageEl.setAttribute("src", previewUrl);
  setElementCssSizeForDeviceRatio(this.previewImageEl, previewWidthPx, previewHeightPx)
};

StyleButton.renderStylePreviewDataUrl = renderStylePreviewDataUrl;

export {
  BrushPickerButton,
  ToolPresetButton,
  StyleButton,
  listBundledBrushPresetUrls,
  buildBrushEditorPresetPayload,
  brushPresetDisplayLabel,
  resolveBrushAtVisibleMenuIndex,
  solidColorPreviewCacheKey,
  renderStylePreviewDataUrl
};
