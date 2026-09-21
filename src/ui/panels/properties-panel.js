/**
 * Properties sidebar panel. Shows a tabbed set of property forms for the active
 * selection, choosing the tab automatically from what is selected:
 *
 *   Layer  (LayerSectionForm) — adjustment sliders, solid/gradient/pattern fill
 *                               controls, and artboard size/background fields.
 *   Mask   (MaskSectionForm)  — raster/vector/filter mask density, feather, and
 *                               invert, with sub-tabs for whichever masks exist.
 *   Shape  (ShapeSectionForm) — live-shape bounds (W/H/X/Y) and corner radii.
 *
 * Editing a field dispatches a documentAction back to the model. Short keys such
 * as SoCo, GdFl, PtFl, artb, vmsk, vogk, and Clr are PSD descriptor wire keys,
 * not identifiers to rename. The payload's `value` slot is an app key, not a
 * wire key.
 */

import { Rect } from "../../core/math/rect.js";
import { Locale } from "../../core/i18n/locale.js";

import { EventChannel } from "../../document/model/tool-base.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { Layer } from "../../document/model/layer.js"
import { PopupTypes } from "../config/popup-types.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { BaseTool } from "../widgets/base-tool.js";
import { Button, Checkbox, Label } from "../widgets/form-controls.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { SliderDropdown, TextRangeInput } from "../widgets/controls/number-inputs.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { LayerEffectRow } from "./layer-effect-row.js";
import { FilterParameterPanel } from "../filter-panels/filter-parameter-panel.js";
import { adjustmentKeyOf } from "../../document/formats/psd/adjustment-parsers.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, appendBreak, isInDOM, makeElement, removeClass, setWidthHeightLabels } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { computeHistogram } from "../../engine/compositing/pixel-ops.js";
import { aggregateKeyOriginBounds } from "../../engine/compositing/key-origins.js";

const GRADIENT_FILL_WIDGET_KEYS = "Grad Rvrs Type Algn Angl Dthr Scl Ofst".split(" ");
const PATTERN_FILL_WIDGET_KEYS = ["Ptrn", "Scl", "Algn", "phase"];
const ARTBOARD_DIMENSION_LABELS = ["W", "H", "X", "Y"];
const SHAPE_BOUNDS_LABELS = ["W", "H", "X", "Y"];
const SHAPE_CORNER_LABELS = ["\u250F", "\u2513", "\u2517", "\u251B"];

/**
 * Scan path layers for a live shape (vogk entry with keyOriginType, not invalidated).
 * @param {object|null} doc
 * @returns {{ hasLiveShape: boolean, liveShapeLayerIndex: number }}
 */
function detectLiveShapeLayer(doc) {
  if (doc == null) return { hasLiveShape: false, liveShapeLayerIndex: -1 };
  const pathLists = doc.getPaths(),
    layersWithPaths = pathLists[0],
    pathIndices = pathLists[1];
  if (pathIndices.length == 0) return { hasLiveShape: false, liveShapeLayerIndex: -1 };
  const pathLayer = layersWithPaths[pathIndices[0]],
    vogkList = pathLayer.add.vogk;
  if (!vogkList) return { hasLiveShape: false, liveShapeLayerIndex: -1 };
  for (let vogkIdx = 0; vogkIdx < vogkList.length; vogkIdx++) {
    const vogkEntry = vogkList[vogkIdx].v,
      invalidatedFlag = vogkEntry.keyShapeInvalidated;
    if (invalidatedFlag && invalidatedFlag.v || vogkEntry.keyOriginType == null) continue;
    return { hasLiveShape: true, liveShapeLayerIndex: pathLayer.idx };
  }
  return { hasLiveShape: false, liveShapeLayerIndex: -1 }
}

/**
 * Which properties tab to show for the current layer selection.
 * @param {object} activeLayer
 * @param {boolean} hasLiveShape
 * @returns {number} 0 layer, 1 mask, 2 live shape
 */
function resolvePropertiesSectionIndex(activeLayer, hasLiveShape) {
  if (hasLiveShape) return 2;
  if (activeLayer.pixelContent < 1 && !activeLayer.pathLayerActive) return 0;
  return 1
}

/**
 * Pick the visible content block and section title for LayerSectionForm.open.
 * @param {object} form LayerSectionForm instance
 * @param {object} layer
 * @param {object} doc
 * @param {string} defaultTitle Locale title when no specialized block matches
 * @returns {{ visibleBlock: (HTMLElement|null), sectionTitle: string }}
 */
