/**
 * Lens Correction (`LnCr`) workspace — preview + Auto / Custom controls.
 *
 * Layout mirrors Liquify / Camera Raw: live {@link PanelWrapper} on the left,
 * sectioned parameter form on the right. Descriptor I/O uses the PSD `LnCr`
 * wire keys from {@link FilterDefs.create}.
 */
import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { LENS_EDGE_OPTIONS } from "../../features/filters/lens-correction-apply.js";
import {
  findCamera,
  findLens,
  interpolateDistortion,
  interpolateTca,
  interpolateVignetting,
  lensCoversFocalLength,
  listCameraMakers,
  listCameras,
  listLenses,
  loadLensProfileDatabase,
  matchProfileFromMetadata,
} from "../../features/filters/lens-profile.js";
import { ToolBar } from "../tool-options/option-bar.js";
import { DrawingCanvas } from "../widgets/controls/canvas-widgets.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { TextRangeInput } from "../widgets/controls/number-inputs.js";
import { PanelWrapper } from "../widgets/controls/panel-widgets.js";
import { Button, Checkbox } from "../widgets/form-controls.js";
import { FilterParameterPanel } from "./filter-parameter-panel.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, getDevicePixelRatio, makeElement, removeClass } from "../../core/dom.js";
import { resampleDown } from "../../engine/compositing/pixel-ops.js";

const LENS_CORRECTION_CONTROLS_WIDTH_PX = 320;
const LENS_CORRECTION_FILTER_ID = "LnCr";

const TOOL_GRID = 0;
const TOOL_STRAIGHTEN = 1;
const TOOL_HAND = 2;

/** Longest edge for interactive transform previews (angle / straighten / keystone). */
const DRAFT_PREVIEW_MAX_EDGE = 1024;
/** Coarser warp lattice while dragging — full quality lands after the commit delay. */
const DRAFT_WARP_GRID_DIVISOR = 10;
/** Wait this long after the last transform tick before committing the document plate. */
const TRANSFORM_COMMIT_MS = 140;

/** Grid overlay only — never re-runs the warp pipeline. */
function isGridOnlyControl(panel, widgetEvent) {
  const target = widgetEvent && widgetEvent.target;
  return (
    target === panel.showGridCheckbox ||
    target === panel.gridSizeSlider ||
    target === panel.gridColorWidget
  );
}

/** Angle / perspective / scale / distortion — expensive warp; draft while dragging. */
function isInteractiveTransformControl(panel, widgetEvent) {
  const target = widgetEvent && widgetEvent.target;
  return (
    target === panel.angleDial ||
    target === panel.verticalPerspectiveSlider ||
    target === panel.horizontalPerspectiveSlider ||
    target === panel.scaleSlider ||
    target === panel.removeDistortionSlider
  );
}

/** Nearest-neighbour upscale so a draft plate can fill the full preview buffer. */
function upscaleNearestRgba(src, srcW, srcH, dest, destW, destH) {
  for (let y = 0; y < destH; y++) {
    const srcY = Math.min(srcH - 1, ((y * srcH) / destH) | 0);
    const srcRow = srcY * srcW;
    const destRow = y * destW;
    for (let x = 0; x < destW; x++) {
      const srcX = Math.min(srcW - 1, ((x * srcW) / destW) | 0);
      const si = (srcRow + srcX) << 2;
      const di = (destRow + x) << 2;
      dest[di] = src[si];
      dest[di + 1] = src[si + 1];
      dest[di + 2] = src[si + 2];
      dest[di + 3] = src[si + 3];
    }
  }
}

function computePreferredLensCorrectionDialogSize(maxW, maxH) {
  return {
    width: Math.min(Math.max(Math.round(maxW * 0.78), 780), Math.min(1180, maxW)),
    height: Math.min(Math.max(Math.round(maxH * 0.72), 520), Math.min(860, maxH)),
  };
}

function buildLensCorrectionToolbarSpec() {
  return {
    toolbarGroups: [
      [{ tool: { id: TOOL_GRID, name: "filters.options.lensCorrection.showGrid", iconId: "tools/grid-4x4" } }],
      [{ tool: { id: TOOL_STRAIGHTEN, name: "filters.options.lensCorrection.straighten", iconId: "tools/keyframe-align-horizontal" } }],
      [{ tool: { id: TOOL_HAND, name: "tools.handTool", iconId: "tools/hand" } }],
    ],
    toolbarShortcutKeys: [],
  };
}

/** Plain label markup (no trailing colon) — same pattern as Camera Raw Filter. */
function sliderLabelMarkup(text) {
  return "<span class=\"lens-correction-slider-label\">" + text + "</span>";
}

function mountSectionHeading(hostEl, titleKey) {
  const headingEl = makeElement("div", "lens-correction-section-heading");
  headingEl.textContent = Locale.get(titleKey);
  hostEl.appendChild(headingEl);
}

/** A labelled dropdown in the Search Criteria block. */
function mountSearchDropdown(panel, labelKey, handler) {
  const dropdown = new Dropdown(labelKey, [""]);
  dropdown.parent = panel;
  dropdown.on(EventType.widgetSelect, handler, panel);
  const rowEl = makeElement("div", "lens-correction-search-row");
  rowEl.appendChild(dropdown.el);
  panel.autoPaneEl.appendChild(rowEl);
  return dropdown;
}

function mountSection(hostEl, titleKey) {
  const sectionEl = makeElement("section", "lens-correction-section");
  const headingEl = makeElement("div", "lens-correction-section-heading");
  headingEl.textContent = Locale.get(titleKey);
  sectionEl.appendChild(headingEl);
  const fieldsEl = makeElement("div", "lens-correction-section-fields");
  sectionEl.appendChild(fieldsEl);
  hostEl.appendChild(sectionEl);
  return fieldsEl;
}

