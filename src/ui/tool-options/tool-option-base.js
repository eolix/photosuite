/**
 * Base classes for the tool-options bar (the strip shown for the active tool).
 *
 * ToolOptionBase provides the shared chrome — a tool-preset button or icon plus
 * a `body` container — and the onUpdate/buildUI lifecycle. The three subclasses
 * cover families of tools: BrushOptionBase assembles a configurable kit of
 * brush-style widgets and reports their settings back per stroke; FillOptionBase
 * drives selection/fill tools (combine mode, feather, refine edge); and
 * CropOptionBase drives crop/trim tools (sample scope, aspect constraint,
 * confirm). Concrete per-tool bars extend these and choose which widgets appear.
 */


import { BlendModes } from "../../document/model/blend-modes.js";
import { TOOL_BRUSH_PRESET_MAP, ToolId } from "../../document/model/tool-base.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { Button, Checkbox } from "../widgets/form-controls.js";
import { buildSelectMenu } from "../menu/menu-bar-select-menu.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import { BrushPickerButton, ToolPresetButton } from "../widgets/controls/brush-preset-controls.js";
import { CropConstraintWidget } from "../widgets/controls/color-controls.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { AntialiasingOption, ButtonMenu, ConfirmWidget, DocumentSelector, Dropdown, RadioOption } from "../widgets/controls/popup-controls.js";
import { InputHandler } from "./input-handler.js";
import { getIconUrl, iconImgHtml } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { psdColorToRgb, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/**
 * Common tool-options chrome and lifecycle. `initialize(routingChannel, iconId)`
 * adds a ToolPresetButton for tools that have presets or a plain tool icon
 * otherwise, then builds the widget body. `routingChannel` is the tool id that
 * dispatched actions are routed to. Subclasses fill `body` and implement
 * `syncWidgets` (rebuild widgets) and, where relevant, `applyPreset` /
 * `getCurrentPreset` / `onToolEvent`.
 */
function ToolOptionBase() {
  BaseWidget.call(this);
  this.routingChannel = 0;
  this.iconId = null;
  this.el = makeElement("div", "toolconf");
  this.presetButton = null;
  this.iconContainer = null;
  this.body = makeElement("div", "body")
}
ToolOptionBase.prototype = Object.create(BaseWidget.prototype);
ToolOptionBase.prototype.initialize = function(routingChannel, iconId) {
  this.routingChannel = routingChannel;
  this.iconId = iconId;
  if (TOOL_BRUSH_PRESET_MAP[routingChannel]) {
    const presetButton = this.presetButton = new ToolPresetButton(routingChannel);
    this.el.appendChild(presetButton.el);
    presetButton.parent = this
  } else {
    this.iconContainer = makeElement("div", "toolconf-icon");
    this.el.appendChild(this.iconContainer)
  }
  this.el.appendChild(this.body);
  this.buildUI()
};
ToolOptionBase.prototype.applyPreset = function(presetEntry, presetContext) {};
ToolOptionBase.prototype.getCurrentPreset = function(unusedArg) {};
ToolOptionBase.prototype.onUpdate = function(documentModel, popupType) {
  if (popupType == PopupTypes.ALL || popupType == PopupTypes.TOOL_PRESETS)
    if (this.presetButton) this.presetButton.setPresets(documentModel.toolPresets)
};
ToolOptionBase.prototype.onToolEvent = function(toolEvent) {};
ToolOptionBase.prototype.buildUI = function() {
  if (this.presetButton) this.presetButton.buildUI();
  else this.iconContainer.innerHTML = iconImgHtml(this.iconId, null, "toolicon");
  this.syncWidgets()
};
ToolOptionBase.prototype.syncWidgets = function() {};

/**
 * Options bar for brush-family tools (brush, clone, heal, dodge/burn, blur,
 * smudge, eraser, …). `widgetKeys` is an ordered list of short option-kit ids —
 * "brush", "bmode" (blend mode), "opacity", "flow", "strn" (strength), "wconf"
 * (magic-wand options), "sfrom" (sample source), etc. Each id maps to a
 * concrete widget built below; the same ids are the keys under `this.widgets`
 * and the field names emitToolSettings sends back to the tool.
 * @param {string[]} widgetKeys
 */
function BrushOptionBase(widgetKeys) {
  ToolOptionBase.call(this);
  if (widgetKeys == null) return;
  this.doc = null;
  this.widgets = {};
  for (let widgetIdx = 0; widgetIdx < widgetKeys.length; widgetIdx++) {
    const widgetKey = widgetKeys[widgetIdx];
    let widget = null;
    if (widgetKey == "brush") {
      widget = new BrushPickerButton()
    }
    if (widgetKey == "bmode") {
      widget = new Dropdown("properties.blendMode", BlendModes.uiLabels, false, BlendModes.groupSizes)
    }
    if (widgetKey == "bmode0") {
      widget = new Dropdown("properties.blendMode", BlendModes.uiLabels.slice(23), false)
    }
    if (widgetKey == "emode") {
      widget = new Dropdown("properties.mode", [
        "panels.brush",
        "tools.pencilTool"
      ])
    }
    if (widgetKey == "opacity") {
      widget = new SliderDropdown("properties.opacity", 0, 100, "%");
      widget.setValue(100)
    }
    if (widgetKey == "flow") {
      widget = new SliderDropdown("properties.flow", 0, 100, "%");
      widget.setValue(100)
    }
    if (widgetKey == "smth") {
      widget = new SliderDropdown("styleOptions.bevelTechnique.smooth", 0, 100, "%");
      widget.setValue(0)
    }
    if (widgetKey == "samp") {
      widget = new Dropdown("Sampling", ["Brush Center", "Start of Stroke", "Background Color"])
    }
    if (widgetKey == "wconf") {
      widget = new AntialiasingOption();
      widget.setValue([40, true, true])
    }
    if (widgetKey == "strn") {
      widget = new SliderDropdown("properties.strength", 1, 100, "%");
      widget.setValue(50)
    }
    if (widgetKey == "smode") {
      widget = new Dropdown("properties.mode", [
        "styleOptions.desaturate",
        "styleOptions.saturate"
      ]);
      widget.setValue(1)
    }
    if (widgetKey == "pdetail") {
      widget = new Checkbox("properties.protectDetail");
      widget.markActive()
    }
    if (widgetKey == "rng") {
      widget = new Dropdown("properties.range", [
        "styleOptions.toneRange.shadows",
        "styleOptions.toneRange.midtones",
        "styleOptions.toneRange.highlights"
      ]);
      widget.setValue(1)
    }
    if (widgetKey == "expo") {
      widget = new SliderDropdown("properties.exposure", 0, 100, "%");
      widget.setValue(50)
    }
    if (widgetKey == "algnd") {
      widget = new Checkbox("properties.aligned");
      widget.setValue(false)
    }
    if (widgetKey == "sfrom") {
      widget = new Dropdown("properties.source", [
        "sampleScope.currentLayer",
        "sampleScope.currentBelow",
        "sampleScope.allLayers"
      ])
    }
    if (widgetKey == "alt") {
      widget = new RadioOption(null, ["Alt"], true, ["Select Source"])
    }
    if (widgetKey == "qsmode") {
      widget = new ButtonMenu("properties.mode", ["<img src=\"" + getIconUrl("set/front") + "\" class=\"autoscale gsicon\" />", "<img src=\"" + getIconUrl("zoomIn") + "\" class=\"autoscale gsicon\" />", "<img src=\"" + getIconUrl("zoomOut") + "\" class=\"autoscale gsicon\" />"], [
        "clipboard.new",
        "pathOps.unite",
        "pathOps.subtract"
      ])
    }
    if (widgetKey == "redge") {
      widget = new Button("select.refineEdge", false, null, true)
    }
    if (widgetKey == "setop") {
      widget = new DocumentSelector()
    }
    if (widgetKey == "patch") {
      widget = new ButtonMenu(null, [
        "properties.source",
        "properties.target"
      ])
    }
    if (widgetKey == "prsr") {
      widget = new RadioOption(null, ["<img src=\"" + getIconUrl("prsO") + "\" class=\"autoscale gsicon\" />", "<img src=\"" + getIconUrl("prsS") + "\" class=\"autoscale gsicon\" />"], true, [
        "brushAndMessages.stylusPressureControlsOpacity",
        "brushAndMessages.stylusPressureControlsSize"
      ]);
      widget.setValue([false, true])
    }
    widget.parent = this;
    this.body.appendChild(widget.el);
    this.widgets[widgetKey] = widget;
    if (widgetKey == "brush") widget.on(EventType.widgetSelect, this.onBrushSelected, this);
    else if (widgetKey == "redge") widget.on("click", this.openRefineEdge, this);
    else widget.on(EventType.widgetSelect, this.emitToolSettings, this)
  }
}
BrushOptionBase.prototype = Object.create(ToolOptionBase.prototype);
BrushOptionBase.prototype.applyPreset = function(presetEntry, presetContext) {
  presetEntry = presetEntry[1];
  const widgets = this.widgets;
  if (presetEntry.Md) widgets.bmode.setValue(BlendModes.psdNames.indexOf(presetEntry.Md.v.blendMode));
  if (presetEntry.Opct) widgets.Opct.setValue(presetEntry.Opct.v);
  if (presetEntry.flow) widgets.flow.setValue(presetEntry.flow.v);
  if (presetEntry.Brsh) widgets.brush.setValue(presetEntry, presetContext.brushPresets.samples, presetContext.brushPresets.patterns);
  if (presetEntry.FrgC) {
    const rgb = psdColorToRgb(presetEntry.FrgC.v),
      colorChangeEvent = new AppEvent(EventType.uiDispatch, true);
    colorChangeEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.COLOR_CHANGE,
      operation: 0,
      value: rgb.h << 16 | rgb.l << 8 | rgb.O
    };
    this.dispatch(colorChangeEvent)
  }
  this.onBrushSelected();
  this.emitToolSettings()
};
BrushOptionBase.prototype.getCurrentPreset = function() {
  if (TOOL_BRUSH_PRESET_MAP[this.routingChannel] == null) return null;
  const widgets = this.widgets,
    brushPresetDesc = JSON.parse(JSON.stringify(widgets.brush.getValue()));
  brushPresetDesc.classID = TOOL_BRUSH_PRESET_MAP[this.routingChannel].actionClassIds[0];
  if (widgets.bmode) brushPresetDesc.Md = {
    t: "enum",
    v: {
      blendMode: BlendModes.psdNames[widgets.bmode.getValue()]
    }
  };
  if (widgets.Opct) brushPresetDesc.Opct = {
    t: "long",
    v: widgets.Opct.getValue()
  };
  if (widgets.flow) brushPresetDesc.flow = {
    t: "long",
    v: widgets.flow.getValue()
  };
  let colorInt = this.doc.colorInt;
  colorInt = {
    h: colorInt >>> 16,
    l: colorInt >>> 8 & 255,
    O: colorInt & 255
  };
  brushPresetDesc.FrgC = {
    t: "Objc",
    v: toRGBDesc(colorInt)
  };
  return ["Brush Preset " + brushPresetDesc.Brsh.v.diameter.v.val, brushPresetDesc];
};
BrushOptionBase.prototype.openRefineEdge = function() {
  const dialogEvent = new AppEvent(EventType.uiDispatch, true);
  dialogEvent.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "redge"
  };
  this.dispatch(dialogEvent)
};
BrushOptionBase.prototype.syncWidgets = function() {
  for (let widgetKey in this.widgets) this.widgets[widgetKey].buildUI()
};
BrushOptionBase.prototype.onToolEvent = function(toolEvent) {
  if (toolEvent.brushOptionsSubAction == "showBrushOpts") {
    this.widgets.brush.showPopupAt(toolEvent.popupAnchorPoint.x, toolEvent.popupAnchorPoint.y)
  }
  for (let widgetKey in toolEvent.optionUpdates) {
    let widgetValue = toolEvent.optionUpdates[widgetKey];
    if (widgetKey != "qsmode") widgetValue *= 100;
    if (this.widgets[widgetKey]) this.widgets[widgetKey].setValue(widgetValue)
  }
};
BrushOptionBase.prototype.onUpdate = function(documentModel, popupType) {
  ToolOptionBase.prototype.onUpdate.call(this, documentModel, popupType);
  this.doc = documentModel;
  const brushPicker = this.widgets.brush;
  if (brushPicker == null) return;
  if (popupType == PopupTypes.ALL || popupType == PopupTypes.BRUSHES) {
    brushPicker.setPresets(documentModel.brushPresets);
    let activeBrush = documentModel.brushPresets.activeBrushPreset;
    if (activeBrush == null)
      for (let presetIdx = 0; presetIdx < documentModel.brushPresets.list.length; presetIdx++) {
        activeBrush = BrushPresetUtil.getBrushPresetFromListEntry(documentModel.brushPresets.list[presetIdx]);
        if (activeBrush != null) break
      }
    if (activeBrush) brushPicker.setValue(activeBrush, documentModel.brushPresets.samples, documentModel.brushPresets.patterns)
  }
  if (popupType == PopupTypes.SCRIPTS) {
    brushPicker.setValue(documentModel.brushPresets.activeBrushPreset, documentModel.brushPresets.samples, documentModel.brushPresets.patterns)
  }
};
BrushOptionBase.prototype.onBrushSelected = function() {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.SCRIPTS,
    brushPreset: this.widgets.brush.getValue()
  };
  this.dispatch(uiEvent)
};
BrushOptionBase.prototype.emitToolSettings = function() {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel
  };
  for (let widgetKey in this.widgets) {
    if (widgetKey == "brush" || widgetKey == "redge") continue;
    const widgetValue = this.widgets[widgetKey].getValue();
    if (["opacity", "flow", "smth", "strn", "expo"].indexOf(widgetKey) != -1) uiEvent.data[widgetKey] = widgetValue / 100;
    else if (widgetKey == "bmode") uiEvent.data.bmode = BlendModes.psdCodes[widgetValue];
    else if (widgetKey == "bmode0") uiEvent.data.bmode = BlendModes.psdCodes[23 + widgetValue];
    else uiEvent.data[widgetKey] = widgetValue
  }
  this.dispatch(uiEvent)
};

