/**
 * Stroke, contour-size, and layer-effect dimension controls.
 *
 * Effect-specific picker atoms live in sibling modules; this file composes
 * FillTypePicker for stroke fill selection.
 */

import { SliderDropdown } from "./number-inputs.js";
import { ButtonMenu, Dropdown, PopupButton } from "./popup-controls.js";
import { FillTypePicker } from "./fill-type-picker.js";
import { BaseWidget } from "../base-widget.js";
import { Button, Checkbox, Label, TextInput } from "../form-controls.js";

import { Locale } from "../../../core/i18n/locale.js";
import { Matrix2D } from "../../../core/math/matrix2d.js";
import { Point } from "../../../core/math/point.js";
import { Rect } from "../../../core/math/rect.js";
import { PathRecordCodec } from "../../../document/formats/psd/path-record-codec.js";
import { LayerEffectDefs } from "../../../document/formats/psd/effect-defs.js";
import { Layer } from "../../../document/model/layer.js";
import { PopupTypes } from "../../config/popup-types.js";
import { VectorMask } from "../../../document/model/layer-masks.js";
import { getIconUrl } from "../../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { addClass, appendBreak, getDevicePixelRatio, makeElement, resizeCanvasForDevicePixelRatio, setElementCssSizeForDeviceRatio } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";
import { allocBuffer, extractChannel, fillBuffer } from "../../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../../engine/compositing/pixel-ops.js";
import { transformPathRecordCoords } from "../../../engine/compositing/path-records.js";
import { invert } from "../../../engine/compositing/color-math.js";


const SHAPE_PREVIEW_MARGIN = 0.9;
const SHAPE_PREVIEW_INNER_SCALE = 0.95;
const DEFAULT_SHAPE_RESOURCE_URL = "resources/basic/default.csh";
const STROKE_PREVIEW_RGBA_FILL = 4278190080;
const STROKE_PREVIEW_RGBA_WHITE = 4294967295;
const MM_PER_INCH = 25.4;

// --- Pure helpers (exported for tests) -----------------------------------------

function computeUnitScale(unitIndex, dpi) {
  return [1, 1, MM_PER_INCH / dpi, 1 / dpi][unitIndex];
}

function parseDashPatternTokens(dashPatternText) {
  const tokens = dashPatternText.split(" ");
  while ((tokens.length & 1) != 0) tokens.pop();
  return tokens;
}

function strokeCanvasLineCap(capIndex) {
  return ["butt", "round", "square"][capIndex];
}

function strokeCanvasLineJoin(joinIndex) {
  return ["miter", "round", "bevel"][joinIndex];
}

function formatAspectRatioLabel(width, height) {
  let aspectRatioText = (width / height).toFixed(3);
  while (aspectRatioText.charAt(aspectRatioText.length - 1) == "0") {
    aspectRatioText = aspectRatioText.substring(0, aspectRatioText.length - 1);
  }
  if (aspectRatioText.charAt(aspectRatioText.length - 1) == ".") {
    aspectRatioText = aspectRatioText.substring(0, aspectRatioText.length - 1);
  }
  let aspectRatioLabelText = "  " + aspectRatioText + " : 1",
    greatestCommonDivisor = function(a, b) {
      while (b != 0) {
        const remainder = b;
        b = a % b;
        a = remainder;
      }
      return a;
    },
    gcd = greatestCommonDivisor(width, height);
  if (Math.min(width, height) / gcd < 10) {
    aspectRatioLabelText = "  " + Math.round(width / gcd) + " : " + Math.round(height / gcd);
  }
  return aspectRatioLabelText;
}

function filterPresetIndicesBySearchQuery(presets, searchQueryLower) {
  const matchingIndices = [];
  for (let presetIdx = 0; presetIdx < presets.length; presetIdx++) {
    if (presets[presetIdx].categoryName.toLowerCase().indexOf(searchQueryLower) == -1) continue;
    matchingIndices.push(presetIdx);
  }
  return matchingIndices;
}

function buildFillMaskValueFromStroke(strokeEnabled, strokeContent, fillLayerTypes) {
  if (!strokeEnabled) return { fillKind: 0 };
  return {
    fillKind: 1 + fillLayerTypes.indexOf(strokeContent.classID),
    fillDescriptor: strokeContent
  };
}

function cloneContourShapeData(shapeData) {
  return {
    categoryName: shapeData.categoryName,
    shapeName: shapeData.shapeName,
    pathRecords: VectorMask.clonePathRecords(shapeData.pathRecords),
    boundsRect: shapeData.boundsRect.clone()
  };
}

