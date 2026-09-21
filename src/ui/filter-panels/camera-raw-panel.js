/**
 * Camera Raw filter workspace.
 *
 * Live preview on the left, developing controls on the right: histogram, the
 * stack of collapsible panels, and the confirm row. Each panel's visibility
 * switch writes the descriptor's own enable flag, so hiding a panel removes it
 * from the canvas preview and from the committed filter alike.
 */
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { ThemeConfig } from "../config/theme-config.js";
import { Button } from "../widgets/form-controls.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import {
  ChannelModeSelect,
  PanelWrapper,
} from "../widgets/controls/panel-widgets.js";
import { TextRangeInput } from "../widgets/controls/number-inputs.js";
import { FilterParameterPanel } from "./filter-parameter-panel.js";
import {
  CAMERA_RAW_APP_ID,
  CAMERA_RAW_MODE_FILTER,
  CAMERA_RAW_MODE_RAW,
  CAMERA_RAW_SECTIONS,
  COLOR_MIXER_BANDS,
  COLOR_MIXER_CHANNELS,
  PROCESS_VERSIONS,
  RAW_SLIDER_RANGES,
  RAW_WHITE_BALANCE_PRESETS,
  UPRIGHT_MODES,
  WHITE_BALANCE_AS_SHOT,
  WHITE_BALANCE_CUSTOM,
  WHITE_BALANCE_OPTIONS,
  WHITE_BALANCE_PRESETS,
  collectCameraRawScalars,
  createCameraRawDefaultDescriptor,
  readScalar,
  writeCameraRawScalars,
} from "../../features/filters/camera-raw-descriptor.js";
import { estimateTemperatureAndTintFromNeutral } from "../../features/filters/camera-raw-color.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, makeElement, removeClass } from "../../core/dom.js";
import { fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { computeHistogram } from "../../engine/compositing/pixel-ops.js";
import { developRaw, solveIlluminantForNeutral } from "../../engine/compositing/raw-functions.js";
import { planckianLocusFromChromaticity } from "../../engine/compositing/color-temperature.js";

const CAMERA_RAW_CONTROLS_WIDTH_PX = 320;

/** Mixer tab index that shows every channel at once. */
const MIXER_TAB_ALL = 3;

/** Opaque white: the fill a decoded plate starts from, since developRaw writes no alpha. */
const OPAQUE_WHITE_RGBA = 4294967295;

/** Saturation and lightness the tinted tracks are drawn at. */
const TRACK_SATURATION = "68%";
const TRACK_LIGHTNESS = "55%";

/** How far either side of a band's centre hue its track sweeps. */
const TRACK_HUE_SWEEP_DEGREES = 40;

/** Neutral grey the desaturated end of a saturation track starts from. */
const TRACK_GREY = "hsl(0, 0%, 52%)";

function trackHue(hueDegrees) {
  return "hsl(" + Math.round(((hueDegrees % 360) + 360) % 360) + ", " + TRACK_SATURATION + ", " + TRACK_LIGHTNESS + ")";
}

function fullHueSweep() {
  const stops = [];
  for (let hue = 0; hue <= 360; hue += 60) stops.push(trackHue(hue));
  return stops.join(", ");
}

/**
 * CSS gradient for a slider track. Camera Raw tints every track with the
 * outcome of dragging it — warm to cool, green to magenta, the hues a mixer
 * band reaches — so the control reads before it is touched.
 */
function buildSliderTrackGradient(spec) {
  const hue = spec.trackHue || 0;
  const sweep = TRACK_HUE_SWEEP_DEGREES;
  switch (spec.track) {
    case "temperature":
      return "linear-gradient(to right, hsl(212, 70%, 52%), hsl(200, 25%, 60%), hsl(48, 78%, 58%))";
    case "tint":
      return "linear-gradient(to right, hsl(125, 55%, 48%), hsl(120, 8%, 58%), hsl(310, 55%, 58%))";
    case "tone":
      return "linear-gradient(to right, #1a1a1a, #f2f2f2)";
    case "saturation":
      return "linear-gradient(to right, " + TRACK_GREY + ", " + fullHueSweep() + ")";
    case "hueWheel":
      return "linear-gradient(to right, " + fullHueSweep() + ")";
    case "bandHue":
    case "primaryHue":
      return "linear-gradient(to right, " + trackHue(hue - sweep) + ", " + trackHue(hue) +
        ", " + trackHue(hue + sweep) + ")";
    case "bandSaturation":
    case "primarySaturation":
      return "linear-gradient(to right, " + TRACK_GREY + ", " + trackHue(hue) + ")";
    case "bandLuminance":
      return "linear-gradient(to right, hsl(" + Math.round(hue) + ", 55%, 12%), " + trackHue(hue) +
        ", hsl(" + Math.round(hue) + ", 60%, 92%))";
    default:
      return null;
  }
}

function computePreferredCameraRawDialogSize(maxW, maxH) {
  return {
    width: Math.min(Math.max(Math.round(maxW * 0.82), 900), Math.min(1320, maxW)),
    height: Math.min(Math.max(Math.round(maxH * 0.8), 560), Math.min(940, maxH)),
  };
}

function iconButtonHtml(iconKey) {
  const src = getIconUrl(iconKey) || "";
  if (!src) return "";
  return "<img src=\"" + src + "\" class=\"autoscale gsicon\" width=\"14\" height=\"14\" alt=\"\" />";
}

/**
 * Camera Raw labels its rows plainly — no trailing colon — so the label is
 * handed over as markup, which the numeric widget renders verbatim.
 */
function sliderLabelMarkup(text) {
  return "<span class=\"camera-raw-slider-label\">" + text + "</span>";
}

function mountSlider(panel, hostEl, spec) {
  const widget = new TextRangeInput(
    sliderLabelMarkup(spec.label),
    spec.min,
    spec.max,
    null,
    spec.decimals || 0,
    false,
  );
  widget.setValue(readScalar(createCameraRawDefaultDescriptor(), spec.key, 0));
  widget.parent = panel;
  widget.on(EventType.widgetSelect, panel.onSliderChanged, panel);
  addClass(widget.el, "trangeinput");
  addClass(widget.el, "camera-raw-slider");
  const gradient = buildSliderTrackGradient(spec);
  if (gradient) widget.el.style.setProperty("--camera-raw-track", gradient);
  // Sliders that run from a negative minimum park their neutral point at the
  // centre of the track; Camera Raw marks that point on the track itself.
  if (spec.min < 0) addClass(widget.el, "camera-raw-slider-centred");
  panel.widgetsByKey[spec.key] = widget;
  hostEl.appendChild(widget.el);
  return widget;
}

/**
 * Move a numeric widget onto a different scale. Camera and layer develop share
 * the same three controls but not the same units, so the widget's bounds, the
 * range track it drives, and its decimal places all move together.
 */
/** The panel-layout spec for a slider key, or null when the key is unknown. */
function findSliderSpec(key) {
  for (let sectionIdx = 0; sectionIdx < CAMERA_RAW_SECTIONS.length; sectionIdx++) {
    const groups = CAMERA_RAW_SECTIONS[sectionIdx].groups || [];
    for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
      const sliders = groups[groupIdx].sliders;
      for (let sliderIdx = 0; sliderIdx < sliders.length; sliderIdx++) {
        if (sliders[sliderIdx].key === key) return sliders[sliderIdx];
      }
    }
  }
  return null;
}

