/**
 * Layer effect row widgets shared by the layers/properties UI and Layer Style dialog.
 * Descriptor field keys (enab, lagl, Ofst, …) are PSD wire names; changeprop payloads
 * use the `value` slot consumed by LayerStyleDialogTracker.
 */


import { BlendModes } from "../../document/model/blend-modes.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { Button, Checkbox, Label } from "../widgets/form-controls.js";
import { RangeInput } from "../widgets/controls/number-inputs.js";
import { DrawingCanvas } from "../widgets/controls/canvas-widgets.js";
import { ModeDropdown, Dropdown, GradientPickerButton, RadioOption } from "../widgets/controls/popup-controls.js";
import { ContourButton, PatternPickerButton, ShadowOffsetWidget } from "../widgets/controls/effect-pickers.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, cancel, makeElement, removeClass } from "../../core/dom.js";
import { iconImgHtml } from "../../assets/icon-registry.js";
import { AppEvent } from "../../core/event-bus.js";

const PERCENT_SCALAR_KEYS =
  "Opct iOpa hglO sdwO Dstn Ckmt blur Nose Scl Sz Inpr Angl srgR Sftn textureDepth ShdN".split(" ");

const NESTED_DESCRIPTOR_KEYS =
  "enab brst knko Clr hglC sdwC uglg Grad TrnS MpgS Rvrs Dthr Algn Invr InvT Ptrn layerConceals useShape useTexture Ofst phase blIf".split(" ");

const SHADOW_DRAG_EFFECT_CLASS_IDS = ["DrSh", "IrSh", "ChFX"];

/**
 * Editor for one layer effect (drop shadow, bevel, stroke, overlay, blending
 * options, …), identified by its PSD effect classID. The field list for the
 * effect (fieldListsByEffectClass) drives which widgets are built; each field
 * key is a PSD wire name. update() copies an effect descriptor into the
 * widgets, and editing a widget emits a change: as a changeprop document
 * action (Layer Style dialog) or a plain widgetSelect event (inline form),
 * with the value carried in the payload's `value` slot.
 *
 * @param {string} effectClassId PSD effect class (e.g. "DrSh", "ebbl", "FrFX")
 * @param {boolean} isInlineForm true for the compact inline form, false for the
 *   sectioned Layer Style dialog layout
 * @param {number[]} effectPathIndices [effectKindIndex, instanceIndex] locating
 *   this effect instance within the layer's effect stack
 */
function LayerEffectRow(effectClassId, isInlineForm, effectPathIndices) {
  BaseWidget.call(this);
  this.el = makeElement("div", "");
  this.effectClassId = effectClassId;
  this.widgets = null;
  this.isInlineForm = isInlineForm == null ? false : isInlineForm;
  this.effectDescriptor = null;
  this.effectPathIndices = effectPathIndices;
  this.sectionLabelWidgets = [];
  this.sectionContainerEls = [];
  this.rowLeadWidgets = [];
  this.listItemEls = [];
  this.selectedListIndex = 0;
  this.widgets = this.buildWidgetsFromFieldList(LayerEffectRow.fieldListsByEffectClass[effectClassId]);
  this.buildWidgetRows();
  this.dragStartPointer = null;
  this.dragStartDescriptor = null;
  this.dragStartAngleValue = null;
}
LayerEffectRow.prototype = Object.create(BaseWidget.prototype);

LayerEffectRow.prototype.onMouseDown = function(docContext, _unusedMode, _unusedView, _unusedModifier, pointerPos) {
  this.dragStartPointer = pointerPos;
  this.dragStartDescriptor = JSON.parse(JSON.stringify(this.effectDescriptor));
  if (this.widgets.lagl) this.dragStartAngleValue = this.widgets.lagl.getValue()
};

LayerEffectRow.prototype.onMouseMove = function(docContext, _unusedMode, _unusedView, _unusedModifier, pointerPos) {
  applyPointerDragToEffectRow(this, docContext, pointerPos)
};

