/**
 * FilterParameterPanel subclasses for built-in (non-adjustment) filters:
 * blur, distort, stylize, noise, sharpen, and related FilterDefs ids.
 *
 * Each subclass is attached as `FilterParameterPanel.<filterId>` (see
 * filter-parameter-panel.js for the base class and the id → constructor lookup).
 * A subclass follows the same shape:
 *   - the constructor fills `this.paramWidgets` with the dialog controls and
 *     calls `mountFormLayout()` to lay them out;
 *   - `setFields(descriptor, values)` reads the filter's descriptor tree into a
 *     flat `values` array whose order matches `paramWidgets` (the base class
 *     then pushes each entry into its widget);
 *   - `getFields(descriptor, values)` does the reverse, writing edited widget
 *     values back onto a fresh descriptor.
 *
 * Constructor keys match FilterDefs create ids, including FourCC names that
 * keep a trailing space (`Dfs `, `Wnd `, `Mdn `, …). Descriptor wire keys
 * (`Amnt`, `Rds`, `UndA`, …) are PSD TypeIDs and are read/written verbatim.
 */
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Locale } from "../../core/i18n/locale.js";
import { BlendModes } from "../../document/model/blend-modes.js";
import { LENS_FLARE_PRESET_WIRE_KEYS } from "../../engine/compositing/effect-filters.js";
import { DIFFUSE_MODES } from "../../features/filters/filter-apply.js";
import { CurveEditor, DrawingCanvas } from "../widgets/controls/canvas-widgets.js";
import { RangeInput, TextRangeInput } from "../widgets/controls/number-inputs.js";
import { ButtonMenu, Dropdown, RadioGroup } from "../widgets/controls/popup-controls.js";
import { Button, Checkbox, Label, TextInput } from "../widgets/form-controls.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { pickAndReadFile } from "../../core/tauri-host.js";
import { showToast } from "../../core/user-prompts.js";
import { FilterParameterPanel } from "./filter-parameter-panel.js";
import { AppEvent, EventType } from "../../core/event-bus.js";
import { addClass, appendBreak, makeElement } from "../../core/dom.js";
import { transformCurvePoints } from "../../engine/compositing/tone-curves.js";

const DEFAULT_RANDOM_SEED = 248325464;
const RANDOM_SEED_MAX = 268435455;

function clampRandomSeed(parsedSeed) {
  if (isNaN(parsedSeed)) parsedSeed = DEFAULT_RANDOM_SEED;
  return Math.max(0, Math.min(RANDOM_SEED_MAX, parsedSeed));
}

function percentClamped(axisPos, axisMax) {
  return Math.round(Math.max(0, Math.min(100, 100 * axisPos / axisMax)));
}

// Maps the Shear filter's stored curve points into the CurveEditor's 0..255
// coordinate space (and, inverted, back again in getFields).
function createShearUiMatrix() {
  return new Matrix2D(0, 255 / 127, 255 / 127, 0, -2, 128);
}

/** Dropdown index for Bokeh depth-map source (`BkDi` / `BkDc`). */
function resolveBokehDepthMapIndex(descriptor) {
  const depthSourceWire = descriptor.BkDi.v.BtDi;
  const depthChannelDesc = descriptor.BkDc;
  if (depthSourceWire == "BeIn") return 0;
  if (depthSourceWire == "BeIt" && depthChannelDesc.v.BtDc == "BeCt") return 1;
  if (depthSourceWire == "BeIt" && depthChannelDesc.v.BtDc == "BeCm") return 2;
  return 3 + depthChannelDesc.v;
}

function applyBokehDepthMapSelection(descriptor, depthMapDropdownIndex) {
  let depthSourceWire;
  if (depthMapDropdownIndex == 0) {
    depthSourceWire = "BeIn";
    delete descriptor.BkDc;
  } else if (depthMapDropdownIndex < 3) {
    depthSourceWire = "BeIt";
    descriptor.BkDc = {
      t: "enum",
      v: {
        BtDc: ["BeCt", "BeCm"][depthMapDropdownIndex - 1],
      },
    };
  } else {
    depthSourceWire = "BeIa";
    descriptor.BkDc = {
      t: "long",
      v: depthMapDropdownIndex - 3,
    };
  }
  descriptor.BkDi.v.BtDi = depthSourceWire;
}

// --- Bokeh ------------------------------------------------------------------