function retuneSlider(widget, min, max, decimals) {
  if (!widget) return;
  const current = widget.getValue();
  widget.minValue = min;
  widget.maxValue = max;
  widget.setDecimalPlaces(decimals);
  widget.rangeEl.min = min;
  widget.rangeEl.max = max;
  if (decimals !== 0) widget.rangeEl.step = (max - min) / 200;
  else widget.rangeEl.removeAttribute("step");
  widget.setValue(Math.max(min, Math.min(max, current)));
  if (min < 0) addClass(widget.el, "camera-raw-slider-centred");
  else removeClass(widget.el, "camera-raw-slider-centred");
}

/**
 * Temperature / Tint that render a camera-native colour neutral, as the
 * white-balance eyedropper and Auto both need.
 * @returns {number[]} `[kelvin, tint]`, both rounded.
 */
function solveRawWhiteBalance(cameraMetadata, cameraRgb) {
  const illuminant = solveIlluminantForNeutral(cameraMetadata, cameraRgb);
  const locus = planckianLocusFromChromaticity(illuminant);
  return [Math.round(locus.correlatedColorTemp), Math.round(locus.tintBias)];
}

function mountGroupHeading(hostEl, text) {
  const headingEl = makeElement("div", "camera-raw-group-heading");
  headingEl.textContent = text;
  hostEl.appendChild(headingEl);
}

function mountSliderGroups(panel, fieldsEl, groups) {
  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const groupEl = makeElement("div", "camera-raw-group");
    if (group.heading) mountGroupHeading(groupEl, group.heading);
    for (let sliderIdx = 0; sliderIdx < group.sliders.length; sliderIdx++) {
      mountSlider(panel, groupEl, group.sliders[sliderIdx]);
    }
    fieldsEl.appendChild(groupEl);
  }
}

