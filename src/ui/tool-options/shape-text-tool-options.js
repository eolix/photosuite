/**
 * Shape, pen, type, and free-transform tool option panels plus transform numeric inputs.
 */


import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { ToolId } from "../../document/model/tool-base.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { PopupTypes } from "../config/popup-types.js";
import { InputHandler } from "./input-handler.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { Button, Checkbox, TextInput } from "../widgets/form-controls.js";
import { getFreeTransformMenuItems, getFreeTransformActions } from "./free-transform-menu-data.js";
import { BrushPickerButton } from "../widgets/controls/brush-preset-controls.js";
import { FontComboBox } from "../widgets/controls/font-controls.js";
import { CropConstraintWidget } from "../widgets/controls/color-controls.js";
import { AngleInput, SliderDropdown } from "../widgets/controls/number-inputs.js";
import { DisplayOptions } from "../widgets/controls/panel-widgets.js";
import { AntialiasingOption, ButtonMenu, ConfirmWidget, DocumentSelector, Dropdown, GradientPickerButton, RadioOption } from "../widgets/controls/popup-controls.js";
import { StrokeWidget, ContourSizeButton } from "../widgets/controls/stroke-layer-controls.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import {
  ToolOptionBase,
  BrushOptionBase,
  FillOptionBase,
  CropOptionBase
} from "./tool-option-base.js";
import { FillTypePicker } from "../widgets/controls/fill-type-picker.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, clearElement, makeElement, setWidthHeightLabels } from "../../core/dom.js";
import { iconImgHtml } from "../../assets/icon-registry.js";
import { AppEvent } from "../../core/event-bus.js";

import { unitePathRecordsWithPaper } from "../../engine/compositing/path-paper-bridge.js";
import { countSubpaths, knotCountInSubpath, recordIndexForSubpath } from "../../engine/compositing/path-records.js";
import { createEmptyKeyOrigin } from "../../engine/compositing/key-origins.js";
/**
 * Shape/path, text, warp, and transform tool-option panels.
 */

function CompactCropOption() {
  CropOptionBase.call(this, true)
}
CompactCropOption.prototype = Object.create(CropOptionBase.prototype);

