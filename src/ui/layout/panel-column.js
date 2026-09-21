/**
 * Resizable vertical sidebar column that hosts stacked DocumentTab strips
 * and optional floating panel overlays.
 */

import { SideBar } from "../tool-options/option-bar.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, getEventPos, makeElement, removePointerMoveListener, removePointerUpListener } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/**
 * Vertical chrome inset subtracted from column height before panel layout:
 * covers the column's collapse handle (`.sbar > .top` in all.css).
 */
const COLUMN_CONTENT_VERTICAL_INSET_PX = 9;

/**
 * One resizable vertical column of the right sidebar. It stacks several
 * {@link DocumentTab} strips, distributes their heights (each strip gets its
 * header height, the last one absorbs the slack), and can collapse to a
 * narrow rail. When a strip is expanded from the collapsed state it is shown
 * as a floating overlay rather than inline. Owned by {@link RightSidebar}.
 *
 * @param {number} defaultWidth Initial column width in CSS pixels.
 */
function PanelColumn(defaultWidth) {
  SideBar.call(this, "vcolumn");
  this.columnWidth = defaultWidth;
  this.applyWidthStyle();
  this.contentEl = makeElement("div");
  this.contentEl.setAttribute("style", "cursor:default;");
  this.onResizePointerDown = this.onColumnResizeStart.bind(this);
  this.onResizePointerMove = this.onColumnResizeMove.bind(this);
  this.onResizePointerUp = this.onColumnResizeEnd.bind(this);
  addPointerDownListener(this.el, this.onResizePointerDown);
  this.el.appendChild(this.contentEl);
  this.floatHostEl = makeElement("div", "");
  this.contentEl.appendChild(this.floatHostEl);
  this.floatingContentEl = null;
  this.floatOverlayEl = makeElement("div", "float");
  this.childPanels = [];
  this.resizeDragStartPos = null;
  this.resizeStartWidth = 0;
}
PanelColumn.prototype = Object.create(SideBar.prototype);

PanelColumn.prototype.onColumnResizeStart = function(evt) {
  if (evt.target != this.el) return;
  if (!this.isExpanded()) return;
  this.resizeDragStartPos = getEventPos(evt, document.body);
  this.resizeStartWidth = this.columnWidth;
  addPointerMoveListener(document, this.onResizePointerMove);
  addPointerUpListener(document, this.onResizePointerUp);
};

PanelColumn.prototype.onColumnResizeMove = function(evt) {
  const pos = getEventPos(evt, document.body);
  this.columnWidth = this.resizeStartWidth + this.resizeDragStartPos.x - pos.x;
  this.applyWidthStyle();
  dispatchDocumentLayoutInvalidate(this);
};

PanelColumn.prototype.onColumnResizeEnd = function() {
  removePointerMoveListener(document, this.onResizePointerMove);
  removePointerUpListener(document, this.onResizePointerUp);
};

PanelColumn.prototype.addPanel = function(panel) {
  panel.on("showFloat", this.onPanelShowFloat, this);
  panel.on("hideFloat", this.hideFloatingPanel, this);
  this.childPanels.push(panel);
  panel.parent = this;
  this.contentEl.appendChild(panel.el);
};

PanelColumn.prototype.removePanelAt = function(index) {
  const panel = this.childPanels[index];
  panel.removeEventListener("showFloat", this.onPanelShowFloat, this);
  panel.removeEventListener("hideFloat", this.hideFloatingPanel, this);
  this.childPanels.splice(index, 1);
  panel.parent = null;
  this.contentEl.removeChild(panel.el);
};

PanelColumn.prototype.getPanelCount = function() {
  return this.childPanels.length;
};

PanelColumn.prototype.dismissChildFloats = function() {
  for (let pi = 0; pi < this.childPanels.length; pi++) {
    this.childPanels[pi].dismissSidebarButtonPopups();
  }
};

PanelColumn.prototype.onPanelShowFloat = function(evt) {
  this.hideFloatingPanel(evt);
  this.floatHostEl.appendChild(this.floatOverlayEl);
  this.floatingContentEl = evt.currentTarget.expandedBodyEl;
  this.floatOverlayEl.appendChild(this.floatingContentEl);
  this.floatOverlayEl.setAttribute("style", buildFloatOverlayStyle(evt.currentTarget.getPreferredSize()));
  this.resize(this.cachedWidth, this.cachedHeight);
};

PanelColumn.prototype.hideFloatingPanel = function() {
  this.dismissChildFloats();
  if (this.floatingContentEl) {
    this.floatHostEl.removeChild(this.floatOverlayEl);
    this.floatOverlayEl.removeChild(this.floatingContentEl);
    this.floatingContentEl = null;
  }
};

PanelColumn.prototype.applyWidthStyle = function() {
  this.el.setAttribute("style", "width: " + this.columnWidth + "px; padding-left:3px; cursor:ew-resize;");
};

PanelColumn.prototype.expand = function(notifyLayout) {
  this.applyWidthStyle();
  this.hideFloatingPanel();
  expandAllChildPanels(this.childPanels);
  SideBar.prototype.expand.call(this, notifyLayout);
};

PanelColumn.prototype.collapse = function(notifyLayout) {
  this.el.removeAttribute("style");
  collapseAllChildPanels(this.childPanels);
  SideBar.prototype.collapse.call(this, notifyLayout);
};

PanelColumn.prototype.resize = function(width, height) {
  this.cachedWidth = width;
  this.cachedHeight = height;
  distributeHeightAcrossPanels(this.childPanels, this.columnWidth, height - COLUMN_CONTENT_VERTICAL_INSET_PX, this.isExpanded());
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function dispatchDocumentLayoutInvalidate(widget) {
  const layoutEvt = new AppEvent(EventType.uiDispatch, true);
  layoutEvt.data = {
    dispatchKind: UiCommand.documentLayoutInvalidate
  };
  widget.dispatch(layoutEvt);
}

/** @param {{x:number,y:number}} preferred */
function buildFloatOverlayStyle(preferred) {
  let style = "";
  if (preferred.x != 0) style += "width : " + preferred.x + "px;";
  if (preferred.y != 0) style += "height: " + preferred.y + "px;";
  return style;
}

function expandAllChildPanels(panels) {
  for (let pi = 0; pi < panels.length; pi++) panels[pi].expand();
}

function collapseAllChildPanels(panels) {
  for (let pi = 0; pi < panels.length; pi++) panels[pi].collapse();
}

/**
 * All but the last panel get their header height when expanded; the last
 * panel absorbs remaining space. When collapsed, every panel gets full height.
 */
function distributeHeightAcrossPanels(panels, width, height, expanded) {
  const panelCount = panels.length;
  if (panelCount == 0) return;
  let remainingHeight = height;
  for (let pi = 0; pi < panelCount - 1; pi++) {
    const panel = panels[pi];
    const headerHeight = panel.getHeaderHeight();
    panel.resize(width, expanded ? headerHeight : height);
    remainingHeight -= headerHeight;
  }
  panels[panelCount - 1].resize(width, expanded ? remainingHeight : height);
}

export { PanelColumn };
