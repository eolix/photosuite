/**
 * Brush, fill, crop, and gradient tool option panels built on shared `ToolOptionBase` chrome.
 */


import { BlendModes } from "../../document/model/blend-modes.js";
import { ToolId } from "../../document/model/tool-base.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { Button, Checkbox, TextInput } from "../widgets/form-controls.js";
import { FontComboBox } from "../widgets/controls/font-controls.js";
import { CropConstraintWidget } from "../widgets/controls/color-controls.js";
import { GradientPickerButton, Dropdown, RadioOption, ConfirmWidget, AntialiasingOption, ButtonMenu } from "../widgets/controls/popup-controls.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { FillTypePicker } from "../widgets/controls/fill-type-picker.js";
import { StrokeWidget } from "../widgets/controls/stroke-layer-controls.js";
import { getIconUrl, iconImgHtml } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { clearElement, makeElement, setWidthHeightLabels } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { PaintTool } from "../../document/tools/paint-tools.js";
import { formatDocLength } from "../../engine/compositing/geometry.js";
import {
  ToolOptionBase,
  BrushOptionBase,
  FillOptionBase,
  CropOptionBase
} from "./tool-option-base.js";

/**
 * Brush, fill, select, crop, move, and zoom tool-option panels.
 */

function StrenBrushOption() {
  BrushOptionBase.call(this, ["brush", "strn"])
}
StrenBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function PaintBrushOption() {
  BrushOptionBase.call(this, "brush bmode opacity flow smth prsr".split(" "))
}
PaintBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function HealBrushOption() {
  BrushOptionBase.call(this, ["brush", "bmode0", "samp", "wconf"])
}
HealBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function BasicBrushOption() {
  BrushOptionBase.call(this, ["brush"])
}
BasicBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function BlurBrushOption() {
  BrushOptionBase.call(this, ["brush", "bmode", "opacity", "smth", "prsr"])
}
BlurBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function DodgeBrushOption() {
  BrushOptionBase.call(this, ["brush", "rng", "expo"])
}
DodgeBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function CloneStampOption() {
  BrushOptionBase.call(this, "brush bmode opacity algnd sfrom alt".split(" "))
}
CloneStampOption.prototype = Object.create(BrushOptionBase.prototype);


function CropToolOption() {
  CropOptionBase.call(this, false)
}
CropToolOption.prototype = Object.create(CropOptionBase.prototype);

function SpongeBrushOption() {
  BrushOptionBase.call(this, ["brush", "rng", "expo"])
}
SpongeBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function AirbrushOption() {
  BrushOptionBase.call(this, "brush emode opacity flow smth prsr".split(" "))
}
AirbrushOption.prototype = Object.create(BrushOptionBase.prototype);

function ContentFillOption() {
  BrushOptionBase.call(this, ["brush", "samp", "wconf"])
}
ContentFillOption.prototype = Object.create(BrushOptionBase.prototype);

function ColorFillOption() {
  FillOptionBase.call(this);
  this.constraintWidget = new CropConstraintWidget();
  this.constraintWidget.on(EventType.widgetSelect, this.onColorChange, this);
  this.body.appendChild(this.constraintWidget.el)
}
ColorFillOption.prototype = Object.create(FillOptionBase.prototype);
ColorFillOption.prototype.onColorChange = function(changeEvent) {
  this.data.aspectController = this.constraintWidget.getValue();
  this.onInput()
};
ColorFillOption.prototype.syncWidgets = function() {
  FillOptionBase.prototype.syncWidgets.call(this);
  this.constraintWidget.buildUI()
};

function SampleSizeOption() {
  ToolOptionBase.call(this);
  this.sampleSizeDropdown = new Dropdown("properties.sampleSize", ["1x1", "3x3", "5x5", "11x11", "31x31"]);
  this.sampleSizeDropdown.on(EventType.widgetSelect, this.emitToolSettings, this);
  this.body.appendChild(this.sampleSizeDropdown.el)
}
SampleSizeOption.prototype = Object.create(ToolOptionBase.prototype);
SampleSizeOption.prototype.emitToolSettings = function(changeEvent) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel,
    sampleSizePixels: [1, 3, 5, 11, 31][this.sampleSizeDropdown.getValue()]
  };
  this.dispatch(uiEvent)
};
SampleSizeOption.prototype.syncWidgets = function() {
  this.sampleSizeDropdown.buildUI()
};

