/**
 * Filter Gallery stack UI: per-filter param editors ({@link FilterParamWidget})
 * and the right-hand stack list ({@link FilterStackPanel}).
 *
 * Descriptor keys (`Sz`, `GEfk`, `GELv`, `TxtT`, …) are PSD / gallery wire names.
 */

import { Locale } from "../../core/i18n/locale.js";
import { GalleryFilterDefs } from "../../features/filters/gallery/gallery-filter-defs.js";
import { ChannelsPanel } from "../panels/channels-panel.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { LayerListItem } from "../widgets/layer-list-item.js";
import { Checkbox } from "../widgets/form-controls.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { TextRangeInput } from "../widgets/controls/number-inputs.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { EventType } from "../../core/event-bus.js";
import { appendBreak, clearElement, makeElement } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";

const GALLERY_DESCRIPTOR_SKIP_KEYS = {
  "__name": true,
  "classID": true,
  "GEfk": true,
  "GELv": true,
  "FlRs": true,
};

/** Menu label for each texture wire id. */
const TEXTURE_LABEL_BY_WIRE_ID = {
  TxBl: "filters.options.textureType.blocks",
  TxCa: "filters.options.textureType.canvas",
  TxFr: "filters.options.textureType.frosted",
  TxTL: "filters.options.textureType.tinyLens",
  TxBr: "filters.options.textureType.bricks",
  TxBu: "filters.options.textureType.burlap",
  TxSt: "filters.options.textureType.sandstone",
};

/**
 * Builds the control for one gallery filter parameter wire key.
 * @returns {BaseWidget|null}
 */