LayerEffectRow.prototype.onMouseUp = function(_docContext, _unusedMode, _unusedView, _unusedModifier, _pointerPos) {
  this.dragStartPointer = null
};

LayerEffectRow.prototype.clearListSelection = function() {
  for (let listIdx = 0; listIdx < this.listItemEls.length; listIdx++) {
    removeClass(this.listItemEls[listIdx], "selected");
    if (this.rowLeadWidgets[listIdx] instanceof Checkbox) this.rowLeadWidgets[listIdx].setValue(false)
  }
};

LayerEffectRow.prototype.appendListItems = function(listContainerEl) {
  const onListItemClickBound = this.onListItemClick.bind(this);
  for (let listIdx = 0; listIdx < this.rowLeadWidgets.length; listIdx++) {
    const listItemEl = makeElement("div", "listitem effectrow");
    this.listItemEls.push(listItemEl);
    // The name takes the row's free width and elides; the duplicate / reorder
    // buttons keep a fixed gutter on the right so long names never run under them.
    const leadEl = makeElement("span", "effectrow-lead");
    if (listIdx > 0) leadEl.textContent = "\u2003";
    leadEl.appendChild(this.rowLeadWidgets[listIdx].el);
    listItemEl.appendChild(leadEl);
    if (LayerEffectDefs.singleSlotEffectKinds.indexOf(this.effectClassId) != -1) {
      appendSingleSlotListButtons(listItemEl)
    }
    listItemEl.addEventListener("click", onListItemClickBound, false);
    listContainerEl.appendChild(listItemEl)
  }
};

LayerEffectRow.pointerYRatioInElement = function(pointerEvt, elementEl) {
  const bounds = elementEl.getBoundingClientRect();
  return (pointerEvt.clientY - bounds.top) / bounds.height
};

LayerEffectRow.prototype.onListItemClick = function(clickEvt) {
  const tagName = clickEvt.target.tagName.toLowerCase();
  if (tagName == "input") return;
  // The row's action buttons hold an icon, so the click can land on the <img>.
  const actionButtonEl = clickEvt.target.closest("button");
  if (actionButtonEl) {
    dispatchSingleSlotListAction(this, clickEvt, actionButtonEl);
    return
  }
  cancel(clickEvt);
  this.enableEffectOnSelect();
  this.selectedListIndex = this.listItemEls.indexOf(clickEvt.currentTarget);
  this.dispatch(new AppEvent("showme"))
};

LayerEffectRow.prototype.enableEffectOnSelect = function() {
  if (this.widgets.enab && this.widgets.enab.getValue() == false) {
    this.applyEvent({
      descriptorKey: "enab",
      value: true
    })
  }
};

LayerEffectRow.prototype.mountSelectedSection = function() {
  const selectedListItem = this.listItemEls[this.selectedListIndex];
  if (selectedListItem) addClass(selectedListItem, "selected");
  return this.sectionContainerEls[this.selectedListIndex]
};

LayerEffectRow.prototype.buildWidgetsFromFieldList = function(fieldList) {
  const widgetsByKey = {};
  for (let fieldIdx = 0; fieldIdx < fieldList.length; fieldIdx++) {
    const fieldKey = fieldList[fieldIdx],
      widget = createEffectFieldWidget(this.effectClassId, fieldKey, widgetsByKey);
    const widgetMapKey = fieldKey == "----" || fieldKey == "\n" ? fieldKey + fieldIdx : fieldKey;
    if (widget != null) widgetsByKey[widgetMapKey] = widget
  }
  return widgetsByKey
};

LayerEffectRow.prototype.removeFieldWidgetsFromSection = function(fieldKeys) {
  const sectionEl = this.sectionContainerEls[this.selectedListIndex];
  for (let fieldIdx = 0; fieldIdx < fieldKeys.length; fieldIdx++) {
    const widget = this.widgets[fieldKeys[fieldIdx]];
    if (widget && sectionEl.contains(widget.el)) sectionEl.removeChild(widget.el)
  }
};