function mountSlider(panel, hostEl, labelKey, min, max, suffix, decimals) {
  const labelText = Locale.get(labelKey);
  const widget = new TextRangeInput(
    sliderLabelMarkup(labelText),
    min,
    max,
    suffix || null,
    decimals || 0,
    false
  );
  widget.parent = panel;
  widget.on(EventType.widgetSelect, panel.onControlChanged, panel);
  addClass(widget.el, "trangeinput");
  addClass(widget.el, "lens-correction-slider");
  if (min < 0) addClass(widget.el, "lens-correction-slider-centred");
  hostEl.appendChild(widget.el);
  return widget;
}

/** Dropdown index for an `LnFt` value, falling back to the first entry. */
function edgeOptionIndex(edgeValue) {
  for (let i = 0; i < LENS_EDGE_OPTIONS.length; i++) {
    if (LENS_EDGE_OPTIONS[i][1] === edgeValue) return i;
  }
  return 0;
}

function readRgbFromColorWidgetValue(colorValue) {
  if (colorValue && colorValue.Rd) {
    return {
      r: colorValue.Rd.v,
      g: colorValue.Grn.v,
      b: colorValue.Bl.v,
    };
  }
  if (colorValue && colorValue.h != null) {
    return { r: colorValue.h, g: colorValue.l, b: colorValue.O };
  }
  return { r: 127, g: 127, b: 127 };
}

/**
 * Fullscreen Lens Correction dialog panel.
 */
