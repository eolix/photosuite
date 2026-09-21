/**
 * Panel chrome: histogram channel picker, warp display options, pannable canvas
 * wrapper, and export-format option tab.
 */

import { SliderDropdown, TextRangeInput } from "./number-inputs.js";
import { CanvasViewport } from "../../../document/model/canvas-viewport.js";
import {
  ButtonMenu,
  CheckboxList,
  Dropdown,
  PopupButton
} from "./popup-controls.js";
import { BaseWidget } from "../base-widget.js";
import { Button, Checkbox, Label, TextInput } from "../form-controls.js";

import { basenameFromPath } from "../../../core/file-names.js";
import { KeyboardHandler } from "../../../core/keyboard-handler.js";
import { Locale } from "../../../core/i18n/locale.js";
import { Point } from "../../../core/math/point.js";
import { Rect } from "../../../core/math/rect.js";

import { ColorLookupParser } from "../../../features/adjustments/color-lookup-file.js";
import { PopupTypes } from "../../config/popup-types.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { addClass, addPointerDownListener, addPointerMoveListener, addPointerUpListener, appendBreak, clearElement, disableTouchGestures, getDevicePixelRatio, getEventPos, isInDOM, makeElement, removeClass, removePointerMoveListener, removePointerUpListener, setElementCssSizeForDeviceRatio } from "../../../core/dom.js";
import { showToast } from "../../../core/user-prompts.js";
import { CursorOverlay } from "../../shell/cursor-overlay.js";
import { AppEvent } from "../../../core/event-bus.js";
import { ZoomTool } from "../../../document/tools/view-tools.js";
import { allocBuffer, fillBuffer } from "../../../engine/compositing/buffer-utils.js";
import { copyPixels, resampleDown, resampleUint32UniformScale } from "../../../engine/compositing/pixel-ops.js";
import { composite } from "../../../engine/compositing/compositing-ops.js";
import { drawCheckerboard, rgbToHex } from "../../../engine/compositing/color-math.js";
import { getWarpControlPoints, pointsToCustomEnvelope } from "../../../engine/compositing/warp.js";

const HISTOGRAM_BAND_PEAK_SCALE = 6000;
/** Leading entries of a histogram that are 256-bin bands: combined, red, green, blue. */
const HISTOGRAM_BAND_COUNT = 4;
const WHEEL_ZOOM_DEBOUNCE_MS = 100;
const ZOOM_BAR_HIT_TOLERANCE_CSS = 4;
const ZOOM_BAR_CLEAR_MARGIN = 1000;

// --- Pure helpers (exported for tests) ---------------------------------------

/** Bundled LUT cube preset paths shown in the ICC profile picker. */
function buildCubePresetPaths() {
  const presetNames =
    "Arabica 12,Ava 614,Azrael 93,Bourbon 64,Byers 11,Clayton 33,Clouseau 54,Cobi 3,Contrail 35,Cubicle 99,Django 25,Domingo 145,Faded 47,Folger 50,Fusion 88,Hyla 68,Chemical 168,Korben 214,Lenox 340,Lucky 64,McKinnon 75,Milo 5,Neon 770,Paladin 1875,Pasadena 21,Pitaya 15,Reeve 38,Remy 24,Sprocket 231,Teigen 28,Trent 18,Tweed 71,Vireo 37,Zed 32,Zeke 39".split(
      ","
    );
  const cubePaths = [];
  for (let presetIdx = 0; presetIdx < presetNames.length; presetIdx++) {
    // Underscores in on-disk names: Tauri's asset protocol does not map %20 to
    // spaces, and XHR always percent-encodes spaces in the request URL.
    cubePaths.push("luts/" + presetNames[presetIdx].replace(/ /g, "_") + ".CUBE");
  }
  return cubePaths;
}

/** Display label for a bundled cube path (`Bourbon_64.CUBE` → `Bourbon 64.CUBE`). */
function formatCubePresetLabel(fileName) {
  return fileName.replace(/_/g, " ");
}

function orientationWireToIndex(orientationWire) {
  return orientationWire == "Hrzn" ? 0 : 1;
}

function indexToOrientationWire(orientationIndex) {
  return orientationIndex == 0 ? "Hrzn" : "Vrtc";
}

function formatZoomPercentLabel(zoomScale) {
  let zoomPercent = zoomScale * 100;
  if (zoomPercent < 100) zoomPercent = zoomPercent.toFixed(2);
  else zoomPercent = Math.round(zoomPercent);
  return zoomPercent + "%";
}

function resolveFrameAdvanceDelayMs(layerName) {
  let frameDelayMs = layerName ? parseInt(layerName.split(",").pop()) : 30;
  if (frameDelayMs == 0) frameDelayMs = 16;
  return frameDelayMs;
}

/** Formats that share another format's option set. PSB writes through the PSD codec. */
const FORMAT_OPTION_ALIASES = { PSB: "PSD" };

function buildPanelTabRebuildCacheKey(formatKey, isAnimated, hidePagesField) {
  return formatKey + " " + isAnimated + " " + hidePagesField;
}

function computeHistogramBandScale(totalPixelCount) {
  return HISTOGRAM_BAND_PEAK_SCALE / totalPixelCount;
}

function computeHistogramChannelMean(channelBins, scopedPixelCount, averageRgbChannels) {
  let weightedSum = 0;
  for (let binIdx = 0; binIdx < 256; binIdx++) {
    weightedSum += binIdx * channelBins[binIdx];
  }
  if (averageRgbChannels) weightedSum /= 3;
  return weightedSum / scopedPixelCount;
}

function extractStylePresetLabel(styleDescriptor) {
  if (!styleDescriptor.Nm) return "ICC / 3DL / look / cube";
  return styleDescriptor.Nm.v.split("\\").pop().split("/").pop();
}

function shouldDisableWarpDistortionControls(warpStyleKey) {
  return warpStyleKey == "warpNone" || warpStyleKey == "warpCustom";
}

// --- ChannelModeSelect ---------------------------------------------------------

/**
 * Histogram viewer with a channel dropdown (RGB / red / green / blue / all).
 * Paints the selected channel's 256-bin distribution as a filled band on a
 * canvas and, when `showStatLabels` is set, shows mean and pixel-count stats.
 * `setValue(histogramData, scopedPixelCount)` feeds it a computed histogram.
 */
function ChannelModeSelect(canvasWidth, showStatLabels) {
  BaseWidget.call(this);
  mountChannelModeSelectDom(this, canvasWidth, showStatLabels);
}

ChannelModeSelect.prototype = Object.create(BaseWidget.prototype);
ChannelModeSelect.prototype.constructor = ChannelModeSelect;

ChannelModeSelect.prototype.buildUI = function() {
  this.channelDropdown.buildUI();
};

ChannelModeSelect.prototype.setChannelIndex = function(channelIndex) {
  this.channelDropdown.setValue(channelIndex);
  this.redraw();
};

ChannelModeSelect.prototype.setValue = function(histogramData, scopedPixelCount) {
  this.histogramData = histogramData;
  this.scopedPixelCount = scopedPixelCount;
  this.redraw();
};

/**
 * Smooth the plotted bands over ±`radius` bins.
 *
 * A histogram taken straight off freshly quantised eight-bit pixels combs:
 * output levels the tone mapping never lands on read as empty, and the plot
 * turns into a picket fence that says more about the quantiser than the
 * picture. Smoothing is display-only — the bins themselves are untouched — so
 * leave it off where the comb is the point, as in Levels and Curves.
 */
ChannelModeSelect.prototype.setHistogramSmoothing = function(radius) {
  this.histogramSmoothingRadius = radius;
  this.redraw();
};