function buildShapePreviewTransform(bounds, width, height) {
  const scale = Math.min(width / bounds.width, height / bounds.height) * SHAPE_PREVIEW_MARGIN,
    transform = new Matrix2D();
  transform.translate(-0.5, -0.5);
  transform.scale(SHAPE_PREVIEW_INNER_SCALE, SHAPE_PREVIEW_INNER_SCALE);
  transform.translate(0.5, 0.5);
  transform.scale(scale * bounds.width, scale * bounds.height);
  return transform;
}

function buildStrokeDashDescriptorEntries(dashPatternText) {
  const dashEntries = [],
    dashTokens = parseDashPatternTokens(dashPatternText);
  for (let dashIdx = 0; dashIdx < dashTokens.length; dashIdx++) {
    dashEntries.push({
      t: "UntF",
      v: { type: "#Nne", val: parseInt(dashTokens[dashIdx]) }
    });
  }
  return dashEntries;
}

// --- ContourSizeButton ---------------------------------------------------------

/**
 * Popup button that picks a contour (transfer-curve) preset from a searchable
 * thumbnail grid. Its value is a contour path record (see PathRecordCodec).
 */
function ContourSizeButton(labelLocaleKey) {
  PopupButton.call(this, labelLocaleKey, false, "contourbutton", 34, 16, PopupTypes.SHAPES);
  mountContourSizeButtonSearch(this);
  this.filteredPresets = null;
  this.searchQueryLower = "";
  this.previewDataUrls = null;
  this.setValue(PathRecordCodec.create());
}

ContourSizeButton.prototype = Object.create(PopupButton.prototype);
ContourSizeButton.prototype.constructor = ContourSizeButton;

ContourSizeButton.prototype.buildUI = function() {
  PopupButton.prototype.buildUI.call(this);
  this.searchInput.buildUI();
};

ContourSizeButton.prototype.onPick = function(pickEvent) {
  this.setValue(this.filteredPresets[pickEvent.target.getValue()]);
  this.dispatch(new AppEvent(EventType.widgetSelect));
};

ContourSizeButton.prototype.onSearchInput = function() {
  this.searchQueryLower = this.searchInput.getValue().toLowerCase();
  this.refreshFilteredGrid();
};

ContourSizeButton.prototype.listBundledPresetUrls = function() {
  return ["basic/extra_shapes.csh"];
};

ContourSizeButton.defaultShapeLoadRequested = false;

ContourSizeButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  const presets = this.presets;
  if (presets == null || !ContourSizeButton.defaultShapeLoadRequested) {
    this.dispatch(buildDefaultShapeImportDispatch());
    ContourSizeButton.defaultShapeLoadRequested = true;
    return;
  }
  const thumbWidthPx = Math.floor(38 * getDevicePixelRatio()),
    thumbHeightPx = Math.floor(38 * getDevicePixelRatio());
  this.previewDataUrls = [];
  for (let presetIdx = 0; presetIdx < presets.length; presetIdx++) {
    this.previewDataUrls.push(
      ContourSizeButton.renderShapePreviewDataUrl(presets[presetIdx], thumbWidthPx, thumbHeightPx)
    );
  }
  this.refreshFilteredGrid();
  this.popupContentStale = false;
};

ContourSizeButton.prototype.refreshFilteredGrid = function() {
  const thumbWidthPx = Math.floor(38 * getDevicePixelRatio()),
    thumbHeightPx = Math.floor(38 * getDevicePixelRatio()),
    matchingIndices = filterPresetIndicesBySearchQuery(this.presets, this.searchQueryLower);
  this.filteredPresets = [];
  const previewUrls = [],
    presetLabels = [];
  for (let matchIdx = 0; matchIdx < matchingIndices.length; matchIdx++) {
    const presetIdx = matchingIndices[matchIdx],
      preset = this.presets[presetIdx];
    this.filteredPresets.push(preset);
    previewUrls.push(this.previewDataUrls[presetIdx]);
    presetLabels.push(preset.categoryName);
  }
  this.menuList.setThumbnailGrid(previewUrls, presetLabels, thumbWidthPx, thumbHeightPx);
};

ContourSizeButton.prototype.setValue = function(shapeData) {
  this.styleData = cloneContourShapeData(shapeData);
  this.renderPreview();
};

