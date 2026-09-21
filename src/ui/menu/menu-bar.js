/**
 * In-window HTML menu strip: top-level buttons, lazy {@link InputHandler} dropdowns,
 * and command-palette search affordance.
 */

import { Locale } from "../../core/i18n/locale.js";
import { PopupTypes } from "../config/popup-types.js";
import { InputHandler } from "../tool-options/input-handler.js";
import { Button } from "../widgets/form-controls.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addPointerDownListener, clearElement, isInDOM, makeElement } from "../../core/dom.js";
import { iconImgHtml } from "../../assets/icon-registry.js";
import { AppEvent } from "../../core/event-bus.js";

/**
 * The in-window HTML menu strip. Renders one top-level button per
 * {@link MenuBar.data} entry (File, Edit, Image, …) plus a search button that
 * opens the command palette. Each button's dropdown is an {@link InputHandler}
 * built lazily on first hover/press from that entry's `items` / `menuActions`.
 * On macOS the shell installs a native menu bar instead and this strip is
 * hidden (see `tauri-menu-bridge.js`).
 */
function MenuBar() {
  BaseWidget.call(this);
  this.el = makeElement("div", "topbar");
  this.menuButtonsHost = makeElement("span", "");
  this.lastOpenMenuIndex = 0;
  this.el.appendChild(this.menuButtonsHost);
  this.menuContextDoc = null;
  this.menuContextAppData = null;
  this.topLevelMenuButtons = [];
  /** Lazily built {@link InputHandler} dropdown, one per {@link MenuBar.data} entry. */
  this.menuDropdowns = [];
  const boundOnDragStart = this.onDragStart.bind(this);
  for (let menuIdx = 0; menuIdx < MenuBar.data.length; menuIdx++) {
    const menuButtonEl = makeElement("button");
    this.topLevelMenuButtons.push(menuButtonEl);
    this.menuButtonsHost.appendChild(menuButtonEl);
    menuButtonEl.addEventListener("mouseover", boundOnDragStart, false);
    addPointerDownListener(menuButtonEl, boundOnDragStart);
  }
  this.searchButton = new Button(
    iconImgHtml("tools/zoom", null, "autoscale"),
    false,
    "properties.find"
  );
  this.searchButton.on("click", this.onOpenCommandPaletteClick, this);
  this.el.appendChild(this.searchButton.el);
}
MenuBar.prototype = Object.create(BaseWidget.prototype);

MenuBar.prototype.ensureMenuDropdownsInitialized = function() {
  if (this.menuDropdowns.length !== 0) return;
  for (let menuIdx = 0; menuIdx < MenuBar.data.length; menuIdx++) {
    const menuRoot = MenuBar.data[menuIdx];
    const menuDropdown = new InputHandler(menuRoot.items, menuRoot.menuActions);
    menuDropdown.parent = this;
    this.menuDropdowns.push(menuDropdown);
  }
  this.buildUI();
};

MenuBar.prototype.buildUI = function() {
  this.searchButton.buildUI();
  for (let menuIdx = 0; menuIdx < this.topLevelMenuButtons.length; menuIdx++) {
    this.topLevelMenuButtons[menuIdx].textContent = Locale.get(MenuBar.data[menuIdx].name);
  }
  this.refreshVisibleMenuButtons();
  for (let menuIdx = 0; menuIdx < this.menuDropdowns.length; menuIdx++) {
    this.menuDropdowns[menuIdx].buildUI();
  }
};

MenuBar.prototype.onOpenCommandPaletteClick = function() {
  dispatchCommandPaletteOpen(this);
};

MenuBar.prototype.setMenuContext = function(currentDoc, appData) {
  this.menuContextDoc = currentDoc;
  this.menuContextAppData = appData;
};

MenuBar.prototype.onUpdate = function(appData, popupType) {
  this.menuContextAppData = appData;
  if (popupType == PopupTypes.ALL) {
    rebuildTopLevelButtonsFromVisibility(this, appData.menuVisibility);
  }
  if (shouldRefreshDropdownsForPopup(popupType) && this.menuDropdowns.length !== 0) {
    refreshAllMenuDropdowns(this);
  }
  this.refreshVisibleMenuButtons();
};

MenuBar.prototype.refreshVisibleMenuButtons = function() {};

MenuBar.prototype.onDragStart = function(pointerEvent) {
  this.ensureMenuDropdownsInitialized();
  const menuIndex = this.topLevelMenuButtons.indexOf(pointerEvent.currentTarget);
  const menuDropdown = this.menuDropdowns[menuIndex];
  if (pointerEvent.type == "mouseover" && !isInDOM(this.menuDropdowns[this.lastOpenMenuIndex].el)) {
    return;
  }
  if (isInDOM(menuDropdown.el)) return;
  pointerEvent.skipOverlayDismiss = true;
  this.lastOpenMenuIndex = menuIndex;
  refreshAllMenuDropdowns(this);
  dispatchMenuDropdownOverlay(this, menuDropdown, pointerEvent.target);
};

/** Filled at startup by {@link ui.js} via `createMenuBarData(() => RightSidebar.panelRegistry)`. */
MenuBar.data = [];

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function dispatchCommandPaletteOpen(menuBar) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = { dispatchKind: UiCommand.openCommandPaletteSearch };
  menuBar.dispatch(uiEvent);
}

function shouldRefreshDropdownsForPopup(popupType) {
  return popupType == PopupTypes.FONTS
    || popupType == PopupTypes.CHANGE_THEME
    || popupType == PopupTypes.CHANGE_LANGUAGE;
}

function refreshAllMenuDropdowns(menuBar) {
  for (let dropdownIdx = 0; dropdownIdx < MenuBar.data.length; dropdownIdx++) {
    menuBar.menuDropdowns[dropdownIdx].update(menuBar.menuContextDoc, menuBar.menuContextAppData);
  }
}

function rebuildTopLevelButtonsFromVisibility(menuBar, menuVisibility) {
  clearElement(menuBar.menuButtonsHost);
  for (let menuIdx = 0; menuIdx < menuBar.topLevelMenuButtons.length; menuIdx++) {
    if (menuVisibility == null || menuVisibility[menuIdx] == 1 || menuVisibility[menuIdx] instanceof Array) {
      menuBar.menuButtonsHost.appendChild(menuBar.topLevelMenuButtons[menuIdx]);
    }
    if (menuVisibility != null && menuVisibility[menuIdx] instanceof Array) {
      menuBar.ensureMenuDropdownsInitialized();
      menuBar.menuDropdowns[menuIdx].applyRowVisibility(menuVisibility[menuIdx]);
    }
  }
  menuBar.el.removeChild(menuBar.searchButton.el);
  menuBar.el.appendChild(menuBar.searchButton.el);
}

function dispatchMenuDropdownOverlay(menuBar, menuDropdown, anchorEl) {
  const buttonRect = anchorEl.getBoundingClientRect();
  const overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: menuDropdown,
    x: buttonRect.left,
    y: buttonRect.top + buttonRect.height + 2,
    pinToAnchorY: true
  };
  menuBar.dispatch(overlayEvent);
}

export { MenuBar };