ChannelModeSelect.prototype.setHistogramFillColor = function(fillColor) {
  if (fillColor == this.histogramFillColor) return;
  this.histogramFillColor = fillColor;
  this.redraw();
};

ChannelModeSelect.prototype.redraw = function() {
  if (this.histogramData == null) return;
  paintChannelHistogram(
    this.renderCtx,
    this.offscreenCanvas,
    this.histogramData,
    this.channelDropdown.getValue(),
    this.histogramFillColor,
    this.histogramSmoothingRadius
  );
  updateHistogramStatLabels(
    this.statValueLabels,
    this.histogramData,
    this.channelDropdown.getValue(),
    this.scopedPixelCount
  );
};

ChannelModeSelect.drawHistogramBand = function(ctx, channelBins, bandScale, fillColorHex) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let binIdx = 0; binIdx < 256; binIdx++) {
    ctx.lineTo(binIdx, channelBins[binIdx] * bandScale);
  }
  ctx.lineTo(256, 0);
  ctx.closePath();
  ctx.fillStyle = fillColorHex;
  ctx.fill();
};

function mountChannelModeSelectDom(channelSelect, canvasWidth, showStatLabels) {
  channelSelect.el = makeElement("span", "");
  channelSelect.channelDropdown = new Dropdown("properties.channel", [
    "RGB",
    "colour.labels.red",
    "colour.labels.green",
    "colour.labels.blue",
    "properties.colours"
  ]);
  channelSelect.channelDropdown.on(EventType.widgetSelect, channelSelect.redraw, channelSelect);
  channelSelect.el.appendChild(channelSelect.channelDropdown.el);
  appendBreak(channelSelect.el);
  channelSelect.offscreenCanvas = makeElement("canvas");
  const canvasEl = channelSelect.offscreenCanvas;
  channelSelect.el.appendChild(canvasEl);
  canvasEl.width = Math.round(canvasWidth * getDevicePixelRatio());
  canvasEl.height = Math.round(100 * getDevicePixelRatio());
  setElementCssSizeForDeviceRatio(canvasEl, canvasEl.width, canvasEl.height);
  channelSelect.renderCtx = canvasEl.getContext("2d");
  channelSelect.histogramData = null;
  channelSelect.histogramFillColor = 0;
  channelSelect.scopedPixelCount = null;
  channelSelect.statLabels = [];
  channelSelect.statValueLabels = [];
  const statLabelTexts = ["Mean:", "Pixels:"],
    labelHost = channelSelect.el;
  for (let labelIdx = 0; labelIdx < statLabelTexts.length; labelIdx++) {
    const statLabel = new Label(statLabelTexts[labelIdx]);
    channelSelect.statLabels.push(statLabel);
    if (showStatLabels) labelHost.appendChild(statLabel.el);
    const statValueLabel = new Label("hi");
    channelSelect.statValueLabels.push(statValueLabel);
    if (showStatLabels) labelHost.appendChild(statValueLabel.el);
    appendBreak(labelHost);
  }
}

/** Triangular blur across neighbouring bins; the bins passed in are not modified. */
function smoothHistogramBins(bins, radius) {
  const smoothed = new Float64Array(256);
  let weightTotal = 0;
  for (let offset = -radius; offset <= radius; offset++) weightTotal += radius + 1 - Math.abs(offset);
  for (let binIdx = 0; binIdx < 256; binIdx++) {
    let total = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sourceBin = binIdx + offset;
      if (sourceBin < 0 || sourceBin > 255) continue;
      total += bins[sourceBin] * (radius + 1 - Math.abs(offset));
    }
    smoothed[binIdx] = total / weightTotal;
  }
  return smoothed;
}