/**
 * Options bar for selection / fill tools: a combine-mode selector (replace /
 * add / subtract / intersect), a feather slider, and a refine-edge button.
 * `onToolEvent` also opens the selection context menu when the tool requests it.
 */
function FillOptionBase() {
  ToolOptionBase.call(this);
  this.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    combineMode: "front",
    feather: 0,
    magicWandOptions: [16, true, true],
    aspectController: {
      constraintMode: 0,
      constraintWidth: 1,
      constraintHeight: 1
    }
  };
  this.combineDropdown = new DocumentSelector();
  this.body.appendChild(this.combineDropdown.el);
  this.combineDropdown.on(EventType.widgetSelect, this.onInput, this);
  this.featherSlider = new SliderDropdown("select.feather", 0, 100, " px");
  this.featherSlider.parent = this;
  this.featherSlider.setValue(0);
  this.body.appendChild(this.featherSlider.el);
  this.featherSlider.on(EventType.widgetSelect, this.onInput, this);
  this.refineEdgeBtn = new Button("select.refineEdge", false, null, true);
  this.body.appendChild(this.refineEdgeBtn.el);
  this.refineEdgeBtn.on("click", this.openRefineEdge, this)
}
FillOptionBase.prototype = Object.create(ToolOptionBase.prototype);
FillOptionBase.prototype.onToolEvent = function(toolEvent) {
  if (toolEvent.combineMode != null) this.combineDropdown.setValue(toolEvent.combineMode);
  else if (toolEvent.toolOptions) {
    const toolSettings = this.data;
    toolSettings.combineMode = toolEvent.toolOptions.combineMode;
    this.combineDropdown.setValue(toolSettings.combineMode);
    toolSettings.feather = toolEvent.toolOptions.feather;
    this.featherSlider.setValue(toolSettings.feather);
    toolSettings.magicWandOptions = toolEvent.toolOptions.magicWandOptions;
    if (this.displayOptions) this.displayOptions.setValue(toolSettings.magicWandOptions)
  } else {
    let contextMenu = FillOptionBase.cachedContextMenu;
    if (contextMenu == null) {
      const menuBarData = buildSelectMenu(true);
      contextMenu = FillOptionBase.cachedContextMenu = new InputHandler(menuBarData.items, menuBarData.menuActions)
    }
    contextMenu.buildUI();
    contextMenu.parent = this;
    contextMenu.update(toolEvent.doc, toolEvent.appData);
    const overlayEvent = new AppEvent(EventType.uiDispatch, true);
    overlayEvent.data = {
      dispatchKind: UiCommand.showFloatingOverlay,
      overlayWidget: contextMenu,
      x: toolEvent.pointerState.screenX + 2,
      y: toolEvent.pointerState.screenY + 1
    };
    this.dispatch(overlayEvent)
  }
};
FillOptionBase.prototype.syncWidgets = function() {
  this.featherSlider.buildUI();
  this.combineDropdown.buildUI();
  this.refineEdgeBtn.buildUI()
};
FillOptionBase.prototype.openRefineEdge = function() {
  const dialogEvent = new AppEvent(EventType.uiDispatch, true);
  dialogEvent.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "redge"
  };
  this.dispatch(dialogEvent)
};
FillOptionBase.prototype.onInput = function() {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  this.data.routingChannel = this.routingChannel;
  this.data.combineMode = this.combineDropdown.getValue();
  this.data.feather = this.featherSlider.getValue();
  uiEvent.data = this.data;
  this.dispatch(uiEvent)
};