function AlignOption() {
  ToolOptionBase.call(this);
  this.gradientPicker = new GradientPickerButton(false);
  this.gradientPicker.parent = this;
  this.gradientPicker.on(EventType.widgetSelect, this.emitChange, this);
  this.body.appendChild(this.gradientPicker.el);
  this.gradientPicker.setValue(LayerEffectDefs.descriptorTemplates.foregroundBackgroundGradient.v);
  this.gradientTypeDropdown = new Dropdown(null, LayerEffectDefs.gradientTypeOptions.names.slice(0, 5));
  this.gradientTypeDropdown.on(EventType.widgetSelect, this.emitChange, this);
  this.body.appendChild(this.gradientTypeDropdown.el);
  this.blendModeDropdown = new Dropdown("properties.blendMode", BlendModes.uiLabels, null, BlendModes.groupSizes);
  this.blendModeDropdown.on(EventType.widgetSelect, this.emitChange, this);
  this.body.appendChild(this.blendModeDropdown.el);
  this.opacitySlider = new SliderDropdown("properties.opacity", 0, 100, "%");
  this.opacitySlider.parent = this;
  this.opacitySlider.on(EventType.widgetSelect, this.emitChange, this);
  this.body.appendChild(this.opacitySlider.el);
  this.opacitySlider.setValue(100);
  this.reverseCheckbox = new Checkbox("properties.reverse");
  this.reverseCheckbox.on(EventType.widgetSelect, this.emitChange, this);
  this.body.appendChild(this.reverseCheckbox.el);
  this.ditherCheckbox = new Checkbox("Dither");
  this.ditherCheckbox.on(EventType.widgetSelect, this.emitChange, this);
  this.body.appendChild(this.ditherCheckbox.el)
}
AlignOption.prototype = Object.create(ToolOptionBase.prototype);
AlignOption.prototype.syncWidgets = function() {
  this.gradientTypeDropdown.buildUI();
  this.blendModeDropdown.buildUI();
  this.opacitySlider.buildUI();
  this.reverseCheckbox.buildUI();
  this.ditherCheckbox.buildUI()
};
AlignOption.prototype.onUpdate = function(documentModel, popupType) {
  ToolOptionBase.prototype.onUpdate.call(this, documentModel, popupType);
  const colorChanged = popupType == PopupTypes.COLOR_CHANGE;
  this.gradientPicker.setContextColors(documentModel.colorInt, documentModel.bgColor);
  if (colorChanged || popupType == PopupTypes.GRADIENTS || popupType == PopupTypes.ALL) this.gradientPicker.setPresets(documentModel.gradientPresets)
};
AlignOption.prototype.emitChange = function() {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel
  };
  uiEvent.data.toolOptions = {
    gradientPreset: this.gradientPicker.getValue(),
    gradientStyle: LayerEffectDefs.gradientTypeOptions.types[this.gradientTypeDropdown.getValue()],
    reverseGradient: this.reverseCheckbox.isPressed(),
    ditherGradient: this.ditherCheckbox.isPressed(),
    gradientBlendMode: BlendModes.psdCodes[this.blendModeDropdown.getValue()],
    opacity: this.opacitySlider.getValue() / 100
  };
  this.dispatch(uiEvent)
};

function EmptyOption() {
  ToolOptionBase.call(this)
}
EmptyOption.prototype = Object.create(ToolOptionBase.prototype);

function AngleOption() {
  ToolOptionBase.call(this);
  const controlRow = makeElement("span", "fitem");
  this.body.appendChild(controlRow);
  this.angleControls = [new SliderDropdown("properties.angle", 0, 0, "\xB0"), new Button("Reset", null, null, true)];
  for (let controlIdx = 0; controlIdx < this.angleControls.length; controlIdx++) {
    const controlWidget = this.angleControls[controlIdx];
    controlWidget.parent = this;
    controlRow.appendChild(controlWidget.el);
    controlWidget.on(controlIdx == 1 ? "click" : EventType.widgetSelect, this.onAngleChange, this)
  }
}
AngleOption.prototype = Object.create(ToolOptionBase.prototype);
AngleOption.prototype.syncWidgets = function() {
  for (let controlIdx = 0; controlIdx < this.angleControls.length; controlIdx++) this.angleControls[controlIdx].buildUI()
};
AngleOption.prototype.onToolEvent = function(toolEvent) {
  this.angleControls[0].setValue(toolEvent.rotationRadians * 180 / Math.PI)
};
AngleOption.prototype.onAngleChange = function(changeEvent) {
  const controlIdx = this.angleControls.indexOf(changeEvent.target),
    uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel,
    rotationRadians: controlIdx == 1 ? 0 : changeEvent.target.getValue() * Math.PI / 180
  };
  this.dispatch(uiEvent)
};