function paintChannelHistogram(ctx, canvasEl, histogramData, channelIndex, fillColor, smoothingRadius) {
  if (smoothingRadius > 0) {
    // Entries past the four band arrays are the pixel and alpha totals.
    const smoothed = histogramData.slice(0);
    for (let bandIdx = 0; bandIdx < HISTOGRAM_BAND_COUNT; bandIdx++) {
      smoothed[bandIdx] = smoothHistogramBins(histogramData[bandIdx], smoothingRadius);
    }
    histogramData = smoothed;
  }
  const bandScale = computeHistogramBandScale(histogramData[4]),
    fillColorHex = "#" + rgbToHex(fillColor),
    drawBand = ChannelModeSelect.drawHistogramBand;
  canvasEl.width = canvasEl.width;
  ctx.setTransform(canvasEl.width / 256, 0, 0, -canvasEl.height / 100, 0, canvasEl.height);
  ctx.globalCompositeOperation = "lighter";
  if (channelIndex == 0) {
    drawBand(ctx, histogramData[0], bandScale / 3, fillColorHex);
  } else if (channelIndex < 4) {
    drawBand(ctx, histogramData[channelIndex], bandScale, fillColorHex);
  } else {
    drawBand(ctx, histogramData[1], bandScale, "#ff0000");
    drawBand(ctx, histogramData[2], bandScale, "#00ff00");
    drawBand(ctx, histogramData[3], bandScale, "#0000ff");
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function updateHistogramStatLabels(statValueLabels, histogramData, channelIndex, scopedPixelCount) {
  if (scopedPixelCount == null) return;
  const meanValue = computeHistogramChannelMean(
    histogramData[channelIndex],
    scopedPixelCount,
    channelIndex == 0
  );
  statValueLabels[0].setValue(meanValue.toFixed(1) + "");
  statValueLabels[1].setValue(scopedPixelCount + "");
}

// --- ICCProfileButton ----------------------------------------------------------

/**
 * LUT picker for Color Lookup. The popup lists every bundled `.CUBE` plus any
 * ICC / 3DL / look profiles already in `colorProfilePresets`. Choosing a
 * bundled file loads it, applies it to the adjustment, and adds it to the
 * session preset store.
 */
function createEmptyColorLookupPickerValue() {
  return {
    classID: "null",
    Dthr: {
      t: "bool",
      v: true
    },
    Nm: {
      t: "TEXT",
      v: "ICC / 3DL / look / cube"
    },
    lookupType: {
      t: "enum",
      v: {
        colorLookupType: "abstractProfile"
      }
    }
  };
}

function cloneColorLookupDescriptor(styleDesc) {
  if (styleDesc == null || typeof styleDesc != "object") {
    return createEmptyColorLookupPickerValue();
  }
  const clone = {};
  for (const key in styleDesc) {
    if (key == "profile" && styleDesc.profile && styleDesc.profile.v != null) {
      const profileBytes = styleDesc.profile.v;
      clone.profile = {
        t: styleDesc.profile.t,
        v: Array.isArray(profileBytes)
          ? profileBytes.slice()
          : Array.from(profileBytes)
      };
      continue;
    }
    clone[key] = JSON.parse(JSON.stringify(styleDesc[key]));
  }
  return clone;
}

function ICCProfileButton(presetCategoryLabel) {
  PopupButton.call(this, presetCategoryLabel, false, "ICCButton", 16, 12, PopupTypes.COLOR_PROFILES, true);
  this.menuList.setViewMode(1);
  this.popupEntries = [];
  this.loadingCubePath = null;
  addClass(this.floatWrap.el, "icc-lut-popup");
  // Text chip instead of a gsicon-inverted canvas scribble (unreadable on most themes).
  removeClass(this.previewImageEl, "gsicon");
  this.previewImageEl.style.display = "none";
  this.previewLabelEl = makeElement("span", "icc-preview-label");
  this.triggerButton.insertBefore(this.previewLabelEl, this.triggerButton.firstChild);
  this.setValue(createEmptyColorLookupPickerValue());
}

ICCProfileButton.prototype = Object.create(PopupButton.prototype);
ICCProfileButton.prototype.constructor = ICCProfileButton;

ICCProfileButton.prototype.listCubePresetPaths = function() {
  return buildCubePresetPaths();
};

ICCProfileButton.prototype.listBundledPresetUrls = ICCProfileButton.prototype.listCubePresetPaths;

ICCProfileButton.prototype.buildPopupEntries = function() {
  const entries = [];
  const loadedNames = Object.create(null);
  const loadedPresets = this.presets || [];
  for (let presetIdx = 0; presetIdx < loadedPresets.length; presetIdx++) {
    const preset = loadedPresets[presetIdx];
    if (preset == null) continue;
    const label = extractStylePresetLabel(preset);
    loadedNames[label.toLowerCase()] = true;
    entries.push({
      kind: "loaded",
      label: label,
      preset: preset
    });
  }
  const bundledPaths = buildCubePresetPaths();
  for (let pathIdx = 0; pathIdx < bundledPaths.length; pathIdx++) {
    const resourcePath = "resources/" + bundledPaths[pathIdx];
    const label = formatCubePresetLabel(basenameFromPath(bundledPaths[pathIdx]));
    if (loadedNames[label.toLowerCase()]) continue;
    entries.push({
      kind: "bundled",
      label: label,
      resourcePath: resourcePath
    });
  }
  this.popupEntries = entries;
  return entries;
};

ICCProfileButton.prototype.onPick = function(pickEvent) {
  const entry = this.popupEntries[pickEvent.target.getValue()];
  if (entry == null) return;
  this.dismissLutPopup();
  if (entry.kind == "loaded") {
    this.applyLookupDescriptor(entry.preset);
    return;
  }
  this.loadBundledCubeAndApply(entry.resourcePath, entry.label);
};

ICCProfileButton.prototype.dismissLutPopup = function() {
  const closeEvent = new AppEvent(EventType.uiDispatch, true);
  closeEvent.data = {
    dispatchKind: UiCommand.closeFloatingOverlay,
    overlayWidget: this.floatWrap
  };
  this.dispatch(closeEvent);
};

ICCProfileButton.prototype.applyLookupDescriptor = function(descriptor) {
  this.setValue(descriptor);
  this.dispatch(new AppEvent(EventType.widgetSelect));
};

ICCProfileButton.prototype.loadBundledCubeAndApply = function(resourcePath, displayName) {
  if (this.loadingCubePath) return;
  this.loadingCubePath = resourcePath;
  // Paths are underscore-safe; do not percent-encode — Tauri's asset server
  // treats %20 as a literal miss and returns index.html.
  const requestUrl = resourcePath;
  const xhr = new XMLHttpRequest();
  xhr.open("GET", requestUrl);
  xhr.responseType = "arraybuffer";
  const button = this;
  xhr.onload = function() {
    button.loadingCubePath = null;
    const httpOk = xhr.status == 0 || (xhr.status >= 200 && xhr.status < 300);
    const bytes = xhr.response;
    if (!httpOk || bytes == null || bytes.byteLength == 0) {
      showToast("Could not load LUT: " + displayName);
      return;
    }
    const head = new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength));
    // Asset miss often returns the app shell HTML with status 200.
    if (head[0] == 60 /* < */) {
      showToast("Could not load LUT: " + displayName);
      return;
    }
    let parsed;
    try {
      parsed = ColorLookupParser.parse(bytes, displayName);
    } catch (err) {
      console.error("[color-lookup] parse failed:", err);
      showToast("Could not parse LUT: " + displayName);
      return;
    }
    const descriptor = parsed[0];
    button.applyLookupDescriptor(descriptor);
    const addEvent = new AppEvent(EventType.uiDispatch, true);
    addEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      scriptHostData: "add",
      popupType: PopupTypes.COLOR_PROFILES,
      presetPayload: parsed,
      suppressPresetAddedAlert: true
    };
    button.dispatch(addEvent);
  };
  xhr.onerror = function() {
    button.loadingCubePath = null;
    showToast("Could not load LUT: " + displayName);
  };
  xhr.send();
};

ICCProfileButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  const entries = this.buildPopupEntries();
  const labels = [];
  const placeholderThumbs = [];
  const transparentPixel =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    labels.push(entries[entryIdx].label);
    placeholderThumbs.push(transparentPixel);
  }
  // List mode: captions carry the name; skip gsicon invert on 1×1 thumbs.
  this.menuList.useGsIconClass = false;
  this.menuList.setThumbnailGrid(placeholderThumbs, labels, 1, 1);
  this.popupContentStale = false;
};

ICCProfileButton.prototype.setValue = function(styleDesc) {
  if (styleDesc == null || typeof styleDesc != "object") {
    styleDesc = createEmptyColorLookupPickerValue();
  }
  // Keep profile bytes as a copied array — avoid JSON round-trip on ~200KB LUTs.
  this.styleData = cloneColorLookupDescriptor(styleDesc);
  this.renderPreview();
};

ICCProfileButton.prototype.renderPreview = function() {
  this.previewLabelEl.textContent = extractStylePresetLabel(this.styleData);
};

ICCProfileButton.prototype.getValue = function() {
  if (this.styleData == null) return createEmptyColorLookupPickerValue();
  return cloneColorLookupDescriptor(this.styleData);
};

// --- DisplayOptions ------------------------------------------------------------

/**
 * Warp option bar for the warp/transform tool: a warp-style picker plus
 * orientation, bend, and horizontal/vertical distortion controls. Reads and
 * writes a warp descriptor (`warpStyle`, `warpRotate.Ornt`, `warpValue`,
 * `warpPerspective*`); switching to a preset style seeds sensible bend defaults,
 * and "none"/"custom" styles disable the distortion controls. `getValue()`
 * returns a deep copy of the current warp descriptor.
 */
function DisplayOptions(useSliderDropdown, compactDistortionLabels, showStyleCheckbox) {
  BaseWidget.call(this);
  if (useSliderDropdown == null) useSliderDropdown = false;
  if (compactDistortionLabels == null) compactDistortionLabels = false;
  if (showStyleCheckbox == null) showStyleCheckbox = false;
  this.compactDistortionLabels = compactDistortionLabels;
  this.warpDescSnapshot = null;
  mountDisplayOptionsControls(this, useSliderDropdown, showStyleCheckbox);
}

DisplayOptions.prototype = Object.create(BaseWidget.prototype);
DisplayOptions.prototype.constructor = DisplayOptions;

DisplayOptions.prototype.buildUI = function() {
  this.warpStyleList.buildUI();
  this.warpOrientationDropdown.buildUI();
  this.warpBendControl.buildUI();
  const labelTrimLen = this.compactDistortionLabels ? 1 : 100;
  this.horizontalDistortionControl.setLabel(
    Locale.get("warp.horizontalDistortion").substring(0, labelTrimLen) + ":"
  );
  this.verticalDistortionControl.setLabel(
    Locale.get("warp.verticalDistortion").substring(0, labelTrimLen) + ":"
  );
};

DisplayOptions.prototype.refresh = function() {
  const warpDesc = this.warpDescSnapshot,
    previousWarpStyle = this.warpStyleList.getValue(),
    previousStyleKey = warpDesc.warpStyle.v.warpStyle;
  finalizeCustomWarpEnvelope(warpDesc, previousWarpStyle);
  writeWarpControlsToDescriptor(warpDesc, this);
  applyWarpStyleTransitionDefaults(warpDesc, previousWarpStyle, previousStyleKey);
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
  this.setValue(warpDesc);
};

