/**
 * Tab strip for a sidebar column: a bar of panel tabs above the active panel's
 * body, a collapsed rail of sidebar buttons, tab drag-reorder, and file /
 * cross-document layer drops onto tabs. Instances are stacked by
 * {@link PanelColumn} inside {@link RightSidebar}; each tab is one sidebar
 * panel (Layers, History, Color, …).
 */
import { Point } from "../../core/math/point.js";

import { Button } from "../widgets/form-controls.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, clearElement, getEventPos, isInDOM, makeElement, removeClass } from "../../core/dom.js";
import { iconImgHtml } from "../../assets/icon-registry.js";
import { dispatchDataTransferImports } from "../shell/file-loader.js";
import { AppEvent } from "../../core/event-bus.js";

/**
 * Minimum tab-bar height when the bar is above the panel body: the
 * `--h-tabstrip` tab height plus the 1px rule beneath it (see all.css).
 */
const TAB_BAR_MIN_HEIGHT_PX = 27;

/** Delay before a tab hover while dragging triggers a chrome repaint. */
const TAB_HOVER_REPAINT_MS = 700;
/**
 * A single tab strip: it owns a list of panels, shows one panel's body at a
 * time, and can collapse the body down to a rail of sidebar buttons. Beyond
 * selection it handles drag-reordering its own tabs and accepting drops
 * (imported files, or a layer dragged from another document's strip).
 *
 * @param {object|null} hostController Host that can gate panel select/close
 *   while a document view is busy (e.g. SplashScreen / AppController). When
 *   null, the strip does not accept cross-document layer drops.
 */
function DocumentTab(hostController) {
  BaseWidget.call(this);
  this.dragInstanceId = DocumentTab.nextDragInstanceId++;
  this.hostController = hostController;
  this.onDragEnter = this.onPanelDragEnter.bind(this);
  this.onDragLeave = this.onPanelDragLeave.bind(this);
  this.onDrop = this.onPanelDrop.bind(this);
  this.onTabMouseOver = this.onTabMouseOver.bind(this);
  this.onTabMouseOut = this.onTabMouseOut.bind(this);
  this.onTabHoverTimeout = this.onTabHoverTimeout.bind(this);
  this.hoverTimerId = 0;
  this.hoverTabIndex = 0;
  this.tabBarLayoutMode = 0;
  this.el = makeElement("div", "panelblock");
  this.expandedBodyEl = makeElement("div", "block");
  this.collapsedChromeEl = makeElement("div", "collapsed");
  this.el.appendChild(this.expandedBodyEl);
  this.activePanelIndex = -1;
  this.isBodyExpanded = true;
  this.tabBarEl = makeElement("div", "panelhead");
  this.expandedBodyEl.appendChild(this.tabBarEl);
  this.attachDragHandlers(this.tabBarEl);
  this.optionsMenuBtn = new Button(
    iconImgHtml("ui/menu", "", "autoscale"), false, "properties.panelMenu");
  this.optionsMenuBtn.el.setAttribute("style", "position:absolute; right:0;");
  this.optionsMenuBtn.on("click", this.onOptionsMenuClick, this);
  this.containerEl = makeElement("div", "");
  this.expandedBodyEl.appendChild(this.containerEl);
  this.panels = [];
  this.activePanelBodyEl = null;
  this.emptyStateWidgetEl = null;
}
DocumentTab.nextDragInstanceId = 0;
DocumentTab.prototype = Object.create(BaseWidget.prototype);

/** True when this strip hosts open documents (SplashScreen passes a host). */
DocumentTab.prototype.allowsCrossDocumentLayerDrop = function() {
  return this.hostController != null;
};

DocumentTab.prototype.onOptionsMenuClick = function(evt) {
  const editorMode = this.panels[this.activePanelIndex].getEditorMode();
  const btnRect = evt.currentTarget.el.getBoundingClientRect();
  editorMode.buildUI();
  editorMode.parent = this;
  const overlayEvt = new AppEvent(EventType.uiDispatch, true);
  overlayEvt.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: editorMode,
    x: btnRect.left,
    y: btnRect.top + btnRect.height + 2
  };
  this.dispatch(overlayEvt);
};

/**
 * @param {number} mode `0` = tab bar above body; otherwise body only (bar detached).
 */
DocumentTab.prototype.setTabBarPosition = function(mode) {
  const body = this.expandedBodyEl;
  const tabBar = this.tabBarEl;
  const container = this.containerEl;
  if (isInDOM(tabBar)) body.removeChild(tabBar);
  if (isInDOM(container)) body.removeChild(container);
  if (mode == 0) body.appendChild(tabBar);
  body.appendChild(container);
  this.tabBarLayoutMode = mode;
};