function mountSectionHeading(panel, sectionEl, section) {
  const headingEl = makeElement("div", "camera-raw-section-heading");

  const toggleBtn = makeElement("button", "camera-raw-section-toggle");
  toggleBtn.type = "button";
  toggleBtn.textContent = section.label;
  toggleBtn.addEventListener("click", function() {
    panel.setActiveSection(sectionEl);
  });
  headingEl.appendChild(toggleBtn);

  const visibilityBtn = makeElement("button", "camera-raw-section-eye");
  visibilityBtn.type = "button";
  visibilityBtn.title = "Toggle " + section.label + " adjustments";
  visibilityBtn.innerHTML = iconButtonHtml("lrs/eye") || "◉";
  visibilityBtn.addEventListener("click", function(clickEvent) {
    clickEvent.stopPropagation();
    panel.setSectionEnabled(section.enableKey, !panel.sectionEnabled[section.enableKey]);
    panel.refresh();
  });
  headingEl.appendChild(visibilityBtn);

  sectionEl.appendChild(headingEl);
  panel.sectionButtonsByKey[section.enableKey] = visibilityBtn;
  panel.sectionElementsByKey[section.enableKey] = sectionEl;
}

function mountWhiteBalanceRow(panel, fieldsEl) {
  const rowEl = makeElement("div", "camera-raw-wb-row");
  fieldsEl.appendChild(rowEl);

  const eyedropperBtn = makeElement("button", "camera-raw-eyedropper");
  eyedropperBtn.type = "button";
  eyedropperBtn.title = "White balance tool";
  eyedropperBtn.innerHTML = iconButtonHtml("tools/eyedropper") || "◆";
  eyedropperBtn.addEventListener("click", function() {
    panel.setEyedropperActive(!panel.eyedropperActive);
  });
  panel.eyedropperBtn = eyedropperBtn;
  rowEl.appendChild(eyedropperBtn);

  const labels = [];
  for (let i = 0; i < WHITE_BALANCE_OPTIONS.length; i++) labels.push(WHITE_BALANCE_OPTIONS[i][0]);
  const dropdown = new Dropdown("White Balance", labels);
  dropdown.parent = panel;
  dropdown.on(EventType.widgetSelect, panel.onWhiteBalanceModeChanged, panel);
  panel.whiteBalanceDropdown = dropdown;
  rowEl.appendChild(dropdown.el);
}

function mountProcessRow(panel, fieldsEl) {
  const labels = [];
  for (let i = 0; i < PROCESS_VERSIONS.length; i++) labels.push(PROCESS_VERSIONS[i][0]);
  const dropdown = new Dropdown("Process", labels);
  dropdown.parent = panel;
  dropdown.on(EventType.widgetSelect, panel.onProcessVersionChanged, panel);
  panel.processDropdown = dropdown;
  const rowEl = makeElement("div", "camera-raw-process-row");
  rowEl.appendChild(dropdown.el);
  fieldsEl.appendChild(rowEl);
}

function mountColorMixer(panel, fieldsEl) {
  const tabBar = makeElement("div", "camera-raw-mixer-tabs");
  fieldsEl.appendChild(tabBar);
  panel.mixerTabButtons = [];
  panel.mixerChannelHosts = [];

  const tabNames = [];
  for (let i = 0; i < COLOR_MIXER_CHANNELS.length; i++) tabNames.push(COLOR_MIXER_CHANNELS[i].label);
  tabNames.push("All");
  for (let tabIdx = 0; tabIdx < tabNames.length; tabIdx++) {
    const tabBtn = makeElement("button", "camera-raw-mixer-tab");
    tabBtn.type = "button";
    tabBtn.textContent = tabNames[tabIdx];
    tabBtn.addEventListener("click", function() {
      panel.setMixerTab(tabIdx);
    });
    tabBar.appendChild(tabBtn);
    panel.mixerTabButtons.push(tabBtn);
  }

  for (let channelIdx = 0; channelIdx < COLOR_MIXER_CHANNELS.length; channelIdx++) {
    const channel = COLOR_MIXER_CHANNELS[channelIdx];
    const hostEl = makeElement("div", "camera-raw-mixer-channel camera-raw-group");
    fieldsEl.appendChild(hostEl);
    panel.mixerChannelHosts.push(hostEl);
    const headingEl = makeElement("div", "camera-raw-group-heading camera-raw-mixer-channel-heading");
    headingEl.textContent = channel.label;
    hostEl.appendChild(headingEl);
    for (let bandIdx = 0; bandIdx < COLOR_MIXER_BANDS.length; bandIdx++) {
      const band = COLOR_MIXER_BANDS[bandIdx];
      mountSlider(panel, hostEl, {
        key: channel.prefix + band.suffix,
        label: band.label,
        min: -100,
        max: 100,
        track: channel.track,
        trackHue: band.centreHue,
      });
    }
  }
  panel.setMixerTab(0);
}