DisplayOptions.prototype.getValue = function(unusedArg) {
  return JSON.parse(JSON.stringify(this.warpDescSnapshot));
};

DisplayOptions.prototype.setValue = function(warpDesc) {
  this.warpDescSnapshot = JSON.parse(JSON.stringify(warpDesc));
  readWarpControlsFromDescriptor(this, warpDesc);
  setWarpDistortionControlsEnabled(
    this,
    !shouldDisableWarpDistortionControls(warpDesc.warpStyle.v.warpStyle)
  );
};

function mountDisplayOptionsControls(displayOptions, useSliderDropdown, showStyleCheckbox) {
  displayOptions.warpStyleList = new CheckboxList("properties.style", showStyleCheckbox);
  displayOptions.warpStyleList.parent = displayOptions;
  displayOptions.warpStyleList.on(EventType.widgetSelect, displayOptions.refresh, displayOptions);
  displayOptions.warpOrientationDropdown = new Dropdown("warp.orientation.title", [
    "warp.orientation.horizontal",
    "warp.orientation.vertical"
  ]);
  displayOptions.warpOrientationDropdown.on(EventType.widgetSelect, displayOptions.refresh, displayOptions);
  const rangeControlCtor = useSliderDropdown ? SliderDropdown : TextRangeInput;
  displayOptions.warpBendControl = new rangeControlCtor("warp.bend", -100, 100, "%");
  displayOptions.horizontalDistortionControl = new rangeControlCtor("Horizontal Distortion:", -100, 100, "%");
  displayOptions.verticalDistortionControl = new rangeControlCtor("Vertical Distortion:", -100, 100, "%");
  displayOptions.warpBendControl.parent =
    displayOptions.horizontalDistortionControl.parent =
    displayOptions.verticalDistortionControl.parent =
      displayOptions;
  displayOptions.warpBendControl.on(EventType.widgetSelect, displayOptions.refresh, displayOptions);
  displayOptions.horizontalDistortionControl.on(EventType.widgetSelect, displayOptions.refresh, displayOptions);
  displayOptions.verticalDistortionControl.on(EventType.widgetSelect, displayOptions.refresh, displayOptions);
}

function finalizeCustomWarpEnvelope(warpDesc, previousWarpStyle) {
  if (previousWarpStyle == "warpCustom") {
    pointsToCustomEnvelope(
      getWarpControlPoints(warpDesc),
      warpDesc
    );
  } else {
    delete warpDesc.customEnvelopeWarp;
  }
}

function writeWarpControlsToDescriptor(warpDesc, displayOptions) {
  warpDesc.warpStyle.v.warpStyle = displayOptions.warpStyleList.getValue();
  warpDesc.warpRotate.v.Ornt = indexToOrientationWire(displayOptions.warpOrientationDropdown.getValue());
  warpDesc.warpValue.v = displayOptions.warpBendControl.getValue();
  warpDesc.warpPerspective.v = displayOptions.horizontalDistortionControl.getValue();
  warpDesc.warpPerspectiveOther.v = displayOptions.verticalDistortionControl.getValue();
}

function applyWarpStyleTransitionDefaults(warpDesc, previousWarpStyle, previousStyleKey) {
  if (previousWarpStyle == "warpNone" || previousWarpStyle == "warpCustom") {
    warpDesc.warpValue.v = 0;
    warpDesc.warpPerspective.v = 0;
    warpDesc.warpPerspectiveOther.v = 0;
  } else if (previousStyleKey == "warpNone" || previousStyleKey == "warpCustom") {
    warpDesc.warpValue.v = 50;
  }
}

function readWarpControlsFromDescriptor(displayOptions, warpDesc) {
  displayOptions.warpStyleList.setValue(warpDesc.warpStyle.v.warpStyle);
  displayOptions.warpOrientationDropdown.setValue(orientationWireToIndex(warpDesc.warpRotate.v.Ornt));
  displayOptions.warpBendControl.setValue(warpDesc.warpValue.v);
  displayOptions.horizontalDistortionControl.setValue(warpDesc.warpPerspective.v);
  displayOptions.verticalDistortionControl.setValue(warpDesc.warpPerspectiveOther.v);
}

function setWarpDistortionControlsEnabled(displayOptions, enabled) {
  const distortionControls = [
    displayOptions.warpOrientationDropdown,
    displayOptions.warpBendControl,
    displayOptions.horizontalDistortionControl,
    displayOptions.verticalDistortionControl
  ];
  for (let controlIdx = 0; controlIdx < distortionControls.length; controlIdx++) {
    if (enabled) distortionControls[controlIdx].enable();
    else distortionControls[controlIdx].disable();
  }
}

// --- PanelWrapper --------------------------------------------------------------

/**
 * Pannable, zoomable canvas preview — used by the Navigator panel and animated
 * previews. Owns a CanvasViewport (pan offset + zoom), composites the active
 * frame over a checkerboard, and draws an on-canvas zoom bar (−  %  +). Supports
 * mouse drag-to-pan, wheel and keyboard zoom, and space/ctrl/alt transient
 * grab/zoom cursors. `setValue(frameSources, maxAnimationLoops)` loads one or
 * more frames; equal-sized consecutive frames auto-advance as an animation.
 * When `dispatchCanvasPointerEvents` is set, raw pointer events on the canvas
 * are re-dispatched for tools to consume.
 */
function PanelWrapper(dispatchCanvasPointerEvents) {
  BaseWidget.call(this);
  mountPanelWrapperDom(this, dispatchCanvasPointerEvents);
}

PanelWrapper.prototype = Object.create(BaseWidget.prototype);
PanelWrapper.prototype.constructor = PanelWrapper;

PanelWrapper.prototype.onKeyEvent = function(keyEvent) {
  let cursorName = this.defaultCursorName,
    transientMode = resolveTransientCursorMode(keyEvent);
  this.transientCursorMode = transientMode;
  if (transientMode) cursorName = transientMode;
  this.cursorOverlay.open(cursorName, this.overlayContainerStyle);
  applyKeyboardZoomShortcuts(this, keyEvent);
};

PanelWrapper.prototype.setDefaultCursor = function(cursorName) {
  this.defaultCursorName = cursorName;
  if (this.transientCursorMode) return;
  this.cursorOverlay.open(cursorName, this.overlayContainerStyle);
};

PanelWrapper.prototype.attachPointerHandlers = function(targetEl) {
  addPointerDownListener(targetEl, this.boundOnDragStart);
  disableTouchGestures(targetEl);
  targetEl.addEventListener("wheel", this.boundOnWheel, false);
};

PanelWrapper.prototype.linkViewSync = function(linkedPanel) {
  linkedPanel.on("viewchange", this.onLinkedViewChange, this);
};

PanelWrapper.prototype.onLinkedViewChange = function(viewEvent) {
  const previousScale = this.panZoomState.zoomScale,
    linkedTransform = viewEvent.currentTarget.getViewTransform();
  this.panZoomState.zoomScale = linkedTransform.zoomScale;
  this.panZoomState.panOffset = linkedTransform.panOffset.clone();
  if (previousScale != linkedTransform.zoomScale) this.rebuildScaledFrames();
  this.redraw();
};

PanelWrapper.prototype.getViewTransform = function() {
  return {
    zoomScale: this.panZoomState.zoomScale,
    panOffset: this.panZoomState.panOffset
  };
};