DocumentTab.cancel = function(evt) {
  evt.stopPropagation();
  evt.preventDefault();
};

DocumentTab.isExternalFileDrag = function(evt) {
  const types = evt.dataTransfer && evt.dataTransfer.types;
  if (!types) return false;
  for (let typeIdx = 0; typeIdx < types.length; typeIdx++) {
    const dragType = types[typeIdx];
    if (dragType === "Files" || dragType === "application/x-moz-file") return true;
  }
  return false;
};

DocumentTab.prototype.onPanelDragEnter = function(evt) {
  if (!DocumentTab.isExternalFileDrag(evt)) {
    const types = evt.dataTransfer.types;
    if (types[1] != null && types[1] != this.dragInstanceId + "") return;
  }
  DocumentTab.cancel(evt);
  const target = evt.currentTarget;
  if (evt.target == target) addClass(target, "highlight");
};

DocumentTab.prototype.onPanelDragLeave = function(evt) {
  DocumentTab.cancel(evt);
  const target = evt.currentTarget;
  if (evt.target == target) removeClass(target, "highlight");
};

DocumentTab.prototype.attachDragHandlers = function(el) {
  el.addEventListener("dragenter", this.onDragEnter, true);
  el.addEventListener("dragleave", this.onDragLeave, true);
  el.addEventListener("dragover", DocumentTab.cancel, true);
  el.addEventListener("drop", this.onDrop, true);
  el.addEventListener("dragstart", function(dragEvt) {
    dragEvt.dataTransfer.setData("Text", "--panel");
    dragEvt.dataTransfer.setData(this.dragInstanceId + "", "");
  }.bind(this), false);
};

DocumentTab.prototype.onPanelDrop = function(evt) {
  this.onPanelDragLeave(evt);
  const dropTargetIndex = resolveDropTargetPanelIndex(this, evt.currentTarget);
  const dataType = evt.dataTransfer.getData("Text");
  if (dataType == "" || dataType.startsWith("http")) {
    dispatchDataTransferImports(evt, this, dropTargetIndex);
    return;
  }
  if (dataType == "--panel") {
    reorderPanelsFromTabDrop(this, evt);
    return;
  }
  if (dropTargetIndex != null && this.allowsCrossDocumentLayerDrop()) {
    dispatchCrossDocumentLayerDrop(this, dropTargetIndex);
  }
};

DocumentTab.prototype.createEmptyStateWidget = function() {
  return null;
};

DocumentTab.prototype.animateOut = function() {
  const emptyWidget = this.createEmptyStateWidget();
  if (emptyWidget) {
    this.emptyStateWidgetEl = this.createEmptyStateWidget();
    this.containerEl.appendChild(this.emptyStateWidgetEl);
  }
};

DocumentTab.prototype.removeEmptyStateWidget = function() {
  if (this.emptyStateWidgetEl) {
    this.containerEl.removeChild(this.emptyStateWidgetEl);
    this.emptyStateWidgetEl = null;
  }
};

DocumentTab.prototype.indexOfTabElement = function(el) {
  const panels = this.panels;
  for (let pi = 0; pi < panels.length; pi++) {
    if (panels[pi].tabEl == el) return pi;
  }
  return -1;
};

DocumentTab.prototype.dismissSidebarButtonPopups = function() {
  for (let pi = 0; pi < this.panels.length; pi++) this.panels[pi].sidebarBtn.clearActive();
};

DocumentTab.prototype.getPreferredSize = function() {
  const maxSize = new Point(0, 0);
  for (let pi = 0; pi < this.panels.length; pi++) {
    const size = this.panels[pi].getPreferredSize();
    maxSize.x = Math.max(maxSize.x, size.x);
    maxSize.y = Math.max(maxSize.y, size.y);
  }
  return maxSize;
};

DocumentTab.prototype.getActivePanelIndex = function() {
  return this.activePanelIndex;
};

DocumentTab.prototype.expand = function() {
  if (this.isBodyExpanded) return;
  this.isBodyExpanded = true;
  this.el.removeChild(this.collapsedChromeEl);
  this.el.appendChild(this.expandedBodyEl);
};

DocumentTab.prototype.collapse = function() {
  if (!this.isBodyExpanded) return;
  this.isBodyExpanded = false;
  this.el.appendChild(this.collapsedChromeEl);
  this.el.removeChild(this.expandedBodyEl);
};

DocumentTab.prototype.getHeaderHeight = function() {
  return TAB_BAR_MIN_HEIGHT_PX + this.containerEl.getBoundingClientRect().height;
};