function resolveVisibleLayerContentBlock(form, layer, doc, defaultTitle) {
  let sectionTitle = defaultTitle,
    visibleBlock = null;
  const adjTypeKey = adjustmentKeyOf(layer.add);
  if (adjTypeKey != null && form.adjustmentWidgetByType[adjTypeKey] != null) {
    visibleBlock = form.adjustmentWidgetByType[adjTypeKey].el;
    form.activeAdjustmentWidget = form.adjustmentWidgetByType[adjTypeKey];
    form.adjustmentWidgetByType[adjTypeKey].setValue(layer.add[adjTypeKey]);
    if (doc.selectedLayerIndices[0] != form.lastLayerId) {
      const rasterBelow = doc.getRasterData(doc.selectedLayerIndices[0] - 1);
      form.layerHistogram = computeHistogram(rasterBelow)
    }
    form.adjustmentWidgetByType[adjTypeKey].setChannelHistograms(form.layerHistogram);
    sectionTitle = Locale.get(AdjustmentEngine.names[adjTypeKey])
  }
  if (layer.add.SoCo) {
    visibleBlock = form.solidColorBlock;
    form.solidColorPicker.setValue(layer.add.SoCo.Clr.v);
    sectionTitle = Locale.get("layer.newFillLayer.colourFill")
  }
  if (layer.add.GdFl) {
    visibleBlock = form.gradientControlsBlock;
    form.gradientFillRow.update(doc, layer.add.GdFl);
    sectionTitle = Locale.get("layer.newFillLayer.gradientFill")
  }
  if (layer.add.PtFl) {
    visibleBlock = form.patternControlsBlock;
    form.patternFillRow.update(doc, layer.add.PtFl);
    sectionTitle = Locale.get("layer.newFillLayer.patternFill")
  }
  if (layer.add.artb) {
    const artboardDesc = layer.add.artb,
      artboardRect = layer.getArtboardRect();
    visibleBlock = form.artboardBlock;
    form.artboardBackgroundDropdown.setValue(artboardDesc.artboardBackgroundType.v - 1);
    if (artboardDesc.Clr) form.artboardBackgroundColor.setValue(artboardDesc.Clr.v);
    PropertiesPanel.setDimensionValues(form.artboardDimensionFields, [
      artboardRect.width, artboardRect.height, artboardRect.x, artboardRect.y
    ]);
    sectionTitle = "Artboard"
  }
  return { visibleBlock: visibleBlock, sectionTitle: sectionTitle }
}

/**
 * Resolve which mask tab is active for MaskSectionForm.rebuild.
 * @param {object} layer
 * @param {object} doc
 * @param {number|undefined|null} preferredMaskKind
 * @returns {number} mask kind 0/1/2, or -1 when none
 */
function resolveActiveMaskKind(layer, doc, preferredMaskKind) {
  const hasFilterMask = layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc).d != null,
    hasVectorMask = !!layer.add.vmsk,
    hasRasterMask = !!layer.getMask();
  let activeMaskKind = -1;
  if (hasFilterMask) activeMaskKind = 2;
  if (hasVectorMask) activeMaskKind = 1;
  if (hasRasterMask) activeMaskKind = 0;
  if (preferredMaskKind != null) activeMaskKind = preferredMaskKind;
  else if (layer.pathLayerActive) activeMaskKind = 1;
  else if (layer.pixelContent == 3) activeMaskKind = 2;
  else if (layer.pixelContent == 1) activeMaskKind = 0;
  return activeMaskKind
}

/**
 * Enable mask-type tabs that the layer actually supports.
 * @param {object} layer
 * @param {object} doc
 * @param {object[]} tabButtons
 */
function enableAvailableMaskTabs(layer, doc, tabButtons) {
  if (layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc).d != null) tabButtons[2].enable();
  if (layer.add.vmsk) tabButtons[1].enable();
  if (layer.getMask()) tabButtons[0].enable()
}

/**
 * Build artboard/shape bounds rect [x0,y0,x1,y1] from W/H/X/Y dims with optional aspect lock.
 * @param {number[]} boundsDims [W, H, X, Y]
 * @param {number} fieldIdx which field changed (0=W, 1=H)
 * @param {number} aspectRatio W/H
 * @param {boolean} keepAspectRatio
 * @returns {(number|null)[]}
 */