PanelWrapper.prototype.setValue = function(frameSources, maxAnimationLoops) {
  const firstRect = frameSources[0].rect;
  if (this.frameSources == null || !this.frameSources[0].rect.equals(firstRect)) {
    this.panZoomState.documentBounds = new Rect(firstRect.x, firstRect.y, firstRect.width, firstRect.height);
    this.panZoomState.panOffset = new Point(0, 0);
    this.panZoomState.zoomScale = 1;
  }
  this.frameSources = frameSources;
  this.rebuildScaledFrames();
  this.stopFrameAnimation();
  this.activeFrameIndex = 0;
  this.animationLoopCount = 0;
  this.maxAnimationLoops = maxAnimationLoops == null ? 0 : maxAnimationLoops;
  this.advanceFrame();
};

PanelWrapper.prototype.onWheelZoom = function(wheelEvent) {
  wheelEvent.preventDefault();
  if (wheelEvent.deltaY == 0 || Date.now() - this.lastWheelZoomMs < WHEEL_ZOOM_DEBOUNCE_MS) return;
  const canvasPos = scalePointerToCanvasPixels(getEventPos(wheelEvent));
  this.lastWheelZoomMs = Date.now();
  this.zoomAtPoint(canvasPos, wheelEvent.deltaY < 0);
};

PanelWrapper.prototype.zoomAtPoint = function(canvasPos, zoomIn) {
  ZoomTool.setDocumentZoom(this.panZoomState, canvasPos, zoomIn);
  this.emitViewChange();
};

PanelWrapper.prototype.fitToBounds = function() {
  const panZoomState = this.panZoomState,
    docBounds = panZoomState.documentBounds;
  this.panZoomState.zoomScale = ZoomTool.fitZoomToBounds(
    docBounds.width,
    docBounds.height,
    panZoomState.viewportRect.width,
    panZoomState.viewportRect.height
  );
  this.emitViewChange();
};

PanelWrapper.prototype.emitViewChange = function() {
  this.rebuildScaledFrames();
  this.dispatch(new AppEvent("viewchange"));
  this.dispatch(new AppEvent("zoom"));
};

PanelWrapper.prototype.rebuildScaledFrames = function() {
  this.scaledFrameBuffers = [];
  const zoomScale = this.panZoomState.zoomScale;
  for (let frameIdx = 0; frameIdx < this.frameSources.length; frameIdx++) {
    const frameSource = this.frameSources[frameIdx],
      framePixels = new Uint8Array(frameSource.data);
    let scaledFrame;
    if (zoomScale >= 1) {
      scaledFrame = { buffer: framePixels, rect: frameSource.rect };
    } else {
      scaledFrame = resampleDown(framePixels, frameSource.rect, zoomScale);
    }
    this.scaledFrameBuffers.push(scaledFrame);
  }
};

PanelWrapper.prototype.stopFrameAnimation = function() {
  clearTimeout(this.frameAdvanceTimerId);
};

PanelWrapper.prototype.redraw = function() {
  if (this.frameSources == null || !isInDOM(this.canvasEl)) return;
  const frameComposite = buildPanelFrameComposite(this);
  if (frameComposite == null) return;
  blitPanelFrameComposite(this, frameComposite);
};

PanelWrapper.zoomBarImageCache = {};
PanelWrapper.ZOOM_BAR_WIDTH = 0;
PanelWrapper.ZOOM_BAR_HEIGHT = 0;

PanelWrapper.renderZoomBarImage = function(zoomScale, textColor) {
  const cacheKey = "z" + zoomScale + "," + textColor;
  let cachedImage = PanelWrapper.zoomBarImageCache[cacheKey];
  if (cachedImage) return cachedImage;
  const barWidth = Math.round(88 * getDevicePixelRatio()),
    barHeight = Math.round(18 * getDevicePixelRatio()),
    barCanvas = makeElement("canvas"),
    barCtx = barCanvas.getContext("2d");
  barCanvas.width = barWidth;
  barCanvas.height = barHeight;
  PanelWrapper.ZOOM_BAR_WIDTH = barWidth;
  PanelWrapper.ZOOM_BAR_HEIGHT = barHeight;
  barCtx.fillStyle = "rgba(1,1,1,1)";
  barCtx.fillRect(0, 0, barWidth, barHeight);
  barCtx.font = Math.round(11 * getDevicePixelRatio()) + "px monospace";
  barCtx.fillStyle = textColor;
  const zoomPercent = formatZoomPercentLabel(zoomScale),
    labelWidth = barCtx.measureText(zoomPercent).width,
    buttonWidth = Math.round(barWidth / 3),
    baselineY = Math.round(barHeight * 0.7);
  barCtx.fillText("-", Math.round((buttonWidth - barCtx.measureText("-").width) / 2), baselineY);
  barCtx.fillText(zoomPercent, Math.round((barWidth - labelWidth) / 2), baselineY);
  barCtx.fillText(
    "+",
    Math.round(barWidth - buttonWidth + (buttonWidth - barCtx.measureText("+").width) / 2),
    baselineY
  );
  cachedImage = PanelWrapper.zoomBarImageCache[cacheKey] = barCtx.getImageData(0, 0, barWidth, barHeight);
  return cachedImage;
};

PanelWrapper.prototype.advanceFrame = function() {
  const frameSources = this.frameSources,
    frameCount = frameSources.length,
    frameIndex = this.activeFrameIndex,
    currentFrame = frameSources[frameIndex],
    nextIndex = (frameIndex + 1) % frameCount;
  this.redraw();
  if (frameCount != 1 && frameSources[nextIndex].rect.equals(currentFrame.rect)) {
    const frameDelayMs = resolveFrameAdvanceDelayMs(currentFrame.layerName);
    if (nextIndex == 0) this.animationLoopCount++;
    if (this.maxAnimationLoops == 0 || this.animationLoopCount < this.maxAnimationLoops) {
      this.frameAdvanceTimerId = setTimeout(this.boundAdvanceFrame, frameDelayMs);
    }
  }
  this.activeFrameIndex = nextIndex;
};

PanelWrapper.prototype.resize = function(width, height) {
  if (width <= 0 || height <= 0) return;
  const pixelWidth = Math.floor(width * getDevicePixelRatio()),
    pixelHeight = Math.floor(height * getDevicePixelRatio());
  this.panZoomState.viewportRect = new Rect(0, 0, pixelWidth, pixelHeight);
  this.canvasEl.width = pixelWidth;
  this.canvasEl.height = pixelHeight;
  this.canvasEl.setAttribute(
    "style",
    "width:" +
      pixelWidth / getDevicePixelRatio() +
      "px; height:" +
      pixelHeight / getDevicePixelRatio() +
      "px; display:block;"
  );
  this.redraw();
};

/**
 * Send raw canvas pointer events to the host instead of panning.
 *
 * A panel that paints or samples on the preview wants the drag; one that only
 * looks at it wants the hand. Panels with a tool rail switch this on while that
 * tool is selected, so the hand tool keeps working the rest of the time.
 */
PanelWrapper.prototype.setPointerEventsDispatched = function(dispatched) {
  this.dispatchCanvasPointerEvents = !!dispatched;
};

PanelWrapper.prototype.onDragStart = function(pointerEvent) {
  this.pointerDownTarget = pointerEvent.target;
  addPointerMoveListener(window, this.boundOnDrag);
  addPointerUpListener(window, this.boundOnDragEnd);
  this.dragStartCanvasPos = scalePointerToCanvasPixels(getEventPos(pointerEvent, this.canvasEl));
  this.pointerCanvasPos = this.dragStartCanvasPos;
  this.panOriginAtDragStart = this.panZoomState.panOffset.clone();
  if (this.dispatchCanvasPointerEvents && this.pointerDownTarget == this.canvasEl && !this.transientCursorMode) {
    this.dispatch(new AppEvent("mousedown"));
  }
};