FilterParameterPanel.LnCr = function() {
  FilterParameterPanel.call(this, LENS_CORRECTION_FILTER_ID);
  this.activeTab = "custom";
  this.activeToolIndex = TOOL_HAND;
  this.straightenAnchor = null;
  this.straightenTip = null;
  this.sourceBuffer = null;
  this.previewBuffer = null;
  this.previewRect = null;
  this._needsPreviewFit = true;
  this._redrawScheduled = false;
  this._previewQuality = "full";
  this._transformCommitTimer = null;
  this._draftWorkBuffer = null;
  this.profileDatabase = null;
  this.documentMetadata = null;
  this.selectedCamera = null;
  this.selectedLens = null;

  addClass(this.el, "lens-correction-root");
  this.el.style.cssText =
    "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;" +
    "display:flex;flex-direction:column;box-sizing:border-box;";

  const panelEl = makeElement("div", "flexrow lens-correction-panel");
  panelEl.style.cssText =
    "flex:1 1 0;min-width:0;min-height:0;height:100%;width:100%;overflow:hidden;";
  this.containerEl = panelEl;
  this.el.appendChild(panelEl);

  this.toolbarSpec = buildLensCorrectionToolbarSpec();
  this.toolBar = new ToolBar(this.toolbarSpec, false);
  this.toolBar.setActiveToolById(TOOL_HAND);
  this.toolBar.on(EventType.uiDispatch, this.onToolbarDispatch, this);
  panelEl.appendChild(this.toolBar.el);

  // Drags pan the preview; Straighten takes them over only while it is selected.
  this.view = new PanelWrapper();
  addClass(this.view.el, "lens-correction-preview");
  this.view.resize(100, 100);
  this.view.on("mousedown", this.onPreviewPointerDown, this);
  this.view.on("mousemove", this.onPreviewPointerMove, this);
  this.view.on("mouseup", this.onPreviewPointerUp, this);
  this.view.on("viewchange", this.onPreviewViewChange, this);
  panelEl.appendChild(this.view.el);

  // Screen-space chrome: grid + straighten rubber-band (never touch the plate).
  this.gridOverlayEl = makeElement("canvas", "lens-correction-grid-overlay");
  this.gridOverlayEl.setAttribute("aria-hidden", "true");
  this.view.el.appendChild(this.gridOverlayEl);
  this.straightenOverlayEl = makeElement("canvas", "lens-correction-straighten-overlay");
  this.straightenOverlayEl.setAttribute("aria-hidden", "true");
  this.view.el.appendChild(this.straightenOverlayEl);

  const workspaceEl = makeElement("aside", "lens-correction-workspace");
  panelEl.appendChild(workspaceEl);
  this.workspaceEl = workspaceEl;

  const tabBarEl = makeElement("div", "lens-correction-tabs");
  workspaceEl.appendChild(tabBarEl);
  this.autoTabBtn = makeElement("button", "lens-correction-tab");
  this.autoTabBtn.type = "button";
  this.autoTabBtn.textContent = Locale.get("filters.options.lensCorrection.autoCorrection");
  this.autoTabBtn.addEventListener("click", () => this.setActiveTab("auto"));
  tabBarEl.appendChild(this.autoTabBtn);
  this.customTabBtn = makeElement("button", "lens-correction-tab selected");
  this.customTabBtn.type = "button";
  this.customTabBtn.textContent = Locale.get("filters.options.lensCorrection.custom");
  this.customTabBtn.addEventListener("click", () => this.setActiveTab("custom"));
  tabBarEl.appendChild(this.customTabBtn);

  const controlsEl = makeElement("div", "lens-correction-controls scrollable");
  workspaceEl.appendChild(controlsEl);
  this.controlsEl = controlsEl;

  this.autoPaneEl = makeElement("div", "lens-correction-pane");
  controlsEl.appendChild(this.autoPaneEl);

  mountSectionHeading(this.autoPaneEl, "filters.options.lensCorrection.correction");
  this.geometricAutoCheckbox = new Checkbox("filters.options.lensCorrection.geometricDistortion");
  this.chromaticAutoCheckbox = new Checkbox("filters.options.lensCorrection.chromaticAberration");
  this.vignetteAutoCheckbox = new Checkbox("filters.options.lensCorrection.vignette");
  this.autoScaleCheckbox = new Checkbox("filters.options.lensCorrection.autoScale");
  this.profileCorrectionCheckboxes = [
    this.geometricAutoCheckbox,
    this.chromaticAutoCheckbox,
    this.vignetteAutoCheckbox,
  ];
  for (const checkbox of this.profileCorrectionCheckboxes.concat(this.autoScaleCheckbox)) {
    checkbox.parent = this;
    checkbox.on(EventType.widgetSelect, this.onControlChanged, this);
    this.autoPaneEl.appendChild(checkbox.el);
  }

  const edgeRow = makeElement("div", "lens-correction-edge-row");
  const edgeLabels = LENS_EDGE_OPTIONS.map((option) => option[0]);
  this.edgeDropdown = new Dropdown("filters.options.lensCorrection.edge", edgeLabels);
  this.edgeDropdown.parent = this;
  this.edgeDropdown.on(EventType.widgetSelect, this.onControlChanged, this);
  edgeRow.appendChild(this.edgeDropdown.el);
  this.autoPaneEl.appendChild(edgeRow);

  mountSectionHeading(this.autoPaneEl, "filters.options.lensCorrection.searchCriteria");
  this.cameraMakerDropdown = mountSearchDropdown(
    this, "filters.options.lensCorrection.cameraMake", this.onCameraMakerChanged);
  this.cameraModelDropdown = mountSearchDropdown(
    this, "filters.options.lensCorrection.cameraModel", this.onCameraModelChanged);
  this.lensModelDropdown = mountSearchDropdown(
    this, "filters.options.lensCorrection.lensModel", this.onLensModelChanged);

  this.autoHelpEl = makeElement("div", "lens-correction-help");
  this.autoPaneEl.appendChild(this.autoHelpEl);

  this.customPaneEl = makeElement("div", "lens-correction-pane");
  controlsEl.appendChild(this.customPaneEl);

  const geoFields = mountSection(this.customPaneEl, "filters.options.lensCorrection.geometricDistortion");
  this.removeDistortionSlider = mountSlider(
    this, geoFields, "filters.options.lensCorrection.removeDistortion", -100, 100, null, 2
  );

  const caFields = mountSection(this.customPaneEl, "filters.options.lensCorrection.chromaticAberration");
  this.redCyanSlider = mountSlider(this, caFields, "filters.options.lensCorrection.fixRedCyan", -100, 100, null, 2);
  this.greenMagentaSlider = mountSlider(this, caFields, "filters.options.lensCorrection.fixGreenMagenta", -100, 100, null, 2);
  this.blueYellowSlider = mountSlider(this, caFields, "filters.options.lensCorrection.fixBlueYellow", -100, 100, null, 2);

  const vigFields = mountSection(this.customPaneEl, "filters.options.lensCorrection.vignette");
  this.vignetteAmountSlider = mountSlider(this, vigFields, "properties.amount", -100, 100, null, 0);
  this.vignetteMidpointSlider = mountSlider(this, vigFields, "filters.options.lensCorrection.midpoint", 0, 100, null, 0);

  const xformFields = mountSection(this.customPaneEl, "filters.options.lensCorrection.transform");
  this.verticalPerspectiveSlider = mountSlider(
    this, xformFields, "filters.options.lensCorrection.verticalPerspective", -100, 100, null, 0
  );
  this.horizontalPerspectiveSlider = mountSlider(
    this, xformFields, "filters.options.lensCorrection.horizontalPerspective", -100, 100, null, 0
  );
  this.angleDial = new DrawingCanvas("properties.angle", { zeroAtTop: true });
  this.angleDial.parent = this;
  this.angleDial.on(EventType.widgetSelect, this.onControlChanged, this);
  addClass(this.angleDial.el, "lens-correction-angle");
  xformFields.appendChild(this.angleDial.el);
  this.scaleSlider = mountSlider(this, xformFields, "properties.scale", 10, 200, "%", 0);

  const viewFields = mountSection(this.customPaneEl, "filters.options.lensCorrection.gridOptions");
  this.showGridCheckbox = new Checkbox("filters.options.lensCorrection.showGrid");
  this.showGridCheckbox.parent = this;
  this.showGridCheckbox.on(EventType.widgetSelect, this.onControlChanged, this);
  viewFields.appendChild(this.showGridCheckbox.el);
  this.gridColorWidget = new ColorSampleWidget(false);
  this.gridColorWidget.parent = this;
  this.gridColorWidget.on(EventType.widgetSelect, this.onControlChanged, this);
  const colorRow = makeElement("div", "lens-correction-color-row");
  const colorLabel = makeElement("span", "flabel");
  colorLabel.textContent = Locale.get("colour.title");
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(this.gridColorWidget.el);
  viewFields.appendChild(colorRow);
  this.gridSizeSlider = mountSlider(this, viewFields, "properties.size.title", 4, 200, null, 0);

  const actionsEl = makeElement("div", "lens-correction-actions");
  workspaceEl.appendChild(actionsEl);
  this.actionsEl = actionsEl;
  const resetButton = new Button("properties.reset", true, null, true);
  resetButton.on("click", () => {
    this.applyDefaults();
    this.refresh();
  });
  actionsEl.appendChild(resetButton.el);

  this.setActiveTab("custom");
};

FilterParameterPanel.LnCr.prototype = Object.create(FilterParameterPanel.prototype);

FilterParameterPanel.LnCr.prototype.dialogClassName = "lens-correction-window";