LayerEffectRow.prototype.appendFieldWidgetsToSection = function(fieldKeys) {
  const sectionEl = this.sectionContainerEls[this.selectedListIndex];
  for (let fieldIdx = 0; fieldIdx < fieldKeys.length; fieldIdx++) {
    const widget = this.widgets[fieldKeys[fieldIdx]];
    if (widget && !sectionEl.contains(widget.el)) sectionEl.appendChild(widget.el)
  }
};

LayerEffectRow.prototype.onUpdate = function(appData, popupType) {
  if (this.widgets == null) return;
  const refreshAll = popupType == PopupTypes.ALL;
  refreshPresetPickers(this.widgets, appData, popupType, refreshAll)
};

LayerEffectRow.prototype.buildUI = function() {
  for (let labelIdx = 0; labelIdx < this.sectionLabelWidgets.length; labelIdx++) {
    this.sectionLabelWidgets[labelIdx].buildUI()
  }
  for (const widgetKey in this.widgets) {
    if (this.widgets[widgetKey] instanceof BaseWidget) this.widgets[widgetKey].buildUI()
  }
};

LayerEffectRow.prototype.buildWidgetRows = function() {
  for (const widgetKey in this.widgets) {
    const widget = this.widgets[widgetKey];
    widget.parent = this;
    if (widget instanceof BaseWidget) widget.on(EventType.widgetSelect, this.onWidgetValueChange, this);
    if (this.sectionContainerEls.length == 0 || widgetKey == "useShape" || widgetKey == "useTexture") {
      const sectionLabel = new Label(widget.getLabelKey()),
        sectionContainer = makeElement("div", "bordered padded");
      if (this.isInlineForm == false) {
        sectionContainer.appendChild(sectionLabel.el);
        sectionContainer.appendChild(makeElement("hr", ""))
      }
      this.sectionLabelWidgets.push(sectionLabel);
      this.sectionContainerEls.push(sectionContainer);
      this.rowLeadWidgets.push(widget)
    } else {
      this.sectionContainerEls[this.sectionContainerEls.length - 1].appendChild(widget.el)
    }
  }
};

LayerEffectRow.prototype.update = function(docContext, effectDescriptor) {
  if (this.widgets == null) return;
  this.effectDescriptor = JSON.parse(JSON.stringify(effectDescriptor));
  for (const fieldKey in effectDescriptor) {
    syncDescriptorFieldToWidgets(this, docContext, fieldKey, effectDescriptor)
  }
};

LayerEffectRow.prototype.onWidgetValueChange = function(widgetEvt) {
  for (const fieldKey in this.widgets) {
    if (this.widgets[fieldKey] != widgetEvt.target) continue;
    const { wireValue, refreshSection } = buildWireValueFromWidget(fieldKey, widgetEvt.target);
    this.applyEvent({
      descriptorKey: fieldKey,
      value: wireValue
    });
    if (refreshSection) refreshEffectRowSection(this)
  }
};

LayerEffectRow.prototype.applyEvent = function(eventPayload) {
  if (this.effectDescriptor && this.effectDescriptor[eventPayload.descriptorKey]) {
    this.effectDescriptor[eventPayload.descriptorKey].v = eventPayload.value
  }
  if (this.isInlineForm) {
    this.dispatch(new AppEvent(EventType.widgetSelect))
  } else {
    dispatchLayerStylePropertyChange(this, eventPayload)
  }
};

LayerEffectRow.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.effectDescriptor))
};