function mountGeometry(panel, fieldsEl) {
  mountGroupHeading(fieldsEl, "Upright");
  const barEl = makeElement("div", "camera-raw-geometry-bar");
  fieldsEl.appendChild(barEl);
  panel.geometryButtons = Object.create(null);
  for (let modeIdx = 0; modeIdx < UPRIGHT_MODES.length; modeIdx++) {
    const label = UPRIGHT_MODES[modeIdx][0];
    const mode = UPRIGHT_MODES[modeIdx][1];
    const buttonEl = makeElement("button", "camera-raw-geometry-btn");
    buttonEl.type = "button";
    buttonEl.textContent = label;
    buttonEl.addEventListener("click", function() {
      panel.setUprightMode(mode);
    });
    panel.geometryButtons[mode] = buttonEl;
    barEl.appendChild(buttonEl);
  }
}

FilterParameterPanel.cameraRaw = function() {
  FilterParameterPanel.call(this, CAMERA_RAW_APP_ID);
  addClass(this.el, "camera-raw-root");
  // Fill the dialog body so flex children can scroll instead of growing past it.
  this.el.style.cssText =
    "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;" +
    "display:flex;flex-direction:column;box-sizing:border-box;";
  this.widgetsByKey = Object.create(null);
  this.sectionButtonsByKey = Object.create(null);
  this.sectionElementsByKey = Object.create(null);
  this.sectionEnabled = Object.create(null);
  this.geometryButtons = Object.create(null);
  this.activeUprightMode = 0;
  this.processVersion = PROCESS_VERSIONS[0][1];
  this.sourceBuffer = null;
  this.previewBuffer = null;
  this.previewRect = null;
  this.redrawScheduled = false;
  this.needsPreviewFit = true;
  this.activeSectionEl = null;
  this.eyedropperActive = false;
  this.mixerTabIndex = 0;
  this.rawSource = null;
  this.lastRawDevelopSettings = null;
  this.activeWhiteBalance = WHITE_BALANCE_AS_SHOT;
  this.whiteBalanceDropdown = null;
  this.processDropdown = null;
  this.eyedropperBtn = null;
  this.mixerTabButtons = [];
  this.mixerChannelHosts = [];

  const panelEl = makeElement("div", "flexrow camera-raw-panel");
  panelEl.style.cssText = "flex:1 1 0;min-width:0;min-height:0;height:100%;width:100%;overflow:hidden;";
  this.containerEl = panelEl;
  this.el.appendChild(panelEl);

  // Drags pan the preview; the eyedropper takes them over only while it is armed.
  this.view = new PanelWrapper();
  addClass(this.view.el, "camera-raw-preview");
  this.view.resize(100, 100);
  panelEl.appendChild(this.view.el);
  this.view.on("mousedown", this.onPreviewPointerDown, this);

  const workspaceEl = makeElement("aside", "camera-raw-workspace");
  panelEl.appendChild(workspaceEl);

  const headerEl = makeElement("div", "camera-raw-header");
  workspaceEl.appendChild(headerEl);

  this.histogram = new ChannelModeSelect(280);
  this.histogram.setChannelIndex(4);
  // Develop output is quantised to eight bits, so the raw bins comb badly;
  // smoothing them shows the picture's distribution rather than the quantiser's.
  this.histogram.setHistogramSmoothing(2);
  addClass(this.histogram.el, "camera-raw-histogram");
  headerEl.appendChild(this.histogram.el);

  const controlsEl = makeElement("div", "camera-raw-controls scrollable");
  workspaceEl.appendChild(controlsEl);
  this.controlsEl = controlsEl;

  for (let sectionIdx = 0; sectionIdx < CAMERA_RAW_SECTIONS.length; sectionIdx++) {
    const section = CAMERA_RAW_SECTIONS[sectionIdx];
    this.sectionEnabled[section.enableKey] = true;
    const sectionEl = makeElement("section", "camera-raw-section");
    sectionEl.dataset.sectionId = section.id;
    mountSectionHeading(this, sectionEl, section);

    const fieldsEl = makeElement("div", "camera-raw-section-fields");
    sectionEl.appendChild(fieldsEl);

    if (section.kind === "basic") mountWhiteBalanceRow(this, fieldsEl);
    if (section.kind === "calibration") mountProcessRow(this, fieldsEl);
    if (section.kind === "colorMixer") mountColorMixer(this, fieldsEl);
    else if (section.kind === "geometry") mountGeometry(this, fieldsEl);
    else if (section.groups) mountSliderGroups(this, fieldsEl, section.groups);

    controlsEl.appendChild(sectionEl);
    if (this.activeSectionEl == null) this.activeSectionEl = sectionEl;
    else addClass(sectionEl, "collapsed");
  }

  const actionsEl = makeElement("div", "camera-raw-actions");
  workspaceEl.appendChild(actionsEl);
  this.actionsEl = actionsEl;

  const resetButton = new Button("properties.reset", true, null, true);
  resetButton.on("click", () => {
    this.applyDefaults();
    this.refresh();
  });
  actionsEl.appendChild(resetButton.el);
};