FilterParameterPanel.LnCr.prototype.opensAsModalDialog = function() {
  return true;
};

FilterParameterPanel.LnCr.prototype.getPreferredDialogSize = function(maxW, maxH) {
  return computePreferredLensCorrectionDialogSize(maxW, maxH);
};

FilterParameterPanel.LnCr.prototype.appendCategoryHeader = function(headerEl) {
  addClass(headerEl, "lens-correction-confirm");
  this.actionsEl.appendChild(headerEl);
};

FilterParameterPanel.LnCr.prototype.setActiveTab = function(tabId) {
  this.activeTab = tabId;
  if (tabId === "auto") {
    addClass(this.autoTabBtn, "selected");
    removeClass(this.customTabBtn, "selected");
    this.autoPaneEl.style.display = "";
    this.customPaneEl.style.display = "none";
  } else {
    removeClass(this.autoTabBtn, "selected");
    addClass(this.customTabBtn, "selected");
    this.autoPaneEl.style.display = "none";
    this.customPaneEl.style.display = "";
  }
};

FilterParameterPanel.LnCr.prototype.onToolbarDispatch = function(dispatchEvent) {
  if (!dispatchEvent.data || dispatchEvent.data.dispatchKind != UiCommand.setActiveToolPanelMode) {
    return;
  }
  const toolId = dispatchEvent.data.routingChannel;
  if (toolId === TOOL_GRID) {
    // Latch: keep Hand / Straighten as the interaction tool; only flip the overlay.
    this.setShowGrid(!this.showGridCheckbox.getValue());
    this.toolBar.setActiveToolById(this.activeToolIndex);
    this.syncGridToolbarState();
    return;
  }
  this.activeToolIndex = toolId;
  this.toolBar.setActiveToolById(toolId);
  this.syncGridToolbarState();
  this.view.setPointerEventsDispatched(toolId === TOOL_STRAIGHTEN);
  this.view.setDefaultCursor(toolId === TOOL_STRAIGHTEN ? "crosshair" : "grab");
};

FilterParameterPanel.LnCr.prototype.onControlChanged = function(widgetEvent) {
  if (isGridOnlyControl(this, widgetEvent)) {
    this.syncGridToolbarState();
    this.redrawGridOverlay();
    return;
  }
  if (isInteractiveTransformControl(this, widgetEvent)) {
    this.scheduleInteractiveTransformPreview();
    return;
  }
  this.commitFullPreview();
};

/**
 * Fast dialog-only draft while the user is still dragging a transform control.
 * Document live-preview waits until {@link commitFullPreview}.
 */
FilterParameterPanel.LnCr.prototype.scheduleInteractiveTransformPreview = function() {
  this._previewQuality = "draft";
  this.redraw();
  if (this._transformCommitTimer != null) clearTimeout(this._transformCommitTimer);
  const panel = this;
  this._transformCommitTimer = setTimeout(function() {
    panel._transformCommitTimer = null;
    panel.commitFullPreview();
  }, TRANSFORM_COMMIT_MS);
};

/** Full-quality panel preview + document commit (end of a drag / non-transform edit). */
FilterParameterPanel.LnCr.prototype.commitFullPreview = function() {
  if (this._transformCommitTimer != null) {
    clearTimeout(this._transformCommitTimer);
    this._transformCommitTimer = null;
  }
  this._previewQuality = "full";
  this.refresh();
};

/** Preview-only Show Grid latch — no document / warp refresh. */
FilterParameterPanel.LnCr.prototype.setShowGrid = function(show) {
  this.showGridCheckbox.setValue(!!show);
  this.syncGridToolbarState();
  this.redrawGridOverlay();
};

/** Grid is a toggle, not a mode — keep it lit while Hand / Straighten stays active. */
FilterParameterPanel.LnCr.prototype.syncGridToolbarState = function() {
  const show = !!(this.showGridCheckbox && this.showGridCheckbox.getValue());
  const entries = this.toolBar.toolEntries;
  const buttons = this.toolBar.toolButtons;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === TOOL_GRID) buttons[i].setSelected(show);
  }
};

FilterParameterPanel.LnCr.prototype.onPreviewViewChange = function() {
  this.redrawGridOverlay();
  this.redrawStraightenOverlay();
};

/**
 * Size/position an overlay canvas to match the preview bitmap's device pixels.
 * @returns {{ ctx: CanvasRenderingContext2D, pixelW: number, pixelH: number, dpr: number }|null}
 */
FilterParameterPanel.LnCr.prototype.prepareOverlayCanvas = function(overlay) {
  const view = this.view;
  if (!overlay || !view || !view.panZoomState || !view.canvasEl) return null;
  const viewport = view.panZoomState.viewportRect;
  if (!viewport || viewport.width < 1 || viewport.height < 1) return null;

  const dpr = getDevicePixelRatio();
  const pixelW = viewport.width | 0;
  const pixelH = viewport.height | 0;
  if (overlay.width !== pixelW || overlay.height !== pixelH) {
    overlay.width = pixelW;
    overlay.height = pixelH;
  }
  overlay.style.left = view.canvasEl.offsetLeft + "px";
  overlay.style.top = view.canvasEl.offsetTop + "px";
  overlay.style.width = pixelW / dpr + "px";
  overlay.style.height = pixelH / dpr + "px";
  overlay.style.transform = "none";

  const ctx = overlay.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixelW, pixelH);
  return { ctx: ctx, pixelW: pixelW, pixelH: pixelH, dpr: dpr };
};

/**
 * Stroke the alignment grid in screen pixels over the preview. Cheap enough to
 * run on every pan/zoom tick; never touches the corrected plate.
 */
