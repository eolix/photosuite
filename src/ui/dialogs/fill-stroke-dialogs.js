/**
 * Edit Fill and layer stroke effect dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { ToolId } from "../../document/model/tool-base.js";
import { BlendModes } from "../../document/model/blend-modes.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { RangeInput } from "../widgets/controls/number-inputs.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { LayerEffectRow } from "../panels/layer-effect-row.js";
import { Button, Checkbox } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { PaintTool } from "../../document/tools/paint-tools.js";
import { toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/** PSD action fill-kind TypeIDs indexed by FillDialog dropdown order. */
const FILL_KIND_WIRE_KEYS = "FrgC BckC Clr Blck Gry Wht contentAware".split(" ");

function FillDialog() {
  BaseDialog.call(this, "edit.fill", "fill");
  this.doc = null;
  this.targetDocument = null;
  const formDiv = makeElement("div", "form padded form-labelled");
  formDiv.style.width = "22em";
  formDiv.style.setProperty("--form-label-width", "6.4em");
  this.body.appendChild(formDiv);
  this.fillKindKeys = FILL_KIND_WIRE_KEYS;
  this.fillKindDropdown = new Dropdown("edit.fill", [
    "properties.foreground",
    "properties.background",
    "properties.custom",
    "colour.labels.black",
    "colour.labels.grey",
    "colour.labels.white",
    "layer.newFillLayer.contentAware"
  ]);
  this.fillKindDropdown.on(EventType.widgetSelect, this.onFillKindDropdownChanged, this);
  formDiv.appendChild(this.fillKindDropdown.el);
  this.customColorHostEl = makeElement("span");
  formDiv.appendChild(this.customColorHostEl);
  this.customColorPicker = new ColorSampleWidget();
  this.customColorPicker.parent = this;
  this.customColorPicker.setPackedRgb(0);
  this.blendModeDropdown = new Dropdown("properties.blendMode", BlendModes.uiLabels, false, BlendModes.groupSizes);
  formDiv.appendChild(this.blendModeDropdown.el);
  this.opacitySlider = new RangeInput("properties.opacity", 0, 100, "%", 0, false);
  this.opacitySlider.setValue(100);
  formDiv.appendChild(this.opacitySlider.el);
  this.preserveTransparencyCheckbox = new Checkbox("properties.preserveTransparency");
  this.preserveTransparencyCheckbox.setValue(false);
  formDiv.appendChild(this.preserveTransparencyCheckbox.el);
  this.okButton = new Button("clipboard.ok", true, null, true);
  this.okButton.on("click", this.onOK, this);
  this.body.appendChild(this.okButton.el)
}
FillDialog.prototype = Object.create(BaseDialog.prototype);
FillDialog.prototype.constructor = FillDialog;
FillDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  return currentDoc != null
};
FillDialog.prototype.isActive = function() {
  return true
};
FillDialog.prototype.onFillKindDropdownChanged = function() {
  const showCustomColor = this.fillKindDropdown.getValue() == 2,
    colorPickerEl = this.customColorPicker.el,
    colorHostEl = this.customColorHostEl;
  if (showCustomColor) colorHostEl.appendChild(colorPickerEl);
  else if (colorHostEl.contains(colorPickerEl)) colorHostEl.removeChild(colorPickerEl)
};
FillDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.fillKindDropdown.buildUI();
  this.blendModeDropdown.buildUI();
  this.opacitySlider.buildUI()
};
FillDialog.prototype.onOK = function(clickEvent) {
  if (!this.targetDocument.ensureLayerEditableForTools()) return;
  const historyEvent = new AppEvent(EventType.historyGrouped, true),
    fillKindIndex = this.fillKindDropdown.getValue();
  historyEvent.data = PaintTool.buildFillAction(this.fillKindKeys[fillKindIndex], BlendModes.psdCodes[this.blendModeDropdown.getValue()], this.opacitySlider.getValue() / 100, this.customColorPicker.getValue(), this.preserveTransparencyCheckbox.getValue());
  this.close();
  this.dispatch(historyEvent)
};
FillDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.targetDocument = currentDoc
};
FillDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData
};


function StrokeDialog() {
  BaseDialog.call(this, "layerEffects.stroke", "stroke");
  this.doc = null;
  this.formDiv = makeElement("div", "form form-labelled");
  this.formDiv.setAttribute("style", "width:24em; --form-label-width:6.4em;");
  this.body.appendChild(this.formDiv);
  this.strokeEffectRow = new LayerEffectRow("FrFX", true);
  this.strokeEffectRow.parent = this;
  const widgetKeyOrder = ["Sz", "Styl", "Md", "Opct"].concat(LayerEffectDefs.solidFillPropertyKeys);
  for (let keyIdx = 0; keyIdx < widgetKeyOrder.length; keyIdx++) {
    const widgetKey = widgetKeyOrder[keyIdx];
    const widgetEl = this.strokeEffectRow.widgets[widgetKey].el;
    // The colour swatch carries no label of its own, so it gets one here and
    // joins the label column the other rows line up on.
    if (widgetKey === "Clr") {
      const colorRowEl = makeElement("div", "fieldrow");
      const colorLabelEl = makeElement("label", "flabel");
      colorLabelEl.textContent = Locale.get("colour.title") + ":";
      colorRowEl.appendChild(colorLabelEl);
      colorRowEl.appendChild(widgetEl);
      this.formDiv.appendChild(colorRowEl);
      continue;
    }
    this.formDiv.appendChild(widgetEl)
  }
  this.hasAppliedDefaultStroke = false;
  this.okButton = new Button("clipboard.ok", true, null, true);
  this.okButton.on("click", this.onOK, this);
  this.body.appendChild(this.okButton.el)
}
StrokeDialog.prototype = Object.create(BaseDialog.prototype);
StrokeDialog.prototype.constructor = StrokeDialog;
StrokeDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  return currentDoc != null
};
StrokeDialog.prototype.isActive = function() {
  return true
};
StrokeDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.strokeEffectRow.buildUI()
};
StrokeDialog.prototype.onOK = function(clickEvent) {
  const docActionEvent = new AppEvent(EventType.documentAction, true);
  docActionEvent.routingChannel = ToolId.TOOL_ERASER;
  docActionEvent.data = {
    actionKind: "stroke",
    strokeDescriptor: this.strokeEffectRow.getValue()
  };
  this.close();
  this.dispatch(docActionEvent)
};
StrokeDialog.prototype.open = function(currentDoc, dialogPayload) {
  if (!this.hasAppliedDefaultStroke) {
    const strokeDescriptor = LayerEffectDefs.getEffectDefault("FrFX");
    this.strokeEffectRow.update(currentDoc, strokeDescriptor);
    this.hasAppliedDefaultStroke = true
  }
  const strokeDescriptor = this.strokeEffectRow.getValue(),
    packedFgColor = this.doc.colorInt;
  strokeDescriptor.Clr.v = toRGBDesc({
    h: packedFgColor >> 16 & 255,
    l: packedFgColor >> 8 & 255,
    O: packedFgColor & 255
  });
  this.strokeEffectRow.update(currentDoc, strokeDescriptor)
};
StrokeDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData
};

export { FillDialog, StrokeDialog, FILL_KIND_WIRE_KEYS };