LayerEffectRow.fieldListsByEffectClass = {
  bops: "blOptions lrMd Opct ---- iOpa brst ---- blIf".split(" "),
  DrSh: "enab Md Clr Opct lagl uglg Dstn Ckmt blur TrnS Nose layerConceals".split(" "),
  IrSh: "enab Md Clr Opct lagl uglg Dstn Ckmt blur TrnS Nose".split(" "),
  OrGl: ["enab", "Md", "Opct", "Nose", "\n", "Clr", "Grad", "----", "GlwT", "Ckmt", "blur", "TrnS", "Inpr", "ShdN"],
  IrGl: ["enab", "Md", "Opct", "Nose", "\n", "Clr", "Grad", "----", "GlwT", "glwS", "Ckmt", "blur", "TrnS", "Inpr", "ShdN"],
  ebbl: ["enab", "bvlS", "bvlT", "bvlD", "srgR", "blur", "Sftn", "----", "lagl", "Lald", "uglg", "TrnS", "\n", "hglM", "hglC", "hglO", "sdwM", "sdwC", "sdwO", "useShape", "MpgS", "Inpr", "useTexture", "Ptrn", "Scl", "textureDepth", "InvT", "Algn", "phase"],
  SoFi: ["enab", "Md", "Opct"].concat(LayerEffectDefs.solidFillPropertyKeys),
  GrFl: ["enab", "Md", "Opct"].concat(LayerEffectDefs.gradientOverlayPropertyKeys),
  patternFill: ["enab", "Md", "Opct"].concat(LayerEffectDefs.patternOverlayPropertyKeys),
  ChFX: "enab Md Clr Opct lagl Dstn blur MpgS Invr".split(" "),
  FrFX: ["enab", "Sz", "Styl", "\n", "Md", "Opct", "PntT", "\n"].concat(LayerEffectDefs.fillPropertyKeyGroups.flat())
};

export { LayerEffectRow };

// ---------------------------------------------------------------------------
// Pointer drag
// ---------------------------------------------------------------------------

function applyPointerDragToEffectRow(row, docContext, pointerPos) {
  const dragStartPointer = row.dragStartPointer,
    effectClassId = row.effectClassId,
    dragStartDescriptor = row.dragStartDescriptor;
  if (dragStartPointer == null) return;
  const deltaXDoc = (pointerPos.x - dragStartPointer.x) / docContext.pathViewport.zoomScale,
    deltaYDoc = (pointerPos.y - dragStartPointer.y) / docContext.pathViewport.zoomScale;
  if (effectClassId == "GrFl") {
    const offsetDesc = JSON.parse(JSON.stringify(dragStartDescriptor.Ofst.v));
    offsetDesc.Hrzn.v.val += deltaXDoc * .5;
    offsetDesc.Vrtc.v.val += deltaYDoc * .5;
    row.widgets.Ofst.setValue(offsetDesc, true)
  }
  if (effectClassId == "patternFill") {
    const phaseDesc = JSON.parse(JSON.stringify(dragStartDescriptor.phase.v));
    phaseDesc.Hrzn.v += deltaXDoc;
    phaseDesc.Vrtc.v += deltaYDoc;
    row.widgets.phase.setValue(phaseDesc, true)
  }
  if (SHADOW_DRAG_EFFECT_CLASS_IDS.indexOf(effectClassId) != -1) {
    const distanceVal = dragStartDescriptor.Dstn.v.val,
      angleRad = row.dragStartAngleValue.oc * Math.PI / 180,
      offsetX = -Math.cos(angleRad) * distanceVal + deltaXDoc,
      offsetY = Math.sin(angleRad) * distanceVal + deltaYDoc;
    row.widgets.Dstn.setValue(Math.sqrt(offsetX * offsetX + offsetY * offsetY), true);
    row.widgets.lagl.setValue(Math.atan2(offsetY, -offsetX) * 180 / Math.PI, null, true)
  }
}

// ---------------------------------------------------------------------------
// List actions
// ---------------------------------------------------------------------------