function PatternStampOption() {
  BrushOptionBase.call(this, ["brush", "algnd", "sfrom", "alt"])
}
PatternStampOption.prototype = Object.create(BrushOptionBase.prototype);

function GradientStrokeOption() {
  ToolOptionBase.call(this);
  this.fontCombo = new FontComboBox();
  this.fontCombo.parent = this;
  this.body.appendChild(this.fontCombo.fontNameInput.el);
  this.body.appendChild(this.fontCombo.fontSizeInput.el);
  this.body.appendChild(this.fontCombo.fillColorPicker.el);
  const alignRow = makeElement("span", "fitem");
  this.body.appendChild(alignRow);
  alignRow.appendChild(this.fontCombo.alignLeftButton.el);
  alignRow.appendChild(this.fontCombo.alignCenterButton.el);
  alignRow.appendChild(this.fontCombo.alignRightButton.el);
  this.antialiasingDropdown = new Dropdown("Aa", [
    "warp.styles.none", "Sharp", "Crisp", "Strong", "Smooth"
  ]);
  this.antialiasingDropdown.on(EventType.widgetSelect, this.onConfirm, this);
  this.body.appendChild(this.antialiasingDropdown.el);
  this.warpButton = new Button("dialogs.warp", false, null, true);
  this.warpButton.on("click", this.onShowWarp, this);
  this.body.appendChild(this.warpButton.el);
  this.confirmWidget = new ConfirmWidget();
  this.confirmWidget.on("click", this.onConfirm, this)
}
GradientStrokeOption.prototype = Object.create(ToolOptionBase.prototype);
GradientStrokeOption.prototype.syncWidgets = function() {
  this.confirmWidget.buildUI();
  this.fontCombo.buildUI();
  this.warpButton.buildUI()
};
GradientStrokeOption.prototype.onShowWarp = function(clickEvent) {
  const actionPayload = {
      dispatchKind: UiCommand.applyDocumentToolAction,
      routingChannel: this.routingChannel,
      subAction: "showwarp"
    },
    uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = actionPayload;
  this.dispatch(uiEvent)
};
GradientStrokeOption.prototype.onToolEvent = function(toolEvent) {
  if (toolEvent.subAction == "showactive") this.body.appendChild(this.confirmWidget.el);
  if (toolEvent.subAction == "hideactive") this.body.removeChild(this.confirmWidget.el);
  if (toolEvent.subAction == "changeAA") this.antialiasingDropdown.setValue(toolEvent.antialiasMode)
};
GradientStrokeOption.prototype.onUpdate = function(documentModel, popupType) {
  ToolOptionBase.prototype.onUpdate.call(this, documentModel, popupType);
  if (popupType != PopupTypes.ALL && popupType != PopupTypes.EXPORT_AS && popupType != PopupTypes.OPEN_RECENT && popupType != PopupTypes.ABOUT) return;
  this.fontCombo.setValue(documentModel.currentTextStyle, documentModel.fontRegistry, documentModel.favoriteFontFamilies)
};
GradientStrokeOption.prototype.onConfirm = function(changeEvent) {
  const actionPayload = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel,
    subAction: this.confirmWidget.getValue() ? "commit" : "cancel"
  };
  if (changeEvent.target == this.antialiasingDropdown) {
    actionPayload.subAction = "changeAA";
    actionPayload.antialiasMode = this.antialiasingDropdown.getValue()
  }
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = actionPayload;
  this.dispatch(uiEvent)
};

function FillOptionA() {
  FillOptionBase.call(this)
}
FillOptionA.prototype = Object.create(FillOptionBase.prototype);

