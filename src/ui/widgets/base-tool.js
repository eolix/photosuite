/**
 * Base class for dockable right-sidebar panels (Layers, History, Channels, …).
 *
 * Owns the tab strip, collapsed-sidebar icon, optional close control, panel
 * body, and context menu. Subclasses fill `panelBody` and override
 * `open` / `onUpdate` / `refresh` / `resize`.
 */

import { BaseWidget } from "./base-widget.js";

import { Point } from "../../core/math/point.js";
import { Locale } from "../../core/i18n/locale.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { InputHandler } from "../tool-options/input-handler.js";
import { PopupTypes } from "../config/popup-types.js";
import { Button } from "./form-controls.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { cancel, clearElement, getEventPos, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/**
 * Base class for dockable right-sidebar panels (Layers, History, Channels, …).
 *
 * Owns the tab strip (tabEl), collapsed-sidebar icon button (sidebarBtn),
 * optional close control (closeBtn), panel body (panelBody), and a small
 * right-click context menu (contextMenu). Subclasses fill panelBody and
 * override open / onUpdate / refresh / resize as needed.
 *
 * @param {string} labelKey Locale key (or English fallback) on the panel tab.
 * @param {boolean} showClose Render the close cross on the tab.
 * @param {string} iconSrc Icon URL for the collapsed sidebar; when null, a
 *   short text label is derived from labelKey.
 * @param {string} panelId Stable id from BaseTool.PanelId.
 * @param {boolean} themedIcon When true, the icon img gets the gsicon class so
 *   the theme invert filter tints it. Defaults false for full-color plugin icons.
 */
function BaseTool(labelKey, showClose, iconSrc, panelId, themedIcon) {
  BaseWidget.call(this);
  this.name = labelKey;
  this.iconSrc = iconSrc;
  this.themedIcon = themedIcon === true;
  this.panelId = panelId;
  this.expanded = false;
  installPanelChrome(this, showClose);
}

BaseTool.prototype = Object.create(BaseWidget.prototype);

BaseTool.prototype.getEditorMode = function() {
  return null
};

BaseTool.prototype.getPreferredSize = function() {
  return new Point(0, 0);
};

BaseTool.prototype.buildUI = function() {
  const resolvedToolName = Locale.get(this.name),
    label =
      resolvedToolName == null
        ? ""
        : typeof resolvedToolName === "string"
          ? resolvedToolName
          : String(resolvedToolName),
    layout = computePanelTabLabelLayout(label, this.labelLayoutWidthPx);
  this.labelEl.textContent = layout.displayText;
  if (layout.truncate) appendTruncationFadeChars(this.labelEl, label, layout.maxChars);
  applySidebarButtonIcon(this, label, buildShortSidebarLabel(label));
};

BaseTool.prototype.enable = function() {
  this.panelBody.setAttribute("class", "pbody")
};

BaseTool.prototype.disable = function() {
  this.panelBody.setAttribute("class", "pbody disabled")
};

BaseTool.prototype.onUpdate = function(doc, popupType) {};
BaseTool.prototype.open = function(layerOrDoc, doc, mode) {};
BaseTool.prototype.broadcastMessage = function(payload) {};
BaseTool.prototype.resize = function(width, height) {};

BaseTool.prototype.setName = function(name) {
  this.name = name;
  this.buildUI()
};

BaseTool.prototype.refresh = function() {};

BaseTool.prototype.onTabMouseDown = function(evt) {
  if (evt.button == 0) this.dispatch(new AppEvent("select", false))
};

BaseTool.prototype.onContextMenu = function(evt) {
  cancel(evt);
  if (this.panelId != null && isNaN(this.panelId)) return;
  const pos = getEventPos(evt, document.body),
    menu = this.contextMenu;
  menu.update(null);
  menu.buildUI();
  menu.parent = this;
  const showEvt = new AppEvent(EventType.uiDispatch, true);
  showEvt.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: menu,
    x: pos.x + 1,
    y: pos.y + 1
  };
  this.dispatch(showEvt)
};