function createGalleryParamWidget(filterKey, paramKey) {
  if (paramKey == "Sz") return new TextRangeInput("properties.size.title", 1, 50);
  if (paramKey == "Dtl") {
    return filterKey == "Chrc"
      ? new TextRangeInput("filters.options.detail", 0, 5)
      : new TextRangeInput("filters.options.detail", 1, 15);
  }
  if (paramKey == "Shrp") return new TextRangeInput("filters.options.sharpness", 0, 40);
  if (paramKey == "TxtT") {
    const textureLabels = GalleryFilterDefs.textureWireIdsFor(filterKey)
      .map((wireId) => TEXTURE_LABEL_BY_WIRE_ID[wireId]);
    return new Dropdown("filters.gallery.groups.texture", textureLabels);
  }
  if (paramKey == "BrsT") {
    return new Dropdown("filters.options.brushType", "filters.options.brushTypeOpt.simple,filters.options.brushTypeOpt.lightRough,filters.options.brushTypeOpt.darkRough,filters.options.brushTypeOpt.wideSharp,filters.options.brushTypeOpt.wideBlurry,filters.options.brushTypeOpt.sparkle".split(","));
  }
  if (paramKey == "LghD") {
    return new Dropdown("properties.light", "filters.options.lightDir.bottom,filters.options.lightDir.bottomLeft,filters.options.lightDir.left,filters.options.lightDir.topLeft,filters.options.lightDir.top,filters.options.lightDir.topRight,filters.options.lightDir.right,filters.options.lightDir.bottomRight".split(","));
  }
  if (paramKey == "SDir") {
    return new Dropdown("properties.direction", ["filters.options.rightDiagonal", "warp.orientation.horizontal", "filters.options.leftDiagonal", "warp.orientation.vertical"]);
  }
  if (paramKey == "LghP") {
    return new Dropdown("filters.options.lightPosition", "filters.options.lightDir.bottom,filters.options.lightDir.bottomLeft,filters.options.lightDir.left,filters.options.lightDir.topLeft,filters.options.lightDir.top,filters.options.lightDir.topRight,filters.options.lightDir.right,filters.options.lightDir.bottomRight".split(","));
  }
  if (paramKey == "Grnt") {
    return new Dropdown("filters.options.grainType", "filters.options.grainTypeOpt.regular,filters.options.grainTypeOpt.soft,filters.options.grainTypeOpt.sprinkles,filters.options.grainTypeOpt.clumped,filters.options.grainTypeOpt.contrasty,filters.options.grainTypeOpt.enlarged,filters.options.grainTypeOpt.stippled,warp.orientation.horizontal,warp.orientation.vertical,filters.options.grainTypeOpt.speckle".split(","));
  }
  if (paramKey == "ScrT") {
    return new Dropdown("properties.pattern", ["filters.options.circle", "filters.options.dot", "tools.line"]);
  }
  if (paramKey == "EdgW") return new TextRangeInput("filters.options.edgeWidth", 1, 14);
  if (paramKey == "EdgB") return new TextRangeInput("filters.options.edgeBrightness", 0, 20);
  if (paramKey == "Smth") {
    return new TextRangeInput("styleOptions.bevelTechnique.smoothness", 1, filterKey == "Stmp" ? 50 : 15);
  }
  if (paramKey == "ClSz") return new TextRangeInput("properties.cellSize", 3, 100);
  if (paramKey == "BrdT") return new TextRangeInput("select.border", 1, 20);
  if (paramKey == "HghS") return new TextRangeInput("properties.strength", 0, 20);
  if (paramKey == "HlSz") return new TextRangeInput("properties.size.title", 1, 15);
  if (paramKey == "Cntr") {
    return new TextRangeInput("properties.contrast", 0, filterKey == "Grn" ? 100 : 50);
  }
  if (paramKey == "SprR") return new TextRangeInput("filters.options.sprayRadius", 0, 25);
  if (paramKey == "StrL") return new TextRangeInput("filters.options.strokeLength", 0, 20);
  if (paramKey == "LgDr") {
    return new TextRangeInput("filters.options.lightDarkBalance", 0, filterKey == "Stmp" ? 50 : 100);
  }
  if (paramKey == "Drkn") return new TextRangeInput("filters.options.darkness", 1, 50);
  if (paramKey == "Dstr") return new TextRangeInput("filters.options.distortion", 0, 20);
  if (paramKey == "Scln") return new TextRangeInput("properties.scale", 50, 200);
  // Patchwork indexes relief into the 26-entry blurFactors table (0–25); other
  // filters that share this slider accept up to 50.
  if (paramKey == "Rlf") {
    return new TextRangeInput("filters.options.relief", 0, filterKey == "Ptch" ? 25 : 50);
  }
  if (paramKey == "ChAm") return new TextRangeInput("filters.options.thickness", 1, 7);
  if (paramKey == "InvT") return new Checkbox("adjustments.invert");
  if (paramKey == "RplS") return new TextRangeInput("filters.options.rippleSize", 1, 15);
  if (paramKey == "RplM") return new TextRangeInput("filters.options.rippleMagnitude", 0, 20);
  if (paramKey == "Pncl") return new TextRangeInput("filters.options.pencilWidth", 1, 24);
  if (paramKey == "StrP") return new TextRangeInput("filters.options.strokePressure", 0, 15);
  if (paramKey == "PprB") return new TextRangeInput("filters.options.paperBrightness", 0, 50);
  if (paramKey == "BrsS") return new TextRangeInput("filters.options.brushSize", 1, 10);
  if (paramKey == "BrsD") return new TextRangeInput("filters.options.brushDetail", 1, 10);
  if (paramKey == "Txtr") return new TextRangeInput("filters.gallery.groups.texture", 1, 3);
  if (paramKey == "Grn") return new TextRangeInput("filters.gallery.grain", 0, 10);
  if (paramKey == "HghA") return new TextRangeInput("filters.options.highlightArea", 0, 20);
  if (paramKey == "Intn") return new TextRangeInput("filters.options.intensity", 0, 10);
  if (paramKey == "Brgh") return new TextRangeInput("properties.brightness", 0, 20);
  if (paramKey == "StrS") return new TextRangeInput("filters.options.strokeSize", 0, 40);
  if (paramKey == "StDt") return new TextRangeInput("filters.options.strokeDetail", 1, 5);
  if (paramKey == "Sftn") return new TextRangeInput("filters.options.softness", 0, 5);
  if (paramKey == "EdgT") return new TextRangeInput("filters.options.edgeThickness", 1, 10);
  if (paramKey == "EdgI") return new TextRangeInput("filters.options.edgeIntensity", 0, 10);
  if (paramKey == "Pstr") return new TextRangeInput("filters.options.posterization", 0, 6);
  if (paramKey == "TxtC") return new TextRangeInput("filters.options.textureCoverage", 0, 40);
  if (paramKey == "ShdI") return new TextRangeInput("filters.options.shadowIntensity", 0, 10);
  if (paramKey == "DrcB") return new TextRangeInput("filters.options.directionBalance", 0, 100);
  if (paramKey == "Strg") return new TextRangeInput("properties.strength", 0, 5);
  if (paramKey == "Blnc") return new TextRangeInput("filters.options.balance", 0, 10);
  if (paramKey == "BlcI") return new TextRangeInput("filters.options.blackIntensity", 0, 10);
  if (paramKey == "WhtI") return new TextRangeInput("filters.options.whiteIntensity", 0, 10);
  if (paramKey == "DrkI") return new TextRangeInput("filters.options.darkIntensity", 0, 50);
  if (paramKey == "LghI") {
    return new TextRangeInput("filters.options.lightIntensity", 0, filterKey == "StnG" ? 7 : 30);
  }
  if (paramKey == "StrW") return new TextRangeInput("styleOptions.bevelStyle.strokeWidth", 0, 20);
  if (paramKey == "Grns") return new TextRangeInput("filters.options.graininess", 0, 10);
  if (paramKey == "GlwA") return new TextRangeInput("filters.options.glowAmount", 0, 20);
  if (paramKey == "ClrA") return new TextRangeInput("filters.options.colourAmount", 0, 30);
  if (paramKey == "ChrA") return new TextRangeInput("filters.options.charcoalAmount", 0, 20);
  if (paramKey == "ChlA") return new TextRangeInput("filters.options.chalkAmount", 0, 20);
  if (paramKey == "FrgL") return new TextRangeInput("filters.options.foregroundLevels", 0, 20);
  if (paramKey == "BckL") return new TextRangeInput("filters.options.backgroundLevels", 0, 20);
  if (paramKey == "WhtL") return new TextRangeInput("filters.options.whiteLevel", 0, 70);
  if (paramKey == "BlcL") return new TextRangeInput("filters.options.blackLevel", 0, 70);
  if (paramKey == "ImgB") return new TextRangeInput("filters.options.imageBalance", 0, 50);
  if (paramKey == "Dnst") return new TextRangeInput("properties.density", 1, 50);
  if (paramKey == "FbrL") return new TextRangeInput("filters.options.fiberLength", 3, 50);
  if (paramKey == "CrcS") return new TextRangeInput("filters.options.crackSpacing", 2, 100);
  if (paramKey == "CrcD") return new TextRangeInput("filters.options.crackDepth", 0, 10);
  if (paramKey == "CrcB") return new TextRangeInput("filters.options.crackBrightness", 0, 10);
  if (paramKey == "TlSz") return new TextRangeInput("filters.options.tileSize", 2, 100);
  if (paramKey == "GrtW") return new TextRangeInput("filters.options.groutWidth", 1, 15);
  if (paramKey == "LghG") return new TextRangeInput("filters.options.lightIntensity", 0, 10);
  if (paramKey == "SqrS") return new TextRangeInput("filters.options.squareSize", 1, 20);
  if (paramKey == "NmbL") return new TextRangeInput("filters.options.numberOfLevels", 2, 16);
  if (paramKey == "EdgS") return new TextRangeInput("filters.options.edgeSimplicity", 1, 10);
  if (paramKey == "EdgF") return new TextRangeInput("filters.options.edgeFidelity", 1, 3);
  if (paramKey == "Dfnt") return new TextRangeInput("filters.options.definition", 0, 25);
  if (paramKey == "Clr") return new ColorSampleWidget();
  return null;
}

