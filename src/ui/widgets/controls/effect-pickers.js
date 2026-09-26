/**
 * Layer-effect input controls shared by the effects panel and tool options:
 * a contour (transfer-curve) preset button, a pattern preset button, and a
 * shadow/point XY-offset control. Each reads and writes the PSD-style effect
 * descriptor for its slot (contour Crv, pattern Ptrn, offset Pnt with Hrzn/Vrtc)
 * and renders a thumbnail preview of the current value.
 */

import { PopupButton } from "./popup-controls.js";
import { RangeInput } from "./number-inputs.js";
import { BaseWidget } from "../base-widget.js";

import { Matrix2D } from "../../../core/math/matrix2d.js";
import { Point } from "../../../core/math/point.js";

import { LayerStyleRenderer } from "../../../features/layer-styles/style-renderer.js";
import { PopupTypes } from "../../config/popup-types.js";
import { findPattern } from "../../../document/formats/psd/layer-data-parsers.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { getDevicePixelRatio, makeElement, setElementCssSizeForDeviceRatio } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";
import { TransformToolBase } from "../../../document/transform/transform-static.js";
import { transformPixels } from "../../../document/render/raster-transform.js";
import { copyBuffer } from "../../../engine/compositing/buffer-utils.js";
import { renderCurvePreview } from "../../../engine/compositing/tone-curves.js";

/**
 * Contour (transfer curve) preset popup button.
 * Contour descriptors keep PSD wire keys Nm / Crv / Cnty.
 * @param {string} [labelLocaleKey]
 */
function ContourButton(labelLocaleKey) {
  PopupButton.call(this, labelLocaleKey, true, "contourbutton", 17, 10.5, PopupTypes.CONTOURS)
}

ContourButton.prototype = Object.create(PopupButton.prototype);
ContourButton.prototype.constructor = ContourButton;

ContourButton.prototype.onPick = function(pickEvent) {
  this.setValue(this.presets[pickEvent.target.getValue()]);
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

ContourButton.prototype.openEditor = function() {
  const editorEvent = new AppEvent(EventType.uiDispatch, true);
  editorEvent.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "contoureditor",
    children: this.styleData,
    response: this.onEditorApply.bind(this)
  };
  this.dispatch(editorEvent)
};

ContourButton.prototype.onEditorApply = function(contourData) {
  this.setValue(contourData);
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

ContourButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  const thumbWidthPx = Math.floor(38 * getDevicePixelRatio()),
    thumbHeightPx = Math.floor(38 * getDevicePixelRatio()),
    previewUrls = [],
    presetLabels = [],
    presets = this.presets;
  for (let presetIdx = 0; presetIdx < presets.length; presetIdx++) {
    presetLabels.push(presets[presetIdx].Nm ? presets[presetIdx].Nm.v : "");
    previewUrls.push(renderCurvePreview(presets[presetIdx].Crv.v, thumbWidthPx, thumbHeightPx))
  }
  this.menuList.setThumbnailGrid(previewUrls, presetLabels, thumbWidthPx, thumbHeightPx);
  this.popupContentStale = false
};

ContourButton.prototype.setValue = function(contourData) {
  this.styleData = JSON.parse(JSON.stringify(contourData));
  ensureContourPointContinuityFlags(this.styleData.Crv.v);
  this.renderPreview()
};

ContourButton.prototype.renderPreview = function() {
  const previewWidthPx = Math.floor(30 * getDevicePixelRatio()),
    previewHeightPx = Math.floor(30 * getDevicePixelRatio()),
    previewUrl = renderCurvePreview(this.styleData.Crv.v, previewWidthPx, previewHeightPx);
  this.previewImageEl.setAttribute("src", previewUrl);
  setElementCssSizeForDeviceRatio(this.previewImageEl, previewWidthPx, previewHeightPx)
};

ContourButton.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.styleData))
};

/**
 * Pattern preset popup. Wire descriptor uses classID Ptrn with Nm / Idnt.
 * @param {string} [labelLocaleKey]
 */
function PatternPickerButton(labelLocaleKey) {
  PopupButton.call(this, labelLocaleKey, false, "patternbutton", 18, 10, PopupTypes.PATTERNS);
  this.resolvedPatternEntry = null
}

PatternPickerButton.prototype = Object.create(PopupButton.prototype);
PatternPickerButton.prototype.constructor = PatternPickerButton;