FilterParameterPanel.Bokh = function() {
  FilterParameterPanel.call(this, "Bokh");
  this.paramWidgets = [
    new Dropdown("filters.options.depthMap", ["A", "b"]),
    new TextRangeInput("filters.options.focalDistance", 0, 255),
    new Dropdown("properties.drawMode.shape", "filters.options.irisShape.triangle,filters.options.irisShape.square,filters.options.irisShape.pentagon,filters.options.irisShape.hexagon,filters.options.irisShape.heptagon,filters.options.irisShape.octagon".split(",")),
    new TextRangeInput("properties.radius", 0, 100),
    new TextRangeInput("properties.angle", 0, 360),
    new TextRangeInput("properties.brightness", 0, 100),
    new TextRangeInput("adjustments.threshold", 0, 255),
    new TextRangeInput("filters.menu.noise.title", 0, 100),
    new ButtonMenu("properties.distribution", [
      "properties.uniform",
      "properties.gaussian",
    ]),
    new Checkbox("properties.monochromatic"),
  ];
  this.mountFormLayout("adjustments.colourBalance")
};
FilterParameterPanel.Bokh.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Bokh.prototype.setFields = function(descriptor, values, extra) {
  const depthMapItemLabels = [
    "warp.styles.none",
    "layer.layerMask.fromTransparency",
    "layer.rasterMask",
  ];
  const depthMapDropdownIndex = resolveBokehDepthMapIndex(descriptor);
  const extraChannels = extra && extra[1] ? extra[1] : [];
  for (let channelIdx = 0; channelIdx < extraChannels.length; channelIdx++) {
    depthMapItemLabels.push(extraChannels[channelIdx].name);
  }
  this.paramWidgets[0].setItems(depthMapItemLabels, [3]);
  values[0] = depthMapDropdownIndex;
  values[1] = descriptor.BkDp.v;
  values[2] = parseInt(descriptor.BkIs.v.BtIs.slice(3)) - 3;
  values[3] = descriptor.BkIb.v;
  values[4] = descriptor.BkIr.v;
  values[5] = descriptor.BkSb.v;
  values[6] = descriptor.BkSt.v;
  values[7] = descriptor.BkNa.v;
  values[8] = descriptor.BkNt.v.BtNt == "BeNu" ? 0 : 1;
  values[9] = descriptor.BkNm.v;
};
FilterParameterPanel.Bokh.prototype.getFields = function(descriptor, values) {
  applyBokehDepthMapSelection(descriptor, values[0]);
  descriptor.BkDp.v = values[1];
  descriptor.BkIs.v.BtIs = "BeS" + (3 + values[2]);
  descriptor.BkIb.v = values[3];
  descriptor.BkIr.v = values[4];
  descriptor.BkSb.v = values[5];
  descriptor.BkSt.v = values[6];
  descriptor.BkNa.v = values[7];
  descriptor.BkNt.v.BtNt = ["BeNu", "BeNg"][values[8]];
  descriptor.BkNm.v = values[9];
};

// --- Oil Paint --------------------------------------------------------------