FilterParameterPanel.cameraRaw.prototype = Object.create(FilterParameterPanel.prototype);

FilterParameterPanel.cameraRaw.prototype.opensAsModalDialog = function() {
  return true;
};

/** Styling hook the hosting dialog copies onto its window element. */
FilterParameterPanel.cameraRaw.prototype.dialogClassName = "camera-raw-window";

/** True while the panel is developing a camera file rather than a layer. */
FilterParameterPanel.cameraRaw.prototype.isRawMode = function() {
  return this.rawSource != null;
};

FilterParameterPanel.cameraRaw.prototype.getPreferredDialogSize = function(maxW, maxH) {
  return computePreferredCameraRawDialogSize(maxW, maxH);
};

FilterParameterPanel.cameraRaw.prototype.appendCategoryHeader = function(headerEl) {
  addClass(headerEl, "camera-raw-confirm");
  this.actionsEl.appendChild(headerEl);
};

FilterParameterPanel.cameraRaw.prototype.onDocumentUpdate = function(doc) {
  if (!doc || !doc.theme) return;
  const fill = ThemeConfig.themes[doc.theme]["--text-color"];
  this.histogram.setHistogramFillColor(fill);
};

FilterParameterPanel.cameraRaw.prototype.setActiveSection = function(activeSectionEl) {
  const sections = this.el.querySelectorAll(".camera-raw-section");
  for (let sectionIdx = 0; sectionIdx < sections.length; sectionIdx++) {
    const sectionEl = sections[sectionIdx];
    if (sectionEl === activeSectionEl) removeClass(sectionEl, "collapsed");
    else addClass(sectionEl, "collapsed");
  }
  this.activeSectionEl = activeSectionEl;
  if (this.controlsEl) this.controlsEl.scrollTop = activeSectionEl.offsetTop;
};

/**
 * Toggle one panel's contribution. The switch dims and so do the panel's own
 * controls, so a hidden panel reads as hidden without losing its settings.
 */
FilterParameterPanel.cameraRaw.prototype.setSectionEnabled = function(enableKey, enabled) {
  this.sectionEnabled[enableKey] = !!enabled;
  const buttonEl = this.sectionButtonsByKey[enableKey];
  const sectionEl = this.sectionElementsByKey[enableKey];
  if (buttonEl) {
    if (enabled) removeClass(buttonEl, "bypassed");
    else addClass(buttonEl, "bypassed");
  }
  if (sectionEl) {
    // Use a scoped class — global `.disabled` sets pointer-events:none and
    // would trap the eye switch so the section could never be turned back on.
    if (enabled) removeClass(sectionEl, "camera-raw-section-off");
    else addClass(sectionEl, "camera-raw-section-off");
  }
};

FilterParameterPanel.cameraRaw.prototype.setMixerTab = function(tabIndex) {
  this.mixerTabIndex = tabIndex;
  for (let i = 0; i < this.mixerTabButtons.length; i++) {
    if (i === tabIndex) addClass(this.mixerTabButtons[i], "selected");
    else removeClass(this.mixerTabButtons[i], "selected");
  }
  const showAll = tabIndex === MIXER_TAB_ALL;
  for (let i = 0; i < this.mixerChannelHosts.length; i++) {
    const hostEl = this.mixerChannelHosts[i];
    hostEl.style.display = showAll || tabIndex === i ? "" : "none";
    // A single-channel tab is already named by the tab itself.
    if (showAll) removeClass(hostEl, "camera-raw-mixer-single");
    else addClass(hostEl, "camera-raw-mixer-single");
  }
};

FilterParameterPanel.cameraRaw.prototype.setEyedropperActive = function(active) {
  this.eyedropperActive = !!active;
  this.view.setPointerEventsDispatched(this.eyedropperActive);
  if (this.eyedropperActive) addClass(this.eyedropperBtn, "selected");
  else removeClass(this.eyedropperBtn, "selected");
  if (this.view && this.view.el) {
    this.view.el.style.cursor = this.eyedropperActive ? "crosshair" : "";
  }
};