function ShapeOptionBase(widgetKeys, hidePixelsMode) {
  ToolOptionBase.call(this);
  if (widgetKeys == null) return;
  this.widgets = {};
  const toolModeLabels = [
    "properties.drawMode.path",
    "properties.drawMode.shape"
  ];
  if (hidePixelsMode == null) toolModeLabels.push("properties.drawMode.pixels");
  for (let widgetIdx = 0; widgetIdx < widgetKeys.length; widgetIdx++) {
    const widgetKey = widgetKeys[widgetIdx];
    let widget = null;
    if (widgetKey == "tmode") {
      widget = new Dropdown(null, toolModeLabels);
      widget.setValue(1)
    }
    if (widgetKey == "make") {
      widget = new Button("Make Selection", null, null, true);
      widget.disable()
    }
    if (widgetKey == "binop") {
      widget = new Dropdown(null, [
        "pathOps.unite",
        "pathOps.subtract",
        "pathOps.intersect",
        "pathOps.exclude"
      ]);
      widget.disable()
    }
    if (widgetKey == "pshape") widget = new Dropdown(null, [
      "properties.shapeType.polygon",
      "properties.shapeType.star", "Arrow", "properties.shapeType.spiral"
    ]);
    if (widgetKey == "shape") widget = new ContourSizeButton("properties.drawMode.shape");
    if (widgetKey == "crad") {
      widget = new SliderDropdown("properties.cornerRadius", 0, 50, "px");
      widget.setValue(0)
    }
    if (widgetKey == "cstr") {
      widget = new CropConstraintWidget()
    }
    if (widgetKey == "irad") {
      widget = new SliderDropdown("properties.innerRadius", 0, 100, "%");
      widget.setValue(40)
    }
    if (widgetKey == "length") {
      widget = new SliderDropdown("properties.length", 4, 40);
      widget.setValue(4)
    }
    if (widgetKey == "sides") {
      widget = new SliderDropdown("properties.sides", 3, 30);
      widget.setValue(5)
    }
    if (widgetKey == "width") {
      widget = new SliderDropdown("properties.width", 1, 100, "px");
      widget.setValue(5)
    }
    if (widgetKey == "tsiz") {
      widget = new SliderDropdown("Tip Size", 100, 500, "%");
      widget.setValue(300)
    }
    if (widgetKey == "tolr") {
      widget = new SliderDropdown("properties.tolerance", 0, 100);
      widget.setValue(5)
    }
    if (widgetKey == "fstyle") {
      widget = new FillTypePicker("properties.fill")
    }
    if (widgetKey == "sstyle") {
      widget = new StrokeWidget()
    }
    if (widgetKey == "psnap") {
      widget = new Checkbox("view.snapToPixels")
    }
    if (widgetKey == "crnr") {
      widget = new Button("\u2312", false, "properties.cornerRadius", true)
    }
    widget.parent = this;
    this.body.appendChild(widget.el);
    this.widgets[widgetKey] = widget;
    widget.on(widgetKey == "crnr" || widgetKey == "make" ? "click" : EventType.widgetSelect, this.emitToolSettings, this)
  }
}
ShapeOptionBase.prototype = Object.create(ToolOptionBase.prototype);
ShapeOptionBase.prototype.onToolEvent = function(toolEvent) {
  if (toolEvent.operation == "vals") {
    for (let widgetKey in toolEvent.optionValues) this.widgets[widgetKey].setValue(toolEvent.optionValues[widgetKey]);
    this.refreshLayout();
    return
  }
  let contextMenu = ShapeOptionBase.cachedContextMenu;
  if (contextMenu == null) contextMenu = ShapeOptionBase.cachedContextMenu = new InputHandler([{
    name: "Make Selection"
  }], [{
    appEventType: EventType.uiDispatch,
    payload: {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "makesel"
    }
  }]);
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
};
ShapeOptionBase.prototype.getVisibleWidgetKeys = function(polygonShapeIndex) {
  return null
};
ShapeOptionBase.prototype.refreshLayout = function() {
  if (this.widgets.pshape == null) return;
  const visibleKeys = this.getVisibleWidgetKeys(this.widgets.pshape.getValue());
  if (visibleKeys == null) return;
  clearElement(this.body);
  for (let keyIdx = 0; keyIdx < visibleKeys.length; keyIdx++) {
    const widgetKey = visibleKeys[keyIdx];
    this.body.appendChild(this.widgets[widgetKey].el)
  }
};
ShapeOptionBase.prototype.syncWidgets = function() {
  for (let widgetKey in this.widgets) {
    this.widgets[widgetKey].buildUI()
  }
};
ShapeOptionBase.prototype.emitToolSettings = function(changeEvent) {
  if (changeEvent.target == this.widgets.crnr) {
    const cornerEvent = new AppEvent(EventType.documentAction, true);
    cornerEvent.routingChannel = ToolId.TOOL_DIRECT_SELECT;
    cornerEvent.data = {
      actionKind: "crnr"
    };
    this.dispatch(cornerEvent);
    return
  }
  if (changeEvent.target == this.widgets.make) {
    const dialogEvent = new AppEvent(EventType.uiDispatch, true);
    dialogEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "makesel"
    };
    this.dispatch(dialogEvent);
    return
  }
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  if (changeEvent.target == this.widgets.fstyle) {
    uiEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.PLACE_IMAGE,
      value: this.widgets.fstyle.getValue()
    };
    this.dispatch(uiEvent);
    return
  }
  if (changeEvent.target == this.widgets.sstyle) {
    uiEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.SHAPE_STROKE,
      value: this.widgets.sstyle.getValue()
    };
    this.dispatch(uiEvent);
    return
  }
  if (this.widgets.tmode && this.widgets.binop) {
    const pathModeActive = this.widgets.tmode.getValue() == 0,
      booleanOpDropdown = this.widgets.binop,
      makeSelectionButton = this.widgets.make;
    if (booleanOpDropdown) booleanOpDropdown.setEnabled(pathModeActive);
    if (makeSelectionButton) makeSelectionButton.setEnabled(pathModeActive)
  }
  uiEvent.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel
  };
  for (let widgetKey in this.widgets)
    if (widgetKey != "sstyle") uiEvent.data[widgetKey] = this.widgets[widgetKey].getValue();
  this.dispatch(uiEvent);
  if (changeEvent.target == this.widgets.pshape) this.refreshLayout()
};
ShapeOptionBase.prototype.onUpdate = function(documentModel, popupType) {
  ToolOptionBase.prototype.onUpdate.call(this, documentModel, popupType);
  const fillStyleWidget = this.widgets.fstyle,
    strokeStyleWidget = this.widgets.sstyle;
  if (fillStyleWidget) fillStyleWidget.onUpdate(documentModel, popupType);
  if (strokeStyleWidget) strokeStyleWidget.onUpdate(documentModel, popupType);
  if (popupType == PopupTypes.ALL || popupType == PopupTypes.SHAPES)
    if (documentModel.customShapePresets.length != 0 && this.widgets.shape) {
      this.widgets.shape.setPresets(documentModel.customShapePresets)
    } if (popupType == PopupTypes.ALL || popupType == PopupTypes.PLACE_IMAGE)
    if (fillStyleWidget) fillStyleWidget.setValue(null, documentModel.currentFill, documentModel.fillPresetsByKind);
  if (popupType == PopupTypes.ALL || popupType == PopupTypes.SHAPE_STROKE)
    if (strokeStyleWidget) strokeStyleWidget.setValue(null, documentModel.currentStroke, documentModel.strokeFillPresetsByKind)
};