function appendSingleSlotListButtons(listItemEl) {
  const actionsEl = makeElement("span", "effectrow-actions");
  const reorderButton = new Button(
    iconImgHtml("ui/reorder", "", "autoscale"), false, "properties.reorderEffect");
  addClass(reorderButton.el, "effectrow-reorder");
  actionsEl.appendChild(reorderButton.el);
  const addButton = new Button(
    iconImgHtml("ui/plus", "", "autoscale"), false, "properties.duplicateEffect");
  addClass(addButton.el, "effectrow-add");
  actionsEl.appendChild(addButton.el);
  listItemEl.appendChild(actionsEl)
}

function dispatchSingleSlotListAction(row, clickEvt, actionButtonEl) {
  const isAddButton = actionButtonEl.getAttribute("class").indexOf("effectrow-add") != -1,
    moveDirection = isAddButton ? 0 : LayerEffectRow.pointerYRatioInElement(clickEvt, actionButtonEl) < .5 ? -1 : 1,
    docActionEvt = new AppEvent(EventType.documentAction, true);
  if (isAddButton) {
    docActionEvt.data = {
      actionKind: "st_dupsingle",
      layerIndex: row.parent.data.layerIndex,
      effectPathIndices: row.effectPathIndices
    }
  } else {
    docActionEvt.data = {
      actionKind: "st_movsingle",
      layerIndex: row.parent.data.layerIndex,
      effectPathIndices: row.effectPathIndices,
      moveDelta: moveDirection
    }
  }
  docActionEvt.routingChannel = EventChannel.EVENT_PLUGIN;
  docActionEvt.fromDialog = true;
  row.dispatch(docActionEvt);
  const redrawEvt = new AppEvent("redrawall", true);
  redrawEvt.data = { moveDelta: moveDirection };
  row.dispatch(redrawEvt)
}

// ---------------------------------------------------------------------------
// Widget factory
// ---------------------------------------------------------------------------