function buildShapeBoundsRect(boundsDims, fieldIdx, aspectRatio, keepAspectRatio) {
  const dims = boundsDims.slice();
  dims[0] = Math.max(1, dims[0]);
  dims[1] = Math.max(1, dims[1]);
  if (keepAspectRatio && fieldIdx == 0) dims[1] = dims[0] / aspectRatio;
  if (keepAspectRatio && fieldIdx == 1) dims[0] = dims[1] * aspectRatio;
  const boundsRect = [null, null, null, null];
  boundsRect[0] = dims[2];
  boundsRect[1] = dims[3];
  boundsRect[2] = boundsRect[0] + dims[0];
  boundsRect[3] = boundsRect[1] + dims[1];
  return boundsRect
}

/**
 * Build corner-radii payload for transformKeyOrigins (swaps indices 2/3).
 * @param {number[]} radiusValues four corner values from fields
 * @param {number} cornerFieldIdx which corner field changed
 * @param {boolean} sameRadii
 * @returns {(number|null)[]}
 */
function buildShapeCornerRadii(radiusValues, cornerFieldIdx, sameRadii) {
  const cornerRadii = [null, null, null, null];
  cornerRadii[cornerFieldIdx] = Math.max(0, radiusValues[cornerFieldIdx]);
  if (sameRadii)
    for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) cornerRadii[cornerIdx] = cornerRadii[cornerFieldIdx];
  const swappedRadius = cornerRadii[3];
  cornerRadii[3] = cornerRadii[2];
  cornerRadii[2] = swappedRadius;
  return cornerRadii
}

/**
 * Mount gradient and pattern LayerEffectRow widgets into control blocks.
 * @param {object} form LayerSectionForm
 */
function installLayerFillControls(form) {
  form.gradientFillRow = new LayerEffectRow("GrFl", true);
  form.gradientFillRow.parent = form;
  form.gradientFillRow.on(EventType.widgetSelect, form.onGradientChange, form);
  form.gradientControlsBlock = makeElement("div", "marged hiline");
  for (let widgetIdx = 0; widgetIdx < GRADIENT_FILL_WIDGET_KEYS.length; widgetIdx++) {
    const widgetEl = form.gradientFillRow.widgets[GRADIENT_FILL_WIDGET_KEYS[widgetIdx]].el;
    form.gradientControlsBlock.appendChild(widgetEl)
  }
  form.patternFillRow = new LayerEffectRow("patternFill", true);
  form.patternFillRow.parent = form;
  form.patternFillRow.on(EventType.widgetSelect, form.onPatternChange, form);
  form.patternControlsBlock = makeElement("div", "marged hiline");
  for (let widgetIdx = 0; widgetIdx < PATTERN_FILL_WIDGET_KEYS.length; widgetIdx++) {
    const widgetEl = form.patternFillRow.widgets[PATTERN_FILL_WIDGET_KEYS[widgetIdx]].el;
    form.patternControlsBlock.appendChild(widgetEl)
  }
}

/**
 * Properties sidebar: Layer / Mask / Live Shape tabs over the active document.
 * @constructor
 */
function PropertiesPanel() {
  BaseTool.call(this, "panels.properties", false, getIconUrl("panels/properties"), BaseTool.PanelId.PROPERTIES, true);
  this.previewDoc = null;
  this.doc = null;
  this.lastLayerIndex = -1
}
PropertiesPanel.prototype = Object.create(BaseTool.prototype);

PropertiesPanel.detectLiveShapeLayer = detectLiveShapeLayer;
PropertiesPanel.resolvePropertiesSectionIndex = resolvePropertiesSectionIndex;
PropertiesPanel.resolveVisibleLayerContentBlock = resolveVisibleLayerContentBlock;
PropertiesPanel.resolveActiveMaskKind = resolveActiveMaskKind;
PropertiesPanel.buildShapeBoundsRect = buildShapeBoundsRect;
PropertiesPanel.buildShapeCornerRadii = buildShapeCornerRadii;

PropertiesPanel.prototype.initDom = function() {
  this.propertiesRootEl = makeElement("div", "padded");
  this.propertiesRootEl.style.width = "22em";
  this.panelBody.appendChild(this.propertiesRootEl);
  const tabBarEl = makeElement("span", "fitem");
  this.propertiesRootEl.appendChild(tabBarEl);
  this.tabButtons = [new Button("topMenu.layer"), new Button("properties.mask"), new Button("properties.liveShape")];
  for (let tabIdx = 0; tabIdx < this.tabButtons.length; tabIdx++) {
    const tabButton = this.tabButtons[tabIdx];
    tabButton.on("click", this.onTabClick, this);
    tabBarEl.appendChild(tabButton.el)
  }
  this.propertiesRootEl.appendChild(makeElement("hr"));
  this.layerSection = new PropertiesPanel.LayerSectionForm();
  this.layerSection.parent = this;
  this.maskSection = new PropertiesPanel.MaskSectionForm();
  this.maskSection.parent = this;
  this.shapeSection = new PropertiesPanel.ShapeSectionForm();
  this.shapeSection.parent = this;
  this.sections = [this.layerSection, this.maskSection, this.shapeSection];
  this.propertiesRootEl.appendChild(this.layerSection.el)
};