ContourSizeButton.prototype.renderPreview = function() {
  const previewWidthPx = Math.floor(23 * getDevicePixelRatio()),
    previewHeightPx = Math.floor(23 * getDevicePixelRatio()),
    previewUrl = ContourSizeButton.renderShapePreviewDataUrl(this.styleData, previewWidthPx, previewHeightPx);
  this.previewImageEl.setAttribute("src", previewUrl);
  setElementCssSizeForDeviceRatio(this.previewImageEl, previewWidthPx, previewHeightPx);
};

ContourSizeButton.prototype.getValue = function() {
  return cloneContourShapeData(this.styleData);
};

ContourSizeButton.cloneShapeData = cloneContourShapeData;
ContourSizeButton.offscreenCanvas = null;
ContourSizeButton.scratchImageData = null;

ContourSizeButton.renderShapePreviewDataUrl = function(shapeData, width, height) {
  const pathRecords = VectorMask.clonePathRecords(shapeData.pathRecords),
    bounds = shapeData.boundsRect,
    transform = buildShapePreviewTransform(bounds, width, height);
  transformPathRecordCoords(pathRecords, transform);
  const vectorMask = new VectorMask();
  vectorMask.pathRecords = pathRecords;
  const maskSnapshot = vectorMask.getMask();
  maskSnapshot.rect.x = Math.floor((width - maskSnapshot.rect.width) / 2);
  maskSnapshot.rect.y = Math.floor((height - maskSnapshot.rect.height) / 2);
  const rgbaBuffer = allocBuffer(maskSnapshot.rect.area() * 4);
  fillBuffer(rgbaBuffer, STROKE_PREVIEW_RGBA_FILL);
  invert(maskSnapshot.channel);
  extractChannel(maskSnapshot.channel, rgbaBuffer, 0);
  extractChannel(maskSnapshot.channel, rgbaBuffer, 1);
  extractChannel(maskSnapshot.channel, rgbaBuffer, 2);
  const shapeButtonClass = ContourSizeButton;
  if (shapeButtonClass.offscreenCanvas == null) shapeButtonClass.offscreenCanvas = makeElement("canvas");
  const canvas = shapeButtonClass.offscreenCanvas,
    renderCtx = canvas.getContext("2d");
  if (canvas.width != width || canvas.height != height || shapeButtonClass.scratchImageData == null) {
    canvas.width = width;
    canvas.height = height;
    shapeButtonClass.scratchImageData = renderCtx.createImageData(width, height);
  }
  const imageData = shapeButtonClass.scratchImageData;
  fillBuffer(imageData.data, STROKE_PREVIEW_RGBA_WHITE);
  copyPixels(rgbaBuffer, maskSnapshot.rect, imageData.data, new Rect(0, 0, width, height));
  renderCtx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
};

function mountContourSizeButtonSearch(contourButton) {
  contourButton.searchInput = new TextInput("properties.find", null, 16);
  contourButton.searchInput.on("input", contourButton.onSearchInput, contourButton);
  contourButton.floatWrap.el.appendChild(contourButton.searchInput.el);
}

function buildDefaultShapeImportDispatch() {
  const importEvent = new AppEvent(EventType.uiDispatch, true);
  importEvent.data = {
    dispatchKind: UiCommand.importFromUrl,
    importSpec: { url: DEFAULT_SHAPE_RESOURCE_URL }
  };
  return importEvent;
}

// --- StrokeButton --------------------------------------------------------------

/** Compact trigger button that opens the stroke-options popup (hosts a StrokeWidget). */
function StrokeButton() {
  BaseWidget.call(this);
  mountStrokeButtonDom(this);
}

StrokeButton.prototype = Object.create(BaseWidget.prototype);
StrokeButton.prototype.constructor = StrokeButton;

StrokeButton.prototype.togglePopup = function() {
  const buttonRect = this.triggerButton.getBoundingClientRect(),
    overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: this.floatWrap,
    x: buttonRect.left,
    y: buttonRect.top + buttonRect.height + 4
  };
  this.dispatch(overlayEvent);
};

StrokeButton.prototype.onChange = function(changeEvent) {
  const optionValues = collectStrokeOptionValues(this.optionWidgets);
  this.strokeStyleData = buildStrokeStyleFromOptions(this.strokeStyleData, optionValues);
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

StrokeButton.prototype.onPresetStyleClick = function(clickEvent) {
  const presetIdx = this.presetStyleButtons.indexOf(clickEvent.currentTarget);
  this.setValue(buildStrokeStyleFromOptions(this.strokeStyleData, this.presetStyleRows[presetIdx]));
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

StrokeButton.prototype.buildUI = function() {
  for (let widgetIdx = 0; widgetIdx < this.optionWidgets.length; widgetIdx++) {
    this.optionWidgets[widgetIdx].buildUI();
  }
};

StrokeButton.prototype.setValue = function(strokeStyle) {
  this.strokeStyleData = JSON.parse(JSON.stringify(strokeStyle));
  hydrateStrokeOptionWidgets(this.optionWidgets, strokeStyle);
  const previewOptions = collectStrokeOptionValues(this.optionWidgets);
  this.drawStrokePreviewLine(this.ctx2d, 40, 16, previewOptions);
};

StrokeButton.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.strokeStyleData));
};