PanelWrapper.prototype.onDrag = function(pointerEvent) {
  const panZoomState = this.panZoomState,
    cursorMode = this.transientCursorMode,
    scaledDocRect = this.frameSources[this.activeFrameIndex].rect.clone();
  scaledDocRect.width *= panZoomState.zoomScale;
  scaledDocRect.height *= panZoomState.zoomScale;
  const canvasPos = scalePointerToCanvasPixels(getEventPos(pointerEvent, this.canvasEl));
  this.pointerCanvasPos = canvasPos;
  if (this.dispatchCanvasPointerEvents && this.pointerDownTarget == this.canvasEl && !cursorMode) {
    this.dispatch(new AppEvent("mousemove"));
  } else if ((cursorMode == "grab" || cursorMode == null) && !panZoomState.viewportRect.containsRect(scaledDocRect)) {
    const deltaX = canvasPos.x - this.dragStartCanvasPos.x,
      deltaY = canvasPos.y - this.dragStartCanvasPos.y;
    panZoomState.panOffset.x = this.panOriginAtDragStart.x + Math.round(deltaX);
    panZoomState.panOffset.y = this.panOriginAtDragStart.y + Math.round(deltaY);
    this.dispatch(new AppEvent("viewchange"));
  }
};

PanelWrapper.prototype.onDragEnd = function(pointerEvent) {
  removePointerMoveListener(window, this.boundOnDrag);
  removePointerUpListener(window, this.boundOnDragEnd);
  if (handleZoomBarClick(this)) return;
  if (pointerEvent.detail > 1) {
    this.panZoomState.zoomScale = 1;
    this.panZoomState.panOffset.setXY(0, 0);
    this.redraw();
  }
  const cursorMode = this.transientCursorMode;
  if (this.dispatchCanvasPointerEvents && this.pointerDownTarget == this.canvasEl && !cursorMode) {
    this.dispatch(new AppEvent("mouseup"));
  } else if (cursorMode == "zoom-in" || cursorMode == "zoom-out") {
    this.zoomAtPoint(this.pointerCanvasPos, cursorMode == "zoom-in");
  }
};

PanelWrapper.prototype.pointerToDocPoint = function() {
  return this.panZoomState.screenToDocPoint(this.pointerCanvasPos.x, this.pointerCanvasPos.y);
};

/** True while the pointer is over either clickable end of the on-canvas zoom bar. */
PanelWrapper.prototype.isPointerOverZoomButton = function(pointerEvent) {
  const pointerPos = pointerEvent
    ? scalePointerToCanvasPixels(getEventPos(pointerEvent, this.canvasEl))
    : this.pointerCanvasPos;
  const barWidth = PanelWrapper.ZOOM_BAR_WIDTH || Math.round(88 * getDevicePixelRatio());
  const barHeight = PanelWrapper.ZOOM_BAR_HEIGHT || Math.round(18 * getDevicePixelRatio());
  if (pointerPos.y < this.panZoomState.viewportRect.height - barHeight || pointerPos.x < 0 || pointerPos.x >= barWidth) {
    return false;
  }
  const buttonWidth = barWidth / 3;
  return pointerPos.x < buttonWidth || pointerPos.x >= 2 * buttonWidth;
};

function mountPanelWrapperDom(panelWrapper, dispatchCanvasPointerEvents) {
  panelWrapper.el = makeElement("div");
  panelWrapper.dispatchCanvasPointerEvents = dispatchCanvasPointerEvents;
  panelWrapper.transientCursorMode = null;
  panelWrapper.pointerCanvasPos = new Point(0, 0);
  panelWrapper.overlayContainerStyle = "position:relative;overflow:hidden;";
  panelWrapper.defaultCursorName = null;
  panelWrapper.cursorOverlay = new CursorOverlay(panelWrapper.el);
  // A bitmap brush cursor obscures the compact +/- zoom controls. Temporarily
  // restore the normal cursor over those buttons, while retaining brush cursor
  // feedback everywhere else in the preview.
  panelWrapper.cursorOverlay.shouldSuppressBitmapPreview = panelWrapper.isPointerOverZoomButton.bind(panelWrapper);
  panelWrapper.setDefaultCursor("grab");
  panelWrapper.canvasEl = makeElement("canvas", "canv");
  panelWrapper.el.appendChild(panelWrapper.canvasEl);
  panelWrapper.ctx2d = panelWrapper.canvasEl.getContext("2d");
  panelWrapper.frameImageData = null;
  panelWrapper.frameSources = null;
  panelWrapper.scaledFrameBuffers = null;
  panelWrapper.activeFrameIndex = 0;
  panelWrapper.animationLoopCount = 0;
  panelWrapper.maxAnimationLoops = 0;
  panelWrapper.boundAdvanceFrame = panelWrapper.advanceFrame.bind(panelWrapper);
  panelWrapper.frameAdvanceTimerId = null;
  panelWrapper.panZoomState = new CanvasViewport(new Rect(0, 0, 1, 1));
  panelWrapper.dragStartCanvasPos = null;
  panelWrapper.panOriginAtDragStart = null;
  panelWrapper.boundOnDragStart = panelWrapper.onDragStart.bind(panelWrapper);
  panelWrapper.boundOnDrag = panelWrapper.onDrag.bind(panelWrapper);
  panelWrapper.boundOnDragEnd = panelWrapper.onDragEnd.bind(panelWrapper);
  panelWrapper.boundOnWheel = panelWrapper.onWheelZoom.bind(panelWrapper);
  panelWrapper.lastWheelZoomMs = 0;
  panelWrapper.pointerDownTarget = null;
  panelWrapper.attachPointerHandlers(panelWrapper.canvasEl);
  panelWrapper.linkViewSync(panelWrapper);
}

function resolveTransientCursorMode(keyEvent) {
  if (!keyEvent.isPressed(KeyboardHandler.Space)) return null;
  let transientMode = "grab";
  if (keyEvent.isPressed(KeyboardHandler.Ctrl)) {
    transientMode = "zoom-in";
    if (keyEvent.isPressed(KeyboardHandler.Alt)) transientMode = "zoom-out";
  }
  return transientMode;
}

function applyKeyboardZoomShortcuts(panelWrapper, keyEvent) {
  if (!keyEvent.isPressed(KeyboardHandler.Ctrl)) return;
  let zoomDir = 0;
  if (keyEvent.isPressed(KeyboardHandler.Plus)) zoomDir = 1;
  if (keyEvent.isPressed(KeyboardHandler.Minus)) zoomDir = -1;
  if (zoomDir != 0) {
    panelWrapper.zoomAtPoint(
      new Point(panelWrapper.canvasEl.width / 2, panelWrapper.canvasEl.height / 2),
      zoomDir == 1
    );
  }
}

function scalePointerToCanvasPixels(canvasPos) {
  canvasPos.x *= getDevicePixelRatio();
  canvasPos.y *= getDevicePixelRatio();
  return canvasPos;
}