PropertiesPanel.prototype.onTabClick = function(clickEvent) {
  const sectionIndex = this.tabButtons.indexOf(clickEvent.currentTarget);
  this.activateSection(sectionIndex);
  this.focusMaskChannel(sectionIndex == 1 ? this.maskSection.activeMaskKind : -1)
};

PropertiesPanel.prototype.activateSection = function(sectionIndex) {
  for (let tabIdx = 0; tabIdx < 3; tabIdx++) {
    this.tabButtons[tabIdx].clearActive();
    const sectionEl = this.sections[tabIdx].el;
    if (sectionEl.parentNode == this.propertiesRootEl && tabIdx != sectionIndex) this.propertiesRootEl.removeChild(sectionEl);
    if (sectionEl.parentNode != this.propertiesRootEl && tabIdx == sectionIndex) this.propertiesRootEl.appendChild(sectionEl)
  }
  this.tabButtons[sectionIndex].markActive()
};

PropertiesPanel.prototype.focusMaskChannel = function(maskKind) {
  const layerIndex = this.doc.selectedLayerIndices[0],
    layer = this.doc.layers[layerIndex],
    pixelContentKind = maskKind + 1;
  if (maskKind == 1 && layer.pathLayerActive) return;
  const docEvent = new AppEvent(EventType.documentAction, true);
  docEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  if (maskKind != 1 && layer.pathLayerActive) {
    docEvent.data = {
      actionKind: Layer.selectLayer,
      layerIndex: layerIndex,
      pixelContentKind: 2
    };
    this.dispatch(docEvent)
  }
  docEvent.data = {
    actionKind: Layer.selectLayer,
    layerIndex: layerIndex,
    pixelContentKind: pixelContentKind
  };
  this.dispatch(docEvent)
};

PropertiesPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  if (this.propertiesRootEl == null) return;
  this.open(this.doc);
  for (let tabIdx = 0; tabIdx < 3; tabIdx++) {
    this.tabButtons[tabIdx].buildUI();
    this.sections[tabIdx].buildUI()
  }
};

PropertiesPanel.prototype.refresh = function() {
  if (!isInDOM(this.panelBody)) return;
  if (this.propertiesRootEl == null) {
    this.initDom();
    this.onUpdate(this.doc, PopupTypes.ALL);
    this.open(this.previewDoc);
    this.buildUI()
  }
};

/**
 * Sync the panel to `doc`: refresh each section form, disable the panel when
 * there is no editable selection, and (when the document or active layer
 * changes) auto-select the tab that fits the selection. A detected live shape
 * redirects to its path layer and enables the Shape tab.
 */
PropertiesPanel.prototype.open = function(doc) {
  this.previewDoc = doc;
  if (this.propertiesRootEl == null) return;
  this.layerSection.open(doc);
  this.maskSection.open(doc);
  this.shapeSection.open(doc);
  if (doc == null || doc.selectedLayerIndices.length == 0 || doc.layers[doc.selectedLayerIndices[0]] == null) {
    addClass(this.panelBody, "disabled");
    this.doc = null;
    return
  } else removeClass(this.panelBody, "disabled");
  let activeLayerIndex = doc.selectedLayerIndices[0];
  const activeLayer = doc.layers[activeLayerIndex],
    liveShape = detectLiveShapeLayer(doc),
    hasLiveShape = liveShape.hasLiveShape;
  if (hasLiveShape) activeLayerIndex = liveShape.liveShapeLayerIndex;
  if (doc != this.doc || this.lastLayerIndex != activeLayerIndex) {
    this.doc = doc;
    this.lastLayerIndex = activeLayerIndex;
    this.activateSection(resolvePropertiesSectionIndex(activeLayer, hasLiveShape))
  }
  this.tabButtons[1].setEnabled(this.maskSection.activeMaskKind != -1);
  this.tabButtons[2].setEnabled(hasLiveShape)
};

PropertiesPanel.prototype.onUpdate = function(doc, popupType) {
  this.doc = doc;
  if (this.layerSection) this.layerSection.onUpdate(doc, popupType)
};

/**
 * Layer tab form. Holds one control block per layer kind — a widget for each
 * adjustment type, a solid-color picker, gradient and pattern fill rows, and
 * artboard dimension/background controls — and shows whichever block matches the
 * active layer. Only one block is mounted at a time.
 */