function LineworkOption() {
  ShapeOptionBase.call(this, ["tmode", "make", "fstyle", "sstyle", "binop"], true)
}
LineworkOption.prototype = Object.create(ShapeOptionBase.prototype);

function LassoOption() {
  ShapeOptionBase.call(this, ["tmode", "fstyle", "sstyle", "binop", "tolr"])
}
LassoOption.prototype = Object.create(ShapeOptionBase.prototype);

function PathSelectOption() {
  ShapeOptionBase.call(this, ["fstyle", "sstyle"]);
  this.storedPathData = null;
  this.storedKeyOrigins = null;
  this.pathOpsDropdown = new Dropdown("Path", [
    "pathOps.unite",
    "pathOps.subtract",
    "pathOps.intersect",
    "pathOps.exclude",
    "pathOps.merge"
  ], false, [4]);
  this.moveDownBtn = new Button("");
  this.moveDownBtn.markActive();
  addClass(this.moveDownBtn.el, "chevron");
  this.moveUpBtn = new Button("");
  this.moveUpBtn.markActive();
  addClass(this.moveUpBtn.el, "chevron chevron-up");
  this.pathControls = [this.pathOpsDropdown, this.moveDownBtn, this.moveUpBtn];
  for (let controlIdx = 0; controlIdx < this.pathControls.length; controlIdx++) {
    const pathControl = this.pathControls[controlIdx];
    this.body.appendChild(pathControl.el);
    pathControl.parent = this;
    pathControl.on(controlIdx == 0 ? EventType.widgetSelect : "click", this.onChange, this)
  }
}
PathSelectOption.prototype = Object.create(ShapeOptionBase.prototype);
PathSelectOption.prototype.onToolEvent = function(toolEvent) {
  if (toolEvent.subAction == "main") {
    const pathControls = this.pathControls,
      pathSelection = toolEvent.vectorMask;
    if (pathSelection && pathSelection.C.length == 1) {
      this.storedPathData = pathSelection.clone();
      this.storedKeyOrigins = JSON.stringify(toolEvent.KeyOrigins);
      const activeComponentIndex = pathSelection.C[0],
        subpathCount = countSubpaths(pathSelection.pathRecords);
      this.pathOpsDropdown.enable();
      if (activeComponentIndex > 0) this.moveDownBtn.enable();
      else this.moveDownBtn.disable();
      if (activeComponentIndex < subpathCount - 1) this.moveUpBtn.enable();
      else this.moveUpBtn.disable();
      const recordIndex = recordIndexForSubpath(pathSelection.pathRecords, activeComponentIndex),
        pathRecord = pathSelection.pathRecords[recordIndex];
      this.pathOpsDropdown.setLabel("Path " + (activeComponentIndex + 1));
      this.pathOpsDropdown.setValue([3, 0, 1, 2][pathRecord.fillRule])
    } else {
      for (let controlIdx = 0; controlIdx < pathControls.length; controlIdx++) pathControls[controlIdx].disable()
    }
  } else ShapeOptionBase.prototype.onToolEvent.call(this, toolEvent)
};
PathSelectOption.prototype.syncWidgets = function() {
  ShapeOptionBase.prototype.syncWidgets.call(this);
  this.pathOpsDropdown.buildUI()
};
PathSelectOption.prototype.onChange = function(changeEvent) {
  if (changeEvent.target == this.pathOpsDropdown || changeEvent.target == this.moveDownBtn || changeEvent.target == this.moveUpBtn) {
    let actionPayload = {},
      pathSelection = this.storedPathData,
      pathRecords = pathSelection.pathRecords,
      keyOrigins = JSON.parse(this.storedKeyOrigins),
      activeComponentIndex = pathSelection.C[0],
      recordIndex = recordIndexForSubpath(pathRecords, activeComponentIndex),
      pathRecord = pathRecords[recordIndex];
    if (changeEvent.target == this.pathOpsDropdown) {
      const opIndex = this.pathOpsDropdown.getValue();
      if (opIndex < 4) pathRecord.fillRule = [1, 2, 3, 0][opIndex];
      else {
        if (countSubpaths(pathRecords) <= 1) return;
        pathSelection.pathRecords = unitePathRecordsWithPaper(pathRecords);
        pathSelection.C = pathSelection.pathRecords.length == 2 ? [] : [0];
        pathSelection.selectedComponents = [];
        keyOrigins = [createEmptyKeyOrigin()]
      }
    } else {
      const direction = changeEvent.target == this.moveDownBtn ? -1 : 1,
        lowerIndex = Math.min(activeComponentIndex, activeComponentIndex + direction),
        upperIndex = Math.max(activeComponentIndex, activeComponentIndex + direction),
        lowerRecordIndex = recordIndexForSubpath(pathRecords, lowerIndex),
        upperRecordIndex = recordIndexForSubpath(pathRecords, upperIndex);
      if (lowerRecordIndex == -1 || upperRecordIndex == -1) return;
      const upperKnotEnd = upperRecordIndex + knotCountInSubpath(pathRecords, upperIndex),
        lowerKeyOrigin = keyOrigins[lowerIndex];
      keyOrigins[lowerIndex] = keyOrigins[upperIndex];
      keyOrigins[upperIndex] = lowerKeyOrigin;
      const recordsBefore = pathRecords.slice(0, lowerRecordIndex),
        recordsMiddle = pathRecords.slice(lowerRecordIndex, upperRecordIndex),
        recordsUpper = pathRecords.slice(upperRecordIndex, upperKnotEnd),
        recordsAfter = pathRecords.slice(upperKnotEnd);
      pathSelection.pathRecords = recordsBefore.concat(recordsUpper.concat(recordsMiddle.concat(recordsAfter)));
      pathSelection.C[0] += direction
    }
    actionPayload.vectorMask = pathSelection;
    actionPayload.KeyOrigins = keyOrigins;
    const uiEvent = new AppEvent(EventType.uiDispatch, true);
    uiEvent.data = {
      dispatchKind: UiCommand.applyDocumentToolAction,
      routingChannel: this.routingChannel,
      pathEditPayload: actionPayload
    };
    this.dispatch(uiEvent)
  }
};

