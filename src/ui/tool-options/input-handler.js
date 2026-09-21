/**
 * Context and overflow menus: parallel item and action descriptor arrays that
 * mirror `AppEvent` dispatch fields when a row is activated.
 */

import { Locale } from "../../core/i18n/locale.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { BaseWidget } from "../widgets/base-widget.js";
import { getIconUrl, iconImgHtml } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { clearElement, makeElement, preventDomDefaultAction } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Hover delay before opening a nested submenu (ms). */
const SUBMENU_OPEN_DELAY_MS = 300;

/**
 * Context / overflow menu: parallel arrays of item descriptors and dispatch
 * descriptors. Each dispatch entry mirrors AppEvent fields: appEventType,
 * optional documentModelType, optional payload.
 * @param {Array<Object>} menuItemDescriptors
 * @param {Array<Object>|null|undefined} menuActionDescriptors
 */
function InputHandler(menuItemDescriptors, menuActionDescriptors) {
  BaseWidget.call(this);
  this.openSubmenuOverlay = null;
  this.onRowPointerUp = this.onDragEnd.bind(this);
  this.onRowPointerEnter = this.onRowPointerEnterDeferredOpen.bind(this);
  this.onRowPointerLeave = this.onRowPointerLeaveClearTimer.bind(this);
  this.openSubmenuAfterDelay = this.openSubmenuAfterDelay.bind(this);
  this.selectedPathFromRoot = [];
  this.rowElements = [];
  this.labelElements = [];
  this.checkmarkElements = [];
  this.el = makeElement("div", "contextpanel");
  this.el.addEventListener("contextmenu", preventDomDefaultAction, false);
  this.submenuOpenTimerId = null;
  this.pendingSubmenuRowIndex = 0;
  this.menuItemDescriptors = menuItemDescriptors;
  this.menuActionDescriptors = menuActionDescriptors;
  this.nestedHandlers = [];
  mountMenuRows(this, menuItemDescriptors, menuActionDescriptors);
}

InputHandler.prototype = Object.create(BaseWidget.prototype);

InputHandler.prototype.applyRowVisibility = function(visibilityRowStates) {
  clearElement(this.el);
  for (let rowIndex = 0; rowIndex < visibilityRowStates.length; rowIndex++) {
    if (!isVisibleMenuRowState(visibilityRowStates[rowIndex])) continue;
    this.el.appendChild(this.rowElements[rowIndex]);
    if (
      shouldApplyNestedVisibility(visibilityRowStates[rowIndex]) &&
      this.nestedHandlers[rowIndex]
    ) {
      this.nestedHandlers[rowIndex].applyRowVisibility(visibilityRowStates[rowIndex]);
    }
  }
};

InputHandler.prototype.buildUI = function() {
  const items = this.menuItemDescriptors;
  for (let rowIndex = 0; rowIndex < items.length; rowIndex++) {
    if (items[rowIndex].title) {
      this.rowElements[rowIndex].title = Locale.get(items[rowIndex].title);
    }
    this.labelElements[rowIndex].textContent = formatMenuRowLabel(items[rowIndex]);
  }
  for (let nestedIdx = 0; nestedIdx < this.nestedHandlers.length; nestedIdx++) {
    if (this.nestedHandlers[nestedIdx]) this.nestedHandlers[nestedIdx].buildUI();
  }
};

InputHandler.prototype.update = function(doc, appData) {
  const items = this.menuItemDescriptors;
  for (let rowIndex = 0; rowIndex < items.length; rowIndex++) {
    if (items[rowIndex].resolveRowState) {
      applyResolvedRowState(
        this,
        rowIndex,
        items[rowIndex].resolveRowState(doc, appData, rowIndex)
      );
    }
  }
  for (let nestedIdx = 0; nestedIdx < this.nestedHandlers.length; nestedIdx++) {
    if (this.nestedHandlers[nestedIdx]) {
      this.nestedHandlers[nestedIdx].update(doc, appData);
    }
  }
};