PropertiesPanel.LayerSectionForm = function() {
  BaseWidget.call(this);
  this.el = makeElement("div", "form");
  this.sectionTitleLabel = new Label("Hello");
  this.el.appendChild(this.sectionTitleLabel.el);
  this.visibleBlockEl = null;
  this.activeAdjustmentWidget = null;
  this.doc = null;
  this.lastLayerId = -1;
  this.layerHistogram = null;
  this.solidColorPicker = new ColorSampleWidget(true);
  this.solidColorPicker.parent = this;
  this.solidColorPicker.on(EventType.widgetSelect, this.onSolidColorChange, this);
  this.solidColorBlock = makeElement("div", "marged hiline");
  this.solidColorBlock.appendChild(this.solidColorPicker.el);
  installLayerFillControls(this);
  this.adjustmentWidgetByType = {};
  for (let adjTypeKey in AdjustmentEngine.names) {
    if (FilterParameterPanel[adjTypeKey] == null) continue;
    this.adjustmentWidgetByType[adjTypeKey] = new FilterParameterPanel[adjTypeKey]();
    this.adjustmentWidgetByType[adjTypeKey].on(EventType.widgetSelect, this.onAdjustmentWidgetChange, this);
    this.adjustmentWidgetByType[adjTypeKey].parent = this
  }
  const artboardBlockEl = this.artboardBlock = makeElement("div", "marged hiline");
  this.artboardDimensionFields = PropertiesPanel.createDimensionFields(
    ARTBOARD_DIMENSION_LABELS, null, artboardBlockEl, this.onArtboardFieldsChange, this
  );
  this.artboardBackgroundDropdown = new Dropdown("properties.background", [
    "colour.labels.white",
    "colour.labels.black",
    "colour.labels.transparent",
    "properties.custom"
  ]);
  this.artboardBackgroundDropdown.on(EventType.widgetSelect, this.onArtboardFieldsChange, this);
  artboardBlockEl.appendChild(this.artboardBackgroundDropdown.el);
  this.artboardBackgroundColor = new ColorSampleWidget(false);
  this.artboardBackgroundColor.parent = this;
  this.artboardBackgroundColor.on(EventType.widgetSelect, this.onArtboardFieldsChange, this);
  artboardBlockEl.appendChild(this.artboardBackgroundColor.el)
};
PropertiesPanel.LayerSectionForm.prototype = Object.create(BaseWidget.prototype);

PropertiesPanel.LayerSectionForm.prototype.buildUI = function() {
  for (let adjTypeKey in this.adjustmentWidgetByType) this.adjustmentWidgetByType[adjTypeKey].buildUI();
  this.gradientFillRow.buildUI();
  this.patternFillRow.buildUI();
  this.artboardBackgroundDropdown.buildUI();
  for (let fieldIdx = 0; fieldIdx < 4; fieldIdx++) this.artboardDimensionFields[fieldIdx].buildUI()
};

PropertiesPanel.LayerSectionForm.prototype.onArtboardFieldsChange = function() {
  const dimensions = PropertiesPanel.getDimensionValues(this.artboardDimensionFields),
    artboardRectDesc = Layer.rectToArtboardDescriptor(new Rect(dimensions[2], dimensions[3], dimensions[0], dimensions[1])),
    backgroundTypeIndex = this.artboardBackgroundDropdown.getValue(),
    artboardPayload = {
      classID: "artboard",
      artboardRect: {
        t: "Objc",
        v: artboardRectDesc
      },
      Clr: {
        t: "Objc",
        v: this.artboardBackgroundColor.getValue()
      },
      artboardBackgroundType: {
        t: "long",
        v: backgroundTypeIndex + 1
      }
    },
    docEvent = new AppEvent(EventType.documentAction, true);
  docEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  docEvent.data = {
    actionKind: Layer.editArtboard,
    artboardPayload: artboardPayload
  };
  this.dispatch(docEvent)
};

PropertiesPanel.LayerSectionForm.prototype.onSolidColorChange = function() {
  const doc = this.doc,
    layerIndex = doc.selectedLayerIndices[0];
  if (doc.layers[layerIndex].add.SoCo == null) return;
  const solidColorDesc = JSON.parse(JSON.stringify(doc.layers[layerIndex].add.SoCo));
  solidColorDesc.Clr.v = this.solidColorPicker.getValue();
  this.applyFillLayerChange({
    fillKind: 1,
    fillDescriptor: solidColorDesc
  })
};