function DirectSelectShapeOption() {
  ShapeOptionBase.call(this, ["fstyle", "sstyle", "crnr", "psnap"])
}
DirectSelectShapeOption.prototype = Object.create(ShapeOptionBase.prototype);

function RectShapeOption() {
  ShapeOptionBase.call(this, "tmode fstyle sstyle binop cstr crad".split(" "))
}
RectShapeOption.prototype = Object.create(ShapeOptionBase.prototype);

function SelectionModeOption() {
  ShapeOptionBase.call(this, ["tmode", "fstyle", "sstyle", "binop", "cstr"])
}
SelectionModeOption.prototype = Object.create(ShapeOptionBase.prototype);

function PolygonShapeOption() {
  ShapeOptionBase.call(this, "tmode fstyle sstyle binop pshape sides irad crad width tsiz length".split(" "));
  this.shapeWidgetGroups = [
    ["sides", "crad"],
    ["sides", "irad", "crad"],
    ["width", "tsiz"],
    ["length"]
  ];
  this.refreshLayout()
}
PolygonShapeOption.prototype = Object.create(ShapeOptionBase.prototype);
PolygonShapeOption.prototype.getVisibleWidgetKeys = function(polygonShapeIndex) {
  return ["tmode", "fstyle", "sstyle", "binop", "pshape"].concat(this.shapeWidgetGroups[polygonShapeIndex])
};