function MoveToolOption() {
  ToolOptionBase.call(this);
  const bodySections = [];
  this.autoSelectCheckbox = new Checkbox("properties.autoSelect");
  this.autoSelectCheckbox.on(EventType.widgetSelect, this.emitToolSettings, this);
  bodySections.push(this.autoSelectCheckbox.el);
  this.transformControlsCheckbox = new Checkbox("align.transformControls");
  this.transformControlsCheckbox.on(EventType.widgetSelect, this.emitToolSettings, this);
  bodySections.push(this.transformControlsCheckbox.el);
  this.distancesCheckbox = new Checkbox("properties.distances");
  this.distancesCheckbox.on(EventType.widgetSelect, this.emitToolSettings, this);
  bodySections.push(this.distancesCheckbox.el);
  const horizontalAlignRow = makeElement("span", "fitem");
  bodySections.push(horizontalAlignRow);
  const verticalAlignRow = makeElement("span", "fitem");
  bodySections.push(verticalAlignRow);
  this.alignButtons = [];
  const moveToolAlignTitleKeys = ["align.options.alignLeftEdges", "align.options.centreHorizontally", "align.options.alignRightEdges", "align.options.equalGaps", "align.options.alignTopEdges", "align.options.centreVertically", "align.options.alignBottomEdges", "align.options.equalGaps"];
  for (let buttonIdx = 0; buttonIdx < 8; buttonIdx++) {
    const titleKey = moveToolAlignTitleKeys[buttonIdx],
      alignButton = new Button("Hi", false, titleKey);
    (buttonIdx < 4 ? horizontalAlignRow : verticalAlignRow).appendChild(alignButton.el);
    alignButton.on("click", this.onAlignButtonClick, this);
    this.alignButtons.push(alignButton)
  }
  for (let sectionIdx = 0; sectionIdx < bodySections.length; sectionIdx++) this.body.appendChild(bodySections[sectionIdx]);
  this.allElements = bodySections
}
MoveToolOption.prototype = Object.create(ToolOptionBase.prototype);
MoveToolOption.prototype.onToolEvent = function(toolEvent) {
  const toolOptions = toolEvent.toolOptions,
    visibleSectionFlags = toolEvent.visibleSectionFlags;
  this.autoSelectCheckbox.setValue(toolOptions.autoSelectLayers);
  this.transformControlsCheckbox.setValue(toolOptions.showTransformControls);
  this.distancesCheckbox.setValue(toolOptions.showMeasurementGuides);
  if (visibleSectionFlags) {
    clearElement(this.body);
    for (let sectionIdx = 0; sectionIdx < visibleSectionFlags.length; sectionIdx++)
      if (visibleSectionFlags[sectionIdx] == 1 && this.allElements[sectionIdx]) this.body.appendChild(this.allElements[sectionIdx])
  }
};
MoveToolOption.prototype.onAlignButtonClick = function(clickEvent) {
  const alignButtonIdx = this.alignButtons.indexOf(clickEvent.target);
  if (alignButtonIdx == -1) return;
  const uiEvent = new AppEvent(EventType.documentAction, true);
  uiEvent.routingChannel = ToolId.TOOL_MOVE;
  uiEvent.data = {
    actionKind: "algn",
    value: alignButtonIdx
  };
  this.dispatch(uiEvent)
};
MoveToolOption.prototype.emitToolSettings = function(changeEvent) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel,
    operation: "prms",
    autoSelectLayers: this.autoSelectCheckbox.isPressed(),
    showTransformControls: this.transformControlsCheckbox.isPressed(),
    showMeasurementGuides: this.distancesCheckbox.isPressed()
  };
  this.dispatch(uiEvent)
};
MoveToolOption.prototype.syncWidgets = function() {
  this.autoSelectCheckbox.buildUI();
  this.transformControlsCheckbox.buildUI();
  this.distancesCheckbox.buildUI();
  const alignIconIds = "h0 h1 h2 hG v0 v1 v2 vG".split(" ");
  for (let buttonIdx = 0; buttonIdx < 8; buttonIdx++) {
    this.alignButtons[buttonIdx].setLabel(iconImgHtml("align/" + alignIconIds[buttonIdx], null, "autoscale"))
  }
};

function FillColorOption() {
  FillOptionBase.call(this);
  const antialiasingOption = this.displayOptions = new AntialiasingOption();
  antialiasingOption.parent = this;
  antialiasingOption.on(EventType.widgetSelect, this.onAntialiasingChange, this);
  this.body.appendChild(antialiasingOption.el)
}
FillColorOption.prototype = Object.create(FillOptionBase.prototype);
FillColorOption.prototype.onAntialiasingChange = function(changeEvent) {
  this.data.magicWandOptions = this.displayOptions.getValue();
  this.onInput()
};
FillColorOption.prototype.syncWidgets = function() {
  FillOptionBase.prototype.syncWidgets.call(this);
  this.displayOptions.buildUI()
};

function PatchOption() {
  BrushOptionBase.call(this, ["setop", "patch"])
}
PatchOption.prototype = Object.create(BrushOptionBase.prototype);

