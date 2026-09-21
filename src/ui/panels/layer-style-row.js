/**
 * One indented sub-row shown under a layer in the Layers panel: a single layer
 * effect, a smart-filter variant, or one of their master toggle rows. Each row
 * carries a visibility eye, an optional mask thumbnail, an optional filter gear,
 * and a name label, and can be dragged to reorder effects/filters or copy them
 * between layers. Dragging uses mouse events rather than HTML drag-and-drop so a
 * row behaves exactly like a layer row: a move cursor, an insert bar on the row
 * under the pointer, and no OS copy badge.
 *
 * `dragKind` distinguishes the four row types: "s" layer-effect variant,
 * "sm" layer-effects master, "f" smart-filter variant, "fm" smart-filters
 * master. The parent is the LayerGroupItem owning this row.
 */

import { FilterDefs } from "../../features/filters/filter-apply.js";
import { TrackerRegistry } from "../../features/trackers/tracker-registry.js";
import { Layer } from "../../document/model/layer.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { FilterParameterPanel } from "../filter-panels/filter-parameter-panel.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import {
  clearPanelDropIndicators,
  dispatchLayerStyleDragReorder,
  findPanelRowAtPoint,
  layerPanelDragState,
  layerPanelEventYRatioInElement,
} from "./layers-panel-drag.js";

/**
 * Build a style sub-row DOM widget. `labelHtml` is the row's inner HTML label,
 * `dialogRouteId` (when set) names the dialog opened on double-click, `depth`
 * and `rowKind` control the left indent, `styleIndex` is the effect/filter
 * index within its layer, and `thumbEl`, when supplied, is a mask thumbnail
 * wrapper inserted into the header.
 */
function LayerStyleRow(labelHtml, dragKind, dialogRouteId, depth, rowKind, styleIndex, thumbEl) {
  BaseWidget.call(this);
  this.dragKind = dragKind;
  this.dialogRouteId = dialogRouteId;
  this.index = styleIndex;
  this.el = makeElement("div", "styleitem");
  this.headerEl = makeElement("div", "head");
  this.filterGearEl = null;
  if (dragKind == "f") {
    const gearEl = this.filterGearEl = makeElement("div", "headR");
    gearEl.textContent = "\u2699";
    this.headerEl.appendChild(gearEl)
  }
  this.styleVisibilityEyeEl = makeElement("div", "eye gsicon");
  this.nameLabelEl = makeElement("div", "label");
  this.el.appendChild(this.headerEl);
  this.headerEl.appendChild(this.styleVisibilityEyeEl);
  if (thumbEl) {
    this.rasterMaskThumbWrap = thumbEl;
    this.headerEl.appendChild(this.rasterMaskThumbWrap);
    this.headerEl.setAttribute("style", "height: " + (thumbEl.firstChild.height / getDevicePixelRatio() + 10) + "px")
  }
  this.nameLabelEl.innerHTML = labelHtml;
  this.el.setAttribute("style", "margin-left: " + (24 + depth * 16 + rowKind * 22) + "px");
  this.headerEl.appendChild(this.nameLabelEl);
  this.styleVisibilityEyeEl.addEventListener("click", this.onStyleVisibilityClick.bind(this), false);
  const dragRootEl = this.el;
  dragRootEl.__layerStyleRow = this;
  dragRootEl.setAttribute("draggable", "false");
  dragRootEl.addEventListener("mousedown", this.onRowPointerDown.bind(this), false);
  this.el.addEventListener("click", this.onMouseUp.bind(this), false);
  this.el.addEventListener("contextmenu", this.onContextMenu.bind(this), false)
};
LayerStyleRow.prototype = Object.create(BaseWidget.prototype);
LayerStyleRow.prototype.onContextMenu = function(evt) {
  this.parent.handleStyleItemContextMenu(evt, this)
};
/**
 * True when `targetRow` can receive this row: rows only reorder among their own
 * kind, so a smart filter cannot be dropped into the layer-effects list.
 */
LayerStyleRow.prototype.acceptsDropFrom = function(targetRow) {
  if (targetRow == null) return false;
  const filterKinds = this.dragKind == "f" || this.dragKind == "fm";
  const targetIsFilter = targetRow.dragKind == "f" || targetRow.dragKind == "fm";
  return filterKinds == targetIsFilter
};

/** Draw the insert bar on the edge the drop would land against. */
LayerStyleRow.prototype.showDropIndicator = function(ratio) {
  this.headerEl.style.boxShadow = "inset 0 " + (ratio > .5 ? -3 : 3) + "px 0 var(--text-color)"
};

LayerStyleRow.prototype.clearDropIndicator = function() {
  this.headerEl.style.boxShadow = ""
};

/** The eye and the gear are controls, not drag handles. */
LayerStyleRow.prototype.isReorderGripTarget = function(target) {
  if (target == null) return false;
  if (target == this.styleVisibilityEyeEl || target == this.filterGearEl) return false;
  return true
};

/**
 * Begin a reorder drag. Mirrors the layer-row gesture: nothing happens until the
 * pointer travels far enough to distinguish a drag from a click, after which the
 * row under the pointer shows an insert bar and the drop is committed on release.
 */