function LineShapeOption() {
  ShapeOptionBase.call(this, ["tmode", "fstyle", "sstyle", "binop", "width"])
}
LineShapeOption.prototype = Object.create(ShapeOptionBase.prototype);

function CustomShapeOption() {
  ShapeOptionBase.call(this, "tmode fstyle sstyle binop cstr shape".split(" "))
}
CustomShapeOption.prototype = Object.create(ShapeOptionBase.prototype);

function FillOptionD() {
  FillOptionBase.call(this)
}
FillOptionD.prototype = Object.create(FillOptionBase.prototype);

function QuickSelectOption() {
  BrushOptionBase.call(this, ["brush", "qsmode", "redge"])
}
QuickSelectOption.prototype = Object.create(BrushOptionBase.prototype);

function EmptyOptionPanel() {
  ToolOptionBase.call(this)
}
EmptyOptionPanel.prototype = Object.create(ToolOptionBase.prototype);

/** Bare push button whose only content is a chevron affordance. */
function makeChevronButton(pointsUp) {
  const chevronButton = new Button("", null, null, true);
  addClass(chevronButton.el, pointsUp ? "chevron chevron-up" : "chevron");
  return chevronButton;
}

function LayerOrderOption() {
  ToolOptionBase.call(this);
  this.moveDownBtn = new Button("");
  this.moveDownBtn.markActive();
  addClass(this.moveDownBtn.el, "chevron");
  this.moveUpBtn = new Button("");
  this.moveUpBtn.markActive();
  addClass(this.moveUpBtn.el, "chevron chevron-up");
  const reorderButtons = [this.moveDownBtn, this.moveUpBtn];
  for (let buttonIdx = 0; buttonIdx < 2; buttonIdx++) {
    const reorderButton = reorderButtons[buttonIdx];
    this.body.appendChild(reorderButton.el);
    reorderButton.on("click", this.onChange, this)
  }
}
LayerOrderOption.prototype = Object.create(ToolOptionBase.prototype);
LayerOrderOption.prototype.onChange = function(clickEvent) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.applyDocumentToolAction,
    routingChannel: this.routingChannel,
    operation: "reorder",
    dir: clickEvent.target == this.moveDownBtn ? -1 : 1
  };
  this.dispatch(uiEvent)
};