StrokeButton.prototype.drawStrokePreviewLine = function(renderCtx, width, height, optionValues) {
  const capIndex = optionValues[1],
    joinIndex = optionValues[2],
    dashPattern = optionValues[3].split(" ").map(parseFloat);
  resizeCanvasForDevicePixelRatio(renderCtx.canvas, width, height);
  const lineWidth = Math.min(5, this.strokeStyleData.strokeStyleLineWidth.v.val);
  for (let dashIdx = 0; dashIdx < dashPattern.length; dashIdx++) dashPattern[dashIdx] *= lineWidth;
  renderCtx.clearRect(0, 0, width, height);
  renderCtx.setLineDash(dashPattern);
  renderCtx.lineCap = strokeCanvasLineCap(capIndex);
  renderCtx.lineJoin = strokeCanvasLineJoin(joinIndex);
  renderCtx.lineWidth = lineWidth;
  renderCtx.beginPath();
  renderCtx.moveTo(0, height / 2);
  renderCtx.lineTo(width * 2, height / 2);
  renderCtx.stroke();
};

function mountStrokeButtonDom(strokeButton) {
  strokeButton.el = makeElement("span", "fitem strokebutton");
  strokeButton.presetStyleRows = [
    [null, null, null, ""],
    [null, 0, null, "4 2"],
    [1, 1, null, "0 2"]
  ];
  strokeButton.strokeStyleData = LayerEffectDefs.getStrokeStyleDefault();
  strokeButton.triggerButton = makeElement("button");
  strokeButton.el.appendChild(strokeButton.triggerButton);
  strokeButton.triggerButton.addEventListener("click", strokeButton.togglePopup.bind(strokeButton), false);
  const previewCanvas = makeElement("canvas", "gsicon");
  strokeButton.ctx2d = previewCanvas.getContext("2d");
  strokeButton.triggerButton.appendChild(previewCanvas);
  const chevronEl = makeElement("span");
  addClass(chevronEl, "chevron");
  strokeButton.triggerButton.appendChild(chevronEl);
  strokeButton.floatWrap = new BaseWidget();
  strokeButton.floatWrap.parent = strokeButton;
  strokeButton.floatWrap.el = makeElement("div", "floatcont form");
  strokeButton.floatWrap.el.setAttribute("style", "width: 14em;");
  mountStrokeOptionWidgets(strokeButton);
  mountStrokePresetButtons(strokeButton);
}

function mountStrokeOptionWidgets(strokeButton) {
  strokeButton.optionWidgets = [
    new Dropdown("properties.position", [
      "styleOptions.strokePosition.inside",
      "styleOptions.strokePosition.centre",
      "styleOptions.strokePosition.outside"
    ]),
    new ButtonMenu("styleOptions.strokeOptions.caps", [
      "<img src=\"" + getIconUrl("caps/butt") + "\" class=\"autoscale gsicon\" />",
      "<img src=\"" + getIconUrl("caps/round") + "\" class=\"autoscale gsicon\" />",
      "<img src=\"" + getIconUrl("caps/square") + "\" class=\"autoscale gsicon\" />"
    ]),
    new ButtonMenu("styleOptions.strokeOptions.corners", [
      "<img src=\"" + getIconUrl("joints/miter") + "\" class=\"autoscale gsicon\" />",
      "<img src=\"" + getIconUrl("joints/round") + "\" class=\"autoscale gsicon\" />",
      "<img src=\"" + getIconUrl("joints/bevel") + "\" class=\"autoscale gsicon\" />"
    ]),
    new TextInput("styleOptions.strokeOptions.dashes")
  ];
  const popupForm = strokeButton.floatWrap.el;
  for (let widgetIdx = 0; widgetIdx < strokeButton.optionWidgets.length; widgetIdx++) {
    const optionWidget = strokeButton.optionWidgets[widgetIdx];
    popupForm.appendChild(optionWidget.el);
    optionWidget.on(widgetIdx < 4 ? EventType.widgetSelect : "click", strokeButton.onChange, strokeButton);
  }
  appendBreak(popupForm);
}