FilterParameterPanel.cameraRaw.prototype.onPreviewPointerDown = function() {
  if (!this.eyedropperActive || this.sourceBuffer == null || this.previewRect == null) return;
  const docPoint = this.view.pointerToDocPoint();
  if (!docPoint) return;
  const x = Math.max(0, Math.min(this.previewRect.width - 1, Math.floor(docPoint.x)));
  const y = Math.max(0, Math.min(this.previewRect.height - 1, Math.floor(docPoint.y)));
  const pixel = y * this.previewRect.width + x;
  if (this.isRawMode()) {
    // Solve against the camera's own linear values, not the rendered plate.
    const linear = this.rawSource.previewLinear.linearRgbBuffer;
    const balance = solveRawWhiteBalance(this.rawSource.cameraMetadata, [
      linear[pixel * 3],
      linear[pixel * 3 + 1],
      linear[pixel * 3 + 2],
    ]);
    this.setTemperatureAndTint(balance[0], balance[1]);
  } else {
    // Measure against the undeveloped plate so repeated picks stay stable.
    const plate = this.sourceBuffer;
    const offset = pixel * 4;
    this.applyNeutralSample(plate[offset] / 255, plate[offset + 1] / 255, plate[offset + 2] / 255);
  }
  this.setWhiteBalanceEnum(WHITE_BALANCE_CUSTOM);
  this.setEyedropperActive(false);
  this.refresh();
};

/** Set Temperature / Tint so the sampled colour renders neutral. */
FilterParameterPanel.cameraRaw.prototype.applyNeutralSample = function(r, g, b) {
  const balance = estimateTemperatureAndTintFromNeutral(r, g, b);
  this.setTemperatureAndTint(balance.temperature, balance.tint);
};

FilterParameterPanel.cameraRaw.prototype.setWhiteBalanceEnum = function(enumValue) {
  let index = 0;
  for (let i = 0; i < WHITE_BALANCE_OPTIONS.length; i++) {
    if (WHITE_BALANCE_OPTIONS[i][1] === enumValue) { index = i; break; }
  }
  if (this.whiteBalanceDropdown) this.whiteBalanceDropdown.setValue(index);
  this.activeWhiteBalance = enumValue;
};

FilterParameterPanel.cameraRaw.prototype.onWhiteBalanceModeChanged = function() {
  const index = this.whiteBalanceDropdown.getValue();
  const enumValue = WHITE_BALANCE_OPTIONS[index][1];
  this.activeWhiteBalance = enumValue;
  if (enumValue === "Auto" && !this.isRawMode()) this.applyAutoWhiteBalance();
  else {
    const preset = this.resolveWhiteBalancePreset(enumValue);
    if (preset) this.setTemperatureAndTint(preset[0], preset[1]);
  }
  this.activeWhiteBalance = enumValue;
  this.refresh();
};

FilterParameterPanel.cameraRaw.prototype.setTemperatureAndTint = function(temperature, tint) {
  if (this.widgetsByKey.Temp) this.widgetsByKey.Temp.setValue(temperature);
  if (this.widgetsByKey.Tint) this.widgetsByKey.Tint.setValue(tint);
};

/** Auto white balance: neutralise the plate's average colour. */
FilterParameterPanel.cameraRaw.prototype.applyAutoWhiteBalance = function() {
  if (this.sourceBuffer == null) return;
  const plate = this.sourceBuffer;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let counted = 0;
  // Every 16th pixel is plenty to estimate a global cast and keeps the click instant.
  for (let offset = 0; offset < plate.length; offset += 64) {
    if (plate[offset + 3] === 0) continue;
    sumR += plate[offset];
    sumG += plate[offset + 1];
    sumB += plate[offset + 2];
    counted++;
  }
  if (!counted) return;
  const balance = estimateTemperatureAndTintFromNeutral(
    sumR / counted / 255,
    sumG / counted / 255,
    sumB / counted / 255,
  );
  this.setTemperatureAndTint(balance.temperature, balance.tint);
};

FilterParameterPanel.cameraRaw.prototype.onProcessVersionChanged = function() {
  this.processVersion = PROCESS_VERSIONS[this.processDropdown.getValue()][1];
  this.refresh();
};

FilterParameterPanel.cameraRaw.prototype.onSliderChanged = function(widgetEvent) {
  // Moving Temperature or Tint by hand puts white balance into Custom.
  const target = widgetEvent && widgetEvent.target;
  if (target && (target === this.widgetsByKey.Temp || target === this.widgetsByKey.Tint)) {
    this.setWhiteBalanceEnum(WHITE_BALANCE_CUSTOM);
  }
  this.refresh();
};