function TextFontOptionBase(isPuppetWarpVariant) {
  ToolOptionBase.call(this);
  if (window.Typr == null) return;
  this.isPuppetWarpVariant = isPuppetWarpVariant;
  this.cachedToolEvent = null;
  this.transformControlsSpan = makeElement("span", "");
  this.warpControlsSpan = makeElement("span", "");
  const decimalPlaces = 1;
  this.transformInputs = {
    refPointAngle: new AngleInput(null, 24),
    xInput: new SliderDropdown("X", 0, 0, "px", 0, false, true, 4),
    yInput: new SliderDropdown("Y", 0, 0, "px", 0, false, true, 4),
    widthInput: new SliderDropdown("W", 0, 0, ["%", "px"], 2, false, true, 5),
    keepAspectBtn: new Button(
      iconImgHtml("ui/aspect-lock", "", "autoscale"), null, "properties.keepAspectRatio", null),
    heightInput: new SliderDropdown("H", 0, 0, ["%", "px"], 2, false, true, 5),
    rotationInput: new SliderDropdown("\u2221", 0, 0, "\xB0", decimalPlaces, false, true),
    hSkewInput: new SliderDropdown("\u25B1 H", -85, 85, "\xB0", decimalPlaces, false, true),
    vSkewInput: new SliderDropdown("\u25B1 V", -85, 85, "\xB0", decimalPlaces, false, true),
    interpolationDropdown: new Dropdown(null, [
      "properties.size.nearestNeighbour",
      "properties.size.bilinear", "Bicubic Sharper"
    ])
  };
  this.transformInputs.interpolationDropdown.setValue(1);
  for (let inputKey in this.transformInputs) {
    const inputWidget = this.transformInputs[inputKey];
    if (isPuppetWarpVariant && (inputWidget == this.transformInputs.rotationInput || inputWidget == this.transformInputs.hSkewInput || inputWidget == this.transformInputs.vSkewInput || inputWidget == this.transformInputs.interpolationDropdown)) {} else this.transformControlsSpan.appendChild(inputWidget.el);
    const eventName = inputWidget == this.transformInputs.keepAspectBtn ? "click" : EventType.widgetSelect;
    inputWidget.on(eventName, this.onTransformInput, this)
  }
  this.displayOptions = new DisplayOptions(true, true, true);
  this.displayOptions.on(EventType.widgetSelect, this.onWarpChange, this);
  this.displayOptions.parent = this;
  const warpControlsSpan = this.warpControlsSpan,
    displayOptions = this.displayOptions;
  warpControlsSpan.appendChild(displayOptions.warpStyleList.el);
  warpControlsSpan.appendChild(displayOptions.warpOrientationDropdown.el);
  warpControlsSpan.appendChild(displayOptions.warpBendControl.el);
  warpControlsSpan.appendChild(displayOptions.horizontalDistortionControl.el);
  warpControlsSpan.appendChild(displayOptions.verticalDistortionControl.el);
  this.warpButton = new Button("dialogs.warp");
  this.warpButton.on("click", this.onSwitchWarp, this);
  this.confirmWidget = new ConfirmWidget();
  this.confirmWidget.on("click", this.onConfirm, this)
}
TextFontOptionBase.prototype = Object.create(ToolOptionBase.prototype);
TextFontOptionBase.prototype.onToolEvent = function(toolEvent) {
  if (toolEvent.pointerState) {
    let contextMenu = this.cachedContextMenu;
    if (contextMenu == null) contextMenu = this.cachedContextMenu = new InputHandler(TextFontOptionBase.getFreeTransformContextMenuItems(), TextFontOptionBase.getFreeTransformContextMenuActions(this.routingChannel));
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
    this.dispatch(overlayEvent);
    return
  }
  clearElement(this.body);
  this.cachedToolEvent = toolEvent;
  if (toolEvent.freeTransform) {
    const layerBounds = toolEvent.freeTransform.boundsRect,
      decomposedMatrix = toolEvent.freeTransform.decomposedMatrix.clone(),
      rotationRad = Math.atan2(-decomposedMatrix.b, decomposedMatrix.a),
      rotationMatrix = new Matrix2D();
    rotationMatrix.rotate(-rotationRad);
    decomposedMatrix.concat(rotationMatrix);
    const transformInputs = this.transformInputs;
    transformInputs.refPointAngle.setValue(toolEvent.freeTransform.refPointIndex);
    transformInputs.xInput.setValue(toolEvent.freeTransform.refPoint.x);
    transformInputs.yInput.setValue(toolEvent.freeTransform.refPoint.y);
    transformInputs.widthInput.setValue(decomposedMatrix.w * (transformInputs.widthInput.getDisplaySuffix() == "%" ? 100 : layerBounds.width));
    transformInputs.heightInput.setValue(decomposedMatrix.d * (transformInputs.heightInput.getDisplaySuffix() == "%" ? 100 : layerBounds.height));
    transformInputs.rotationInput.setValue(-rotationRad * 180 / Math.PI);
    transformInputs.hSkewInput.setValue(0 * 180 / Math.PI);
    transformInputs.vSkewInput.setValue(Math.atan(decomposedMatrix.c) * 180 / Math.PI);
    this.body.appendChild(this.transformControlsSpan);
    this.warpButton.clearActive()
  }
  if (toolEvent.warpDescriptor) {
    this.displayOptions.setValue(toolEvent.warpDescriptor);
    this.body.appendChild(this.warpControlsSpan);
    this.warpButton.markActive()
  }
  this.body.appendChild(this.confirmWidget.el);
  if (toolEvent.hasWarpMesh && !this.isPuppetWarpVariant) this.body.appendChild(this.warpButton.el)
};
TextFontOptionBase.prototype.onTransformInput = function(changeEvent) {
  const transformInputs = this.transformInputs,
    layerBounds = this.cachedToolEvent.freeTransform.boundsRect;
  if (changeEvent.target == transformInputs.keepAspectBtn) transformInputs.keepAspectBtn.setValue(!transformInputs.keepAspectBtn.getValue());
  if (transformInputs.keepAspectBtn.isPressed()) {
    let drivingInput = transformInputs.heightInput,
      linkedInput = transformInputs.widthInput,
      drivingExtent = layerBounds.height,
      linkedExtent = layerBounds.width;
    if (changeEvent.target == transformInputs.widthInput) {
      drivingInput = transformInputs.widthInput;
      linkedInput = transformInputs.heightInput;
      drivingExtent = layerBounds.width;
      linkedExtent = layerBounds.height
    }
    let linkedValue = drivingInput.getValue() / (drivingInput.getDisplaySuffix() == "%" ? 100 : drivingExtent);
    linkedValue *= linkedInput.getDisplaySuffix() == "%" ? 100 : linkedExtent;
    linkedInput.setValue(linkedValue)
  }
  const transformValues = [];
  for (let inputKey in transformInputs)
    if (transformInputs[inputKey] != transformInputs.keepAspectBtn && transformInputs[inputKey] != transformInputs.refPointAngle) {
      let inputValue = transformInputs[inputKey].getValue();
      if ((transformInputs[inputKey] == transformInputs.widthInput || transformInputs[inputKey] == transformInputs.heightInput) && inputValue == 0) {
        inputValue = .1;
        transformInputs[inputKey].setValue(inputValue)
      }
      if (transformInputs[inputKey] == transformInputs.widthInput && transformInputs[inputKey].getDisplaySuffix() == "px") inputValue /= layerBounds.width / 100;
      if (transformInputs[inputKey] == transformInputs.heightInput && transformInputs[inputKey].getDisplaySuffix() == "px") inputValue /= layerBounds.height / 100;
      transformValues.push(inputValue)
    } var centerPoint = new Point(transformValues[0], transformValues[1]);
  if (changeEvent.target == transformInputs.refPointAngle) {
    this.dispatchAction({
      subAction: "ctyp",
      refPointIndex: transformInputs.refPointAngle.getValue()
    })
  } else if (changeEvent.target == transformInputs.xInput || changeEvent.target == transformInputs.yInput) {
    this.dispatchAction({
      subAction: "cen",
      refPoint: centerPoint
    })
  } else {
    const workingMatrix = this.cachedToolEvent.freeTransform.decomposedMatrix.clone(),
      normalizedMatrix = workingMatrix.clone(),
      currentRotation = Math.atan2(-workingMatrix.b, workingMatrix.a);
    normalizedMatrix.translate(-centerPoint.x, -centerPoint.y);
    normalizedMatrix.rotate(-currentRotation);
    const inverseNormalized = new Matrix2D(normalizedMatrix.a, normalizedMatrix.b, normalizedMatrix.c, normalizedMatrix.d, 0, 0);
    inverseNormalized.invert();
    normalizedMatrix.concat(inverseNormalized);
    normalizedMatrix.concat(new Matrix2D(transformValues[2] / 100, Math.tan(transformValues[5] * Math.PI / 180), Math.tan(transformValues[6] * Math.PI / 180), transformValues[3] / 100, 0, 0));
    normalizedMatrix.rotate(-transformValues[4] * Math.PI / 180);
    normalizedMatrix.translate(centerPoint.x, centerPoint.y);
    this.cachedToolEvent.freeTransform.decomposedMatrix = normalizedMatrix;
    this.dispatchAction({
      subAction: "trn",
      transformMatrix: normalizedMatrix,
      interpolationMode: this.transformInputs.interpolationDropdown.getValue()
    })
  }
};
TextFontOptionBase.prototype.onWarpChange = function(changeEvent) {
  this.dispatchAction({
    subAction: "wrp",
    warpDescriptor: this.displayOptions.getValue()
  })
};
TextFontOptionBase.prototype.onSwitchWarp = function(clickEvent) {
  this.dispatchAction({
    subAction: "switchWarp"
  })
};
TextFontOptionBase.prototype.onConfirm = function(clickEvent) {
  this.dispatchAction({
    subAction: this.confirmWidget.getValue() ? "commit" : "cancel"
  })
};
TextFontOptionBase.prototype.dispatchAction = function(actionPayload) {
  dispatchApplyDocumentToolAction(this, actionPayload);
};
TextFontOptionBase.prototype.syncWidgets = function() {
  const transformInputs = this.transformInputs;
  for (let inputKey in transformInputs) transformInputs[inputKey].buildUI();
  setWidthHeightLabels(transformInputs.widthInput, transformInputs.heightInput);
  this.confirmWidget.buildUI();
  this.displayOptions.buildUI();
  this.warpButton.buildUI()
};
TextFontOptionBase.getFreeTransformContextMenuItems = getFreeTransformMenuItems;
TextFontOptionBase.getFreeTransformContextMenuActions = getFreeTransformActions;