DocumentTab.prototype.resize = function(width, height) {
  this.tabBarEl.setAttribute("style", "max-width: " + width + "px");
  let tabBarHeight = 0;
  if (this.tabBarLayoutMode == 0) {
    tabBarHeight = this.tabBarEl.getBoundingClientRect().height;
    tabBarHeight = Math.max(tabBarHeight, TAB_BAR_MIN_HEIGHT_PX);
  }
  if (this.activePanelIndex != -1) this.panels[this.activePanelIndex].resize(width, height - tabBarHeight);
  return height - tabBarHeight;
};

DocumentTab.prototype.onUpdate = function(doc, updateKind) {
  if (this.activePanelIndex != -1) this.panels[this.activePanelIndex].onUpdate(doc, updateKind);
};

DocumentTab.prototype.open = function(doc, docs, appData) {
  this.panels[this.activePanelIndex].open(doc, docs, appData);
};

DocumentTab.prototype.attachPanel = function(panel) {
  this.removeEmptyStateWidget();
  const existingIndex = this.panels.indexOf(panel);
  if (existingIndex != -1) {
    this.selectPanelAt(existingIndex);
    return;
  }
  panel.parent = this;
  this.panels.push(panel);
  this.tabBarEl.appendChild(panel.tabEl);
  panel.tabEl.addEventListener("mouseover", this.onTabMouseOver, false);
  this.attachDragHandlers(panel.tabEl);
  this.collapsedChromeEl.appendChild(panel.sidebarBtn.el);
  panel.sidebarBtn.on("click", this.onSidebarBtnClick, this);
  panel.on("select", this.onPanelSelect, this);
  panel.on(EventType.layerEffectsFlush, this.onPanelCloseRequest, this);
  this.selectPanelAt(this.panels.length - 1);
};

DocumentTab.prototype.onTabMouseOver = function(evt) {
  if (evt.buttons == 0) return;
  const tabEl = evt.currentTarget;
  this.hoverTabIndex = siblingIndexAmongPrevious(tabEl);
  tabEl.addEventListener("mouseout", this.onTabMouseOut, false);
  this.hoverTimerId = setTimeout(this.onTabHoverTimeout, TAB_HOVER_REPAINT_MS);
};

DocumentTab.prototype.onTabMouseOut = function(evt) {
  const tabEl = evt.currentTarget;
  tabEl.removeEventListener("mouseout", this.onTabMouseOut);
  clearTimeout(this.hoverTimerId);
};

DocumentTab.prototype.onTabHoverTimeout = function() {
  this.dispatch(new AppEvent(EventType.chromeRepaint, false));
};

DocumentTab.prototype.getHoverTabIndex = function() {
  return this.hoverTabIndex;
};

DocumentTab.prototype.detachPanelAt = function(index) {
  const closeEvt = new AppEvent(EventType.layerEffectsFlush, false);
  closeEvt.data = {
    docTabIndex: index
  };
  this.dispatch(closeEvt);
  const panel = this.panels[index];
  this.panels.splice(index, 1);
  this.tabBarEl.removeChild(panel.tabEl);
  this.collapsedChromeEl.removeChild(panel.sidebarBtn.el);
  panel.tabEl.setAttribute("class", "");
  panel.sidebarBtn.removeEventListener("click", this.onSidebarBtnClick, this);
  panel.sidebarBtn.clearActive();
  panel.removeEventListener("activate", this.onPanelSelect);
  panel.removeEventListener(EventType.layerEffectsFlush, this.onPanelCloseRequest);
  const nextIndex = computeActiveIndexAfterDetach(this.activePanelIndex, index, this.panels.length);
  this.selectPanelAt(nextIndex);
  if (this.panels.length == 0) this.animateOut();
};

DocumentTab.prototype.getPanelCount = function() {
  return this.panels.length;
};

DocumentTab.prototype.dismissPanel = function() {
  if (this.panels.length != 0) this.panels[this.activePanelIndex].dismissPanel();
};

DocumentTab.prototype.selectPanelAt = function(index, dispatchSelect) {
  if (dispatchSelect == null) dispatchSelect = true;
  clearTabActiveClasses(this.panels);
  if (this.activePanelBodyEl) this.containerEl.removeChild(this.activePanelBodyEl);
  this.activePanelBodyEl = null;
  this.activePanelIndex = index;
  if (index == -1) return;
  const panel = this.panels[this.activePanelIndex];
  this.activePanelBodyEl = panel.panelBody;
  this.containerEl.appendChild(panel.panelBody);
  panel.tabEl.setAttribute("class", "active");
  if (!this.isBodyExpanded) {
    this.dispatch(new AppEvent("showFloat"));
    this.panels[index].sidebarBtn.markActive();
  }
  if (dispatchSelect) this.dispatch(new AppEvent(EventType.widgetSelect, false));
  panel.refresh();
  syncOptionsMenuForPanel(this, panel);
  dispatchDocumentLayoutInvalidate(this);
};