FilterParameterPanel.cameraRaw.prototype.setUprightMode = function(mode, shouldRefresh) {
  this.activeUprightMode = mode;
  for (const modeKey in this.geometryButtons) {
    const buttonEl = this.geometryButtons[modeKey];
    if ((modeKey | 0) === (mode | 0)) addClass(buttonEl, "selected");
    else removeClass(buttonEl, "selected");
  }
  if (shouldRefresh !== false) this.refresh();
};

FilterParameterPanel.cameraRaw.prototype.applyDefaults = function() {
  const defaults = createCameraRawDefaultDescriptor();
  for (const key in this.widgetsByKey) this.widgetsByKey[key].setValue(readScalar(defaults, key, 0));
  if (this.isRawMode()) this.setTemperatureAndTint(this.rawSource.asShot[0], this.rawSource.asShot[1]);
  this.setWhiteBalanceEnum(WHITE_BALANCE_AS_SHOT);
  this.setUprightMode(0, false);
  this.setProcessVersion(PROCESS_VERSIONS[0][1]);
  for (const enableKey in this.sectionButtonsByKey) this.setSectionEnabled(enableKey, true);
};

FilterParameterPanel.cameraRaw.prototype.setProcessVersion = function(version) {
  this.processVersion = version;
  if (!this.processDropdown) return;
  for (let i = 0; i < PROCESS_VERSIONS.length; i++) {
    if (PROCESS_VERSIONS[i][1] === version) {
      this.processDropdown.setValue(i);
      return;
    }
  }
};

/**
 * Develop a camera file instead of a rendered layer.
 *
 * The decoder owns white balance and exposure — it can spend the highlight
 * headroom that only exists before the plate is rendered to 8 bits — so those
 * three sliders switch to the camera scales (kelvin, ±150 tint, ±5 stops) and
 * are replayed through the decoder whenever they move. Everything below them in
 * the panel keeps working on the developed plate exactly as it does for a layer.
 *
 * @param {{
 *   previewLinear: { linearRgbBuffer: Float32Array, rawWidth: number, rawHeight: number },
 *   cameraMetadata: object,
 *   asShot: number[],
 *   auto: number[]
 * }} rawSource
 */
FilterParameterPanel.cameraRaw.prototype.setRawSource = function(rawSource) {
  this.rawSource = rawSource;
  this.lastRawDevelopSettings = null;
  for (const key in RAW_SLIDER_RANGES) {
    const range = RAW_SLIDER_RANGES[key];
    retuneSlider(this.widgetsByKey[key], range.min, range.max, range.decimals);
  }
};

/** Temperature / Tint the current white-balance mode asks for, or null for Custom. */
FilterParameterPanel.cameraRaw.prototype.resolveWhiteBalancePreset = function(enumValue) {
  if (!this.isRawMode()) {
    return WHITE_BALANCE_PRESETS[enumValue] || null;
  }
  if (enumValue === WHITE_BALANCE_AS_SHOT) return this.rawSource.asShot;
  if (enumValue === "Auto") return this.rawSource.auto;
  return RAW_WHITE_BALANCE_PRESETS[enumValue] || null;
};

/**
 * The four values `developRaw` takes. Contrast stays at zero:
 * the decoder's own contrast curve would compete with the Basic panel's, which
 * runs on the developed plate for camera files and layers alike.
 * @returns {number[]} `[kelvin, tint, exposureStops, contrast]`
 */
FilterParameterPanel.cameraRaw.prototype.readRawDecoderSettings = function() {
  return [
    this.widgetsByKey.Temp ? this.widgetsByKey.Temp.getValue() : 0,
    this.widgetsByKey.Tint ? this.widgetsByKey.Tint.getValue() : 0,
    this.widgetsByKey.Ex12 ? this.widgetsByKey.Ex12.getValue() : 0,
    0,
  ];
};

/** Re-run the decoder over the preview-sized linear plate when its inputs move. */
FilterParameterPanel.cameraRaw.prototype.refreshRawPlate = function() {
  const settings = this.readRawDecoderSettings();
  const previous = this.lastRawDevelopSettings;
  if (previous &&
      previous[0] === settings[0] && previous[1] === settings[1] && previous[2] === settings[2]) {
    return;
  }
  this.lastRawDevelopSettings = settings;
  // developRaw writes colour but not alpha, so the plate starts fully opaque.
  fillBuffer(this.sourceBuffer, OPAQUE_WHITE_RGBA);
  developRaw(
    this.rawSource.previewLinear,
    this.sourceBuffer,
    this.rawSource.cameraMetadata,
    settings,
  );
};