function mountStrokePresetButtons(strokeButton) {
  strokeButton.presetStyleButtons = [];
  const onPresetStyleClick = strokeButton.onPresetStyleClick.bind(strokeButton);
  for (let presetIdx = 0; presetIdx < strokeButton.presetStyleRows.length; presetIdx++) {
    const presetButton = makeElement("button", "fitem");
    strokeButton.presetStyleButtons.push(presetButton);
    strokeButton.floatWrap.el.appendChild(presetButton);
    presetButton.addEventListener("click", onPresetStyleClick, false);
    const presetCanvas = makeElement("canvas", "gsicon"),
      presetCtx = presetCanvas.getContext("2d");
    presetButton.appendChild(presetCanvas);
    strokeButton.drawStrokePreviewLine(presetCtx, 40, 20, strokeButton.presetStyleRows[presetIdx]);
  }
}

function collectStrokeOptionValues(optionWidgets) {
  const optionValues = [];
  for (let widgetIdx = 0; widgetIdx < 4; widgetIdx++) optionValues.push(optionWidgets[widgetIdx].getValue());
  return optionValues;
}

function buildStrokeStyleFromOptions(strokeStyleTemplate, optionValues) {
  const strokeStyle = JSON.parse(JSON.stringify(strokeStyleTemplate)),
    alignmentIndex = optionValues[0],
    capIndex = optionValues[1],
    joinIndex = optionValues[2],
    dashPatternText = optionValues[3];
  if (alignmentIndex != null) {
    strokeStyle.strokeStyleLineAlignment.v.strokeStyleLineAlignment =
      LayerEffectDefs.StrokeStyleDefs.alignTypes[alignmentIndex];
  }
  if (capIndex != null) {
    strokeStyle.strokeStyleLineCapType.v.strokeStyleLineCapType =
      LayerEffectDefs.StrokeStyleDefs.lineCapTypes[capIndex];
  }
  if (joinIndex != null) {
    strokeStyle.strokeStyleLineJoinType.v.strokeStyleLineJoinType =
      LayerEffectDefs.StrokeStyleDefs.join[joinIndex];
  }
  strokeStyle.strokeStyleLineDashSet.v = buildStrokeDashDescriptorEntries(dashPatternText);
  return strokeStyle;
}

function hydrateStrokeOptionWidgets(optionWidgets, strokeStyle) {
  const alignmentIndex = LayerEffectDefs.StrokeStyleDefs.alignTypes.indexOf(
      strokeStyle.strokeStyleLineAlignment.v.strokeStyleLineAlignment
    ),
    capIndex = LayerEffectDefs.StrokeStyleDefs.lineCapTypes.indexOf(
      strokeStyle.strokeStyleLineCapType.v.strokeStyleLineCapType
    ),
    joinIndex = LayerEffectDefs.StrokeStyleDefs.join.indexOf(
      strokeStyle.strokeStyleLineJoinType.v.strokeStyleLineJoinType
    ),
    dashValues = [],
    dashEntries = strokeStyle.strokeStyleLineDashSet.v;
  for (let dashIdx = 0; dashIdx < dashEntries.length; dashIdx++) dashValues.push(dashEntries[dashIdx].v.val);
  optionWidgets[0].setValue(alignmentIndex);
  optionWidgets[1].setValue(capIndex);
  optionWidgets[2].setValue(joinIndex);
  optionWidgets[3].setValue(dashValues.join(" "));
}

// --- StrokeWidget ----------------------------------------------------------------

/**
 * Stroke editor: fill type (via FillTypePicker) plus width, position, alignment,
 * and dash pattern; emits a stroke-style descriptor.
 */
function StrokeWidget() {
  BaseWidget.call(this);
  mountStrokeWidgetDom(this);
}

StrokeWidget.prototype = Object.create(BaseWidget.prototype);
StrokeWidget.prototype.constructor = StrokeWidget;

StrokeWidget.prototype.buildUI = function() {
  for (let widgetIdx = 0; widgetIdx < this.childWidgets.length; widgetIdx++) {
    this.childWidgets[widgetIdx].buildUI();
  }
};

StrokeWidget.prototype.onUpdate = function(documentModel, popupType) {
  this.fillMaskWidget.onUpdate(documentModel, popupType);
};

