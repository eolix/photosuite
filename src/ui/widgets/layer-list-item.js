/**
 * Shared list row for channels, paths, and similar panels: thumbnail, label,
 * and optional visibility eye with composite-channel wire enums.
 */


import { Locale } from "../../core/i18n/locale.js";
import { ToolId } from "../../document/model/tool-base.js";
import { BaseWidget } from "./base-widget.js";
import { BaseTool } from "./base-tool.js";
import { EventType } from "../../core/event-bus.js";
import { getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { buildSelectChannelAction } from "../../document/tools/selection-actions.js";

/** Row header height in CSS pixels. */
const ROW_HEADER_HEIGHT_PX = 40;

/** Base visibility-eye icon size before DPR correction. */
const VISIBILITY_EYE_BASE_PX = 15;

/**
 * Composite channel row enums for negative synthetic indices
 * (-1 RGB, -2 Rd, -3 Grn, -4 Bl). PSD wire FourCC strings stay as-is.
 */
const COMPOSITE_CHANNEL_ENUMS = ["RGB", "Rd", "Grn", "Bl"];

/**
 * Shared list row: thumbnail + label + optional visibility eye.
 * Used by Channels, Paths, and the Gallery smart-filter chain.
 *
 * @param {number} idx Stable id for click / select wiring (negatives = synthetic).
 * @param {boolean} isChannel Channel flow vs path flow for buildSelectionEvent.
 * @param {boolean} isReadOnly System rows (no rename; italic label).
 * @param {CanvasRenderingContext2D|null} renderCtx Thumbnail canvas context, or null.
 * @param {string} labelKey Locale key or prebuilt display string for Locale.get.
 * @param {boolean} isSelected Initial selected chrome class.
 * @param {boolean} isVisible Initial eye opacity (1 vs 0.2).
 * @param {*} [actionTarget] Routing channel for rename.
 * @param {object} [renameActionData] Partial action payload merged on rename.
 */
function LayerListItem(idx, isChannel, isReadOnly, renderCtx, labelKey, isSelected, isVisible, actionTarget, renameActionData) {
  BaseWidget.call(this);
  this.idx = idx;
  this.isChannel = isChannel;
  this.renderCtx = renderCtx;
  this.actionTarget = actionTarget;
  this.renameActionData = renameActionData;
  mountLayerListItemDom(this, isChannel, isReadOnly, renderCtx, labelKey, isSelected, isVisible);
  wireLayerListItemHeader(this, isReadOnly)
}

LayerListItem.prototype = Object.create(BaseWidget.prototype);

LayerListItem.prototype.onRenameConfirm = function(newName) {
  dispatchRenameDocumentAction(this, newName)
};

LayerListItem.prototype.onHeaderMouseDown = function(evt) {
  const ctrlOrMeta = evt.ctrlKey || evt.metaKey,
    idx = this.idx;
  if (ctrlOrMeta && evt.target == this.renderCtx.canvas) {
    this.dispatch(LayerListItem.buildSelectionEvent(this.isChannel, idx, evt));
    return
  }
  const clickEvt = new AppEvent("click", true);
  clickEvt.data = {
    idx: idx,
    isVisibilityEyeClick: evt.target == this.visEl,
    isMultiSelectModifier: ctrlOrMeta
  };
  this.dispatch(clickEvt)
};

LayerListItem.prototype.onHeaderMouseUp = function(evt) {
  if (evt.detail == 2 && evt.target == this.labelEl) {
    new BaseTool.InlineRenameInput(this.labelEl, this.onRenameConfirm.bind(this))
  }
};

/**
 * Build the AppEvent for ctrl/cmd-click on a thumbnail to load a selection.
 * Channels: composite enums load the channel as a selection, else fromchannel. Paths: frompath.
 */
LayerListItem.buildSelectionEvent = function(isChannel, idx, evt) {
  const modifierFlags = selectionModifierFlagsFromPointerEvent(evt),
    resultEvt = new AppEvent(EventType.documentAction, true);
  resultEvt.routingChannel = ToolId.TOOL_RECT_SELECT;
  if (isChannel) {
    return attachChannelSelectionPayload(resultEvt, idx, modifierFlags)
  }
  resultEvt.data = buildFromPathSelectionData(idx, modifierFlags);
  return resultEvt
};

export {
  LayerListItem,
  selectionModifierFlagsFromPointerEvent,
  isCompositeChannelRowIndex,
  compositeChannelEnumForRowIndex,
  resolveVisibilityEyeCssSize,
  COMPOSITE_CHANNEL_ENUMS,
  ROW_HEADER_HEIGHT_PX,
  VISIBILITY_EYE_BASE_PX
};

// --- DOM mount ---------------------------------------------------------------

function mountLayerListItemDom(item, isChannel, isReadOnly, renderCtx, labelKey, isSelected, isVisible) {
  item.el = makeElement("div", "layeritem");
  item.headerEl = makeElement("div", isSelected ? "head selected" : "head");
  item.headerEl.setAttribute("style", "height: " + ROW_HEADER_HEIGHT_PX + "px");
  const leftEl = makeElement("div", "headL"),
    rightEl = makeElement("div", "headR");
  item.el.appendChild(item.headerEl);
  item.headerEl.appendChild(leftEl);
  item.headerEl.appendChild(rightEl);
  item.visEl = createVisibilityEyeElement(isVisible);
  if (isChannel) leftEl.appendChild(item.visEl);
  item.thumbEl = makeElement("div", "thumb");
  if (renderCtx) item.thumbEl.appendChild(renderCtx.canvas);
  leftEl.appendChild(item.thumbEl);
  item.labelEl = makeElement("div", "label");
  if (isReadOnly) item.labelEl.style.fontStyle = "italic";
  item.labelEl.textContent = Locale.get(labelKey);
  leftEl.appendChild(item.labelEl)
}

function createVisibilityEyeElement(isVisible) {
  const eyeEl = makeElement("div", "eye"),
    eyeSize = resolveVisibilityEyeCssSize(VISIBILITY_EYE_BASE_PX);
  eyeEl.setAttribute("style", "background-size: " + eyeSize + "px " + eyeSize + "px;");
  eyeEl.style.opacity = isVisible ? 1 : 0.2;
  return eyeEl
}

function wireLayerListItemHeader(item, isReadOnly) {
  item.headerEl.setAttribute("draggable", "true");
  item.headerEl.addEventListener("mousedown", item.onHeaderMouseDown.bind(item), false);
  if (!isReadOnly) item.headerEl.addEventListener("mouseup", item.onHeaderMouseUp.bind(item), false)
}

/**
 * Scale the eye icon when DPR sits between 1 and 1.5 (fractional retina).
 */
function resolveVisibilityEyeCssSize(basePx) {
  const devicePixelRatio = getDevicePixelRatio();
  if (1 < devicePixelRatio && devicePixelRatio < 1.5) return basePx / devicePixelRatio;
  return basePx
}

// --- Selection event builders ------------------------------------------------

/**
 * Pack shift/alt into the selectionSource combine flags (shift=1, alt=2).
 */
function selectionModifierFlagsFromPointerEvent(evt) {
  let modifierFlags = 0;
  if (evt.shiftKey) modifierFlags++;
  if (evt.altKey) modifierFlags += 2;
  return modifierFlags
}

/** True for synthetic composite rows RGB/Rd/Grn/Bl (indices -4..-1). */
function isCompositeChannelRowIndex(idx) {
  return -5 < idx && idx < 0
}

function compositeChannelEnumForRowIndex(idx) {
  return COMPOSITE_CHANNEL_ENUMS[-1 - idx]
}

function attachChannelSelectionPayload(resultEvt, idx, modifierFlags) {
  if (isCompositeChannelRowIndex(idx)) {
    const groupedEvt = new AppEvent(EventType.historyGrouped, true);
    groupedEvt.data = buildSelectChannelAction(
      modifierFlags,
      compositeChannelEnumForRowIndex(idx)
    );
    return groupedEvt
  }
  resultEvt.data = buildFromChannelSelectionData(idx, modifierFlags);
  return resultEvt
}

function buildFromChannelSelectionData(idx, modifierFlags) {
  return {
    actionKind: "fromchannel",
    selectionSource: [idx, 0, modifierFlags]
  }
}

function buildFromPathSelectionData(idx, modifierFlags) {
  return {
    actionKind: "frompath",
    selectionSource: [idx, 0, modifierFlags]
  }
}

function dispatchRenameDocumentAction(item, newName) {
  const evt = new AppEvent(EventType.documentAction, true);
  evt.routingChannel = item.actionTarget;
  evt.data = item.renameActionData;
  evt.data.name = newName;
  item.dispatch(evt)
}