/** Return to developing rendered layers, dropping the camera-sized buffers. */
FilterParameterPanel.cameraRaw.prototype.releaseRawSource = function() {
  this.rawSource = null;
  this.lastRawDevelopSettings = null;
  this.sourceBuffer = null;
  this.previewBuffer = null;
  this.previewRect = null;
  for (const key in RAW_SLIDER_RANGES) {
    const spec = findSliderSpec(key);
    if (spec) retuneSlider(this.widgetsByKey[key], spec.min, spec.max, spec.decimals || 0);
  }
};

FilterParameterPanel.cameraRaw.prototype.setValue = function(
  descriptor,
  sourceBuffer,
  sourceRect,
  previewRect,
) {
  if (sourceBuffer != null) {
    sourceRect = sourceRect.clone();
    sourceRect.x = sourceRect.y = 0;
    this.sourceBuffer = sourceBuffer;
    this.previewBuffer = sourceBuffer.slice(0);
    this.previewRect = sourceRect;
  }

  const scalars = collectCameraRawScalars(descriptor || {});
  for (const key in this.widgetsByKey) {
    if (scalars[key] != null) this.widgetsByKey[key].setValue(scalars[key]);
  }
  this.setWhiteBalanceEnum(scalars.WBal || WHITE_BALANCE_AS_SHOT);
  this.setUprightMode(scalars.PerU || 0, false);
  this.setProcessVersion(scalars.PrVN || PROCESS_VERSIONS[0][1]);
  for (const enableKey in this.sectionButtonsByKey) {
    this.setSectionEnabled(enableKey, scalars[enableKey] !== false);
  }
  this.needsPreviewFit = true;
  this.redraw();
};

FilterParameterPanel.cameraRaw.prototype.getValue = function() {
  const descriptor = createCameraRawDefaultDescriptor();
  const scalars = Object.create(null);
  for (const key in this.widgetsByKey) scalars[key] = this.widgetsByKey[key].getValue();
  for (const enableKey in this.sectionEnabled) scalars[enableKey] = this.sectionEnabled[enableKey];
  scalars.WBal = this.activeWhiteBalance || WHITE_BALANCE_AS_SHOT;
  scalars.CMod = this.isRawMode() ? CAMERA_RAW_MODE_RAW : CAMERA_RAW_MODE_FILTER;
  scalars.PerU = this.activeUprightMode | 0;
  scalars.PrVN = this.processVersion | 0;
  writeCameraRawScalars(descriptor, scalars);
  return descriptor;
};

FilterParameterPanel.cameraRaw.prototype.refresh = function(widgetEvent) {
  FilterParameterPanel.prototype.refresh.call(this, widgetEvent);
  this.redraw();
};

FilterParameterPanel.cameraRaw.prototype.redraw = function() {
  if (this.sourceBuffer == null || this.redrawScheduled) return;
  this.redrawScheduled = true;
  const panel = this;
  requestAnimationFrame(function() {
    panel.redrawScheduled = false;
    panel.renderPreview();
  });
};

FilterParameterPanel.cameraRaw.prototype.renderPreview = function() {
  if (this.sourceBuffer == null || this.previewRect == null) return;
  if (this.isRawMode()) this.refreshRawPlate();
  const sourcePixels = { buffer: this.sourceBuffer, rect: this.previewRect };
  const destPixels = { buffer: this.previewBuffer, rect: this.previewRect };
  FilterDefs.applyFilterToPixels(
    CAMERA_RAW_APP_ID, sourcePixels, this.getValue(), null, null, destPixels,
  );
  this.view.setValue([{
    rect: this.previewRect,
    data: this.previewBuffer.buffer,
  }]);
  if (this.needsPreviewFit) {
    this.view.fitToBounds();
    this.needsPreviewFit = false;
  }
  this.histogram.setValue(computeHistogram(this.previewBuffer));
};

/**
 * Size the preview bitmap from the dialog's content box rather than the preview
 * host's client box: an unconstrained sidebar lets that host grow past the
 * window, which centres the image off-clip.
 */
FilterParameterPanel.cameraRaw.prototype.resize = function(width, height) {
  this.view.resize(Math.max(240, width - CAMERA_RAW_CONTROLS_WIDTH_PX), Math.max(120, height));
  this.needsPreviewFit = true;
  if (this.view.frameSources) {
    this.view.fitToBounds();
    this.needsPreviewFit = false;
  }
};

FilterParameterPanel.cameraRaw.prototype.buildUI = function() {
  for (const key in this.widgetsByKey) this.widgetsByKey[key].buildUI();
  if (this.whiteBalanceDropdown) this.whiteBalanceDropdown.buildUI();
  if (this.processDropdown) this.processDropdown.buildUI();
  if (this.histogram) this.histogram.buildUI();
};

export {
  computePreferredCameraRawDialogSize,
  CAMERA_RAW_CONTROLS_WIDTH_PX,
};