function TextLeadingOption() {
  TextFontOptionBase.call(this)
}
TextLeadingOption.prototype = Object.create(TextFontOptionBase.prototype);

function TextTrackingOption() {
  TextFontOptionBase.call(this)
}
TextTrackingOption.prototype = Object.create(TextFontOptionBase.prototype);

function TextBaselineOption() {
  TextFontOptionBase.call(this, true)
}
TextBaselineOption.prototype = Object.create(TextFontOptionBase.prototype);

function WarpOption() {
  ToolOptionBase.call(this);
  this.puppetMeshSettings = [new Dropdown("properties.mode", ["Rigid", "brushAndMessages.blendModes.normal",
    "filters.gallery.groups.distort"
  ]), new Dropdown("properties.density", [
    "styleOptions.spreadSize.small",
    "styleOptions.spreadSize.medium",
    "styleOptions.spreadSize.large"
  ]), new SliderDropdown("select.expand", 0, 100, "px"), new Checkbox("Show Mesh"), makeChevronButton(false), makeChevronButton(true)];
  for (let widgetIdx = 0; widgetIdx < this.puppetMeshSettings.length; widgetIdx++) {
    const settingWidget = this.puppetMeshSettings[widgetIdx];
    settingWidget.parent = this;
    this.body.appendChild(settingWidget.el);
    settingWidget.on(widgetIdx < 4 ? EventType.widgetSelect : "click", this.onPuppetSettingChange, this)
  }
  this.confirmWidget = new ConfirmWidget();
  this.confirmWidget.on("click", this.onConfirm, this);
  this.body.appendChild(this.confirmWidget.el)
}
WarpOption.prototype = Object.create(ToolOptionBase.prototype);
WarpOption.prototype.syncWidgets = function() {
  const settingWidgets = this.puppetMeshSettings;
  for (let widgetIdx = 0; widgetIdx < 4; widgetIdx++) settingWidgets[widgetIdx].buildUI();
  this.confirmWidget.buildUI()
};
WarpOption.prototype.onToolEvent = function(toolEvent) {
  const puppetSettings = toolEvent.puppetMeshSettings;
  for (let widgetIdx = 0; widgetIdx < 4; widgetIdx++) this.puppetMeshSettings[widgetIdx].setValue(puppetSettings[widgetIdx])
};
WarpOption.prototype.onPuppetSettingChange = function(changeEvent) {
  const settingValues = [];
  for (let widgetIdx = 0; widgetIdx < 4; widgetIdx++) settingValues[widgetIdx] = this.puppetMeshSettings[widgetIdx].getValue();
  const changedWidgetIdx = this.puppetMeshSettings.indexOf(changeEvent.target);
  if (changedWidgetIdx < 4) this.dispatchAction({
    subAction: "prm",
    puppetMeshSettings: settingValues
  });
  else this.dispatchAction({
    subAction: "moveDepth",
    increasePinDepth: changedWidgetIdx == 5
  })
};
WarpOption.prototype.onConfirm = function(clickEvent) {
  this.dispatchAction({
    subAction: this.confirmWidget.getValue() ? "commit" : "cancel"
  })
};
WarpOption.prototype.dispatchAction = function(actionPayload) {
  dispatchApplyDocumentToolAction(this, actionPayload);
};

/**
 * Stamp dispatchKind + routingChannel and emit uiDispatch for tool applyAction.
 * @param {{ routingChannel: *, dispatch: Function }} panel
 * @param {Object} actionPayload
 */
function dispatchApplyDocumentToolAction(panel, actionPayload) {
  actionPayload.dispatchKind = UiCommand.applyDocumentToolAction;
  actionPayload.routingChannel = panel.routingChannel;
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = actionPayload;
  panel.dispatch(uiEvent);
}

export {
  CompactCropOption,
  ShapeOptionBase,
  LineworkOption,
  LassoOption,
  PathSelectOption,
  DirectSelectShapeOption,
  RectShapeOption,
  SelectionModeOption,
  PolygonShapeOption,
  LineShapeOption,
  CustomShapeOption,
  FillOptionD,
  QuickSelectOption,
  EmptyOptionPanel,
  LayerOrderOption,
  TextFontOptionBase,
  TextLeadingOption,
  TextTrackingOption,
  TextBaselineOption,
  WarpOption,
  dispatchApplyDocumentToolAction
};