InputHandler.prototype.getSelectedIndices = function() {
  return this.selectedPathFromRoot;
};

InputHandler.prototype.onDragEnd = function(evt) {
  if (evt.button != 0) return;
  const rowIndex = this.rowElements.indexOf(evt.currentTarget);
  if (this.nestedHandlers[rowIndex]) {
    this.pendingSubmenuRowIndex = rowIndex;
    this.openSubmenuAfterDelay();
    return
  }
  dispatchLeafMenuAction(this, rowIndex);
  this.openSubmenuOverlay = null;
  this.selectedPathFromRoot = [rowIndex];
  this.dispatch(new AppEvent("select", false));
  const closePopupsEvt = new AppEvent(EventType.uiDispatch, true);
  closePopupsEvt.data = {
    dispatchKind: UiCommand.removeScrollableOverlayPopups
  };
  this.dispatch(closePopupsEvt);
};

InputHandler.prototype.onRowPointerEnterDeferredOpen = function(evt) {
  const rowIndex = this.rowElements.indexOf(evt.currentTarget);
  clearSubmenuOpenTimer(this);
  if (this.nestedHandlers[rowIndex] == null) return;
  this.pendingSubmenuRowIndex = rowIndex;
  this.submenuOpenTimerId = setTimeout(this.openSubmenuAfterDelay, SUBMENU_OPEN_DELAY_MS);
};

InputHandler.prototype.onRowPointerLeaveClearTimer = function() {
  clearSubmenuOpenTimer(this);
};

InputHandler.prototype.openSubmenuAfterDelay = function() {
  clearSubmenuOpenTimer(this);
  const rowIndex = this.pendingSubmenuRowIndex;
  if (this.openSubmenuOverlay) this.openSubmenuOverlay.dismissFloatingOverlay();
  this.openSubmenuOverlay = this.nestedHandlers[rowIndex];
  const rowRect = this.rowElements[rowIndex].getBoundingClientRect(),
    showFloating = new AppEvent(EventType.uiDispatch, true);
  showFloating.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: this.nestedHandlers[rowIndex],
    x: rowRect.left + rowRect.width + 2,
    y: rowRect.top
  };
  this.dispatch(showFloating);
};

InputHandler.prototype.dismissFloatingOverlay = function() {
  for (let rowIndex = 0; rowIndex < this.nestedHandlers.length; rowIndex++) {
    if (this.nestedHandlers[rowIndex]) {
      this.nestedHandlers[rowIndex].dismissFloatingOverlay();
    }
  }
  const closeFloating = new AppEvent(EventType.uiDispatch, true);
  closeFloating.data = {
    dispatchKind: UiCommand.closeFloatingOverlay,
    overlayWidget: this
  };
  this.dispatch(closeFloating);
};

InputHandler.prototype.onNestedSelect = function(evt) {
  const rowIndex = this.nestedHandlers.indexOf(evt.target);
  this.selectedPathFromRoot = [rowIndex].concat(evt.target.getSelectedIndices());
  this.dispatch(new AppEvent("select", false));
};

/**
 * Build DOM rows, checkmarks/icons, shortcuts, and nested InputHandlers.
 */