PropertiesPanel.LayerSectionForm.prototype.onGradientChange = function() {
  const doc = this.doc,
    layerIndex = doc.selectedLayerIndices[0];
  if (doc.layers[layerIndex].add.GdFl == null) return;
  this.applyFillLayerChange({
    fillKind: 2,
    fillDescriptor: this.gradientFillRow.getValue()
  })
};

PropertiesPanel.LayerSectionForm.prototype.onPatternChange = function() {
  this.applyFillLayerChange({
    fillKind: 3,
    fillDescriptor: this.patternFillRow.getValue()
  })
};

PropertiesPanel.LayerSectionForm.prototype.applyFillLayerChange = function(fillChangePayload) {
  this.dispatchDocumentAction(EventChannel.EVENT_DOCUMENT, {
    actionKind: Layer.updateContentStyle,
    contentLayerIndices: [this.doc.selectedLayerIndices[0]],
    updateContentFill: true,
    contentStylePayload: fillChangePayload
  })
};

PropertiesPanel.LayerSectionForm.prototype.onAdjustmentWidgetChange = function() {
  this.dispatchDocumentAction(EventChannel.EVENT_ADJUSTMENT, {
    actionKind: "edit_layer",
    value: this.activeAdjustmentWidget.getValue()
  })
};

PropertiesPanel.LayerSectionForm.prototype.dispatchDocumentAction = function(routingChannel, actionData) {
  const docEvent = new AppEvent(EventType.documentAction, true);
  docEvent.routingChannel = routingChannel;
  docEvent.data = actionData;
  this.dispatch(docEvent)
};

PropertiesPanel.LayerSectionForm.prototype.open = function(doc) {
  let sectionTitle = Locale.get("topMenu.layer"),
    visibleBlock = null;
  this.doc = doc;
  if (doc && doc.layers.length > 0 && doc.selectedLayerIndices.length != 0 && doc.layers[doc.selectedLayerIndices[0]]) {
    const layer = doc.layers[doc.selectedLayerIndices[0]],
      resolved = resolveVisibleLayerContentBlock(this, layer, doc, sectionTitle);
    visibleBlock = resolved.visibleBlock;
    sectionTitle = resolved.sectionTitle;
    this.lastLayerId = doc.selectedLayerIndices[0]
  }
  if (visibleBlock != this.visibleBlockEl) {
    if (this.visibleBlockEl) this.el.removeChild(this.visibleBlockEl);
    if (visibleBlock != null) this.el.appendChild(visibleBlock);
    this.visibleBlockEl = visibleBlock
  }
  this.sectionTitleLabel.setValue(sectionTitle)
};

PropertiesPanel.LayerSectionForm.prototype.onUpdate = function(doc, popupType) {
  this.gradientFillRow.onUpdate(doc, popupType);
  this.patternFillRow.onUpdate(doc, popupType);
  for (let adjTypeKey in this.adjustmentWidgetByType) this.adjustmentWidgetByType[adjTypeKey].onUpdate(doc, popupType)
};

/**
 * Mask tab form. Sub-tabs select the raster (0), vector (1), or filter (2) mask;
 * only the masks that exist on the layer are enabled. Exposes density and
 * feather inputs and, for raster masks, an invert button.
 */
PropertiesPanel.MaskSectionForm = function() {
  BaseWidget.call(this);
  this.el = makeElement("div", "form");
  this.doc = null;
  this.activeMaskKind = 0;
  const tabBarEl = makeElement("span", "fitem");
  this.el.appendChild(tabBarEl);
  this.tabButtons = [new Button("layer.rasterMask"), new Button("layer.vectorMask"), new Button("layer.filterMask")];
  for (let tabIdx = 0; tabIdx < this.tabButtons.length; tabIdx++) {
    const tabButton = this.tabButtons[tabIdx];
    tabButton.on("click", this.onMaskTypeTabClick, this);
    tabBarEl.appendChild(tabButton.el)
  }
  this.densityInput = new TextRangeInput("properties.density", 0, 255);
  this.densityInput.on(EventType.widgetSelect, this.emitChange, this);
  this.el.appendChild(this.densityInput.el);
  this.featherInput = new TextRangeInput("select.feather", 0, 500, "px", 2, true);
  this.featherInput.on(EventType.widgetSelect, this.emitChange, this);
  this.el.appendChild(this.featherInput.el);
  this.invertButton = new Button("adjustments.invert", null, null, true);
  this.invertButton.on("click", this.onInvertClick, this)
};
PropertiesPanel.MaskSectionForm.prototype = Object.create(BaseWidget.prototype);