/**
 * Options bar for crop / trim tools: a row of sample-scope buttons (all layers /
 * current layer / trim / selection), an aspect-ratio constraint widget, a
 * delete-cropped-pixels toggle, and a confirm/cancel control that appears once a
 * crop is pending. `compactSampleBar` shows only the single current-layer button.
 * @param {boolean} compactSampleBar
 */
function CropOptionBase(compactSampleBar) {
  ToolOptionBase.call(this);
  if (compactSampleBar == null) return;
  const sampleButtonRow = makeElement("span", "fitem");
  this.body.appendChild(sampleButtonRow);
  const sampleScopeLabels = [
    "sampleScope.allLayers",
    "sampleScope.currentLayer",
    "dialogs.trim",
    "sampleScope.selection"
  ];
  this.sampleButtons = [];
  for (let buttonIdx = 0; buttonIdx < sampleScopeLabels.length; buttonIdx++) {
    const sampleButton = new Button(sampleScopeLabels[buttonIdx], false, null, true);
    this.sampleButtons.push(sampleButton);
    sampleButton.on("click", this.onCropModeClick, this);
    if (!compactSampleBar || buttonIdx == 1) sampleButtonRow.appendChild(sampleButton.el)
  }
  this.constraintWidget = new CropConstraintWidget();
  this.constraintWidget.on(EventType.widgetSelect, this.onConfigChange, this);
  if (!compactSampleBar) this.body.appendChild(this.constraintWidget.el);
  this.deleteCroppedCheckbox = new Checkbox("Delete Cropped Pixels");
  this.deleteCroppedCheckbox.on(EventType.widgetSelect, this.onConfigChange, this);
  if (!compactSampleBar) this.body.appendChild(this.deleteCroppedCheckbox.el);
  this.confirmWidget = new ConfirmWidget();
  this.confirmWidget.on("click", this.onConfirm, this)
}
CropOptionBase.prototype = Object.create(ToolOptionBase.prototype);
CropOptionBase.prototype.syncWidgets = function() {
  this.confirmWidget.buildUI();
  for (let buttonIdx = 0; buttonIdx < this.sampleButtons.length; buttonIdx++) this.sampleButtons[buttonIdx].buildUI();
  this.constraintWidget.buildUI();
  this.deleteCroppedCheckbox.buildUI()
};
CropOptionBase.prototype.onToolEvent = function(toolEvent) {
  const confirmEl = this.confirmWidget.el;
  if (toolEvent.showCropConfirm) this.body.appendChild(confirmEl);
  else if (this.body.contains(confirmEl)) this.body.removeChild(confirmEl);
  if (toolEvent.aspectController) this.constraintWidget.setValue(toolEvent.aspectController)
};
CropOptionBase.prototype.onConfirm = function(clickEvent) {
  const actionPayload = {
      dispatchKind: UiCommand.applyDocumentToolAction,
      routingChannel: this.routingChannel,
      subAction: this.confirmWidget.getValue() ? "commit" : "cancel"
    },
    uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = actionPayload;
  this.dispatch(uiEvent)
};
CropOptionBase.prototype.onCropModeClick = function(clickEvent) {
  clickEvent.target.el.blur();
  const actionPayload = {
      dispatchKind: UiCommand.applyDocumentToolAction,
      routingChannel: this.routingChannel,
      subAction: "cropby",
      cropSourceMode: this.sampleButtons.indexOf(clickEvent.target)
    },
    uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = actionPayload;
  this.dispatch(uiEvent)
};
CropOptionBase.prototype.onConfigChange = function(changeEvent) {
  const actionPayload = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel,
    subAction: "config",
    cropOptions: {
      aspectConstraint: this.constraintWidget.getValue()
    }
  };
  if (changeEvent.target == this.deleteCroppedCheckbox) actionPayload.cropOptions.deleteCroppedPixels = this.deleteCroppedCheckbox.getValue();
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = actionPayload;
  this.dispatch(uiEvent)
};



export {
  ToolOptionBase,
  BrushOptionBase,
  FillOptionBase,
  CropOptionBase
};