/**
 * Reads one gallery filter parameter out of its descriptor into a widget value.
 * Plain numeric params (listed in `numericParamKeys`) return the raw `.v`; enum
 * params (texture/brush/light/... types) map their FourCC wire id to the matching
 * dropdown index via the {@link GalleryFilterDefs} id tables. Paired with
 * {@link writeWidgetValueToDescriptor}.
 */
function readWidgetValueFromDescriptor(paramKey, filterDescriptor, numericParamKeys, filterKey) {
  if (numericParamKeys.indexOf(paramKey) != -1) {
    return filterDescriptor[paramKey] ? filterDescriptor[paramKey].v : 0;
  }
  if (paramKey == "TxtT") {
    // A descriptor written elsewhere can name a texture this filter does not
    // offer; show its first option rather than an empty menu.
    const offered = GalleryFilterDefs.textureWireIdsFor(filterKey);
    return Math.max(0, offered.indexOf(filterDescriptor[paramKey].v[paramKey]));
  }
  if (paramKey == "BrsT") {
    return GalleryFilterDefs.brushTypeWireIds.indexOf(filterDescriptor[paramKey].v[paramKey]);
  }
  if (paramKey == "LghD") {
    return GalleryFilterDefs.lightDirectionWireIds.indexOf(filterDescriptor[paramKey].v[paramKey]);
  }
  if (paramKey == "LghP") {
    return GalleryFilterDefs.lightPositionWireIds.indexOf(filterDescriptor[paramKey].v[paramKey]);
  }
  if (paramKey == "Grnt") {
    return GalleryFilterDefs.grainTypeWireIds.indexOf(filterDescriptor[paramKey].v[paramKey]);
  }
  if (paramKey == "ScrT") {
    return GalleryFilterDefs.scratchTypeWireIds.indexOf(filterDescriptor[paramKey].v[paramKey]);
  }
  if (paramKey == "SDir") {
    return GalleryFilterDefs.strokeDirectionWireIds.indexOf(filterDescriptor[paramKey].v.StrD);
  }
  if (paramKey == "Clr") {
    return filterDescriptor[paramKey] ? filterDescriptor[paramKey].v : null;
  }
  return undefined;
}