FilterParameterPanel.LnCr.prototype.redrawGridOverlay = function() {
  const overlay = this.gridOverlayEl;
  const show = !!(this.showGridCheckbox && this.showGridCheckbox.getValue());
  if (overlay) overlay.style.display = show ? "block" : "none";
  if (!show) return;

  const prepared = this.prepareOverlayCanvas(overlay);
  if (!prepared) return;
  const view = this.view;
  const docBounds = view.panZoomState.documentBounds;
  if (!docBounds) return;

  const { ctx, pixelW, pixelH, dpr } = prepared;
  const zoom = view.panZoomState.zoomScale;
  const pan = view.panZoomState.panOffset;
  const drawX = (pixelW - docBounds.width * zoom) / 2 + pan.x;
  const drawY = (pixelH - docBounds.height * zoom) / 2 + pan.y;
  const docW = docBounds.width * zoom;
  const docH = docBounds.height * zoom;
  const stepDoc = Math.max(4, (this.gridSizeSlider && this.gridSizeSlider.getValue()) | 0 || 64);
  const step = stepDoc * zoom;
  if (step < 2) return;

  const rgb = readRgbFromColorWidgetValue(
    this.gridColorWidget ? this.gridColorWidget.getValue() : null
  );
  ctx.strokeStyle = "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + ",0.7)";
  ctx.lineWidth = Math.max(1, dpr * 0.75);
  ctx.beginPath();
  const x0 = drawX;
  const x1 = drawX + docW;
  const y0 = drawY;
  const y1 = drawY + docH;
  for (let x = drawX; x <= x1 + 0.5; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, y0);
    ctx.lineTo(Math.round(x) + 0.5, y1);
  }
  for (let y = drawY; y <= y1 + 0.5; y += step) {
    ctx.moveTo(x0, Math.round(y) + 0.5);
    ctx.lineTo(x1, Math.round(y) + 0.5);
  }
  ctx.stroke();
};

/**
 * Rubber-band from straighten drag start → tip, so the stroke can be lined up
 * with the grid (or any edge that should become horizontal / vertical).
 */
FilterParameterPanel.LnCr.prototype.redrawStraightenOverlay = function() {
  const overlay = this.straightenOverlayEl;
  const dragging = this.straightenAnchor != null && this.straightenTip != null;
  if (overlay) overlay.style.display = dragging ? "block" : "none";
  if (!dragging) return;

  const prepared = this.prepareOverlayCanvas(overlay);
  if (!prepared) return;
  const { ctx, dpr } = prepared;
  const start = this.view.panZoomState.docToScreenPoint(
    this.straightenAnchor.x, this.straightenAnchor.y
  );
  const end = this.view.panZoomState.docToScreenPoint(
    this.straightenTip.x, this.straightenTip.y
  );

  // Dark under-stroke then light stroke — reads on both grid and photo.
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineWidth = Math.max(3, dpr * 2.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = Math.max(1.25, dpr * 1.1);
  ctx.stroke();

  const handleR = Math.max(3, dpr * 2.5);
  for (const pt of [start, end]) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, handleR + dpr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, handleR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
  }
};

FilterParameterPanel.LnCr.prototype.clearStraightenGesture = function() {
  this.straightenAnchor = null;
  this.straightenTip = null;
  this.redrawStraightenOverlay();
};

FilterParameterPanel.LnCr.prototype.onPreviewPointerDown = function() {
  if (this.activeToolIndex !== TOOL_STRAIGHTEN || !this.previewRect) return;
  const docPoint = this.view.pointerToDocPoint();
  if (!docPoint) return;
  this.straightenAnchor = new Point(docPoint.x, docPoint.y);
  this.straightenTip = null;
  this.redrawStraightenOverlay();
};

FilterParameterPanel.LnCr.prototype.onPreviewPointerMove = function() {
  if (this.activeToolIndex !== TOOL_STRAIGHTEN || !this.straightenAnchor) return;
  const docPoint = this.view.pointerToDocPoint();
  if (!docPoint) return;
  this.straightenTip = new Point(docPoint.x, docPoint.y);
  this.redrawStraightenOverlay();
};

FilterParameterPanel.LnCr.prototype.onPreviewPointerUp = function() {
  if (this.activeToolIndex !== TOOL_STRAIGHTEN || !this.straightenAnchor || !this.previewRect) {
    this.clearStraightenGesture();
    return;
  }
  const docPoint = this.view.pointerToDocPoint();
  if (!docPoint) {
    this.clearStraightenGesture();
    return;
  }
  const dx = docPoint.x - this.straightenAnchor.x;
  const dy = docPoint.y - this.straightenAnchor.y;
  this.clearStraightenGesture();
  if (dx * dx + dy * dy < 16) return;
  let degrees = Math.atan2(dy, dx) * 180 / Math.PI;
  if (Math.abs(degrees) > 45 && Math.abs(degrees) < 135) {
    degrees = degrees > 0 ? degrees - 90 : degrees + 90;
  } else {
    degrees = -degrees;
  }
  degrees = ((degrees % 360) + 540) % 360 - 180;
  this.angleDial.setValue(Math.round(degrees * 100) / 100, 0, false);
  // Draft first so the straighten stroke feels immediate; full plate follows.
  this.scheduleInteractiveTransformPreview();
};

FilterParameterPanel.LnCr.prototype.applyDefaults = function() {
  this.writeDescriptorToWidgets(FilterDefs.create(LENS_CORRECTION_FILTER_ID));
};