function createEffectFieldWidget(effectClassId, fieldKey, widgetsByKey) {
  if (fieldKey == "----") return { el: makeElement("hr") };
  if (fieldKey == "\n") return { el: makeElement("br") };
  if (fieldKey == "blOptions") return new Label("layerEffects.blendingOptions");
  if (fieldKey == "brst") return new RadioOption("properties.channels", ["R", "G", "B"]);
  if (fieldKey == "knko") return new Dropdown("Knockout", ["colour.labels.none", "Shallow", "Deep"]);
  if (fieldKey == "enab") return new Checkbox(LayerEffectDefs.names[LayerEffectDefs.order.indexOf(effectClassId)]);
  if (fieldKey == "lrMd" || fieldKey == "Md") {
    return new Dropdown("properties.blendMode", BlendModes.uiLabels, false, BlendModes.groupSizes)
  }
  if (fieldKey == "Opct") return new RangeInput("properties.opacity", 0, 100, "%");
  if (fieldKey == "iOpa") return new RangeInput("properties.fill", 0, 100, "%");
  if (fieldKey == "blIf") return new ModeDropdown();
  if (fieldKey == "ShdN") return new RangeInput("properties.jitter", 0, 100, "%");
  if (fieldKey == "lagl" || fieldKey == "Angl") return new DrawingCanvas("properties.angle");
  if (fieldKey == "uglg") return new Checkbox("properties.useGlobalAngle");
  if (fieldKey == "Dstn") return new RangeInput("properties.distance", 0, 200, "px");
  if (fieldKey == "Ckmt") return new RangeInput("properties.spread", 0, 100, "%");
  if (fieldKey == "blur") return new RangeInput("properties.size.title", 0, 200, "px");
  if (fieldKey == "TrnS" || fieldKey == "MpgS") return new ContourButton("properties.contour");
  if (fieldKey == "Nose") return new RangeInput("properties.noise", 0, 100, "%");
  if (fieldKey == "layerConceals") return new Checkbox("properties.knockOutDropShadow");
  if (fieldKey == "AntA" || fieldKey == "antialiasGloss") return new Checkbox("Anti-alias");
  if (fieldKey == "GlwT") return new Dropdown("properties.technique", LayerEffectDefs.glowTechniqueOptions.names);
  if (fieldKey == "glwS") return new Dropdown("properties.source", LayerEffectDefs.glowTechniqueOptions.sourceLabels);
  if (fieldKey == "Inpr") return new RangeInput("properties.range", 1, 100, "%");
  if (fieldKey == "bvlS") return new Dropdown("properties.style", LayerEffectDefs.bevelStyleOptions.style);
  if (fieldKey == "bvlT") return new Dropdown("properties.technique", LayerEffectDefs.bevelStyleOptions.techniqueLabels);
  if (fieldKey == "bvlD") return new Dropdown(null, LayerEffectDefs.bevelStyleOptions.dir);
  if (fieldKey == "srgR") return new RangeInput("properties.depth", 0, 1e3, "%");
  if (fieldKey == "Sftn") return new RangeInput("properties.soften", 0, 20, "px");
  if (fieldKey == "Lald") return widgetsByKey.lagl;
  if (fieldKey == "hglM" || fieldKey == "sdwM") {
    return new Dropdown("properties.mode", BlendModes.uiLabels, false, BlendModes.groupSizes)
  }
  if (fieldKey == "hglC" || fieldKey == "sdwC") return new ColorSampleWidget();
  if (fieldKey == "hglO" || fieldKey == "sdwO") return new RangeInput("properties.opacity", 0, 100, "%");
  if (fieldKey == "Invr" || fieldKey == "InvT") return new Checkbox("adjustments.invert");
  if (fieldKey == "Sz") return new RangeInput("properties.size.title", 1, 200, "px");
  if (fieldKey == "Styl") return new Dropdown("properties.position", LayerEffectDefs.strokePositionOptions.names);
  if (fieldKey == "PntT") return new Dropdown("properties.fillType", LayerEffectDefs.strokePositionOptions.fillKindLabels);
  if (fieldKey == "Clr") return new ColorSampleWidget(true);
  if (fieldKey == "Grad") {
    const widget = new GradientPickerButton(true, "properties.gradient", true);
    widget.setValue(LayerEffectDefs.descriptorTemplates.twoColorGradient.v);
    return widget
  }
  if (fieldKey == "Rvrs") return new Checkbox("properties.reverse");
  if (fieldKey == "Dthr") return new Checkbox("Dither");
  if (fieldKey == "Type") {
    return new Dropdown(
      "properties.style",
      LayerEffectDefs.gradientTypeOptions.names.slice(0, effectClassId == "FrFX" ? 6 : 5)
    )
  }
  if (fieldKey == "Ptrn") return new PatternPickerButton("properties.pattern");
  if (fieldKey == "Scl") return new RangeInput("properties.scale", 10, 500, "%", 0, true);
  if (fieldKey == "Algn") return new Checkbox("properties.alignWithLayer");
  if (fieldKey == "Ofst") return new ShadowOffsetWidget(true);
  if (fieldKey == "phase") return new ShadowOffsetWidget(false);
  if (fieldKey == "useShape") return new Checkbox("properties.contour");
  if (fieldKey == "useTexture") return new Checkbox("filters.gallery.groups.texture");
  if (fieldKey == "textureDepth") return new RangeInput("properties.depth", -300, 300, "%");
  return null
}

// ---------------------------------------------------------------------------
// Descriptor ↔ widget sync
// ---------------------------------------------------------------------------

function refreshPresetPickers(widgets, appData, popupType, refreshAll) {
  if (widgets.Grad) {
    widgets.Grad.setContextColors(appData.colorInt, appData.bgColor);
    if (refreshAll || popupType == PopupTypes.COLOR_CHANGE || popupType == PopupTypes.GRADIENTS) {
      widgets.Grad.setPresets(appData.gradientPresets)
    }
  }
  if (widgets.Ptrn && (refreshAll || popupType == PopupTypes.PATTERNS)) {
    widgets.Ptrn.setPresets(appData.patternPresets)
  }
  if (widgets.TrnS && (refreshAll || popupType == PopupTypes.CONTOURS)) {
    widgets.TrnS.setPresets(appData.contourPresets)
  }
  if (widgets.MpgS && (refreshAll || popupType == PopupTypes.CONTOURS)) {
    widgets.MpgS.setPresets(appData.contourPresets)
  }
}