/**
 * Writes an edited widget value back onto a gallery filter descriptor — the
 * inverse of {@link readWidgetValueFromDescriptor}. Numeric params set `.v`
 * directly; enum params translate the dropdown index back to its FourCC wire id.
 */
function writeWidgetValueToDescriptor(paramKey, filterDescriptor, widgetValue, numericParamKeys, filterKey) {
  if (numericParamKeys.indexOf(paramKey) != -1) {
    if (filterDescriptor[paramKey]) filterDescriptor[paramKey].v = widgetValue;
    return;
  }
  if (paramKey == "TxtT") {
    filterDescriptor[paramKey].v[paramKey] = GalleryFilterDefs.textureWireIdsFor(filterKey)[widgetValue];
    return;
  }
  if (paramKey == "BrsT") {
    filterDescriptor[paramKey].v[paramKey] = GalleryFilterDefs.brushTypeWireIds[widgetValue];
    return;
  }
  if (paramKey == "LghD") {
    filterDescriptor[paramKey].v[paramKey] = GalleryFilterDefs.lightDirectionWireIds[widgetValue];
    return;
  }
  if (paramKey == "LghP") {
    filterDescriptor[paramKey].v[paramKey] = GalleryFilterDefs.lightPositionWireIds[widgetValue];
    return;
  }
  if (paramKey == "Grnt") {
    filterDescriptor[paramKey].v[paramKey] = GalleryFilterDefs.grainTypeWireIds[widgetValue];
    return;
  }
  if (paramKey == "ScrT") {
    filterDescriptor[paramKey].v[paramKey] = GalleryFilterDefs.scratchTypeWireIds[widgetValue];
    return;
  }
  if (paramKey == "SDir") {
    filterDescriptor[paramKey].v.StrD = GalleryFilterDefs.strokeDirectionWireIds[widgetValue];
    return;
  }
  if (paramKey == "Clr") {
    filterDescriptor[paramKey].v = widgetValue;
  }
}

function resolveStackEntryLabel(filterMeta) {
  if (!filterMeta) return "Filter";
  return Locale.get(filterMeta[1]) || filterMeta[2] || "";
}

function buildStackListItemElements(stackEntries, activeFilterIndex, eventParent) {
  const items = [];
  for (let i = 0; i < stackEntries.length; i++) {
    const entry = stackEntries[i].v;
    const meta = GalleryFilterDefs.names[entry.GEfk.v.GEft];
    const label = resolveStackEntryLabel(meta);
    const item = new LayerListItem(i, true, true, null, label, i === activeFilterIndex, entry.GELv.v);
    item.parent = eventParent;
    items.push(item.el);
  }
  items.reverse();
  return items;
}