FilterParameterPanel.LnCr.prototype.writeDescriptorToWidgets = function(descriptor) {
  this.geometricAutoCheckbox.setValue(!!descriptor.LnAg.v);
  this.chromaticAutoCheckbox.setValue(!!descriptor.LnAc.v);
  this.vignetteAutoCheckbox.setValue(!!descriptor.LnAv.v);
  this.autoScaleCheckbox.setValue(!!descriptor.LnAs.v);
  this.edgeDropdown.setValue(edgeOptionIndex(descriptor.LnFt.v));

  this.removeDistortionSlider.setValue(descriptor.LnIa.v);
  this.redCyanSlider.setValue(descriptor.LnRc.v);
  this.greenMagentaSlider.setValue(descriptor.LnGm.v);
  this.blueYellowSlider.setValue(descriptor.LnBy.v);
  this.vignetteAmountSlider.setValue(descriptor.LnSb.v);
  this.vignetteMidpointSlider.setValue(descriptor.LnSt.v);
  this.verticalPerspectiveSlider.setValue(descriptor.LnVp.v);
  this.horizontalPerspectiveSlider.setValue(descriptor.LnHp.v);
  this.angleDial.setValue(descriptor.LnRa.v, 0, false);
  this.scaleSlider.setValue(descriptor.LnSi.v);
  this.showGridCheckbox.setValue(!!descriptor.LnNm.v);
  this.gridSizeSlider.setValue(descriptor.LnNa.v);
  this.gridColorWidget.setValue(descriptor.LnIs.v);
  this.syncGridToolbarState();
  this.redrawGridOverlay();
};

/**
 * Load the profile database and pick up whatever the photograph says it was
 * taken with. The Auto controls stay off until this resolves; the database is
 * a couple of megabytes and there is no reason to block the dialog on it.
 */
FilterParameterPanel.LnCr.prototype.beginProfileLookup = function() {
  if (this.profileDatabase) {
    this.refreshProfileChoices();
    return;
  }
  loadLensProfileDatabase().then((database) => {
    if (!database) {
      this.showProfileStatus("filters.options.lensCorrection.profilesUnavailable");
      return;
    }
    this.profileDatabase = database;
    const matched = this.documentMetadata
      ? matchProfileFromMetadata(database, this.documentMetadata)
      : { camera: null, lens: null };
    this.selectedCamera = matched.camera;
    this.selectedLens = matched.lens;
    this.refreshProfileChoices();
    this.refresh();
  });
};

/** Repopulate the three Search Criteria lists around the current selection. */
FilterParameterPanel.LnCr.prototype.refreshProfileChoices = function() {
  const database = this.profileDatabase;
  if (!database) return;
  const makers = listCameraMakers(database);
  const makerNames = [Locale.get("filters.options.lensCorrection.anyMaker")].concat(makers);
  this.cameraMakerDropdown.setItems(makerNames);
  const makerIndex = this.selectedCamera ? makers.indexOf(this.selectedCamera.maker) + 1 : 0;
  this.cameraMakerDropdown.setValue(Math.max(0, makerIndex));

  const cameras = makerIndex > 0 ? listCameras(database, makers[makerIndex - 1]) : [];
  this.cameraChoices = cameras;
  this.cameraModelDropdown.setItems(
    [Locale.get("filters.options.lensCorrection.anyCamera")].concat(cameras.map((c) => c.model)));
  const cameraIndex = this.selectedCamera ? cameras.indexOf(this.selectedCamera) + 1 : 0;
  this.cameraModelDropdown.setValue(Math.max(0, cameraIndex));

  // Lenses that could have taken this frame come first, the rest below a rule.
  const focalLength = this.readShotFocalLength();
  const offered = listLenses(database, this.selectedCamera);
  const covering = offered.filter((lens) => lensCoversFocalLength(lens, focalLength));
  const rest = offered.filter((lens) => !lensCoversFocalLength(lens, focalLength));
  const lenses = covering.concat(rest);
  this.lensChoices = lenses;
  this.lensModelDropdown.setItems(
    [Locale.get("filters.options.lensCorrection.noLens")].concat(
      lenses.map((lens) => lens.maker + " " + lens.model)),
    rest.length && covering.length ? [covering.length + 1] : null);
  const lensIndex = this.selectedLens ? lenses.indexOf(this.selectedLens) + 1 : 0;
  this.lensModelDropdown.setValue(Math.max(0, lensIndex));

  this.cameraMakerDropdown.buildUI();
  this.cameraModelDropdown.buildUI();
  this.lensModelDropdown.buildUI();
  this.updateProfileAvailability();
};

/** Enable the profile corrections only while a profile can actually supply them. */
FilterParameterPanel.LnCr.prototype.updateProfileAvailability = function() {
  const calibration = this.resolveProfileCalibration();
  const available = [
    calibration && calibration.distortion,
    calibration && calibration.tca,
    calibration && calibration.vignetting,
  ];
  this.profileCorrectionCheckboxes.forEach((checkbox, index) => {
    const usable = !!available[index];
    checkbox.inputEl.disabled = !usable;
    if (usable) removeClass(checkbox.el, "lens-correction-unavailable");
    else {
      addClass(checkbox.el, "lens-correction-unavailable");
      checkbox.setValue(false);
    }
  });
  if (!this.profileDatabase) return;
  if (!this.selectedLens) {
    this.showProfileStatus("filters.options.lensCorrection.noProfileMatched");
    return;
  }
  // Say which corrections this profile can actually make. Roughly half the
  // lenses in the database carry no vignetting measurements, and a switch that
  // is simply greyed out with no reason reads as a fault.
  const missingLabels = [
    "filters.options.lensCorrection.geometricDistortion",
    "filters.options.lensCorrection.chromaticAberration",
    "filters.options.lensCorrection.vignette",
  ].filter((labelKey, index) => !available[index]).map((labelKey) => Locale.get(labelKey));
  let status = Locale.get("filters.options.lensCorrection.profileMatched") +
    " " + this.selectedLens.maker + " " + this.selectedLens.model;
  if (missingLabels.length) {
    status += " — " + Locale.get("filters.options.lensCorrection.notMeasured") +
      " " + missingLabels.join(", ");
  }
  this.autoHelpEl.textContent = status;
};