function syncDescriptorFieldToWidgets(row, docContext, fieldKey, effectDescriptor) {
  if (PERCENT_SCALAR_KEYS.indexOf(fieldKey) != -1) {
    row.widgets[fieldKey].setValue(effectDescriptor[fieldKey].v.val)
  }
  if (NESTED_DESCRIPTOR_KEYS.indexOf(fieldKey) != -1) {
    row.widgets[fieldKey].setValue(effectDescriptor[fieldKey].v, docContext)
  }
  if (["Md", "hglM", "sdwM"].indexOf(fieldKey) != -1) {
    row.widgets[fieldKey].setValue(BlendModes.psdNames.indexOf(effectDescriptor[fieldKey].v.blendMode))
  }
  if (fieldKey == "lrMd") {
    const blendLabels = (effectDescriptor.isGroup ? ["brushAndMessages.blendModes.passThrough"] : []).concat(
        BlendModes.uiLabels
      ),
      groupSizes = (effectDescriptor.isGroup ? [1] : []).concat(BlendModes.groupSizes);
    row.widgets[fieldKey].setItems(blendLabels, groupSizes);
    row.widgets[fieldKey].setValue(effectDescriptor[fieldKey].v)
  }
  if (fieldKey == "lagl") {
    const angleVal =
      effectDescriptor.uglg && effectDescriptor.uglg.v ? docContext.getRotationAngle() : effectDescriptor.lagl.v.val;
    row.widgets[fieldKey].setValue(angleVal)
  }
  if (fieldKey == "Lald") {
    const lightAngle =
      effectDescriptor.uglg && effectDescriptor.uglg.v
        ? docContext.getGlobalLightAngle()
        : effectDescriptor.Lald.v.val;
    row.widgets[fieldKey].setValue(null, lightAngle)
  }
  if (fieldKey == "Type") {
    row.widgets[fieldKey].setValue(LayerEffectDefs.gradientTypeOptions.types.indexOf(effectDescriptor.Type.v.GrdT))
  }
  if (fieldKey == "Styl") {
    row.widgets[fieldKey].setValue(LayerEffectDefs.strokePositionOptions.types.indexOf(effectDescriptor.Styl.v.FStl))
  }
  if (fieldKey == "PntT") {
    const fillTypeIdx = LayerEffectDefs.strokePositionOptions.fillKinds.indexOf(effectDescriptor.PntT.v.FrFl);
    row.widgets[fieldKey].setValue(fillTypeIdx);
    if (!row.isInlineForm) {
      row.removeFieldWidgetsFromSection(LayerEffectDefs.fillPropertyKeyGroups.flat());
      row.appendFieldWidgetsToSection(LayerEffectDefs.fillPropertyKeyGroups[fillTypeIdx])
    }
  }
  if (fieldKey == "GlwT") {
    row.widgets[fieldKey].setValue(LayerEffectDefs.glowTechniqueOptions.types.indexOf(effectDescriptor.GlwT.v.BETE))
  }
  if (fieldKey == "glwS") {
    row.widgets[fieldKey].setValue(LayerEffectDefs.glowTechniqueOptions.sourceTypes.indexOf(effectDescriptor.glwS.v.IGSr))
  }
  if (fieldKey == "bvlS") {
    row.widgets[fieldKey].setValue(LayerEffectDefs.bevelStyleOptions.types.indexOf(effectDescriptor.bvlS.v.BESl))
  }
  if (fieldKey == "bvlT") {
    row.widgets[fieldKey].setValue(LayerEffectDefs.bevelStyleOptions.techniqueTypes.indexOf(effectDescriptor.bvlT.v.bvlT))
  }
  if (fieldKey == "bvlD") {
    row.widgets[fieldKey].setValue(["In", "Out"].indexOf(effectDescriptor.bvlD.v.BESs))
  }
}