/**
 * The parameter editor for a single gallery filter: builds one control per
 * editable wire key of the filter's default descriptor (skipping the structural
 * keys in {@link GALLERY_DESCRIPTOR_SKIP_KEYS}) and emits a widgetSelect event
 * whenever any control changes. `setValue`/`getValue` move data between the
 * descriptor and these controls. One instance per filter is held by
 * {@link FilterStackPanel}.
 * @param {string} filterKey Gallery filter id, e.g. `Chrc`.
 */
function FilterParamWidget(filterKey) {
  BaseWidget.call(this);
  this.filterKey = filterKey;
  this.el = makeElement("div");
  this.paramWidgets = {};
  const defaultDescriptor = GalleryFilterDefs.create(filterKey);
  for (const paramKey in defaultDescriptor) {
    if (GALLERY_DESCRIPTOR_SKIP_KEYS[paramKey]) continue;
    const paramWidget = createGalleryParamWidget(filterKey, paramKey);
    if (paramWidget == null) continue;
    paramWidget.on(EventType.widgetSelect, this.emitChange, this);
    paramWidget.parent = this;
    this.paramWidgets[paramKey] = paramWidget;
    this.el.appendChild(paramWidget.el);
  }
}
FilterParamWidget.prototype = Object.create(BaseWidget.prototype);
FilterParamWidget.prototype.emitChange = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};
FilterParamWidget.prototype.setValue = function(filterDescriptor) {
  const numericParamKeys = "Sz Dtl Shrp EdgW EdgB Smth ClSz BrdT HghS HlSz Cntr SprR StrL LgDr Drkn Dstr Scln Rlf ChAm InvT RplS RplM Pncl StrP PprB BrsS BrsD Txtr Grn HghA Intn Brgh StrS StDt Sftn EdgT EdgI Pstr TxtC ShdI DrcB Strg Blnc BlcI WhtI DrkI LghI StrW Grns GlwA ClrA ChrA ChlA FrgL BckL WhtL BlcL ImgB Dnst FbrL CrcS CrcD CrcB TlSz GrtW LghG SqrS NmbL EdgS EdgF Dfnt".split(" ");
  for (const paramKey in this.paramWidgets) {
    const widgetValue = readWidgetValueFromDescriptor(paramKey, filterDescriptor, numericParamKeys, this.filterKey);
    this.paramWidgets[paramKey].setValue(widgetValue);
  }
};
FilterParamWidget.prototype.getValue = function() {
  const filterDescriptor = GalleryFilterDefs.create(this.filterKey);
  const numericParamKeys = "Sz Dtl Shrp EdgW EdgB Smth ClSz BrdT HghS HlSz Cntr SprR StrL LgDr Drkn Dstr Scln Rlf ChAm InvT RplS RplM Pncl StrP PprB BrsS BrsD Txtr Grn HghA Intn Brgh StrS StDt Sftn EdgT EdgI Pstr TxtC ShdI DrcB Strg Blnc BlcI WhtI DrkI LghI StrW Grns GlwA ClrA ChrA ChlA FrgL BckL WhtL BlcL ImgB Dnst FbrL CrcS CrcD CrcB TlSz GrtW LghG SqrS NmbL EdgS EdgF Dfnt".split(" ");
  for (const paramKey in this.paramWidgets) {
    const widgetValue = this.paramWidgets[paramKey].getValue();
    writeWidgetValueToDescriptor(paramKey, filterDescriptor, widgetValue, numericParamKeys, this.filterKey);
  }
  return filterDescriptor;
};
FilterParamWidget.prototype.buildUI = function() {
  for (const paramKey in this.paramWidgets) this.paramWidgets[paramKey].buildUI();
};

/**
 * Right panel of the Filter Gallery: active filter params + stacked filter list.
 *
 * @param {object} eventParent The GEfc instance. LayerListItem events bubble to it
 *   via BaseWidget's `parent` chain, so GEfc.on("click", ...) receives them.
 */