PropertiesPanel.MaskSectionForm.prototype.onInvertClick = function() {
  const docEvent = new AppEvent(EventType.documentAction, true);
  docEvent.routingChannel = EventChannel.EVENT_ADJUSTMENT;
  docEvent.data = {
    actionKind: "start",
    adjustmentKey: "nvrt"
  };
  this.dispatch(docEvent)
};

PropertiesPanel.MaskSectionForm.prototype.emitChange = function() {
  const density = this.densityInput.getValue(),
    feather = this.featherInput.getValue(),
    docEvent = new AppEvent(EventType.documentAction, true);
  docEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  docEvent.data = {
    actionKind: Layer.maskDensityFeather,
    layerIndex: this.doc.selectedLayerIndices[0],
    maskSettings: {
      maskType: this.activeMaskKind,
      density: density,
      feather: feather
    }
  };
  this.dispatch(docEvent)
};

PropertiesPanel.MaskSectionForm.prototype.buildUI = function() {
  for (let tabIdx = 0; tabIdx < this.tabButtons.length; tabIdx++) this.tabButtons[tabIdx].buildUI();
  this.densityInput.buildUI();
  this.featherInput.buildUI();
  this.invertButton.buildUI()
};

PropertiesPanel.MaskSectionForm.prototype.open = function(doc) {
  this.doc = doc;
  this.rebuild()
};

PropertiesPanel.MaskSectionForm.prototype.onMaskTypeTabClick = function(clickEvent) {
  this.rebuild(this.tabButtons.indexOf(clickEvent.currentTarget));
  this.parent.focusMaskChannel(this.activeMaskKind)
};

PropertiesPanel.MaskSectionForm.prototype.rebuild = function(preferredMaskKind) {
  const doc = this.doc,
    tabButtons = this.tabButtons;
  for (let tabIdx = 0; tabIdx < 3; tabIdx++) {
    const tabButton = tabButtons[tabIdx];
    tabButton.clearActive();
    tabButton.disable()
  }
  if (doc == null || doc.layers.length == 0 || doc.selectedLayerIndices.length == 0 || doc.layers[doc.selectedLayerIndices[0]] == null) return;
  const layer = doc.layers[doc.selectedLayerIndices[0]];
  enableAvailableMaskTabs(layer, doc, tabButtons);
  const activeMaskKind = resolveActiveMaskKind(layer, doc, preferredMaskKind);
  this.activeMaskKind = activeMaskKind;
  if (activeMaskKind == -1) {
    this.densityInput.disable();
    this.featherInput.disable();
    return
  }
  const maskSettings = layer.getMaskSettings(activeMaskKind);
  this.densityInput.enable();
  this.featherInput.enable();
  this.densityInput.setValue(maskSettings.density);
  this.featherInput.setValue(maskSettings.feather);
  tabButtons[activeMaskKind].markActive();
  const invertButtonEl = this.invertButton.el;
  if (activeMaskKind == 0) this.el.appendChild(invertButtonEl);
  else if (invertButtonEl.parentNode == this.el) this.el.removeChild(invertButtonEl)
};

/**
 * Live-shape tab form. Presents bounds fields (W/H/X/Y, with an aspect-ratio
 * lock) and four corner-radius fields (with a same-radii toggle); edits are
 * pushed back as key-origin transforms on the shape.
 */
PropertiesPanel.ShapeSectionForm = function() {
  BaseWidget.call(this);
  this.el = makeElement("div", "form");
  this.aspectRatio = 1;
  this.boundsFieldsContainer = makeElement("div");
  this.boundsFields = PropertiesPanel.createDimensionFields(
    SHAPE_BOUNDS_LABELS, "properties.keepAspectRatio", this.boundsFieldsContainer, this.onShapeDimensionChange, this
  );
  this.cornerRadiusContainer = makeElement("div");
  this.cornerRadiusFields = PropertiesPanel.createDimensionFields(
    SHAPE_CORNER_LABELS, "properties.sameRadii", this.cornerRadiusContainer, this.onShapeDimensionChange, this
  )
};
PropertiesPanel.ShapeSectionForm.prototype = Object.create(BaseWidget.prototype);

PropertiesPanel.ShapeSectionForm.prototype.buildUI = function() {
  setWidthHeightLabels(this.boundsFields[0], this.boundsFields[1]);
  for (let fieldIdx = 2; fieldIdx < 5; fieldIdx++) {
    this.boundsFields[fieldIdx].buildUI()
  }
  this.cornerRadiusFields[4].buildUI()
};