PatternPickerButton.prototype.listBundledPresetUrls = function() {
  return ["libraries/extra_patterns.pat"];
};

PatternPickerButton.prototype.onPick = function() {
  const patternEntry = this.presets[this.menuList.getValue()];
  this.styleData = buildPatternPtrnDescriptor(patternEntry.name, patternEntry.id);
  this.dispatch(new AppEvent(EventType.widgetSelect));
  this.renderPreview()
};

PatternPickerButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  const presets = this.presets || [];
  const thumbWidthPx = Math.floor(34 * getDevicePixelRatio()),
    thumbHeightPx = Math.floor(34 * getDevicePixelRatio()),
    previewUrls = [],
    presetLabels = [];
  for (let presetIdx = 0; presetIdx < presets.length; presetIdx++) {
    previewUrls.push(PatternPickerButton.renderPatternPreviewDataUrl(presets[presetIdx], thumbWidthPx, thumbHeightPx));
    presetLabels.push(presets[presetIdx].name)
  }
  this.menuList.setThumbnailGrid(previewUrls, presetLabels, thumbWidthPx, thumbHeightPx);
  this.popupContentStale = false
};

PatternPickerButton.prototype.setValue = function(patternRef, documentModel) {
  if (this.styleData && patternRef.Idnt.v == this.styleData.Idnt.v) return;
  this.styleData = JSON.parse(JSON.stringify(patternRef));
  this.renderPreview(documentModel)
};

PatternPickerButton.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.styleData))
};

PatternPickerButton.prototype.getEditorPresetPayload = function() {
  return this.resolvedPatternEntry ? [this.resolvedPatternEntry] : []
};

PatternPickerButton.prototype.renderPreview = function(documentModel) {
  const previewWidthPx = Math.floor(50 * getDevicePixelRatio()),
    previewHeightPx = Math.floor(50 * getDevicePixelRatio());
  let patternEntry = null;
  if (documentModel != null) patternEntry = findPattern(this.styleData, documentModel.add.Patt);
  if (patternEntry == null) patternEntry = findPattern(this.styleData, this.presets);
  this.resolvedPatternEntry = patternEntry;
  const previewUrl = PatternPickerButton.renderPatternPreviewDataUrl(patternEntry, previewWidthPx, previewHeightPx);
  this.previewImageEl.setAttribute("src", previewUrl);
  setElementCssSizeForDeviceRatio(this.previewImageEl, previewWidthPx, previewHeightPx)
};

PatternPickerButton.offscreenCanvas = makeElement("canvas", "");

PatternPickerButton.renderPatternPreviewDataUrl = function(patternEntry, width, height, targetCanvas) {
  return renderPatternPreviewDataUrl(patternEntry, width, height, targetCanvas || PatternPickerButton.offscreenCanvas)
};

/**
 * Shadow / point offset compound control (Off X / Off Y).
 * Descriptor uses PSD wire keys Hrzn / Vrtc on classID Pnt.
 * @param {boolean} usePercentUnits
 */
function ShadowOffsetWidget(usePercentUnits) {
  BaseWidget.call(this);
  this.el = makeElement("span", "");
  this.usePercentUnits = usePercentUnits;
  this.offsetXInput = new RangeInput("Off X", -100, 100, usePercentUnits ? "%" : "px", 0, false);
  this.offsetYInput = new RangeInput("Off Y", -100, 100, usePercentUnits ? "%" : "px", 0, false);
  this.offsetXInput.on(EventType.widgetSelect, this.onChange, this);
  this.offsetYInput.on(EventType.widgetSelect, this.onChange, this);
  this.el.appendChild(this.offsetXInput.el);
  this.el.appendChild(this.offsetYInput.el)
}

ShadowOffsetWidget.prototype = Object.create(BaseWidget.prototype);
ShadowOffsetWidget.prototype.constructor = ShadowOffsetWidget;

ShadowOffsetWidget.prototype.buildUI = function() {
  this.offsetXInput.buildUI();
  this.offsetYInput.buildUI()
};

ShadowOffsetWidget.prototype.onChange = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

ShadowOffsetWidget.prototype.setOffsetPoint = function(offsetPoint) {
  this.offsetXInput.setValue(offsetPoint.x);
  this.offsetYInput.setValue(offsetPoint.y)
};