function buildPanelFrameComposite(panelWrapper) {
  let imageData = panelWrapper.frameImageData,
    canvasWidth = panelWrapper.canvasEl.width,
    canvasHeight = panelWrapper.canvasEl.height;
  if (imageData == null || imageData.width != canvasWidth || imageData.height != canvasHeight) {
    imageData = panelWrapper.frameImageData = panelWrapper.ctx2d.createImageData(canvasWidth, canvasHeight);
  }
  let activeScaled = panelWrapper.scaledFrameBuffers[panelWrapper.activeFrameIndex],
    panZoomState = panelWrapper.panZoomState,
    docBounds = panZoomState.documentBounds,
    viewportRect = panZoomState.viewportRect,
    viewportWidth = viewportRect.width,
    viewportHeight = viewportRect.height,
    scaledDocWidth = docBounds.width * panZoomState.zoomScale,
    scaledDocHeight = docBounds.height * panZoomState.zoomScale,
    drawX = Math.round((viewportWidth - scaledDocWidth) / 2 + panZoomState.panOffset.x),
    drawY = Math.round((viewportHeight - scaledDocHeight) / 2 + panZoomState.panOffset.y);
  let pixelBuffer,
    drawRect;
  if (panZoomState.zoomScale <= 1) {
    drawRect = activeScaled.rect.clone();
    drawRect.x = drawX;
    drawRect.y = drawY;
    scaledDocWidth = drawRect.width;
    scaledDocHeight = drawRect.height;
    pixelBuffer = activeScaled.buffer;
  } else {
    const invScale = 1 / panZoomState.zoomScale,
      sampleRect = new Rect(
        Math.floor((viewportRect.x - drawX) * invScale),
        Math.floor((viewportRect.y - drawY) * invScale),
        Math.ceil(viewportRect.width * invScale) + 1,
        Math.ceil(viewportRect.height * invScale) + 1
      ),
      upscaledRect = new Rect(
        0,
        0,
        sampleRect.width * panZoomState.zoomScale,
        sampleRect.height * panZoomState.zoomScale
      );
    upscaledRect.x = sampleRect.x * panZoomState.zoomScale + drawX;
    upscaledRect.y = sampleRect.y * panZoomState.zoomScale + drawY;
    if (
      panZoomState.zoomPreviewSampleBuffer == null ||
      panZoomState.zoomPreviewSampleBuffer.length != sampleRect.area() * 4
    ) {
      panZoomState.zoomPreviewSampleBuffer = allocBuffer(sampleRect.area() * 4);
    }
    if (
      panZoomState.zoomPreviewUpscaledBuffer == null ||
      panZoomState.zoomPreviewUpscaledBuffer.length != upscaledRect.area() * 4
    ) {
      panZoomState.zoomPreviewUpscaledBuffer = allocBuffer(upscaledRect.area() * 4);
    }
    fillBuffer(panZoomState.zoomPreviewSampleBuffer, 0);
    copyPixels(
      activeScaled.buffer,
      activeScaled.rect,
      panZoomState.zoomPreviewSampleBuffer,
      sampleRect
    );
    resampleUint32UniformScale(
      panZoomState.zoomPreviewSampleBuffer,
      sampleRect.width,
      sampleRect.height,
      panZoomState.zoomPreviewUpscaledBuffer,
      upscaledRect.width,
      upscaledRect.height,
      panZoomState.zoomScale
    );
    pixelBuffer = panZoomState.zoomPreviewUpscaledBuffer;
    drawRect = upscaledRect;
  }
  const canvasPixels = new Uint8Array(imageData.data.buffer);
  drawCheckerboard(canvasPixels, viewportWidth, viewportHeight, 8, -drawX, -drawY);
  composite("norm", pixelBuffer, drawRect, canvasPixels, viewportRect, viewportRect, 1);
  return {
    imageData: imageData,
    drawX: drawX,
    drawY: drawY,
    scaledDocWidth: scaledDocWidth,
    scaledDocHeight: scaledDocHeight,
    zoomScale: panZoomState.zoomScale,
    viewportHeight: panZoomState.viewportRect.height
  };
}

function blitPanelFrameComposite(panelWrapper, frameComposite) {
  const ctx2d = panelWrapper.ctx2d;
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.putImageData(frameComposite.imageData, 0, 0);
  ctx2d.clearRect(frameComposite.drawX - ZOOM_BAR_CLEAR_MARGIN, frameComposite.drawY, ZOOM_BAR_CLEAR_MARGIN, frameComposite.scaledDocHeight);
  ctx2d.clearRect(
    frameComposite.drawX + frameComposite.scaledDocWidth,
    frameComposite.drawY,
    ZOOM_BAR_CLEAR_MARGIN,
    frameComposite.scaledDocHeight
  );
  ctx2d.clearRect(
    frameComposite.drawX - ZOOM_BAR_CLEAR_MARGIN,
    frameComposite.drawY - ZOOM_BAR_CLEAR_MARGIN,
    frameComposite.scaledDocWidth + 2 * ZOOM_BAR_CLEAR_MARGIN,
    ZOOM_BAR_CLEAR_MARGIN
  );
  ctx2d.clearRect(
    frameComposite.drawX - ZOOM_BAR_CLEAR_MARGIN,
    frameComposite.drawY + frameComposite.scaledDocHeight,
    frameComposite.scaledDocWidth + 2 * ZOOM_BAR_CLEAR_MARGIN,
    ZOOM_BAR_CLEAR_MARGIN
  );
  const zoomBarImage = PanelWrapper.renderZoomBarImage(frameComposite.zoomScale, "#ffffff");
  ctx2d.putImageData(zoomBarImage, 0, frameComposite.viewportHeight - zoomBarImage.height);
}

function handleZoomBarClick(panelWrapper) {
  const barHeight =
      PanelWrapper.ZOOM_BAR_HEIGHT || Math.round(18 * getDevicePixelRatio()),
    barWidth = PanelWrapper.ZOOM_BAR_WIDTH || Math.round(88 * getDevicePixelRatio()),
    barY = panelWrapper.panZoomState.viewportRect.height - barHeight,
    clickTolerance = Math.round(ZOOM_BAR_HIT_TOLERANCE_CSS * getDevicePixelRatio());
  if (
    panelWrapper.pointerDownTarget != panelWrapper.canvasEl ||
    Math.abs(panelWrapper.dragStartCanvasPos.x - panelWrapper.pointerCanvasPos.x) >= clickTolerance ||
    Math.abs(panelWrapper.dragStartCanvasPos.y - panelWrapper.pointerCanvasPos.y) >= clickTolerance ||
    panelWrapper.pointerCanvasPos.y < barY ||
    panelWrapper.pointerCanvasPos.x >= barWidth
  ) {
    return false;
  }
  const buttonWidth = barWidth / 3;
  if (panelWrapper.pointerCanvasPos.x < buttonWidth) {
    panelWrapper.zoomAtPoint(panelWrapper.pointerCanvasPos, false);
    return true;
  }
  if (panelWrapper.pointerCanvasPos.x > 2 * buttonWidth) {
    panelWrapper.zoomAtPoint(panelWrapper.pointerCanvasPos, true);
    return true;
  }
  return false;
}

// --- PanelTab ------------------------------------------------------------------

/**
 * Export-options panel for the Save/Export dialog. Holds a per-format set of
 * option controls (quality, metadata, pages, channels, animation speed/repeat,
 * SVG flags, …) keyed by format in `formatOptionDefs`. `setFormatContext`
 * selects which controls are shown for the current format — adding animation
 * and slice options when applicable — and `getValue()` returns their values in
 * definition order. The visible control set is cached by
 * buildPanelTabRebuildCacheKey to avoid needless DOM rebuilds.
 */
function PanelTab() {
  BaseWidget.call(this);
  this.el = makeElement("div");
  this.formatContext = null;
  this.optionValues = null;
  this.rebuildCacheKey = -1;
  this.formatOptionDefs = buildFormatOptionDefinitions();
  wireFormatOptionChangeHandlers(this);
}