/** Focal length the frame was shot at, when its metadata records one. */
FilterParameterPanel.LnCr.prototype.readShotFocalLength = function() {
  if (!this.documentMetadata || !this.profileDatabase) return 0;
  return matchProfileFromMetadata(this.profileDatabase, this.documentMetadata).focalLength || 0;
};

FilterParameterPanel.LnCr.prototype.showProfileStatus = function(messageKey) {
  this.autoHelpEl.textContent = Locale.get(messageKey);
};

/** Coefficients for the selected lens at this photograph's focal length and aperture. */
FilterParameterPanel.LnCr.prototype.resolveProfileCalibration = function() {
  const lens = this.selectedLens;
  if (!lens) return null;
  const settings = this.documentMetadata && this.profileDatabase
    ? matchProfileFromMetadata(this.profileDatabase, this.documentMetadata)
    : { focalLength: 0, aperture: 0 };
  const focalLength = settings.focalLength || 0;
  const aperture = settings.aperture || 0;
  return {
    lensModel: lens.model,
    distortion: interpolateDistortion(lens, focalLength),
    tca: interpolateTca(lens, focalLength),
    vignetting: interpolateVignetting(lens, focalLength, aperture),
    // The frame the measurements were taken on, so a body with a different
    // sensor can have the coefficients placed where they actually belong.
    calibrationCropFactor: lens.cropFactor || 1,
    calibrationAspectRatio: lens.aspectRatio || 1.5,
    imageCropFactor: this.selectedCamera ? this.selectedCamera.cropFactor : (lens.cropFactor || 1),
  };
};

FilterParameterPanel.LnCr.prototype.onCameraMakerChanged = function() {
  const makers = listCameraMakers(this.profileDatabase);
  const index = this.cameraMakerDropdown.getValue() - 1;
  this.selectedCamera = index >= 0 ? listCameras(this.profileDatabase, makers[index])[0] : null;
  this.selectedLens = null;
  this.refreshProfileChoices();
  this.refresh();
};

FilterParameterPanel.LnCr.prototype.onCameraModelChanged = function() {
  const index = this.cameraModelDropdown.getValue() - 1;
  this.selectedCamera = index >= 0 ? this.cameraChoices[index] : null;
  this.selectedLens = null;
  this.refreshProfileChoices();
  this.refresh();
};

FilterParameterPanel.LnCr.prototype.onLensModelChanged = function() {
  const index = this.lensModelDropdown.getValue() - 1;
  this.selectedLens = index >= 0 ? this.lensChoices[index] : null;
  this.updateProfileAvailability();
  this.refresh();
};

FilterParameterPanel.LnCr.prototype.setValue = function(
  descriptor,
  sourceBuffer,
  sourceRect,
  previewRect,
  rasterUnderLayer,
  dialogContext
) {
  const document = dialogContext && dialogContext[2];
  if (document) this.documentMetadata = document.xmpMetadata || null;
  if (sourceBuffer != null) {
    sourceRect = sourceRect.clone();
    sourceRect.x = sourceRect.y = 0;
    this.sourceBuffer = sourceBuffer;
    this.previewBuffer = sourceBuffer.slice(0);
    this.previewRect = sourceRect;
  }
  this.writeDescriptorToWidgets(descriptor || FilterDefs.create(LENS_CORRECTION_FILTER_ID));
  this.beginProfileLookup();
  this._needsPreviewFit = true;
  this.redraw();
};

FilterParameterPanel.LnCr.prototype.getValue = function() {
  const descriptor = FilterDefs.create(LENS_CORRECTION_FILTER_ID);
  descriptor.LnAg.v = this.geometricAutoCheckbox.getValue();
  descriptor.LnAc.v = this.chromaticAutoCheckbox.getValue();
  descriptor.LnAv.v = this.vignetteAutoCheckbox.getValue();
  descriptor.LnAs.v = this.autoScaleCheckbox.getValue();
  descriptor.LnFt.v = LENS_EDGE_OPTIONS[this.edgeDropdown.getValue()][1];
  // The coefficients travel with the filter, not just the lens name, so a
  // committed correction keeps rendering the same way if the database moves on.
  const calibration = this.resolveProfileCalibration();
  if (calibration) {
    descriptor.LnPr.v = calibration.lensModel;
    descriptor.lensProfileCalibration = calibration;
  } else {
    descriptor.LnPr.v = "";
  }

  descriptor.LnIa.v = this.removeDistortionSlider.getValue();
  descriptor.LnRc.v = this.redCyanSlider.getValue();
  descriptor.LnGm.v = this.greenMagentaSlider.getValue();
  descriptor.LnBy.v = this.blueYellowSlider.getValue();
  descriptor.LnSb.v = this.vignetteAmountSlider.getValue();
  descriptor.LnSt.v = this.vignetteMidpointSlider.getValue() | 0;
  descriptor.LnVp.v = this.verticalPerspectiveSlider.getValue();
  descriptor.LnHp.v = this.horizontalPerspectiveSlider.getValue();
  descriptor.LnRa.v = this.angleDial.getValue().oc;
  descriptor.LnSi.v = this.scaleSlider.getValue();
  descriptor.LnNm.v = this.showGridCheckbox.getValue();
  descriptor.LnNa.v = this.gridSizeSlider.getValue() | 0;
  const rgb = readRgbFromColorWidgetValue(this.gridColorWidget.getValue());
  descriptor.LnIs.v.Rd.v = rgb.r;
  descriptor.LnIs.v.Grn.v = rgb.g;
  descriptor.LnIs.v.Bl.v = rgb.b;
  return descriptor;
};