ShadowOffsetWidget.prototype.getOffsetPoint = function() {
  return new Point(this.offsetXInput.getValue(), this.offsetYInput.getValue())
};

ShadowOffsetWidget.prototype.setValue = function(offsetDescriptor, dispatchChange) {
  let horizontal = offsetDescriptor.Hrzn.v,
    vertical = offsetDescriptor.Vrtc.v;
  if (this.usePercentUnits) {
    horizontal = horizontal.val;
    vertical = vertical.val
  }
  this.offsetXInput.setValue(horizontal);
  this.offsetYInput.setValue(vertical);
  if (dispatchChange) this.onChange()
};

ShadowOffsetWidget.prototype.getValue = function() {
  return buildShadowOffsetDescriptor(
    this.offsetXInput.getValue(),
    this.offsetYInput.getValue(),
    this.usePercentUnits
  )
};

export {
  ContourButton,
  PatternPickerButton,
  ShadowOffsetWidget,
  ensureContourPointContinuityFlags,
  buildPatternPtrnDescriptor,
  buildShadowOffsetDescriptor,
  computePatternPreviewScales
};

// --- Contour helpers ---------------------------------------------------------

/** Ensure each curve knot has a Cnty continuity bool (PSD wire). */
function ensureContourPointContinuityFlags(curvePoints) {
  for (let pointIdx = 0; pointIdx < curvePoints.length; pointIdx++) {
    if (curvePoints[pointIdx].v.Cnty == null) {
      curvePoints[pointIdx].v.Cnty = {
        t: "bool",
        v: true
      }
    }
  }
}

// --- Pattern helpers ---------------------------------------------------------

function buildPatternPtrnDescriptor(name, id) {
  return {
    classID: "Ptrn",
    Nm: {
      t: "TEXT",
      v: name
    },
    Idnt: {
      t: "TEXT",
      v: id
    }
  }
}

/**
 * Uniform scale into the preview box, floored so either axis stays ≥2px.
 * Matrix uses (scaleY, scaleXClamped) matching TransformToolBase call sites.
 */
function computePatternPreviewScales(previewWidth, previewHeight, planeWidth, planeHeight) {
  const scaleX = Math.min(previewWidth / planeWidth, previewHeight / planeHeight);
  let scaleY = scaleX,
    scaleXClamped = scaleX;
  if (scaleY * planeWidth < 2) scaleY = 2 / planeWidth;
  if (scaleXClamped * planeHeight < 2) scaleXClamped = 2 / planeHeight;
  return {
    scaleY: scaleY,
    scaleXClamped: scaleXClamped
  }
}

function renderPatternPreviewDataUrl(patternEntry, width, height, targetCanvas) {
  const renderCtx = targetCanvas.getContext("2d");
  targetCanvas.width = width;
  targetCanvas.height = height;
  if (patternEntry) {
    const pixelPlane = patternEntry.pixelData[1],
      planeWidth = pixelPlane.width,
      planeHeight = pixelPlane.height,
      pixelBuffer = patternEntry.pixelData[0],
      scales = computePatternPreviewScales(width, height, planeWidth, planeHeight),
      transformed = transformPixels(
        [pixelBuffer, pixelPlane],
        new Matrix2D(scales.scaleY, 0, 0, scales.scaleXClamped, 0, 0),
        false
      ),
      outWidth = transformed.rect.width,
      outHeight = transformed.rect.height,
      imageData = renderCtx.createImageData(outWidth, outHeight);
    copyBuffer(transformed.buffer, imageData.data);
    renderCtx.putImageData(imageData, Math.floor((width - outWidth) / 2), Math.floor((height - outHeight) / 2))
  }
  return targetCanvas.toDataURL()
}

// --- Shadow offset helpers ---------------------------------------------------

function buildShadowOffsetDescriptor(offsetX, offsetY, usePercentUnits) {
  if (usePercentUnits) {
    return {
      classID: "Pnt",
      Hrzn: {
        t: "UntF",
        v: {
          type: "#Prc",
          val: offsetX
        }
      },
      Vrtc: {
        t: "UntF",
        v: {
          type: "#Prc",
          val: offsetY
        }
      }
    }
  }
  return {
    classID: "Pnt",
    Hrzn: {
      v: offsetX,
      t: "doub"
    },
    Vrtc: {
      v: offsetY,
      t: "doub"
    }
  }
}