FilterParameterPanel.oilPaint = function() {
  FilterParameterPanel.call(this, "oilPaint");
  this.paramWidgets = [
    new TextRangeInput("properties.radius", .1, 10, "px", true),
    new TextRangeInput("filters.options.cleanliness", 0, 10, "px", true),
    new TextRangeInput("properties.scale", .1, 10, null, true),
    new TextRangeInput("filters.options.bristleDetail", 0, 10, null, true),
    new Checkbox("filters.options.lighting"),
    new TextRangeInput("filters.options.shine", 0, 10, null, true),
    new DrawingCanvas("properties.angle"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.oilPaint.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.oilPaint.prototype.setFields = function(descriptor, values) {
  const oilPaintWireKeys = "stylization cleanliness brushScale microBrush lightingOn specularity".split(" ");
  for (let keyIdx = 0; keyIdx < oilPaintWireKeys.length; keyIdx++) {
    values[keyIdx] = descriptor[oilPaintWireKeys[keyIdx]].v;
  }
  values[6] = descriptor.LghD.v;
};
FilterParameterPanel.oilPaint.prototype.getFields = function(descriptor, values) {
  const oilPaintWireKeys = "stylization cleanliness brushScale microBrush lightingOn specularity".split(" ");
  for (let keyIdx = 0; keyIdx < oilPaintWireKeys.length; keyIdx++) {
    descriptor[oilPaintWireKeys[keyIdx]].v = values[keyIdx];
  }
  descriptor.LghD.v = values[6].oc;
};

// --- Trace Contour ----------------------------------------------------------

FilterParameterPanel.TrcC = function() {
  FilterParameterPanel.call(this, "TrcC");
  this.paramWidgets = [
    new TextRangeInput("filters.options.level", 0, 255),
    new ButtonMenu("properties.edge", [
      "styleOptions.down",
      "styleOptions.up",
    ]),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.TrcC.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.TrcC.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Lvl.v;
  values[1] = ["Lwr", "Upr"].indexOf(descriptor.Edg.v.CntE);
};
FilterParameterPanel.TrcC.prototype.getFields = function(descriptor, values) {
  descriptor.Lvl.v = values[0];
  descriptor.Edg.v.CntE = ["Lwr", "Upr"][values[1]];
};

// --- Diffuse ----------------------------------------------------------------

/** Diffuse mode labels, parallel to {@link DIFFUSE_MODES}. */
const DIFFUSE_MODE_I18N_KEYS = [
  "brushAndMessages.blendModes.normal",
  "filters.options.darkenOnly",
  "filters.options.lightenOnly",
  "filters.options.anisotropic",
];

FilterParameterPanel["Dfs "] = function() {
  FilterParameterPanel.call(this, "Dfs ");
  // One choice of four, so the modes stack in their own box rather than
  // collapsing into a menu.
  this.paramWidgets = [new RadioGroup("properties.mode", DIFFUSE_MODE_I18N_KEYS)];
  this.mountSectionedFormLayout([{ from: 0, to: 0 }])
};
FilterParameterPanel["Dfs "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Dfs "].prototype.setFields = function(descriptor, values) {
  values[0] = DIFFUSE_MODES.indexOf(descriptor.Md.v.DfsM);
};
FilterParameterPanel["Dfs "].prototype.getFields = function(descriptor, values) {
  descriptor.Md.v.DfsM = DIFFUSE_MODES[values[0]];
};

// --- Emboss -----------------------------------------------------------------

FilterParameterPanel.Embs = function() {
  FilterParameterPanel.call(this, "Embs");
  this.paramWidgets = [
    new DrawingCanvas("properties.angle"),
    new TextRangeInput("properties.height", 1, 100, "px"),
    new TextRangeInput("properties.amount", 1, 500, "%"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.Embs.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Embs.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Angl.v;
  values[1] = descriptor.Hght.v;
  values[2] = descriptor.Amnt.v;
};
FilterParameterPanel.Embs.prototype.getFields = function(descriptor, values) {
  descriptor.Angl.v = values[0].oc;
  descriptor.Hght.v = values[1];
  descriptor.Amnt.v = values[2];
};

// --- Wind -------------------------------------------------------------------

FilterParameterPanel["Wnd "] = function() {
  FilterParameterPanel.call(this, "Wnd ");
  this.paramWidgets = [
    new RadioGroup("properties.technique", ["filters.options.wind", "filters.options.blast", "filters.options.stagger"]),
    new RadioGroup("properties.direction", ["filters.options.fromTheRight", "filters.options.fromTheLeft"]),
  ];
  this.mountSectionedFormLayout([{ from: 0, to: 0 }, { from: 1, to: 1 }])
};
FilterParameterPanel["Wnd "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Wnd "].prototype.setFields = function(descriptor, values) {
  values[0] = ["Wnd", "Blst", "Stgr"].indexOf(descriptor.WndM.v.WndM);
  values[1] = ["Left", "Rght"].indexOf(descriptor.Drct.v.Drct);
};
FilterParameterPanel["Wnd "].prototype.getFields = function(descriptor, values) {
  descriptor.WndM.v.WndM = ["Wnd", "Blst", "Stgr"][values[0]];
  descriptor.Drct.v.Drct = ["Left", "Rght"][values[1]];
};

// --- Lighting Effects (gradient) --------------------------------------------

FilterParameterPanel.lightFilterGradient = function() {
  FilterParameterPanel.call(this, "lightFilterGradient");
  this.paramWidgets = [
    new TextRangeInput("filters.menu.blur.blur", 0, 100, "px", 1, true),
    new TextRangeInput("properties.scale", 0, 200, "%"),
    new Checkbox("adjustments.invert"),
    new TextRangeInput("properties.high", 0, 100, "%"),
    new TextRangeInput("properties.medium", 0, 100, "%"),
    new TextRangeInput("properties.low", 0, 100, "%"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.lightFilterGradient.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.lightFilterGradient.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.blur.v;
  values[1] = descriptor.textureScale.v * 100;
  values[2] = descriptor.Scl.v == -1;
  const detailBandDescriptors = descriptor.Dtl.v;
  values[3] = detailBandDescriptors[0].v * 100;
  values[4] = detailBandDescriptors[1].v * 100;
  values[5] = detailBandDescriptors[2].v * 100;
};
FilterParameterPanel.lightFilterGradient.prototype.getFields = function(descriptor, values) {
  descriptor.blur.v = values[0];
  descriptor.textureScale.v = values[1] / 100;
  descriptor.Scl.v = values[2] ? -1 : 1;
  const detailBandDescriptors = descriptor.Dtl.v;
  detailBandDescriptors[0].v = values[3] / 100;
  detailBandDescriptors[1].v = values[4] / 100;
  detailBandDescriptors[2].v = values[5] / 100;
};

// --- Lens Flare -------------------------------------------------------------

const LENS_FLARE_TYPE_I18N_KEYS = [
  "filters.options.lensZoom",
  "filters.options.lensPrime35",
  "filters.options.lensPrime105",
  "filters.options.lensMoviePrime",
];

FilterParameterPanel.LnsF = function() {
  FilterParameterPanel.call(this, "LnsF");
  this.paramWidgets = [
    new TextRangeInput("properties.brightness", 10, 300, "%"),
    new RadioGroup("properties.type", LENS_FLARE_TYPE_I18N_KEYS),
    new TextRangeInput("filters.options.positionX", 0, 100, "%"),
    new TextRangeInput("filters.options.positionY", 0, 100, "%"),
  ];
  this.mountSectionedFormLayout([{ from: 1, to: 1 }])
};
FilterParameterPanel.LnsF.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.LnsF.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Brgh.v;
  values[1] = Math.max(0, LENS_FLARE_PRESET_WIRE_KEYS.indexOf(descriptor.Lns.v.Lns));
  const flareCenter = descriptor.FlrC.v;
  values[2] = Math.round(flareCenter.Hrzn.v * 100);
  values[3] = Math.round(flareCenter.Vrtc.v * 100);
};
FilterParameterPanel.LnsF.prototype.getFields = function(descriptor, values) {
  descriptor.Brgh.v = values[0];
  descriptor.Lns.v.Lns = LENS_FLARE_PRESET_WIRE_KEYS[values[1]];
  const flareCenter = descriptor.FlrC.v;
  flareCenter.Hrzn.v = values[2] / 100;
  flareCenter.Vrtc.v = values[3] / 100;
};
// Lens Flare draws an interactive overlay: dragging on the preview moves the
// flare center, which is fed back into the Position X/Y widgets as percentages.
FilterParameterPanel.LnsF.prototype.hasOverlay = function() {
  return true;
};
FilterParameterPanel.LnsF.prototype.onMouseDown = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  this.isDraggingFlarePosition = true;
  this.updateFlarePositionFromPointer(doc, pointerPos);
};
FilterParameterPanel.LnsF.prototype.onMouseMove = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  if (!this.isDraggingFlarePosition) return;
  this.updateFlarePositionFromPointer(doc, pointerPos);
};
FilterParameterPanel.LnsF.prototype.onMouseUp = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  this.isDraggingFlarePosition = false;
};
FilterParameterPanel.LnsF.prototype.updateFlarePositionFromPointer = function(doc, pointerPos) {
  const docPoint = doc.pathViewport.screenToDocPoint(pointerPos.x, pointerPos.y);
  this.paramWidgets[2].setValue(percentClamped(docPoint.x, doc.width));
  this.paramWidgets[3].setValue(percentClamped(docPoint.y, doc.height));
  this.refresh();
};

// --- Clouds / Difference Clouds ---------------------------------------------

FilterParameterPanel.Clds = function() {
  FilterParameterPanel.call(this, "Clds");
  this.paramWidgets = [
    new Label("filters.options.cloudsHelp"),
    new TextInput("filters.options.randomSeed"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.Clds.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Clds.prototype.setFields = function(descriptor, values) {
  values[0] = String(descriptor.FlRs != null && descriptor.FlRs.v != null ? descriptor.FlRs.v : 1857132644);
};
FilterParameterPanel.Clds.prototype.getFields = function(descriptor, values) {
  let parsed = parseInt(values[0], 10);
  parsed = clampRandomSeed(parsed);
  if (descriptor.FlRs == null) {
    descriptor.FlRs = {
      t: "long",
      v: parsed,
    };
  } else {
    descriptor.FlRs.v = parsed;
  }
  this.paramWidgets[1].setValue(String(parsed));
};
FilterParameterPanel.DfrC = function() {
  FilterParameterPanel.call(this, "DfrC");
  this.paramWidgets = [
    new Label("filters.options.differenceCloudsHelp"),
    new TextInput("filters.options.randomSeed"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.DfrC.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.DfrC.prototype.setFields = FilterParameterPanel.Clds.prototype.setFields;
FilterParameterPanel.DfrC.prototype.getFields = FilterParameterPanel.Clds.prototype.getFields;

// --- Blend Options ----------------------------------------------------------

FilterParameterPanel.blendOptions = function() {
  FilterParameterPanel.call(this, "blendOptions");
  this.paramWidgets.push(new Dropdown("properties.blendMode", BlendModes.uiLabels, false, BlendModes.groupSizes));
  this.paramWidgets.push(new TextRangeInput("properties.opacity", 0, 100, "%"));
  this.mountFormLayout()
};
FilterParameterPanel.blendOptions.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.blendOptions.prototype.setFields = function(descriptor, values) {
  values[0] = BlendModes.psdNames.indexOf(descriptor.Md.v.blendMode);
  values[1] = descriptor.Opct.v.val;
};
FilterParameterPanel.blendOptions.prototype.getFields = function(descriptor, values) {
  descriptor.Md.v.blendMode = BlendModes.psdNames[values[0]];
  descriptor.Opct.v.val = values[1];
};

// Lens Correction (`LnCr`) lives in lens-correction-panel.js (fullscreen workspace).

// --- Shadows / Highlights ---------------------------------------------------

FilterParameterPanel.adaptCorrect = function() {
  FilterParameterPanel.call(this, "adaptCorrect");
  this.paramWidgets = [
    new Label("styleOptions.toneRange.shadows"),
    new RangeInput("properties.amount", 0, 100, "%"),
    new RangeInput("filters.options.tone", 0, 100, "%"),
    new RangeInput("properties.radius", 0, 200, "px"),
    new Label("styleOptions.toneRange.highlights"),
    new RangeInput("properties.amount", 0, 100, "%"),
    new RangeInput("filters.options.tone", 0, 100, "%"),
    new RangeInput("properties.radius", 0, 200, "px"),
    new Label("adjustmentsMenuTitle"),
    new RangeInput("colour.title", -100, 100),
  ];
  this.mountFormLayout([3, 7])
};
FilterParameterPanel.adaptCorrect.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.adaptCorrect.prototype.setFields = function(descriptor, values) {
  const shadowToneRange = descriptor.sdwM.v;
  values[0] = shadowToneRange.Amnt.v.val;
  values[1] = shadowToneRange.Wdth.v.val;
  values[2] = shadowToneRange.Rds.v;
  const highlightToneRange = descriptor.hglM.v;
  values[3] = highlightToneRange.Amnt.v.val;
  values[4] = highlightToneRange.Wdth.v.val;
  values[5] = highlightToneRange.Rds.v;
  values[6] = descriptor.ClrC.v;
};
FilterParameterPanel.adaptCorrect.prototype.getFields = function(descriptor, values) {
  const shadowToneRange = descriptor.sdwM.v;
  shadowToneRange.Amnt.v.val = values[0];
  shadowToneRange.Wdth.v.val = values[1];
  shadowToneRange.Rds.v = values[2];
  const highlightToneRange = descriptor.hglM.v;
  highlightToneRange.Amnt.v.val = values[3];
  highlightToneRange.Wdth.v.val = values[4];
  highlightToneRange.Rds.v = values[5];
  descriptor.ClrC.v = values[6];
};

// --- Blur family ------------------------------------------------------------

FilterParameterPanel.boxblur = function() {
  FilterParameterPanel.call(this, "boxblur");
  this.paramWidgets = [new TextRangeInput("properties.radius", 1, 200, " px")];
  this.mountFormLayout()
};
FilterParameterPanel.boxblur.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.boxblur.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Rds.v.val;
};
FilterParameterPanel.boxblur.prototype.getFields = function(descriptor, values) {
  descriptor.Rds.v.val = values[0];
};
FilterParameterPanel.GsnB = function() {
  FilterParameterPanel.call(this, "GsnB");
  this.paramWidgets = [new TextRangeInput("properties.radius", .1, 400, "px", 1, true)];
  this.mountFormLayout()
};
FilterParameterPanel.GsnB.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.MtnB = function() {
  FilterParameterPanel.call(this, "MtnB");
  this.paramWidgets = [
    new DrawingCanvas("properties.angle"),
    new TextRangeInput("properties.distance", 1, 100, " px"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.MtnB.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.RdlB = function() {
  FilterParameterPanel.call(this, "RdlB");
  this.paramWidgets = [
    new TextRangeInput("properties.amount", 1, 100),
    new ButtonMenu("properties.mode", ["filters.options.spin", "filters.options.zoom"]),
    new RangeInput("filters.options.offX", 0, 1, null, 2),
    new RangeInput("filters.options.offY", 0, 1, null, 2),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.RdlB.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.RdlB.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Amnt.v;
  values[1] = ["Spn", "Zm"].indexOf(descriptor.BlrM.v.BlrM);
  values[2] = descriptor.Cntr.v.Hrzn.v;
  values[3] = descriptor.Cntr.v.Vrtc.v;
};
FilterParameterPanel.RdlB.prototype.getFields = function(descriptor, values) {
  descriptor.Amnt.v = values[0];
  descriptor.BlrM.v.BlrM = ["Spn", "Zm"][values[1]];
  descriptor.Cntr.v.Hrzn.v = values[2];
  descriptor.Cntr.v.Vrtc.v = values[3];
};

// --- Displace ---------------------------------------------------------------

/**
 * Displacement-map row: the chosen map's file name plus a button that opens the
 * native file picker. Picked bytes are embedded in the document as a linked file
 * item, and `getValue()` returns that item's tag — which is what the Displace
 * descriptor carries in `DspF`.
 */
function DisplacementMapChooser() {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem dspmap");
  this.labelEl = makeElement("label", "flabel");
  this.el.appendChild(this.labelEl);
  this.fileNameEl = makeElement("span", "labelitem dspmap-name");
  this.el.appendChild(this.fileNameEl);
  this.chooseButton = new Button("filters.options.displacementMap.choose");
  this.chooseButton.parent = this;
  this.chooseButton.on("click", this.onChooseClicked, this);
  this.el.appendChild(this.chooseButton.el);
  /** Document picked maps are embedded into; set when the dialog opens. */
  this.hostDocument = null;
  /** Linked-file items already embedded, used to name a map loaded from a saved filter. */
  this.linkedFiles = null;
  this.mapTag = null;
  this.mapFileName = "";
  this.pickInProgress = false;
  this.buildUI();
}

DisplacementMapChooser.prototype = Object.create(BaseWidget.prototype);
DisplacementMapChooser.prototype.constructor = DisplacementMapChooser;

DisplacementMapChooser.prototype.setDialogContext = function(linkedFiles, hostDocument) {
  if (linkedFiles) this.linkedFiles = linkedFiles;
  if (hostDocument) this.hostDocument = hostDocument;
};

/** @param {string|null} mapTag Linked-file tag stored in `DspF.v.pth`. */
DisplacementMapChooser.prototype.setValue = function(mapTag) {
  this.mapTag = mapTag == null || mapTag === "" ? null : mapTag;
  this.mapFileName = this.resolveFileName(this.mapTag);
  this.updateFileNameLabel();
};

/** @returns {string|null} Tag of the embedded map, or null when none is chosen. */
DisplacementMapChooser.prototype.getValue = function() {
  return this.mapTag;
};

DisplacementMapChooser.prototype.buildUI = function() {
  this.labelEl.textContent = Locale.get("filters.options.displacementMap.title") + ": ";
  this.chooseButton.buildUI();
  this.updateFileNameLabel();
};

DisplacementMapChooser.prototype.resolveFileName = function(mapTag) {
  if (mapTag == null || this.linkedFiles == null) return "";
  for (let fileIdx = 0; fileIdx < this.linkedFiles.length; fileIdx++) {
    if (this.linkedFiles[fileIdx].tag == mapTag) return this.linkedFiles[fileIdx].fileName.trim();
  }
  return "";
};

DisplacementMapChooser.prototype.updateFileNameLabel = function() {
  this.fileNameEl.textContent = this.mapFileName === ""
    ? Locale.get("filters.options.displacementMap.none")
    : this.mapFileName;
};

DisplacementMapChooser.prototype.onChooseClicked = function() {
  if (this.pickInProgress || this.hostDocument == null) return;
  this.pickInProgress = true;
  const chooser = this;
  pickAndReadFile(true).then(function(picked) {
    chooser.pickInProgress = false;
    if (picked == null) return;
    chooser.mapTag = chooser.hostDocument.registerLinkedFile(picked.bytes, picked.name);
    chooser.linkedFiles = chooser.hostDocument.add.lnk2;
    chooser.mapFileName = chooser.resolveFileName(chooser.mapTag);
    chooser.updateFileNameLabel();
    chooser.dispatch(new AppEvent(EventType.widgetSelect, false));
  }).catch(function(err) {
    chooser.pickInProgress = false;
    console.error("[PS] displacement map open failed:", err);
    showToast("Could not open the displacement map.");
  });
};

/**
 * Displace: two scale fields, the map to displace by, how that map is fitted to
 * the layer (`DspM`), and how pixels pulled in from outside the layer are filled
 * (`UndA`). The map is chosen in this dialog and embedded in the document, so
 * applying the filter needs no further prompt.
 */
FilterParameterPanel.Dspl = function() {
  FilterParameterPanel.call(this, "Dspl");
  this.paramWidgets = [
    new TextRangeInput("filters.options.horizontalScale", -999, 999),
    new TextRangeInput("filters.options.verticalScale", -999, 999),
    new DisplacementMapChooser(),
    new RadioGroup(null, [
      "filters.options.displacementMap.stretchToFit",
      "filters.options.displacementMap.tile",
    ]),
    new RadioGroup("filters.options.undefinedArea.title", [
      "filters.options.undefinedArea.wrapAround",
      "filters.options.undefinedArea.repeatEdgePixels",
    ]),
  ];
  this.mountSectionedFormLayout([{ from: 3, to: 3 }, { from: 4, to: 4 }])
};
FilterParameterPanel.Dspl.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Dspl.prototype.setFields = function(descriptor, values, extra) {
  if (extra) this.paramWidgets[2].setDialogContext(extra[0], extra[2]);
  values[0] = descriptor.HrzS.v;
  values[1] = descriptor.VrtS.v;
  values[2] = descriptor.DspF.v.pth;
  values[3] = Math.max(0, ["StrF", "Tile"].indexOf(descriptor.DspM.v.DspM));
  values[4] = Math.max(0, ["WrpA", "RptE"].indexOf(descriptor.UndA.v.UndA));
};
FilterParameterPanel.Dspl.prototype.getFields = function(descriptor, values) {
  descriptor.HrzS.v = values[0];
  descriptor.VrtS.v = values[1];
  descriptor.DspF.v.pth = values[2] == null ? "" : values[2];
  descriptor.DspM.v.DspM = ["StrF", "Tile"][values[3]];
  descriptor.UndA.v.UndA = ["WrpA", "RptE"][values[4]];
};

// --- Distort family ---------------------------------------------------------

FilterParameterPanel.Pnch = function() {
  FilterParameterPanel.call(this, "Pnch");
  this.paramWidgets = [new TextRangeInput("properties.amount", -100, 100, "%")];
  this.mountFormLayout()
};
FilterParameterPanel.Pnch.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Plr "] = function() {
  FilterParameterPanel.call(this, "Plr ");
  this.paramWidgets = [new ButtonMenu(null, ["filters.options.rectToPolar", "filters.options.polarToRect"])];
  this.mountFormLayout()
};
FilterParameterPanel["Plr "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Rple = function() {
  FilterParameterPanel.call(this, "Rple");
  this.paramWidgets = [
    new TextRangeInput("properties.amount", -999, 999),
    new Dropdown("properties.size.title", [
      "styleOptions.spreadSize.small",
      "styleOptions.spreadSize.medium",
      "styleOptions.spreadSize.large",
    ]),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.Rple.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Shr "] = function() {
  FilterParameterPanel.call(this, "Shr ");
  this.paramWidgets = [
    new CurveEditor(true, true),
    new Dropdown("filters.options.undefinedArea.title", [
      "filters.options.undefinedArea.wrapAround",
      "filters.options.undefinedArea.repeatEdgePixels",
    ]),
  ];
  this.mountFormLayout()
};
FilterParameterPanel["Shr "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Shr "].prototype.setFields = function(descriptor, values) {
  const curveToUiMatrix = createShearUiMatrix();
  const uiCurvePoints = JSON.parse(JSON.stringify(descriptor.ShrP.v));
  transformCurvePoints(uiCurvePoints, curveToUiMatrix);
  values[0] = uiCurvePoints;
  values[1] = ["WrpA", "RptE"].indexOf(descriptor.UndA.v.UndA);
};
FilterParameterPanel["Shr "].prototype.getFields = function(descriptor, values) {
  const curveToUiMatrix = createShearUiMatrix();
  curveToUiMatrix.invert();
  transformCurvePoints(values[0], curveToUiMatrix);
  descriptor.ShrP.v = values[0];
  descriptor.ShrE.v = values[0].length - 1;
  descriptor.UndA.v.UndA = ["WrpA", "RptE"][values[1]];
};
FilterParameterPanel.Sphr = function() {
  FilterParameterPanel.call(this, "Sphr");
  this.paramWidgets = [
    new TextRangeInput("properties.amount", -100, 100),
    new Dropdown("properties.mode", [
      "Normal",
      "warp.orientation.horizontal",
      "warp.orientation.vertical",
    ]),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.Sphr.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Sphr.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Amnt.v;
  values[1] = ["Nrml", "HrzO", "VrtO"].indexOf(descriptor.SphM.v.SphM);
};
FilterParameterPanel.Sphr.prototype.getFields = function(descriptor, values) {
  descriptor.Amnt.v = values[0];
  descriptor.SphM.v.SphM = ["Nrml", "HrzO", "VrtO"][values[1]];
};
FilterParameterPanel.Twrl = function() {
  FilterParameterPanel.call(this, "Twrl");
  this.paramWidgets = [new TextRangeInput("properties.angle", -999, 999)];
  this.mountFormLayout()
};
FilterParameterPanel.Twrl.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Wave = function() {
  FilterParameterPanel.call(this, "Wave");
  this.linkedRangePairIndices = [1, 2, 3, 4];
  this.paramWidgets = [
    new TextRangeInput("filters.options.numberOfGenerators", 1, 100),
    new RangeInput("filters.options.minLength", 1, 999),
    new RangeInput("filters.options.maxLength", 1, 999),
    new RangeInput("filters.options.minAmpl", 1, 999),
    new RangeInput("filters.options.maxAmpl", 1, 999),
    new RangeInput("filters.options.scaleX", 1, 100, "%"),
    new RangeInput("filters.options.scaleY", 1, 100, "%"),
    new RadioGroup("properties.type", ["filters.options.sine", "filters.options.triangle", "properties.shapeType.square"]),
    new RadioGroup("filters.options.undefinedArea.title", [
      "filters.options.undefinedArea.wrapAround",
      "filters.options.undefinedArea.repeatEdgePixels",
    ]),
    new TextInput("filters.options.randomizerSeed"),
  ];
  this.mountSectionedFormLayout([{ from: 7, to: 7 }, { from: 8, to: 8 }])
};
FilterParameterPanel.Wave.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Wave.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.NmbG.v;
  values[1] = descriptor.WLMn.v;
  values[2] = descriptor.WLMx.v;
  values[3] = descriptor.AmMn.v;
  values[4] = descriptor.AmMx.v;
  values[5] = descriptor.SclH.v;
  values[6] = descriptor.SclV.v;
  values[7] = ["WvSn", "WvTr", "WvSq"].indexOf(descriptor.Wvtp.v.Wvtp);
  values[8] = ["WrpA", "RptE"].indexOf(descriptor.UndA.v.UndA);
  values[9] = descriptor.RndS.v
};
FilterParameterPanel.Wave.prototype.getFields = function(descriptor, values) {
  descriptor.NmbG.v = values[0];
  descriptor.WLMn.v = values[1];
  descriptor.WLMx.v = values[2];
  descriptor.AmMn.v = values[3];
  descriptor.AmMx.v = values[4];
  descriptor.SclH.v = values[5];
  descriptor.SclV.v = values[6];
  descriptor.Wvtp.v.Wvtp = ["WvSn", "WvTr", "WvSq"][values[7]];
  descriptor.UndA.v.UndA = ["WrpA", "RptE"][values[8]];
  let parsedSeed = parseInt(values[9]);
  parsedSeed = clampRandomSeed(parsedSeed);
  descriptor.RndS.v = parsedSeed;
  this.paramWidgets[9].setValue(parsedSeed);
};

// --- Surface / noise / pixelate ---------------------------------------------

FilterParameterPanel.surfaceBlur = function() {
  FilterParameterPanel.call(this, "surfaceBlur");
  this.paramWidgets = [
    new TextRangeInput("properties.radius", 1, 200, " px"),
    new TextRangeInput("adjustments.threshold", 1, 255, " px"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.surfaceBlur.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.surfaceBlur.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Rds.v.val;
  values[1] = descriptor.Thsh.v;
};
FilterParameterPanel.surfaceBlur.prototype.getFields = function(descriptor, values) {
  descriptor.Rds.v.val = values[0];
  descriptor.Thsh.v = values[1];
};
FilterParameterPanel.AdNs = function() {
  FilterParameterPanel.call(this, "AdNs");
  this.paramWidgets = [
    new TextRangeInput("properties.amount", 0, 200, " %"),
    new Dropdown("properties.distribution", [
      "properties.gaussian",
      "properties.uniform",
    ]),
    new Checkbox("properties.monochromatic"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.AdNs.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.DstS = function() {
  FilterParameterPanel.call(this, "DstS");
  this.paramWidgets = [
    new TextRangeInput("properties.radius", 1, 200, " px"),
    new TextRangeInput("adjustments.threshold", 1, 255, " px"),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.DstS.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Mdn "] = function() {
  FilterParameterPanel.call(this, "Mdn ");
  this.paramWidgets = [new TextRangeInput("properties.radius", 1, 200, " px")];
  this.mountFormLayout()
};
FilterParameterPanel["Mdn "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Mdn "].prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Rds.v.val;
};
FilterParameterPanel["Mdn "].prototype.getFields = function(descriptor, values) {
  descriptor.Rds.v.val = values[0];
};
FilterParameterPanel.ClrH = function() {
  FilterParameterPanel.call(this, "ClrH");
  this.paramWidgets = [new TextRangeInput("properties.radius", 4, 100, " px")];
  for (let angleIdx = 1; angleIdx < 4; angleIdx++) {
    this.paramWidgets.push(new TextRangeInput(["VAR0 VAR1", "properties.angle", String(angleIdx)], 0, 90, " \xB0"));
  }
  this.mountFormLayout()
};
FilterParameterPanel.ClrH.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.ClrH.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Rds.v;
  for (let angleIdx = 1; angleIdx < 4; angleIdx++) values[angleIdx] = descriptor["Ang" + angleIdx].v;
};
FilterParameterPanel.ClrH.prototype.getFields = function(descriptor, values) {
  descriptor.Rds.v = values[0];
  for (let angleIdx = 1; angleIdx < 4; angleIdx++) descriptor["Ang" + angleIdx].v = values[angleIdx];
};
FilterParameterPanel.ClrH.prototype.buildUI = function() {
  const paramWidgets = this.paramWidgets;
  paramWidgets[0].buildUI();
  for (let angleIdx = 1; angleIdx < 4; angleIdx++) {
    paramWidgets[angleIdx].setLabel(Locale.get("properties.angle") + " " + angleIdx);
  }
};
FilterParameterPanel.Crst = function() {
  FilterParameterPanel.call(this, "Crst");
  this.paramWidgets = [new TextRangeInput("properties.cellSize", 3, 100, " px")];
  this.mountFormLayout()
};
FilterParameterPanel.Crst.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Crst.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.ClSz.v
};
FilterParameterPanel.Crst.prototype.getFields = function(descriptor, values) {
  descriptor.ClSz.v = values[0]
};
FilterParameterPanel.Mztn = function() {
  FilterParameterPanel.call(this, "Mztn");
  this.paramWidgets.push(new Dropdown("properties.type", "filters.options.mezzotint.fineDots,filters.options.mezzotint.mediumDots,filters.options.mezzotint.grainyDots,filters.options.mezzotint.coarseDots,filters.options.mezzotint.shortLines,filters.options.mezzotint.mediumLines,filters.options.mezzotint.longLines,filters.options.mezzotint.shortStrokes,filters.options.mezzotint.mediumStrokes,filters.options.mezzotint.longStrokes".split(","), null, [4, 3, 3]));
  this.mezzotintTypeWireIds = "FnDt MdmD GrnD CrsD ShrL MdmL LngL ShSt MdmS LngS".split(" ");
  this.mountFormLayout()
};
FilterParameterPanel.Mztn.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Mztn.prototype.setFields = function(descriptor, values) {
  values[0] = this.mezzotintTypeWireIds.indexOf(descriptor.MztT.v.MztT)
};
FilterParameterPanel.Mztn.prototype.getFields = function(descriptor, values) {
  descriptor.MztT.v.MztT = this.mezzotintTypeWireIds[values[0]]
};
FilterParameterPanel["Msc "] = function() {
  FilterParameterPanel.call(this, "Msc ");
  this.paramWidgets = [new TextRangeInput("properties.cellSize", 2, 200, " px")];
  this.mountFormLayout()
};
FilterParameterPanel["Msc "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Msc "].prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.ClSz.v.val
};
FilterParameterPanel["Msc "].prototype.getFields = function(descriptor, values) {
  descriptor.ClSz.v.val = values[0]
};
FilterParameterPanel.Pntl = function() {
  FilterParameterPanel.call(this, "Pntl");
  this.paramWidgets = [new TextRangeInput("properties.cellSize", 3, 100, " px")];
  this.mountFormLayout()
};
FilterParameterPanel.Pntl.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Pntl.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.ClSz.v
};
FilterParameterPanel.Pntl.prototype.getFields = function(descriptor, values) {
  descriptor.ClSz.v = values[0]
};

// --- Sharpen / other --------------------------------------------------------

FilterParameterPanel.smartSharpen = function() {
  FilterParameterPanel.call(this, "smartSharpen");
  this.paramWidgets = [
    new TextRangeInput("properties.amount", 1, 200, "%"),
    new TextRangeInput("properties.radius", 0, 200, "px", 1, true),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.smartSharpen.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.smartSharpen.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Amnt.v.val;
  values[1] = descriptor.Rds.v.val;
};
FilterParameterPanel.smartSharpen.prototype.getFields = function(descriptor, values) {
  descriptor.Amnt.v.val = values[0];
  descriptor.Rds.v.val = values[1];
};
FilterParameterPanel.UnsM = function() {
  FilterParameterPanel.call(this, "UnsM");
  this.paramWidgets = [
    new TextRangeInput("properties.amount", 1, 200, " %"),
    new TextRangeInput("properties.radius", .1, 400, "px", 1, true),
    new TextRangeInput("adjustments.threshold", 0, 255, " "),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.UnsM.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.HghP = function() {
  FilterParameterPanel.call(this, "HghP");
  this.paramWidgets = [new TextRangeInput("properties.radius", .1, 400, "px", 1, true)];
  this.mountFormLayout()
};
FilterParameterPanel.HghP.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Mxm "] = function() {
  FilterParameterPanel.call(this, "Mxm ");
  this.paramWidgets = [new TextRangeInput("properties.radius", 1, 200, " px")];
  this.mountFormLayout()
};
FilterParameterPanel["Mxm "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel["Mnm "] = function() {
  FilterParameterPanel.call(this, "Mnm ");
  this.paramWidgets = [new TextRangeInput("properties.radius", 1, 200, " px")];
  this.mountFormLayout()
};
FilterParameterPanel["Mnm "].prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.Ofst = function() {
  FilterParameterPanel.call(this, "Ofst");
  this.paramWidgets = [
    new TextRangeInput("warp.orientation.horizontal", -1024, 1024, " px"),
    new TextRangeInput("warp.orientation.vertical", -1024, 1024, " px"),
    new Dropdown("filters.options.undefinedArea.title", [
      "filters.options.undefinedArea.repeatEdgePixels",
      "filters.options.undefinedArea.setToTransparent",
      "filters.options.undefinedArea.wrapAround",
    ]),
  ];
  this.mountFormLayout()
};
FilterParameterPanel.Ofst.prototype = Object.create(FilterParameterPanel.prototype);