FilterParameterPanel.LnCr.prototype.refresh = function(widgetEvent) {
  this._previewQuality = "full";
  this.redraw();
};

FilterParameterPanel.LnCr.prototype.redraw = function() {
  if (this.sourceBuffer == null) return;
  if (this._redrawScheduled) return;
  this._redrawScheduled = true;
  const panel = this;
  requestAnimationFrame(function() {
    panel._redrawScheduled = false;
    panel.renderPreview();
  });
};

FilterParameterPanel.LnCr.prototype.renderPreview = function() {
  if (this.sourceBuffer == null || this.previewRect == null) return;
  if (this._previewQuality === "draft") this.renderDraftPreview();
  else this.renderFullPreview();
};

FilterParameterPanel.LnCr.prototype.renderFullPreview = function() {
  const sourcePixels = { buffer: this.sourceBuffer, rect: this.previewRect };
  const destPixels = { buffer: this.previewBuffer, rect: this.previewRect };
  FilterDefs.applyFilterToPixels(
    LENS_CORRECTION_FILTER_ID,
    sourcePixels,
    this.getValue(),
    null,
    null,
    destPixels,
    [[]]
  );
  this.publishPreviewBuffer();
};

/**
 * Downscale + coarse warp for interactive transforms. Keeps the dialog responsive
 * while the angle dial / straighten tool / keystone sliders are moving.
 */
FilterParameterPanel.LnCr.prototype.renderDraftPreview = function() {
  const fullW = this.previewRect.width;
  const fullH = this.previewRect.height;
  const scale = Math.min(1, DRAFT_PREVIEW_MAX_EDGE / Math.max(fullW, fullH));
  const descriptor = this.getValue();
  descriptor.__warpGridDivisor = DRAFT_WARP_GRID_DIVISOR;

  if (scale >= 0.98) {
    const sourcePixels = { buffer: this.sourceBuffer, rect: this.previewRect };
    const destPixels = { buffer: this.previewBuffer, rect: this.previewRect };
    FilterDefs.applyFilterToPixels(
      LENS_CORRECTION_FILTER_ID, sourcePixels, descriptor, null, null, destPixels, [[]]
    );
    this.publishPreviewBuffer();
    return;
  }

  const scaled = resampleDown(this.sourceBuffer, this.previewRect, scale);
  const draftW = scaled.rect.width;
  const draftH = scaled.rect.height;
  const draftBytes = draftW * draftH * 4;
  if (!this._draftWorkBuffer || this._draftWorkBuffer.length !== draftBytes) {
    this._draftWorkBuffer = new Uint8Array(draftBytes);
  }
  FilterDefs.applyFilterToPixels(
    LENS_CORRECTION_FILTER_ID,
    { buffer: scaled.buffer, rect: scaled.rect },
    descriptor,
    null,
    null,
    { buffer: this._draftWorkBuffer, rect: new Rect(0, 0, draftW, draftH) },
    [[]]
  );
  upscaleNearestRgba(this._draftWorkBuffer, draftW, draftH, this.previewBuffer, fullW, fullH);
  this.publishPreviewBuffer();
};

FilterParameterPanel.LnCr.prototype.publishPreviewBuffer = function() {
  this.view.setValue([{
    rect: this.previewRect,
    data: this.previewBuffer.buffer,
  }]);
  if (this._needsPreviewFit) {
    this.view.fitToBounds();
    this._needsPreviewFit = false;
  }
  this.redrawGridOverlay();
  this.redrawStraightenOverlay();
};

FilterParameterPanel.LnCr.prototype.resize = function(width, height) {
  this.dialogWidth = width;
  this.dialogHeight = height;
  const previewWidth = Math.max(240, width - LENS_CORRECTION_CONTROLS_WIDTH_PX - 48);
  const previewHeight = Math.max(120, height);
  this.view.resize(previewWidth, previewHeight);
  this._needsPreviewFit = true;
  if (this.view.frameSources) {
    this.view.fitToBounds();
    this._needsPreviewFit = false;
  }
  this.redrawGridOverlay();
  this.redrawStraightenOverlay();
};

FilterParameterPanel.LnCr.prototype.buildUI = function() {
  this.autoScaleCheckbox.buildUI();
  this.edgeDropdown.buildUI();
  this.cameraMakerDropdown.buildUI();
  this.cameraModelDropdown.buildUI();
  this.lensModelDropdown.buildUI();
  this.geometricAutoCheckbox.buildUI();
  this.chromaticAutoCheckbox.buildUI();
  this.vignetteAutoCheckbox.buildUI();
  this.removeDistortionSlider.buildUI();
  this.redCyanSlider.buildUI();
  this.greenMagentaSlider.buildUI();
  this.blueYellowSlider.buildUI();
  this.vignetteAmountSlider.buildUI();
  this.vignetteMidpointSlider.buildUI();
  this.verticalPerspectiveSlider.buildUI();
  this.horizontalPerspectiveSlider.buildUI();
  this.angleDial.buildUI();
  this.scaleSlider.buildUI();
  this.showGridCheckbox.buildUI();
  this.gridSizeSlider.buildUI();
  this.gridColorWidget.buildUI();
};

export {
  computePreferredLensCorrectionDialogSize,
  LENS_CORRECTION_CONTROLS_WIDTH_PX,
};