StrokeWidget.prototype.onChange = function(changeEvent) {
  let strokeValue = this.storedValue,
    fillMaskValue = this.fillMaskWidget.getValue(),
    fillKind = fillMaskValue.fillKind;
  strokeValue.strokeEnabled.v = fillKind != 0;
  if (fillKind != 0) {
    strokeValue.strokeStyleContent.v = fillMaskValue.fillDescriptor;
    fillMaskValue.fillDescriptor.classID =
      LayerEffectDefs.StrokeStyleDefs.fillLayerTypes[fillKind - 1];
  }
  strokeValue.strokeStyleLineWidth.v.val = this.strokeWidthInput.getValue();
  if (changeEvent.target == this.strokeStyleButton) strokeValue = this.strokeStyleButton.getValue();
  this.storedValue = strokeValue;
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

StrokeWidget.prototype.setValue = function(documentModel, strokeValue, patternList) {
  this.storedValue = JSON.parse(JSON.stringify(strokeValue));
  const fillMaskValue = buildFillMaskValueFromStroke(
    strokeValue.strokeEnabled.v,
    strokeValue.strokeStyleContent.v,
    LayerEffectDefs.StrokeStyleDefs.fillLayerTypes
  );
  this.fillMaskWidget.setValue(documentModel, fillMaskValue, patternList);
  this.strokeWidthInput.setValue(strokeValue.strokeStyleLineWidth.v.val);
  this.strokeStyleButton.setValue(strokeValue);
};

StrokeWidget.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.storedValue));
};

function mountStrokeWidgetDom(strokeWidget) {
  strokeWidget.storedValue = null;
  strokeWidget.el = makeElement("span", "fitem");
  strokeWidget.fillMaskWidget = new FillTypePicker("layerEffects.stroke");
  strokeWidget.strokeWidthInput = new SliderDropdown(
    null,
    0,
    150,
    "pt",
    1,
    true,
    null,
    null,
    "styleOptions.bevelStyle.strokeWidth"
  );
  strokeWidget.strokeStyleButton = new StrokeButton();
  strokeWidget.childWidgets = [
    strokeWidget.fillMaskWidget,
    strokeWidget.strokeWidthInput,
    strokeWidget.strokeStyleButton
  ];
  for (let widgetIdx = 0; widgetIdx < strokeWidget.childWidgets.length; widgetIdx++) {
    const childWidget = strokeWidget.childWidgets[widgetIdx];
    strokeWidget.el.appendChild(childWidget.el);
    childWidget.parent = strokeWidget;
    childWidget.on(EventType.widgetSelect, strokeWidget.onChange, strokeWidget);
  }
}

// --- LayerEffectOption -----------------------------------------------------------

/**
 * Size / offset option bar for layer effects: width & height fields with an
 * optional aspect-ratio lock, pixel-vs-physical units and DPI, and an optional
 * relative offset. Reports the resolved dimensions back to the effect.
 */
function LayerEffectOption(showPhysicalUnits, showAspectRatioLock, showRelativeOffset, showDpiWithPhysicalUnits) {
  if (showPhysicalUnits == null) showPhysicalUnits = false;
  if (showAspectRatioLock == null) showAspectRatioLock = false;
  if (showRelativeOffset == null) showRelativeOffset = false;
  BaseWidget.call(this);
  this.referenceSize = new Point();
  this.computedSize = new Point();
  this.referenceDpi = 72;
  this.currentDpi = 72;
  this.allowPixelResizing = true;
  mountLayerEffectOptionDom(this, showPhysicalUnits, showAspectRatioLock, showRelativeOffset, showDpiWithPhysicalUnits);
}

LayerEffectOption.prototype = Object.create(BaseWidget.prototype);
LayerEffectOption.prototype.constructor = LayerEffectOption;

LayerEffectOption.prototype.disablePixelResizing = function() {
  this.allowPixelResizing = false;
  if (this.unitDropdown.getValue() == 0) {
    this.unitDropdown.setValue(3);
    this.refreshSizeFields();
  }
};

LayerEffectOption.prototype.enablePixelResizing = function() {
  this.allowPixelResizing = true;
};

LayerEffectOption.prototype.setAspectRatioLock = function(isLocked) {
  this.aspectRatioLockButton.setValue(isLocked);
};

LayerEffectOption.prototype.buildUI = function() {
  this.widthInput.buildUI();
  this.heightInput.buildUI();
  this.dpiInput.buildUI();
  this.aspectRatioLockButton.buildUI();
  this.relativeOffsetCheckbox.buildUI();
};