export function FilterStackPanel(eventParent) {
  this.eventParent = eventParent;

  this.el = makeElement("div", "form filter-gallery-stack");
  this.el.setAttribute("style", "width:250px; margin:0");

  this.categoryHeaderEl = makeElement("div", "filter-gallery-confirm");
  this.el.appendChild(this.categoryHeaderEl);

  this.filterParamsEl = makeElement("div", "filter-gallery-params");
  this.filterParamsEl.style.minHeight = "14em";
  this.filterParamsEl.style.marginBottom = "1em";
  this.el.appendChild(this.filterParamsEl);

  appendBreak(this.el);

  this.filterStackListEl = makeElement("div", "lpbody scrollable filter-gallery-stack-list");
  this.filterStackFooterEl = makeElement("div", "lpfoot");
  this.el.appendChild(this.filterStackListEl);
  this.el.appendChild(this.filterStackFooterEl);

  this.footerButtons = [];
  ChannelsPanel.buildFooterButtons(
    ["clipboard.new", "clipboard.delete"],
    this.footerButtons, this.filterStackFooterEl,
    this.onFooterButton.bind(this)
  );

  this.filterParamWidgets = {};
  for (const key in GalleryFilterDefs.names) {
    const widget = new FilterParamWidget(key);
    widget.parent = this.eventParent;
    this.filterParamWidgets[key] = widget;
    widget.on(EventType.widgetSelect, this.onParamWidgetChange.bind(this));
  }

  /** @type {function(Event): void} Fired when a param slider or dropdown changes. */
  this.onParamChanged = null;
  /** @type {function(number): void} Fired when a footer button is clicked (0=duplicate, 1=delete). */
  this.onStackAction = null;
}

/** Places an element (e.g. the dialog's OK button) into the header area. */
FilterStackPanel.prototype.appendCategoryHeader = function(el) {
  this.categoryHeaderEl.appendChild(el);
};

/** Returns the current value object for the given filter's param widget. */
FilterStackPanel.prototype.getParamValue = function(filterKey) {
  return this.filterParamWidgets[filterKey].getValue();
};

/** Adjusts the filter stack list height to fill available vertical space. */
FilterStackPanel.prototype.resize = function(totalH) {
  let controlsH = this.filterParamsEl.getBoundingClientRect().height;
  controlsH = Math.max(controlsH, 186);
  this.filterStackListEl.style.height = Math.max(80, totalH - controlsH - 96) + "px";
};

/**
 * Renders the active filter's param controls and rebuilds the stack list.
 * @returns {string} The active filter key (derived from filterState).
 */
FilterStackPanel.prototype.render = function(filterState, activeFilterIndex) {
  const stackEntries = filterState.GEfs.v;
  const activeData = stackEntries[activeFilterIndex].v;
  const activeKey = activeData.GEfk.v.GEft;
  const paramsEl = this.filterParamsEl;

  if (GalleryFilterDefs.names[activeKey] == null) {
    showToast(Locale.get("filters.options.unsupportedGalleryFilter"));
    clearElement(paramsEl);
  } else {
    const paramWidget = this.filterParamWidgets[activeKey];
    paramWidget.setValue(activeData);
    if (paramsEl.firstChild !== paramWidget.el) {
      clearElement(paramsEl);
      paramsEl.appendChild(paramWidget.el);
    }
  }

  clearElement(this.filterStackListEl);
  const items = buildStackListItemElements(stackEntries, activeFilterIndex, this.eventParent);
  for (let i = 0; i < items.length; i++) this.filterStackListEl.appendChild(items[i]);

  return activeKey;
};

/** Calls buildUI on all param widgets and applies icons to the footer buttons. */
FilterStackPanel.prototype.buildUI = function() {
  for (const key in this.filterParamWidgets) this.filterParamWidgets[key].buildUI();
  ChannelsPanel.applyFooterIcons(this.footerButtons, ["lrs/newlayer", "lrs/bin"]);
};

FilterStackPanel.prototype.onParamWidgetChange = function(widgetEvt) {
  if (this.onParamChanged) this.onParamChanged(widgetEvt);
};

FilterStackPanel.prototype.onFooterButton = function(pointerEvt) {
  const idx = ChannelsPanel.indexOfButton(this.footerButtons, pointerEvt);
  if (this.onStackAction) this.onStackAction(idx);
};