BaseTool.prototype.dismissPanel = function() {
  this.closePanel({})
};

BaseTool.prototype.closePanel = function(evt) {
  if (evt.stopPropagation) evt.stopPropagation();
  if (this.panelId != null && !isNaN(this.panelId)) {
    dispatchCloseNumericPanel(this);
  } else if (this.canClose()) {
    this.dispatch(new AppEvent(EventType.layerEffectsFlush, false))
  }
};

BaseTool.prototype.canClose = function() {
  return true
};

BaseTool.prototype.onMouseDown = function(evt, doc, mode, view, pos) {};
BaseTool.prototype.onMouseMove = function(evt, doc, mode, view, pos) {};
BaseTool.prototype.onMouseUp = function(evt, doc, mode, view, pos) {};

/**
 * Inline-rename input: replaces a label with a text field. Calls onConfirm with
 * the new value on Enter or outside-click; restores original text on Escape.
 */
BaseTool.InlineRenameInput = function(targetEl, onConfirm, onClose) {
  if (targetEl.childElementCount != 0) return;
  const originalText = targetEl.textContent;
  this.onKeyUpHandler = this.onKeyUp.bind(this);
  this.onOutsideMouseDownHandler = this.onOutsideMouseDown.bind(this);
  this.onConfirm = onConfirm;
  this.onClose = onClose;
  this.targetEl = targetEl;
  this.originalText = originalText;
  const inputEl = makeElement("input", "");
  inputEl.setAttribute("type", "text");
  inputEl.setAttribute("size", "10");
  inputEl.setAttribute("value", originalText);
  clearElement(targetEl);
  targetEl.appendChild(inputEl);
  inputEl.select();
  inputEl.focus();
  targetEl.addEventListener("keyup", this.onKeyUpHandler, false);
  document.body.addEventListener("mousedown", this.onOutsideMouseDownHandler, false)
};

BaseTool.InlineRenameInput.prototype.onKeyUp = function(evt) {
  const hasKeyCode = KeyboardHandler.hasKeyCode,
    commit = hasKeyCode(evt.code, KeyboardHandler.Enter);
  if (hasKeyCode(evt.code, KeyboardHandler.Escape) || commit) this.finish(commit)
};

BaseTool.InlineRenameInput.prototype.onOutsideMouseDown = function(evt) {
  const target = evt.target;
  if (target.tagName && target.tagName.toLowerCase() == "input") return;
  this.finish(true)
};

BaseTool.InlineRenameInput.prototype.finish = function(commit) {
  const target = this.targetEl;
  target.removeEventListener("keyup", this.onKeyUpHandler);
  document.body.removeEventListener("mousedown", this.onOutsideMouseDownHandler);
  if (commit) {
    const value = target.firstChild.value;
    this.onConfirm(value)
  } else {
    clearElement(target);
    target.textContent = this.originalText
  }
  if (this.onClose) this.onClose()
};

/**
 * Stable panel ids for RightSidebar layout and prefs. String values are the
 * wire format persisted as numbers in appData.effectRows — do not change values
 * without a migration. Keys may be renamed.
 *
 * Slots 0-20: built-in panels. Slots 100+: launcher / iframe panels.
 */
BaseTool.PanelId = {
  HISTORY: "0",
  SWATCHES: "1",
  LAYERS: "2",
  INFO: "3",
  HISTOGRAM: "4",
  PROPERTIES: "5",
  CSS: "6",
  BRUSH: "7",
  LAYER_COMPS: "8",
  CHARACTER: "9",
  PARAGRAPH: "10",
  ACTIONS: "11",
  NAVIGATOR: "12",
  COLOR: "13",
  TOOL_PRESETS: "14",
  GUIDES: "15",
  CHANNELS: "16",
  PATHS: "17",
  GLYPHS: "19",
  MEMORY: "20",
  WEB_IMAGES: "101"
};