function SetOpOption() {
  BrushOptionBase.call(this, ["setop"])
}
SetOpOption.prototype = Object.create(BrushOptionBase.prototype);

function PatchBrushOption() {
  BrushOptionBase.call(this, ["bmode", "opacity", "wconf"])
}
PatchBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function FillOptionB() {
  FillOptionBase.call(this)
}
FillOptionB.prototype = Object.create(FillOptionBase.prototype);

function FillOptionC() {
  FillOptionBase.call(this)
}
FillOptionC.prototype = Object.create(FillOptionBase.prototype);

function ColorFillOptionB() {
  FillOptionBase.call(this);
  this.constraintWidget = new CropConstraintWidget();
  this.constraintWidget.on(EventType.widgetSelect, this.onColorChange, this);
  this.body.appendChild(this.constraintWidget.el)
}
ColorFillOptionB.prototype = Object.create(FillOptionBase.prototype);
ColorFillOptionB.prototype.onColorChange = function(changeEvent) {
  this.data.aspectController = this.constraintWidget.getValue();
  this.onInput()
};
ColorFillOptionB.prototype.syncWidgets = function() {
  FillOptionBase.prototype.syncWidgets.call(this);
  this.constraintWidget.buildUI()
};

function TransformOptionBar() {
  ToolOptionBase.call(this);
  this.doc = null;
  this.lastToolEvent = null;
  this.fields = [new TextInput("X", null, 3), new TextInput("Y", null, 3), new TextInput("W", null, 3), new TextInput("H", null, 3), new TextInput("properties.angle", null, 4), new TextInput("properties.length", null, 4), new Button("brushAndMessages.toolHints.straightenLayer", false, null, true)];
  for (let fieldIdx = 0; fieldIdx < this.fields.length; fieldIdx++) {
    const fieldWidget = this.fields[fieldIdx];
    this.body.appendChild(fieldWidget.el)
  }
  this.fields[6].on("click", this.onStraighten, this);
  this.measuredAngle = 0
}
TransformOptionBar.prototype = Object.create(ToolOptionBase.prototype);
TransformOptionBar.prototype.onStraighten = function(clickEvent) {
  if (this.measuredAngle == 0) {
    return
  }
  const rotateEvent = new AppEvent(EventType.documentAction, true);
  rotateEvent.routingChannel = ToolId.TOOL_FREE_TRANSFORM;
  rotateEvent.data = {
    actionKind: "rot",
    historyLabelKey: "edit.rotate",
    gestureValue: -this.measuredAngle
  };
  this.dispatch(rotateEvent)
};
TransformOptionBar.prototype.onToolEvent = function(toolEvent) {
  if (toolEvent == null) return;
  this.lastToolEvent = toolEvent;
  const startPoint = toolEvent.rulerStart,
    endPoint = toolEvent.rulerEnd,
    deltaX = endPoint.x - startPoint.x,
    deltaY = endPoint.y - startPoint.y,
    fieldWidgets = this.fields;
  this.measuredAngle = -Math.atan2(deltaY, deltaX);
  fieldWidgets[0].setValue(startPoint.x);
  fieldWidgets[1].setValue(startPoint.y);
  fieldWidgets[2].setValue(deltaX);
  fieldWidgets[3].setValue(deltaY);
  fieldWidgets[4].setValue((this.measuredAngle * 180 / Math.PI).toFixed(2));
  let lengthFormatted = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  lengthFormatted = formatDocLength(lengthFormatted, toolEvent.dpi, this.doc, toolEvent.referenceDocWidth, false);
  fieldWidgets[5].setValue(parseFloat(lengthFormatted).toFixed(2))
};
TransformOptionBar.prototype.onUpdate = function(documentModel, popupType) {
  this.doc = documentModel;
  this.onToolEvent(this.lastToolEvent)
};
TransformOptionBar.prototype.syncWidgets = function() {
  const fieldWidgets = this.fields;
  for (let fieldIdx = 0; fieldIdx < fieldWidgets.length; fieldIdx++) fieldWidgets[fieldIdx].buildUI();
  setWidthHeightLabels(fieldWidgets[2], fieldWidgets[3])
};

function SharpenBrushOption() {
  BrushOptionBase.call(this, ["brush", "strn", "pdetail"])
}
SharpenBrushOption.prototype = Object.create(BrushOptionBase.prototype);