/**
 * Build four SliderDropdown fields (and optional same-radii checkbox) into containerEl.
 * @param {string[]} labelKeys
 * @param {string|null} sameRadiiCheckboxKey
 * @param {HTMLElement} containerEl
 * @param {Function} changeHandler
 * @param {object} changeContext
 * @returns {object[]}
 */
PropertiesPanel.createDimensionFields = function(labelKeys, sameRadiiCheckboxKey, containerEl, changeHandler, changeContext) {
  const fieldsListEl = makeElement("div", "numlist");
  containerEl.appendChild(fieldsListEl);
  const fields = [];
  for (let fieldIdx = 0; fieldIdx < 4; fieldIdx++) {
    const fieldInput = new SliderDropdown(labelKeys[fieldIdx], 0, 0, null, 1, false, true);
    fieldInput.on(EventType.widgetSelect, changeHandler, changeContext);
    fieldsListEl.appendChild(fieldInput.el);
    fields.push(fieldInput);
    if (fieldIdx == 1 || fieldIdx == 3) appendBreak(fieldsListEl)
  }
  if (sameRadiiCheckboxKey) {
    fields[4] = new Checkbox(sameRadiiCheckboxKey);
    fields[4].setValue(true);
    containerEl.appendChild(fields[4].el)
  }
  return fields
};

/** Write four numeric field values. */
PropertiesPanel.setDimensionValues = function(fields, values) {
  for (let fieldIdx = 0; fieldIdx < 4; fieldIdx++) fields[fieldIdx].setValue(values[fieldIdx])
};

/** Read four numeric field values. */
PropertiesPanel.getDimensionValues = function(fields) {
  const values = [];
  for (let fieldIdx = 0; fieldIdx < 4; fieldIdx++) values[fieldIdx] = fields[fieldIdx].getValue();
  return values
};

PropertiesPanel.ShapeSectionForm.prototype.onShapeDimensionChange = function(changeEvent) {
  const boundsFieldIdx = this.boundsFields.indexOf(changeEvent.currentTarget),
    cornerFieldIdx = this.cornerRadiusFields.indexOf(changeEvent.currentTarget);
  let boundsRect = [null, null, null, null],
    cornerRadii = [null, null, null, null];
  if (boundsFieldIdx != -1) {
    const boundsDims = PropertiesPanel.getDimensionValues(this.boundsFields),
      keepAspectRatio = this.boundsFields[4].getValue();
    boundsRect = buildShapeBoundsRect(boundsDims, boundsFieldIdx, this.aspectRatio, keepAspectRatio)
  }
  if (cornerFieldIdx != -1) {
    const radiusValues = PropertiesPanel.getDimensionValues(this.cornerRadiusFields);
    cornerRadii = buildShapeCornerRadii(
      radiusValues, cornerFieldIdx, this.cornerRadiusFields[4].getValue()
    )
  }
  const docEvent = new AppEvent(EventType.documentAction, true);
  docEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  docEvent.data = {
    actionKind: Layer.transformKeyOrigins,
    artboardBoundsRect: boundsRect,
    artboardCornerRadii: cornerRadii
  };
  this.dispatch(docEvent)
};

PropertiesPanel.ShapeSectionForm.prototype.open = function(doc) {
  if (doc == null) return;
  const boundsVisible = this.boundsFieldsContainer.parentNode != null,
    cornersVisible = this.cornerRadiusContainer.parentNode != null,
    keyOriginBounds = aggregateKeyOriginBounds(doc),
    boundsCoords = keyOriginBounds[0],
    cornerCoords = keyOriginBounds[1];
  if (boundsCoords) {
    if (!boundsVisible) this.el.appendChild(this.boundsFieldsContainer);
    this.aspectRatio = (boundsCoords[2] - boundsCoords[0]) / (boundsCoords[3] - boundsCoords[1]);
    PropertiesPanel.setDimensionValues(this.boundsFields, [
      boundsCoords[2] - boundsCoords[0],
      boundsCoords[3] - boundsCoords[1],
      boundsCoords[0],
      boundsCoords[1]
    ])
  } else if (boundsVisible) this.el.removeChild(this.boundsFieldsContainer);
  if (cornerCoords) {
    if (!cornersVisible) this.el.appendChild(this.cornerRadiusContainer);
    const swappedCorner = cornerCoords[2];
    cornerCoords[2] = cornerCoords[3];
    cornerCoords[3] = swappedCorner;
    PropertiesPanel.setDimensionValues(this.cornerRadiusFields, cornerCoords)
  } else if (cornersVisible) this.el.removeChild(this.cornerRadiusContainer)
};

export { PropertiesPanel };