function buildWireValueFromWidget(fieldKey, widget) {
  let wireValue = null,
    refreshSection = false;
  if ("Opct iOpa hglO Nose Scl sdwO Inpr srgR textureDepth ShdN".split(" ").indexOf(fieldKey) != -1) {
    wireValue = { type: "#Prc", val: widget.getValue() }
  }
  if (["Dstn", "Ckmt", "blur", "Sz", "Sftn"].indexOf(fieldKey) != -1) {
    wireValue = { type: "#Pxl", val: widget.getValue() }
  }
  if (["Angl", "lagl"].indexOf(fieldKey) != -1) {
    wireValue = { type: "#Ang", val: widget.getValue().oc }
  }
  if (
    "enab brst knko Clr hglC sdwC Grad TrnS MpgS Rvrs Dthr Algn Invr InvT Ptrn layerConceals lrMd useShape useTexture AntA antialiasGloss Ofst phase blIf".split(
      " "
    ).indexOf(fieldKey) != -1
  ) {
    wireValue = widget.getValue()
  }
  if (["Md", "hglM", "sdwM"].indexOf(fieldKey) != -1) {
    wireValue = { blendMode: BlendModes.psdNames[widget.getValue()] }
  }
  if (fieldKey == "uglg") {
    wireValue = widget.getValue();
    refreshSection = true
  }
  if (fieldKey == "PntT") {
    wireValue = { FrFl: LayerEffectDefs.strokePositionOptions.fillKinds[widget.getValue()] };
    refreshSection = true
  }
  if (fieldKey == "Lald") wireValue = { type: "#Ang", val: widget.getValue().alt };
  if (fieldKey == "Type") wireValue = { GrdT: LayerEffectDefs.gradientTypeOptions.types[widget.getValue()] };
  if (fieldKey == "Styl") wireValue = { FStl: LayerEffectDefs.strokePositionOptions.types[widget.getValue()] };
  if (fieldKey == "GlwT") wireValue = { BETE: LayerEffectDefs.glowTechniqueOptions.types[widget.getValue()] };
  if (fieldKey == "glwS") wireValue = { IGSr: LayerEffectDefs.glowTechniqueOptions.sourceTypes[widget.getValue()] };
  if (fieldKey == "bvlS") wireValue = { BESl: LayerEffectDefs.bevelStyleOptions.types[widget.getValue()] };
  if (fieldKey == "bvlT") wireValue = { bvlT: LayerEffectDefs.bevelStyleOptions.techniqueTypes[widget.getValue()] };
  if (fieldKey == "bvlD") wireValue = { BESs: ["In", "Out"][widget.getValue()] };
  return { wireValue, refreshSection }
}

function refreshEffectRowSection(row) {
  if (row.isInlineForm) {
    row.update(null, row.effectDescriptor)
  } else {
    const parentWidget = row.parent,
      docView = parentWidget.hostDocument,
      pathIndices = row.effectPathIndices,
      nestedDescriptor = docView.layers[parentWidget.data.layerIndex].add.lmfx[LayerEffectDefs.effectKeys[pathIndices[0]]].v[
        pathIndices[1]
      ].v;
    row.update(docView, nestedDescriptor)
  }
}

function dispatchLayerStylePropertyChange(row, eventPayload) {
  eventPayload.actionKind = "changeprop";
  eventPayload.layerIndex = row.parent.data.layerIndex;
  eventPayload.idx = row.effectPathIndices;
  const docActionEvt = new AppEvent(EventType.documentAction, true);
  docActionEvt.data = eventPayload;
  docActionEvt.routingChannel = EventChannel.EVENT_PLUGIN;
  docActionEvt.fromDialog = true;
  row.dispatch(docActionEvt);
  row.dispatch(new AppEvent("afterchange", true))
}