LayerStyleRow.prototype.onRowPointerDown = function(evt) {
  if (evt.button != 0 || !this.isReorderGripTarget(evt.target)) return;
  const sourceRow = this,
    startX = evt.clientX,
    startY = evt.clientY;
  let dragActive = false;
  function onMove(e) {
    if (!dragActive) {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 4) return;
      dragActive = true;
      layerPanelDragState.styleDrag = { source: sourceRow };
      document.body.style.cursor = "move";
    }
    e.preventDefault();
    const under = findPanelRowAtPoint(e.clientX, e.clientY),
      drag = layerPanelDragState.styleDrag;
    clearPanelDropIndicators();
    drag.target = null;
    drag.layerTarget = null;
    if (under.styleRow != null && sourceRow.acceptsDropFrom(under.styleRow)) {
      const ratio = layerPanelEventYRatioInElement(e, under.styleRow.headerEl);
      under.styleRow.showDropIndicator(ratio);
      layerPanelDragState.activeStyleDropRow = under.styleRow;
      drag.target = under.styleRow;
      drag.dropPositionRatio = ratio;
      return
    }
    // Dropping on a layer header copies the effect or filter onto that layer.
    if (under.layerRow != null) {
      under.layerRow.showDropIndicator(layerPanelEventYRatioInElement(e, under.layerRow.headerEl));
      layerPanelDragState.activeDropRow = under.layerRow;
      drag.layerTarget = under.layerRow
    }
  }
  function onUp(e) {
    document.removeEventListener("mousemove", onMove, false);
    document.removeEventListener("mouseup", onUp, false);
    document.body.style.cursor = "";
    const drag = layerPanelDragState.styleDrag;
    layerPanelDragState.styleDrag = null;
    clearPanelDropIndicators();
    if (!dragActive || drag == null) return;
    sourceRow._suppressNextClick = true;
    const payload = {
      kind: sourceRow.dragKind,
      layerIndex: sourceRow.parent.sectionNode.index,
      styleIndex: sourceRow.index
    };
    if (drag.target != null && drag.target !== sourceRow) {
      const dropIndex = drag.target.index + (drag.dropPositionRatio > .5 ? 0 : 1);
      dispatchLayerStyleDragReorder(e, payload, drag.target.parent, dropIndex);
      return
    }
    if (drag.layerTarget != null && drag.layerTarget !== sourceRow.parent) {
      dispatchLayerStyleDragReorder(e, payload, drag.layerTarget)
    }
  }
  document.addEventListener("mousemove", onMove, false);
  document.addEventListener("mouseup", onUp, false)
};
LayerStyleRow.prototype.setVisible = function(visible) {
  let eyeSize = 15;
  if (1 < getDevicePixelRatio() && getDevicePixelRatio() < 1.5) eyeSize = eyeSize / getDevicePixelRatio();
  this.styleVisibilityEyeEl.setAttribute("style", "background-size: " + eyeSize + "px " + eyeSize + "px;");
  this.styleVisibilityEyeEl.style.opacity = visible ? 1 : 0.2
};
/**
 * Click handler. A single click selects the owning layer; a double-click opens
 * the relevant editor — a smart-filter's settings (route ids prefixed "afw_")
 * or blend options via the gear, otherwise the dialog named by dialogRouteId.
 */
LayerStyleRow.prototype.onMouseUp = function(evt) {
  if (this._suppressNextClick) {
    this._suppressNextClick = false;
    return
  }
  if (evt.target == this.styleVisibilityEyeEl) return;
  const layerIndex = this.parent.sectionNode.index;
  if (evt.detail != 1 && this.dialogRouteId != null) {
    const uiEvt = new AppEvent(EventType.uiDispatch, true);
    if (this.dialogRouteId.indexOf("afw_") == 0) {
      const filterClassId = this.dialogRouteId.slice(4),
        filterTool = FilterParameterPanel[filterClassId] || FilterDefs.toolLinkedFilterIds[filterClassId],
        openBlendOptions = evt.target == this.filterGearEl;
      if (!openBlendOptions && !filterTool) return;
      uiEvt.data = TrackerRegistry.SmartFilterApplyTracker.buildFilterStartDispatch(openBlendOptions ? "blendOptions" : filterClassId, {
        layerIndex: layerIndex,
        index: this.index
      })
    } else uiEvt.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: this.dialogRouteId,
      layerIndex: layerIndex,
      index: this.index
    };
    this.dispatch(uiEvt)
  } else {
    this.parent.applyEvent({
      actionKind: Layer.selectLayer,
      layerIndex: layerIndex,
      pixelContentKind: 0
    })
  }
};
LayerStyleRow.prototype.onStyleVisibilityClick = function(evt) {
  const visibilityEventByKind = {
    fm: Layer.toggleSmartFiltersMaster,
    f: Layer.toggleSmartFilterVariant,
    sm: Layer.toggleLayerEffectsMaster,
    s: Layer.toggleLayerEffectVariant
  } [this.dragKind];
  this.parent.applyEvent({
    actionKind: visibilityEventByKind,
    layerIndex: this.parent.sectionNode.index,
    index: this.index
  })
};

export { LayerStyleRow };