PanelTab.prototype = Object.create(BaseWidget.prototype);
PanelTab.prototype.constructor = PanelTab;

PanelTab.prototype.resetRebuildCache = function() {
  this.rebuildCacheKey = -1;
};

PanelTab.prototype.buildUI = function() {
  for (let formatKey in this.formatOptionDefs) {
    for (let optIdx = 0; optIdx < this.formatOptionDefs[formatKey].length; optIdx++) {
      this.formatOptionDefs[formatKey][optIdx].control.buildUI();
    }
  }
};

PanelTab.prototype.onOptionChanged = function() {
  this.rebuild();
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

PanelTab.prototype.rebuild = function() {
  const formatContext = this.formatContext,
    formatKey = FORMAT_OPTION_ALIASES[formatContext[0]] || formatContext[0],
    isAnimated = formatContext[1],
    hasSlices = formatContext[2],
    hidePagesField = formatContext[3],
    activeOptions = resolveActiveFormatOptions(this.formatOptionDefs, formatKey, isAnimated, hasSlices),
    cacheKey = buildPanelTabRebuildCacheKey(formatKey, isAnimated, hidePagesField);
  if (cacheKey != this.rebuildCacheKey) {
    this.rebuildCacheKey = cacheKey;
    mountFormatOptionControls(this.el, activeOptions, formatKey, hidePagesField);
  }
  this.optionValues = collectFormatOptionValues(activeOptions);
};

PanelTab.prototype.setFormatContext = function(formatKey, isAnimated, hasSlices, hidePagesField) {
  this.formatContext = [formatKey, isAnimated, hasSlices, hidePagesField];
  this.rebuild();
};

PanelTab.prototype.getValue = function() {
  return this.optionValues.slice(0);
};

function buildFormatOptionDefinitions() {
  const formatOptionDefs = {};
  formatOptionDefs.JPG = [
    { control: new TextRangeInput("properties.quality", 0, 100, "%", null, null, true), defaultValue: 70 },
    { control: new Checkbox("dialogs.exportOptions.attachMetadata"), defaultValue: false }
  ];
  formatOptionDefs.TIFF = [{ control: new Checkbox("dialogs.exportOptions.attachMetadata"), defaultValue: false }];
  formatOptionDefs.WEBP = [
    { control: new TextRangeInput("properties.quality", 0, 100, "%", null, null, true), defaultValue: 70 },
    { control: new Checkbox("dialogs.exportOptions.attachMetadata"), defaultValue: true }
  ];
  formatOptionDefs.GIF = [
    { control: new TextRangeInput("properties.quality", 0, 100, "%", null, null, true), defaultValue: 100 }
  ];
  formatOptionDefs.PNG = [
    { control: new TextRangeInput("properties.quality", 0, 100, "%", null, null, true), defaultValue: 100 },
    { control: new Checkbox("dialogs.exportOptions.noPalettes"), defaultValue: false }
  ];
  formatOptionDefs.PDF = [
    { control: new TextInput("properties.pages"), defaultValue: "" },
    { control: new TextRangeInput("properties.quality", 0, 100, "%", null, null, true), defaultValue: 100 },
    { control: new Checkbox("dialogs.exportOptions.rasteriseAll"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.rasteriseText"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.vectoriseText"), defaultValue: false }
  ];
  formatOptionDefs.EMF = [
    { control: new TextInput("properties.pages"), defaultValue: "" },
    { control: new Checkbox("dialogs.exportOptions.rasteriseAll"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.rasteriseText"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.vectoriseText"), defaultValue: false }
  ];
  formatOptionDefs.SVG = [
    { control: new Checkbox("dialogs.exportOptions.addRasterGraphics"), defaultValue: true },
    { control: new Checkbox("dialogs.exportOptions.addHiddenLayers"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.vectoriseText"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.rasteriseText"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.addLayerNames"), defaultValue: true },
    { control: new Checkbox("dialogs.exportOptions.prettyPrint"), defaultValue: true }
  ];
  formatOptionDefs.RAW = [
    { control: new ButtonMenu("properties.channels", ["1", "3", "4"]), defaultValue: 2 },
    { control: new ButtonMenu("properties.depth", ["8 Bits", "16 Bits"]), defaultValue: 0 },
    { control: new ButtonMenu("Byte Order", ["12-34", "34-12"]), defaultValue: 0 }
  ];
  // Written straight through to PSDParser.serialize as encodeOptions[0..2]; the
  // PSB flag at [3] comes from the codec, not from a control.
  formatOptionDefs.PSD = [
    { control: new Checkbox("properties.blankPreviewImage"), defaultValue: false },
    { control: new Checkbox("properties.zipForPixelData"), defaultValue: false },
    { control: new Checkbox("properties.removeSmartObjectPixels"), defaultValue: false }
  ];
  formatOptionDefs.anim = [
    { control: new TextRangeInput("dialogs.exportOptions.speed", 10, 800, "%", null, true, true), defaultValue: 100 },
    {
      control: new SliderDropdown("Repeat (0 = Forever)", 0, 10, " \xD7", 0, false, true),
      defaultValue: 0
    },
    { control: new Checkbox("dialogs.exportOptions.reverseFrames"), defaultValue: false },
    { control: new Checkbox("dialogs.exportOptions.boomerang"), defaultValue: false }
  ];
  formatOptionDefs.slcs = [{ control: new Checkbox("dialogs.exportOptions.asSlices"), defaultValue: true }];
  return formatOptionDefs;
}

function wireFormatOptionChangeHandlers(panelTab) {
  for (let formatKey in panelTab.formatOptionDefs) {
    const optionList = panelTab.formatOptionDefs[formatKey];
    for (let optIdx = 0; optIdx < optionList.length; optIdx++) {
      optionList[optIdx].control.setValue(optionList[optIdx].defaultValue);
      optionList[optIdx].control.on(EventType.widgetSelect, panelTab.onOptionChanged, panelTab);
    }
  }
}

function resolveActiveFormatOptions(formatOptionDefs, formatKey, isAnimated, hasSlices) {
  let activeOptions = formatOptionDefs[formatKey];
  if (activeOptions == null) activeOptions = [];
  else activeOptions = activeOptions.slice(0);
  if (isAnimated) activeOptions = activeOptions.concat(formatOptionDefs.anim);
  if (["GIF", "PNG", "JPG"].indexOf(formatKey) != -1 && hasSlices) {
    activeOptions = activeOptions.concat(formatOptionDefs.slcs);
  }
  return activeOptions;
}

function mountFormatOptionControls(containerEl, activeOptions, formatKey, hidePagesField) {
  clearElement(containerEl);
  for (let optIdx = 0; optIdx < activeOptions.length; optIdx++) {
    if (formatKey == "PDF" && hidePagesField && optIdx == 0) continue;
    containerEl.appendChild(activeOptions[optIdx].control.el);
    appendBreak(containerEl);
  }
}

function collectFormatOptionValues(activeOptions) {
  const optionValues = [];
  for (let optIdx = 0; optIdx < activeOptions.length; optIdx++) {
    optionValues.push(activeOptions[optIdx].control.getValue());
  }
  return optionValues;
}

export {
  buildCubePresetPaths,
  orientationWireToIndex,
  indexToOrientationWire,
  formatZoomPercentLabel,
  resolveFrameAdvanceDelayMs,
  buildPanelTabRebuildCacheKey,
  computeHistogramBandScale,
  computeHistogramChannelMean,
  smoothHistogramBins,
  extractStylePresetLabel,
  ChannelModeSelect,
  ICCProfileButton,
  DisplayOptions,
  PanelWrapper,
  PanelTab
};