function mountMenuRows(handler, menuItemDescriptors, menuActionDescriptors) {
  for (let rowIndex = 0; rowIndex < menuItemDescriptors.length; rowIndex++) {
    const item = menuItemDescriptors[rowIndex],
      rowEl = makeElement("div", "enab");
    handler.rowElements.push(rowEl);
    handler.el.appendChild(rowEl);
    if (item.iconId) {
      const thumbImg = makeElement("img", "thumb");
      thumbImg.setAttribute("src", getIconUrl(item.iconId));
      rowEl.appendChild(thumbImg);
    } else {
      const checkSpan = makeElement("span", "check");
      handler.checkmarkElements.push(checkSpan);
      rowEl.appendChild(checkSpan);
    }
    const labelSpan = makeElement("span", "label");
    labelSpan.innerHTML = Locale.get(item.name);
    rowEl.appendChild(labelSpan);
    handler.labelElements.push(labelSpan);
    if (item.separatorAfter) handler.el.appendChild(makeElement("hr"));
    if (item.shortcut || item.sub) {
      const rightSpan = makeElement("span", "right");
      rowEl.appendChild(rightSpan);
      if (item.shortcut) {
        rightSpan.innerHTML = KeyboardHandler.formatShortcut(item.shortcut);
      }
      if (item.sub) rightSpan.innerHTML = iconImgHtml("ui/submenu", "", "submenu-arrow");
    }
    rowEl.addEventListener("click", handler.onRowPointerUp, false);
    rowEl.addEventListener("mouseover", handler.onRowPointerEnter, true);
    rowEl.addEventListener("mouseout", handler.onRowPointerLeave, true);
    if (item.sub) {
      const nested = new InputHandler(
        item.sub,
        menuActionDescriptors ? menuActionDescriptors[rowIndex].sub : null
      );
      nested.parent = handler;
      handler.nestedHandlers.push(nested);
      nested.on("select", handler.onNestedSelect, handler);
    } else {
      handler.nestedHandlers.push(null);
    }
  }
}

/**
 * Visibility state: 0/null hide; 1 show leaf; nested arrays recurse.
 * @param {*} visibilityState
 * @returns {boolean}
 */
function isVisibleMenuRowState(visibilityState) {
  return visibilityState != 0 && visibilityState != null
}

function shouldApplyNestedVisibility(visibilityState) {
  return visibilityState != 1
}

/**
 * @param {{ name: *, opensDialog?: boolean }} item
 * @returns {string}
 */
function formatMenuRowLabel(item) {
  return Locale.get(item.name) + (item.opensDialog ? "..." : "")
}

function applyResolvedRowState(handler, rowIndex, state) {
  if (state.enabled != null) {
    handler.rowElements[rowIndex].setAttribute("class", state.enabled ? "enab" : "disab");
  }
  if (state.labelOverride != null) {
    handler.labelElements[rowIndex].textContent = state.labelOverride;
  }
  if (state.checked != null) {
    handler.checkmarkElements[rowIndex].textContent = state.checked ? "\u2713" : "";
  }
}

/**
 * Normalize a leaf menu action into AppEvent fields (same contract as menu-action-dispatch).
 * @param {{ appEventType?: *, documentModelType?: *, payload?: * }} action
 * @returns {{ appEventType: *, routingChannel: *, payload: * }}
 */
function readContextMenuActionFields(action) {
  return {
    appEventType: action.appEventType != null ? action.appEventType : null,
    routingChannel:
      action.documentModelType !== undefined ? action.documentModelType : null,
    payload: action.payload !== undefined ? action.payload : undefined
  }
}

function dispatchLeafMenuAction(handler, rowIndex) {
  if (!handler.menuActionDescriptors) return;
  const fields = readContextMenuActionFields(handler.menuActionDescriptors[rowIndex]),
    dispatched = new AppEvent(fields.appEventType, true);
  dispatched.routingChannel = fields.routingChannel != null ? fields.routingChannel : null;
  if (fields.payload !== undefined) dispatched.data = fields.payload;
  handler.dispatch(dispatched);
}

function clearSubmenuOpenTimer(handler) {
  if (handler.submenuOpenTimerId) {
    clearTimeout(handler.submenuOpenTimerId);
    handler.submenuOpenTimerId = null;
  }
}

export {
  InputHandler,
  formatMenuRowLabel,
  isVisibleMenuRowState,
  shouldApplyNestedVisibility,
  readContextMenuActionFields,
  SUBMENU_OPEN_DELAY_MS
};