DocumentTab.prototype.onPanelSelect = function(evt) {
  if (this.hostController && !this.hostController.isDocumentViewIdle()) return;
  const index = this.panels.indexOf(evt.currentTarget);
  this.selectPanelAt(index);
};

DocumentTab.prototype.onPanelCloseRequest = function(evt) {
  if (this.hostController && !this.hostController.isDocumentViewIdle()) return;
  const index = this.panels.indexOf(evt.currentTarget);
  this.detachPanelAt(index);
};

DocumentTab.prototype.onSidebarBtnClick = function(evt) {
  const index = this.panels.indexOf(evt.currentTarget.parent);
  const panel = this.panels[index];
  // Panels that want a click on their sidebar icon to open a floating
  // modal (instead of expanding the panel body inline) can define an
  // `onSidebarClick` method. See WebImagesPanel → WebImagesDialog.
  if (typeof panel.onSidebarClick === "function") {
    panel.onSidebarClick();
    return;
  }
  if (panel.sidebarBtn.isPressed()) this.dispatch(new AppEvent("hideFloat"));
  else this.selectPanelAt(index);
};

DocumentTab.prototype.relayEvent = function(evt) {
  this.dispatch(evt);
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function siblingIndexAmongPrevious(el) {
  let sibling = el;
  let index = 0;
  while ((sibling = sibling.previousSibling) != null) index++;
  return index;
}

function resolveDropTargetPanelIndex(tabStrip, target) {
  const tabIndex = tabStrip.indexOfTabElement(target);
  if (target == tabStrip.containerEl && tabStrip.activePanelIndex != -1) return tabStrip.activePanelIndex;
  if (target == tabStrip.tabBarEl) return null;
  if (tabIndex != -1) return tabIndex;
  return null;
}

function reorderPanelsFromTabDrop(tabStrip, evt) {
  const target = evt.currentTarget;
  const tabIndex = tabStrip.indexOfTabElement(target);
  const pos = getEventPos(evt, target);
  const panels = tabStrip.panels;
  const orderBefore = panels.slice(0);
  const fromIndex = tabStrip.activePanelIndex;
  const insertAt = tabIndex == -1
    ? panels.length
    : pos.x < target.getBoundingClientRect().width / 2
      ? tabIndex
      : tabIndex + 1;
  if (fromIndex == insertAt || fromIndex + 1 == insertAt || target == tabStrip.containerEl) return;
  const toIndex = fromIndex < insertAt ? insertAt - 1 : insertAt;
  const moved = panels[fromIndex];
  panels.splice(fromIndex, 1);
  panels.splice(toIndex, 0, moved);
  clearElement(tabStrip.tabBarEl);
  for (let pi = 0; pi < panels.length; pi++) tabStrip.tabBarEl.appendChild(panels[pi].tabEl);
  tabStrip.selectPanelAt(toIndex);
  const reorderMap = [];
  for (let pi = 0; pi < panels.length; pi++) reorderMap[pi] = orderBefore.indexOf(panels[pi]);
  const reorderEvt = new AppEvent("shuffleItems", false);
  reorderEvt.data = {
    tabReorderIndices: reorderMap
  };
  tabStrip.dispatch(reorderEvt);
}

function dispatchCrossDocumentLayerDrop(tabStrip, dropTargetIndex) {
  const crossDocEvt = new AppEvent(EventType.uiDispatch, true);
  crossDocEvt.data = {
    dispatchKind: UiCommand.dragLayerAcrossDocuments,
    targetDocumentTabIndex: dropTargetIndex
  };
  tabStrip.dispatch(crossDocEvt);
}

function computeActiveIndexAfterDetach(activeIndex, detachedIndex, panelCountAfter) {
  let nextIndex = activeIndex;
  if (detachedIndex < nextIndex) nextIndex--;
  else if (detachedIndex == nextIndex && nextIndex == panelCountAfter) nextIndex--;
  return nextIndex;
}

function clearTabActiveClasses(panels) {
  for (let pi = 0; pi < panels.length; pi++) panels[pi].tabEl.setAttribute("class", "");
}

function syncOptionsMenuForPanel(tabStrip, panel) {
  const menuEl = tabStrip.optionsMenuBtn.el;
  if (menuEl.parentNode) tabStrip.tabBarEl.removeChild(menuEl);
  if (panel.getEditorMode()) tabStrip.tabBarEl.appendChild(menuEl);
}

function dispatchDocumentLayoutInvalidate(tabStrip) {
  const layoutEvt = new AppEvent(EventType.uiDispatch, true);
  layoutEvt.data = {
    dispatchKind: UiCommand.documentLayoutInvalidate
  };
  tabStrip.dispatch(layoutEvt);
}

export { DocumentTab };