function installPanelChrome(panel, showClose) {
  const contextMenuHandler = panel.onContextMenu.bind(panel);
  panel.tabEl = makeElement("div", "");
  panel.tabEl.setAttribute("draggable", "true");
  panel.panelBody = makeElement("div", "pbody");
  panel.sidebarBtn = new Button("", false, "");
  panel.sidebarBtn.parent = panel;
  panel.closeBtn = makeElement("span", "cross");
  panel.labelEl = makeElement("span", "label");
  panel.tabEl.addEventListener("mousedown", panel.onTabMouseDown.bind(panel), false);
  panel.tabEl.addEventListener("contextmenu", contextMenuHandler, false);
  panel.sidebarBtn.el.addEventListener("contextmenu", contextMenuHandler, false);
  panel.closeBtn.addEventListener("mousedown", panel.closePanel.bind(panel), false);
  panel.tabEl.appendChild(panel.labelEl);
  if (showClose) panel.tabEl.appendChild(panel.closeBtn);
  panel.contextMenu = new InputHandler([{ name: "file.close" }]);
  panel.contextMenu.on("select", panel.closePanel, panel);
  panel.labelEl.textContent = panel.name;
}

/**
 * @param {string} label
 * @param {number|undefined} labelLayoutWidthPx
 * @returns {{ displayText: string, truncate: boolean, maxChars: number }}
 */
function computePanelTabLabelLayout(label, labelLayoutWidthPx) {
  const maxChars =
      labelLayoutWidthPx == 0 ? 22 : Math.round(2 + labelLayoutWidthPx / 50),
    truncate = label.length > maxChars;
  return {
    displayText: truncate ? label.slice(0, maxChars - 2) : label,
    truncate: truncate,
    maxChars: maxChars
  }
}

function appendTruncationFadeChars(labelEl, label, maxChars) {
  for (let i = 0; i < 2; i++) {
    const fadeChar = makeElement("span");
    fadeChar.textContent = label.charAt(maxChars - 2 + i);
    fadeChar.setAttribute("style", "opacity:" + (0.6 - i * 0.4));
    labelEl.appendChild(fadeChar)
  }
}

/**
 * Compact sidebar caption when no icon URL is set.
 * @param {string} label
 * @returns {string}
 */
function buildShortSidebarLabel(label) {
  const words = label.split(" ");
  let shortLabel =
    words.length == 2
      ? words[0].substring(0, 2) + words[1][0]
      : label.substring(0, 3);
  if (shortLabel.charCodeAt(0) >= 11776) shortLabel = shortLabel.substring(0, 1);
  return shortLabel
}

function applySidebarButtonIcon(panel, label, shortLabel) {
  const icon = panel.iconSrc;
  if (icon == null) {
    panel.sidebarBtn.setLabel(shortLabel, label);
    return
  }
  if (icon.indexOf("\"") == -1) {
    // gsicon applies the theme-aware invert filter (all.css). Monochrome panel
    // icons opt in; plugin / iframe icons stay full-color.
    const iconClass = panel.themedIcon ? " class=\"gsicon\"" : "";
    panel.sidebarBtn.setLabel(
      "<img src=\"" + icon + "\" alt=\"" + label + "\" height=\"20\"" + iconClass + " />",
      label
    )
  }
}

function dispatchCloseNumericPanel(panel) {
  const msg = new AppEvent(EventType.uiDispatch, true);
  msg.data = {
    dispatchKind: UiCommand.closeFloatingOverlay,
    overlayWidget: panel.contextMenu
  };
  panel.dispatch(msg);
  msg.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.FONTS,
    value: parseFloat(panel.panelId),
    scriptHostData: "del"
  };
  panel.dispatch(msg)
}

export {
  BaseTool,
  computePanelTabLabelLayout,
  buildShortSidebarLabel
};