function SmudgeBrushOption() {
  BrushOptionBase.call(this, ["brush", "sfrom"]);
  this.actionButtons = [];
  const actionLabels = [
    "select.healSelection"
  ];
  for (let buttonIdx = 0; buttonIdx < actionLabels.length; buttonIdx++) {
    const actionButton = new Button(actionLabels[buttonIdx], false, null, true);
    this.actionButtons.push(actionButton);
    actionButton.parent = this;
    this.body.appendChild(actionButton.el);
    actionButton.on("click", this.onActionClick, this)
  }
}
SmudgeBrushOption.prototype = Object.create(BrushOptionBase.prototype);
SmudgeBrushOption.prototype.onActionClick = function(clickEvent) {
  const buttonIdx = this.actionButtons.indexOf(clickEvent.currentTarget),
    historyEvent = new AppEvent(EventType.historyGrouped, true);
  historyEvent.data = PaintTool.buildFillAction("contentAware");
  this.dispatch(historyEvent)
};

function MixBrushOptionA() {
  BrushOptionBase.call(this, ["brush", "strn"])
}
MixBrushOptionA.prototype = Object.create(BrushOptionBase.prototype);

function MixBrushOptionB() {
  BrushOptionBase.call(this, ["brush", "flow", "smode"])
}
MixBrushOptionB.prototype = Object.create(BrushOptionBase.prototype);

function ZoomOption() {
  ToolOptionBase.call(this);
  this.invert = false;
  const zoomRow = makeElement("span", "fitem");
  this.body.appendChild(zoomRow);
  this.zoomModeMenu = new ButtonMenu(null, ["<img src=\"" + getIconUrl("zoomIn") + "\" class=\"autoscale gsicon\" />", "<img src=\"" + getIconUrl("zoomOut") + "\" class=\"autoscale gsicon\" />"]);
  zoomRow.appendChild(this.zoomModeMenu.el);
  this.zoomModeMenu.on(EventType.widgetSelect, this.emitToolSettings, this);
  this.pixelToPixelBtn = new Button("align.pixelToPixel");
  this.body.appendChild(this.pixelToPixelBtn.el);
  this.pixelToPixelBtn.on("click", this.onViewCommand, this);
  this.fitAreaBtn = new Button("align.fitTheArea");
  this.body.appendChild(this.fitAreaBtn.el);
  this.fitAreaBtn.on("click", this.onViewCommand, this)
}
ZoomOption.prototype = Object.create(ToolOptionBase.prototype);
ZoomOption.prototype.syncWidgets = function() {
  this.pixelToPixelBtn.buildUI();
  this.fitAreaBtn.buildUI()
};
ZoomOption.prototype.emitToolSettings = function() {
  const actionPayload = {
      dispatchKind: UiCommand.applyDocumentToolAction,
      routingChannel: this.routingChannel,
      zoomInOnGesture: this.zoomModeMenu.getValue() == 0
    },
    uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = actionPayload;
  this.dispatch(uiEvent)
};
ZoomOption.prototype.onToolEvent = function(toolEvent) {
  if (this.invert != toolEvent.invert) this.zoomModeMenu.setValue(1 - this.zoomModeMenu.getValue());
  this.invert = toolEvent.invert
};
ZoomOption.prototype.onViewCommand = function(clickEvent) {
  const viewEvent = new AppEvent(EventType.documentAction, true);
  viewEvent.routingChannel = ToolId.TOOL_ZOOM;
  viewEvent.data = {
    actionKind: "adapt",
    adaptTarget: clickEvent.target == this.pixelToPixelBtn ? "pixel" : "fitscr"
  };
  this.dispatch(viewEvent)
};



export {
  CloneStampOption,
  DodgeBrushOption,
  BlurBrushOption,
  BasicBrushOption,
  HealBrushOption,
  PaintBrushOption,
  StrenBrushOption,
  CropToolOption,
  SpongeBrushOption,
  AirbrushOption,
  ContentFillOption,
  ColorFillOption,
  SampleSizeOption,
  AlignOption,
  EmptyOption,
  AngleOption,
  PatternStampOption,
  GradientStrokeOption,
  FillOptionA,
  MoveToolOption,
  FillColorOption,
  PatchOption,
  SetOpOption,
  PatchBrushOption,
  FillOptionB,
  FillOptionC,
  ColorFillOptionB,
  TransformOptionBar,
  SharpenBrushOption,
  SmudgeBrushOption,
  MixBrushOptionA,
  MixBrushOptionB,
  ZoomOption
};