LayerEffectOption.prototype.onSwapDimensionsClick = function(clickEvent) {
  const previousWidth = this.computedSize.x;
  this.computedSize.x = this.computedSize.y;
  this.computedSize.y = previousWidth;
  this.refreshSizeFields();
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

LayerEffectOption.prototype.onChange = function(changeEvent) {
  if (changeEvent.target == this.unitDropdown && !this.allowPixelResizing && this.unitDropdown.getValue() == 0) {
    this.unitDropdown.setValue(3);
  }
  if (changeEvent.target == this.unitDropdown || changeEvent.target == this.relativeOffsetCheckbox) {
    this.refreshSizeFields();
    return;
  }
  if (changeEvent.target == this.aspectRatioLockButton) {
    changeEvent.target.setValue(!changeEvent.target.getValue());
  }
  applyLayerEffectSizeFromInputs(this, changeEvent.target);
  this.refreshSizeFields();
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

LayerEffectOption.prototype.setUnitIndex = function(unitIndex) {
  this.unitDropdown.setValue(unitIndex);
  this.refreshSizeFields();
};

LayerEffectOption.prototype.setValue = function(sizePoint, dpi, skipReferenceUpdate) {
  if (skipReferenceUpdate != true) this.referenceSize = sizePoint.clone();
  this.computedSize = sizePoint.clone();
  if (dpi != null) {
    this.referenceDpi = dpi;
    this.currentDpi = dpi;
  }
  this.refreshSizeFields();
};

LayerEffectOption.prototype.refreshSizeFields = function() {
  let width = this.computedSize.x,
    height = this.computedSize.y,
    dpi = this.currentDpi;
  this.aspectRatioLabel.setValue(formatAspectRatioLabel(width, height));
  if (this.relativeOffsetCheckbox.getValue()) {
    width -= this.referenceSize.x;
    height -= this.referenceSize.y;
  }
  const unitIndex = this.unitDropdown.getValue();
  if (unitIndex == 1) {
    if (this.allowPixelResizing) {
      width = (100 * width) / this.referenceSize.x;
      height = (100 * height) / this.referenceSize.y;
    } else {
      width = height = (100 * this.referenceDpi) / this.currentDpi;
    }
  } else {
    width = Math.round(width);
    height = Math.round(height);
  }
  const unitScale = computeUnitScale(unitIndex, dpi);
  width *= unitScale;
  height *= unitScale;
  const decimalPlaces = unitIndex == 1 || unitIndex == 3 ? 2 : 0;
  this.widthInput.setDecimalPlaces(decimalPlaces);
  this.heightInput.setDecimalPlaces(decimalPlaces);
  this.widthInput.setValue(width);
  this.heightInput.setValue(height);
  // A whole-number resolution reads as one: the fraction only appears when
  // rescaling without resampling has actually produced one.
  this.dpiInput.setDecimalPlaces(dpi == Math.round(dpi) ? 0 : 2);
  this.dpiInput.setValue(dpi);
};

LayerEffectOption.prototype.getValue = function() {
  return this.computedSize.clone();
};

LayerEffectOption.prototype.getDpi = function() {
  return this.currentDpi;
};

function mountLayerEffectOptionDom(
  layerEffectOption,
  showPhysicalUnits,
  showAspectRatioLock,
  showRelativeOffset,
  showDpiWithPhysicalUnits
) {
  layerEffectOption.el = makeElement("span", "");
  layerEffectOption.widthInput = new SliderDropdown("properties.width", 0, 0, null, 0, false, true);
  layerEffectOption.el.appendChild(layerEffectOption.widthInput.el);
  layerEffectOption.widthInput.on(EventType.widgetSelect, layerEffectOption.onChange, layerEffectOption);
  let unitLabels = ["px", "%"];
  if (showPhysicalUnits) unitLabels = unitLabels.concat(["mm", "in"]);
  layerEffectOption.unitDropdown = new Dropdown(null, unitLabels);
  layerEffectOption.el.appendChild(layerEffectOption.unitDropdown.el);
  appendBreak(layerEffectOption.el);
  layerEffectOption.unitDropdown.on(EventType.widgetSelect, layerEffectOption.onChange, layerEffectOption);
  layerEffectOption.heightInput = new SliderDropdown("properties.height", 0, 0, null, 0, false, true);
  layerEffectOption.el.appendChild(layerEffectOption.heightInput.el);
  layerEffectOption.heightInput.on(EventType.widgetSelect, layerEffectOption.onChange, layerEffectOption);
  const swapDimensionsButton = new Button("\u21F5", false, null, true);
  swapDimensionsButton.on("click", layerEffectOption.onSwapDimensionsClick, layerEffectOption);
  layerEffectOption.aspectRatioLockButton = new Button(
    "<img src=\"" + getIconUrl("lrs/chain") + "\" class=\"autoscale gsicon\" />",
    false,
    "properties.keepAspectRatio"
  );
  layerEffectOption.aspectRatioLockButton.on("click", layerEffectOption.onChange, layerEffectOption);
  layerEffectOption.aspectRatioLabel = new Label("");
  if (showAspectRatioLock) {
    layerEffectOption.el.appendChild(layerEffectOption.aspectRatioLockButton.el);
    layerEffectOption.el.appendChild(layerEffectOption.aspectRatioLabel.el);
    layerEffectOption.aspectRatioLockButton.markActive();
  } else {
    layerEffectOption.el.appendChild(swapDimensionsButton.el);
  }
  layerEffectOption.dpiInput = new SliderDropdown("DPI", 0, 0, null, 3, false, true, 4);
  if (showPhysicalUnits && showDpiWithPhysicalUnits == null) {
    appendBreak(layerEffectOption.el);
    layerEffectOption.el.appendChild(layerEffectOption.dpiInput.el);
  }
  layerEffectOption.dpiInput.on(EventType.widgetSelect, layerEffectOption.onChange, layerEffectOption);
  layerEffectOption.relativeOffsetCheckbox = new Checkbox("properties.relative");
  layerEffectOption.relativeOffsetCheckbox.on(EventType.widgetSelect, layerEffectOption.onChange, layerEffectOption);
  if (showRelativeOffset) {
    appendBreak(layerEffectOption.el);
    layerEffectOption.el.appendChild(layerEffectOption.relativeOffsetCheckbox.el);
  }
  appendBreak(layerEffectOption.el);
}

function applyLayerEffectSizeFromInputs(layerEffectOption, changeTarget) {
  let referenceSize = layerEffectOption.referenceSize,
    width = parseFloat(layerEffectOption.widthInput.getValue()),
    height = parseFloat(layerEffectOption.heightInput.getValue()),
    unitIndex = layerEffectOption.unitDropdown.getValue();
  if (isNaN(width)) width = 1;
  if (isNaN(height)) height = 1;
  if (layerEffectOption.allowPixelResizing) {
    let dpi = layerEffectOption.currentDpi;
    if (unitIndex == 1) {
      width = layerEffectOption.referenceSize.x * (width / 100);
      height = layerEffectOption.referenceSize.y * (height / 100);
    }
    const unitScale = computeUnitScale(unitIndex, dpi);
    width /= unitScale;
    height /= unitScale;
    if (layerEffectOption.relativeOffsetCheckbox.getValue()) {
      width += layerEffectOption.referenceSize.x;
      height += layerEffectOption.referenceSize.y;
    }
    if (changeTarget == layerEffectOption.dpiInput) {
      const newDpi = layerEffectOption.dpiInput.getValue(),
        dpiRatio = newDpi / dpi;
      width *= dpiRatio;
      height *= dpiRatio;
      dpi = newDpi;
    }
    if (layerEffectOption.aspectRatioLockButton.getValue()) {
      if (changeTarget == layerEffectOption.widthInput) height = width * (referenceSize.y / referenceSize.x);
      else width = height * (referenceSize.x / referenceSize.y);
    }
    width = Math.max(Math.abs(width), 1);
    height = Math.max(Math.abs(height), 1);
    layerEffectOption.computedSize = new Point(Math.round(width), Math.round(height));
    layerEffectOption.currentDpi = dpi;
    return;
  }
  let dpi = layerEffectOption.referenceDpi;
  if (changeTarget == layerEffectOption.dpiInput) {
    dpi = layerEffectOption.dpiInput.getValue();
  } else {
    if (layerEffectOption.aspectRatioLockButton.getValue()) {
      if (changeTarget == layerEffectOption.widthInput) height = width * (referenceSize.y / referenceSize.x);
      else width = height * (referenceSize.x / referenceSize.y);
    }
    const unitScale = computeUnitScale(unitIndex, dpi),
      dpiScaleFactor = width / (unitIndex == 1 ? 100 : referenceSize.x * unitScale);
    dpi = dpi / dpiScaleFactor;
  }
  layerEffectOption.computedSize = new Point(Math.round(referenceSize.x), Math.round(referenceSize.y));
  layerEffectOption.currentDpi = dpi;
}

export {
  computeUnitScale,
  parseDashPatternTokens,
  strokeCanvasLineCap,
  strokeCanvasLineJoin,
  formatAspectRatioLabel,
  filterPresetIndicesBySearchQuery,
  buildFillMaskValueFromStroke,
  cloneContourShapeData,
  ContourSizeButton,
  StrokeButton,
  StrokeWidget,
  LayerEffectOption
};
