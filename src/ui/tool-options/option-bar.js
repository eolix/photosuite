/**
 * Vertical tool strip (ToolBar), tool buttons (MenuButton), and shared sidebar
 * chrome (SideBar).
 */


import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { ToolId } from "../../document/model/tool-base.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { Button, VirtualList } from "../widgets/form-controls.js";
import { RadioOption } from "../widgets/controls/popup-controls.js";
import { InputHandler } from "./input-handler.js";
import { getIconUrl, iconImgHtml } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addPointerDownListener, clearElement, getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/**
 * Preferred merge order when the toolbar must fit fewer rows than tool groups.
 * Pairs are [fromIndex, intoIndex] — tools at intoIndex concatenate onto fromIndex.
 */
/** Vertical pitch of one tool button, including its margins. */
const TOOLBAR_BUTTON_STRIDE_PX = 32;
/** Width of one column of the tool strip. */
const TOOLBAR_COLUMN_WIDTH_PX = 34;
/** Height taken by the colour list and the quick-mask / virtual-keys button. */
const TOOLBAR_CHROME_HEIGHT_PX = 39 + 23;
/**
 * Columns the strip may fill before it starts merging groups. Wrapping keeps
 * every group reachable at a glance; merging hides tools behind a flyout, so it
 * is the later resort. Past this the layout still adds columns as needed — a
 * capped layout would clip the overflow rather than show it.
 */
const TOOLBAR_MERGE_FREE_COLUMNS = 2;
/** Below this the strip is scaled down rather than given another column. */
const TOOLBAR_MIN_SCALE = 0.75;

const TOOLBAR_ROW_MERGE_PAIRS = [
  1, 2, 4, 5, 7, 8, 7, 9, 11, 12, 14, 15, 14, 16, 10, 11, 1, 3, 17, 18, 7, 6, 13, 14
];

const LONG_PRESS_MOVER_MS = 160;
const VIRTUAL_KEY_CODES = ["ControlLeft", "AltLeft", "ShiftLeft", "NoTouch"];

/**
 * Collapsible sidebar chrome with a toggle strip.
 * @param {string|null|undefined} cssClass
 */
/** Height of the collapse handle; mirrors `.sbar > .top` in all.css. */
const TOGGLE_HANDLE_HEIGHT_PX = 14;

/**
 * Double chevron marking the collapse handle. Inline rather than an `<img>`
 * so the stroke follows the handle's colour through its hover transition. It
 * always points right; the stylesheet mirrors it for the strip's side and
 * collapsed state.
 */
const COLLAPSE_CHEVRONS_SVG =
  "<svg viewBox=\"0 0 24 24\" width=\"12\" height=\"12\" fill=\"none\"" +
  " stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"" +
  " stroke-linejoin=\"round\"><path d=\"M7 7l5 5l-5 5\" />" +
  "<path d=\"M13 7l5 5l-5 5\" /></svg>";

function SideBar(cssClass) {
  BaseWidget.call(this);
  if (cssClass == null) return;
  this.cachedWidth = null;
  this.cachedHeight = null;
  this.el = makeElement("div", "sbar" + " " + cssClass);
  // Collapse handle. Its chevrons point the way the strip will move: out to
  // the window edge to collapse, back toward the canvas to expand.
  this.toggleEl = makeElement("div", "top");
  this.toggleEl.innerHTML = COLLAPSE_CHEVRONS_SVG;
  this.toggleEl.setAttribute("title", Locale.get("properties.collapsePanels"));
  this.el.appendChild(this.toggleEl);
  this.expandedFlag = 1;
  this.toggleEl.addEventListener("click", this.onToggleClick.bind(this), false);
}

SideBar.prototype = Object.create(BaseWidget.prototype);

SideBar.prototype.onToggleClick = function() {
  if (this.cachedWidth != null && this.cachedWidth < 500 && this.expandedFlag == 0) return;
  if (this.expandedFlag == 0) this.expand(true);
  else this.collapse(true);
};

SideBar.prototype.setExpandedVisual = function(expanded) {
  this.expandedFlag = expanded;
  this.toggleEl.setAttribute("class", this.expandedFlag == 0 ? "top collapsed" : "top");
  this.toggleEl.setAttribute(
    "title",
    Locale.get(this.expandedFlag == 0 ? "properties.expandPanels" : "properties.collapsePanels"),
  );
};

SideBar.prototype.dispatchLayoutInvalidate = function() {
  const evt = new AppEvent(EventType.uiDispatch, true);
  evt.data = {
    dispatchKind: UiCommand.documentLayoutInvalidate
  };
  this.dispatch(evt);
};

SideBar.prototype.expand = function(notifyLayout) {
  this.setExpandedVisual(1);
  if (notifyLayout) this.dispatchLayoutInvalidate();
};

SideBar.prototype.collapse = function(notifyLayout) {
  this.setExpandedVisual(0);
  if (notifyLayout) this.dispatchLayoutInvalidate();
};

SideBar.prototype.isExpanded = function() {
  return this.expandedFlag == 1;
};

/**
 * Left tool strip: one primary button per tool group, with a long-press flyout
 * to reach the other tools in a group. When the window is too short to show
 * every group in a single column, `resize` wraps the strip into a second column;
 * only past that does it merge groups together using TOOLBAR_ROW_MERGE_PAIRS,
 * and scale the strip down as a last resort. With
 * `includeExtras`, it also hosts the foreground/background color list, the
 * quick-mask toggle, and the virtual modifier-key popup (for touch/pen use).
 * @param {Object} toolRegistry
 * @param {boolean} includeExtras
 */
function ToolBar(toolRegistry, includeExtras) {
  SideBar.call(this, "toolbar");
  this.toolRegistryRef = null;
  this.toolsEl = makeElement("div", "tools");
  this.el.appendChild(this.toolsEl);
  this.toolOptions = null;
  this.includeExtras = includeExtras;
  this.keyboardHandler = null;
  this.lastSlotCount = -1;
  this.toolUseTimestamps = {};
  this.toolEntries = null;
  this.toolButtons = null;
  this.groupPrimaryButtons = null;
  this.groupFlyoutMenus = null;
  this.rebuildToolButtons(toolRegistry);
  this.colorList = new VirtualList();
  this.colorList.el.style.marginTop = "5px";
  this.colorList.el.style.marginBottom = "3px";
  this.colorList.parent = this;
  this.quickMaskButton = new Button(
    iconImgHtml("lrs/mask"),
    false,
    "layer.quickMaskMode"
  );
  this.quickMaskButton.on("click", function() {
    const docEvt = new AppEvent(EventType.documentAction, true);
    docEvt.routingChannel = ToolId.TOOL_RECT_SELECT;
    docEvt.data = {
      actionKind: "qmask"
    };
    this.dispatch(docEvt);
  }, this);
  installVirtualModifierKeys(this);
}

ToolBar.prototype = Object.create(SideBar.prototype);

ToolBar.prototype.onModifierKeysChanged = function(evt) {
  const values = evt.target.getValue();
  this.virtualKeysBtn.setValue(values[0] || values[1] || values[2] || values[3]);
  const closeEvt = new AppEvent(EventType.uiDispatch, true);
  closeEvt.data = {
    dispatchKind: UiCommand.removeScrollableOverlayPopups
  };
  this.dispatch(closeEvt);
  for (let keyIdx = 0; keyIdx < 4; keyIdx++) {
    if (values[keyIdx] != this.modifierKeysDown[keyIdx]) {
      closeEvt.data = {
        dispatchKind: UiCommand.propagateKeyboardShortcutToDocument,
        isDown: values[keyIdx],
        key: VIRTUAL_KEY_CODES[keyIdx]
      };
      this.dispatch(closeEvt);
    }
  }
  this.modifierKeysDown = values.slice(0);
};

ToolBar.prototype.syncFromDocument = function(doc, keyboardHandler) {
  this.keyboardHandler = keyboardHandler;
  if (
    doc == null ||
    doc.selectedLayerIndices.length == 0 ||
    doc.layers[doc.selectedLayerIndices[0]] == null
  ) {
    return;
  }
  const hasQuickMask = doc.getQuickMask() != null,
    channelWeights = doc.pathViewport.channelVisibility,
    pixelContent = doc.layers[doc.selectedLayerIndices[0]].pixelContent;
  this.colorList.setVisible(
    shouldShowToolbarColorList(pixelContent, hasQuickMask, channelWeights)
  );
  this.quickMaskButton.setValue(hasQuickMask);
};

ToolBar.prototype.packToolsIntoRows = function(groups, maxRows) {
  return packToolsIntoRows(groups, maxRows);
};

ToolBar.prototype.findToolGroupIndex = function(toolId, allGroups) {
  return findToolGroupIndex(toolId, allGroups);
};

ToolBar.prototype.rebuildToolButtons = function(toolRegistry, maxRows) {
  this.toolRegistryRef = toolRegistry;
  this.toolButtons = [];
  this.groupPrimaryButtons = [];
  this.groupFlyoutMenus = [];
  this.toolEntries = [];
  let groups = toolRegistry.toolbarGroups;
  if (maxRows != null && this.includeExtras) {
    groups = packToolsIntoRows(groups, maxRows);
  }
  groups = filterGroupsByAllowedTools(groups, this.toolOptions);
  for (let gi = 0; gi < groups.length; gi++) {
    mountToolGroup(this, toolRegistry, groups[gi], gi);
  }
};

/**
 * Tool groups the strip can show at a given inner height before it has to start
 * merging them. Counts the rows one column holds, then allows that many in each
 * merge-free column: a short window widens the strip rather than hiding tools
 * inside flyouts.
 * @param {number} innerHeight Strip height minus the collapse handle.
 * @param {number} buttonStride Vertical pitch of one tool button.
 * @returns {number}
 */
export function toolbarGroupBudget(innerHeight, buttonStride) {
  const rowsPerColumn = Math.max(
    1,
    Math.floor((innerHeight - TOOLBAR_CHROME_HEIGHT_PX) / buttonStride)
  );
  return rowsPerColumn * TOOLBAR_MERGE_FREE_COLUMNS;
}

ToolBar.prototype.resize = function(width, height) {
  const innerHeight = this.cachedHeight = height - TOGGLE_HANDLE_HEIGHT_PX;
  let buttonStride = TOOLBAR_BUTTON_STRIDE_PX;
  if (1 < getDevicePixelRatio() && getDevicePixelRatio() < 1.5) {
    buttonStride = 18 + 14 * (1 / getDevicePixelRatio());
  }
  const groupBudget = toolbarGroupBudget(innerHeight, buttonStride),
    options = this.toolOptions;
  if (options == null) return;
  if (groupBudget != this.lastSlotCount) {
    this.lastSlotCount = groupBudget;
    this.rebuildToolButtons(this.toolRegistryRef, groupBudget);
    this.setActiveToolById(options.activeToolId);
  }
  applyToolbarResizeStyles(
    this,
    height,
    innerHeight,
    this.groupPrimaryButtons.length * buttonStride + TOOLBAR_CHROME_HEIGHT_PX
  );
};

ToolBar.prototype.buildUI = function() {
  for (let bi = 0; bi < this.toolButtons.length; bi++) this.toolButtons[bi].buildUI();
  for (let gi = 0; gi < this.groupFlyoutMenus.length; gi++) {
    if (this.groupFlyoutMenus[gi]) this.groupFlyoutMenus[gi].buildUI();
  }
};

ToolBar.prototype.onInput = function(evt) {
  const uiEvt = new AppEvent(EventType.uiDispatch, true);
  uiEvt.data = {
    dispatchKind: UiCommand.setActiveToolPanelMode,
    routingChannel: this.toolEntries[evt.id].id
  };
  this.dispatch(uiEvt);
};

ToolBar.prototype.onGroupMenuSelect = function(evt) {
  const btnIndex = evt.target.baseButtonIndex + evt.target.getSelectedIndices()[0];
  this.toolButtons[btnIndex].onDragEnd(null);
};

ToolBar.prototype.onToolButtonMover = function(evt) {
  const keys = this.keyboardHandler,
    closeEvt = new AppEvent(EventType.uiDispatch, true);
  closeEvt.data = {
    dispatchKind: UiCommand.removeScrollableOverlayPopups
  };
  this.dispatch(closeEvt);
  const btn = evt.target,
    flyout = this.groupFlyoutMenus[btn.groupIndex];
  if (flyout == null) return;
  const btnRect = btn.el.getBoundingClientRect(),
    showEvt = new AppEvent(EventType.uiDispatch, true);
  showEvt.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: flyout,
    x: btnRect.left + btnRect.width + 8,
    y: btnRect.top
  };
  if (
    keys == null ||
    !(keys.isPressed(KeyboardHandler.Space) || keys.isPressed(KeyboardHandler.Ctrl))
  ) {
    this.dispatch(showEvt);
  }
};

ToolBar.prototype.setActiveToolById = function(toolId) {
  this.toolUseTimestamps[toolId] = Date.now();
  let activeIndex = -1;
  for (let ti = 0; ti < this.toolEntries.length; ti++) {
    if (this.toolEntries[ti].id == toolId) activeIndex = ti;
  }
  for (let bi = 0; bi < this.toolButtons.length; bi++) {
    this.toolButtons[bi].setSelected(activeIndex == bi);
  }
  if (activeIndex == -1) return;
  this.groupPrimaryButtons[this.toolButtons[activeIndex].groupIndex] =
    this.toolButtons[activeIndex];
  clearElement(this.toolsEl);
  const visible = this.groupPrimaryButtons;
  for (let gi = 0; gi < visible.length; gi++) {
    this.toolsEl.appendChild(visible[gi].el);
  }
  if (!this.includeExtras) return;
  this.toolsEl.appendChild(this.colorList.el);
  if (this.cachedHeight > 500) this.toolsEl.appendChild(this.quickMaskButton.el);
  else this.toolsEl.appendChild(this.virtualKeysBtn.el);
};

ToolBar.prototype.open = function(toolRegistry, appData) {
  this.setActiveToolById(appData.activeToolId);
};

ToolBar.prototype.onUpdate = function(appData, updateKind) {
  this.toolOptions = appData;
  if (updateKind == PopupTypes.ALL) {
    this.rebuildToolButtons(this.toolRegistryRef);
    this.setActiveToolById(appData.activeToolId);
  }
  this.colorList.setColors(appData.colorInt, appData.bgColor);
};

/**
 * Compact tool groups into at most maxRows using TOOLBAR_ROW_MERGE_PAIRS.
 * @param {Array<Array>} groups
 * @param {number} maxRows
 * @returns {Array<Array>}
 */
function packToolsIntoRows(groups, maxRows) {
  const groupCount = groups.length,
    packed = [];
  for (let gi = 0; gi < groupCount; gi++) packed[gi] = groups[gi].slice(0);
  groups = packed;
  const mergeCount = Math.min(TOOLBAR_ROW_MERGE_PAIRS.length / 2, groupCount - maxRows);
  for (let pi = 0; pi < mergeCount; pi++) {
    const fromIdx = TOOLBAR_ROW_MERGE_PAIRS[2 * pi],
      intoIdx = TOOLBAR_ROW_MERGE_PAIRS[2 * pi + 1];
    groups[fromIdx] = groups[fromIdx].concat(groups[intoIdx]);
    groups[intoIdx] = null;
  }
  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    if (groups[gIdx] == null) {
      groups.splice(gIdx, 1);
      gIdx--;
    }
  }
  return groups;
}

/**
 * @param {*} toolId
 * @param {Array<Array<{ tool: { id: * } }>>} allGroups
 * @returns {number|undefined}
 */
function findToolGroupIndex(toolId, allGroups) {
  for (let gi = 0; gi < allGroups.length; gi++) {
    for (let ti = 0; ti < allGroups[gi].length; ti++) {
      if (allGroups[gi][ti].tool.id == toolId) return gi;
    }
  }
}

/**
 * Show the color strip when the active layer is color-capable or a channel is solo.
 * @param {number} pixelContent
 * @param {boolean} hasQuickMask
 * @param {number[]} channelWeights
 * @returns {boolean}
 */
function shouldShowToolbarColorList(pixelContent, hasQuickMask, channelWeights) {
  return (
    pixelContent == 1 ||
    pixelContent == 3 ||
    hasQuickMask ||
    channelWeights[0] + channelWeights[1] + channelWeights[2] == 1
  );
}

function filterGroupsByAllowedTools(groups, toolOptions) {
  if (!toolOptions) return groups;
  const filtered = [],
    allowedIds = toolOptions.allowedToolIds;
  for (let gi = 0; gi < groups.length; gi++) {
    const row = [];
    for (let ti = 0; ti < groups[gi].length; ti++) {
      const entry = groups[gi][ti];
      if (allowedIds == null || allowedIds.indexOf(entry.tool.id) != -1) row.push(entry);
    }
    if (row.length > 0) filtered.push(row);
  }
  return filtered;
}

function mountToolGroup(toolBar, toolRegistry, groupEntries, groupIndex) {
  const menuItems = [],
    baseButtonIndex = toolBar.toolButtons.length;
  let primaryBtn = null,
    bestUseTime = -1;
  for (let ti = 0; ti < groupEntries.length; ti++) {
    const toolDef = groupEntries[ti].tool,
      registryGroupIdx = findToolGroupIndex(toolDef.id, toolRegistry.toolbarGroups),
      shortcut = toolRegistry.toolbarShortcutKeys[registryGroupIdx];
    toolBar.toolEntries.push(toolDef);
    const btn = new MenuButton(
      toolDef.name,
      shortcut,
      toolDef.iconId,
      toolBar.toolButtons.length,
      groupIndex,
      groupEntries.length > 1
    );
    toolBar.toolButtons.push(btn);
    let lastUsed = toolBar.toolUseTimestamps[toolDef.id];
    if (lastUsed == null) lastUsed = 0;
    if (lastUsed > bestUseTime) {
      bestUseTime = lastUsed;
      primaryBtn = btn;
    }
    btn.on(EventType.widgetSelect, toolBar.onInput, toolBar);
    btn.on("mover", toolBar.onToolButtonMover, toolBar);
    menuItems.push({
      name: toolDef.name,
      iconId: toolDef.iconId,
      shortcut: shortcut ? shortcut.label : ""
    });
  }
  toolBar.groupPrimaryButtons.push(primaryBtn);
  if (menuItems.length == 1) {
    toolBar.groupFlyoutMenus.push(null);
  } else {
    const flyout = new InputHandler(menuItems);
    flyout.baseButtonIndex = baseButtonIndex;
    flyout.groupIndex = groupIndex;
    toolBar.groupFlyoutMenus.push(flyout);
    flyout.on("select", toolBar.onGroupMenuSelect, toolBar);
    flyout.parent = toolBar;
  }
}

function applyToolbarResizeStyles(toolBar, height, innerHeight, contentHeight) {
  const scale = Math.min(1, innerHeight / contentHeight);
  if (TOOLBAR_MIN_SCALE <= scale) {
    toolBar.toolsEl.setAttribute(
      "style",
      "width:" + TOOLBAR_COLUMN_WIDTH_PX + "px; transform-origin: top left; transform: scale(" +
        scale + "," + scale + ");"
    );
  } else {
    // `.tools` wraps by column, so a definite height turns the overflow into
    // extra columns instead of a taller strip.
    const columnHeight = innerHeight - 4,
      columnCount = Math.ceil(contentHeight / columnHeight);
    toolBar.toolsEl.setAttribute(
      "style",
      "height: " + columnHeight + "px; width:" + columnCount * TOOLBAR_COLUMN_WIDTH_PX + "px"
    );
  }
  // The strip is capped to the window in both layouts; without it the column
  // layout grows to its natural height and runs off the bottom of the window.
  toolBar.el.setAttribute("style", "height:" + (height - 2) + "px; overflow:hidden");
}

function installVirtualModifierKeys(toolBar) {
  const modifierKeys = new RadioOption(null, ["Ctrl", "Alt", "Shift", "No Touch"], true);
  modifierKeys.on(EventType.widgetSelect, toolBar.onModifierKeysChanged, toolBar);
  const modifierRow = makeElement("span", "rangecont form");
  modifierRow.appendChild(modifierKeys.el);
  const modifierHost = new BaseWidget();
  modifierHost.el = modifierRow;
  toolBar.modifierKeysDown = [false, false, false];
  toolBar.virtualKeysBtn = new Button(
    iconImgHtml("ui/keyboard", "", "autoscale"), false, "properties.virtualKeys");
  toolBar.virtualKeysBtn.on("click", function() {
    const btnRect = toolBar.virtualKeysBtn.el.getBoundingClientRect(),
      overlayEvt = new AppEvent(EventType.uiDispatch, true);
    overlayEvt.data = {
      dispatchKind: UiCommand.showFloatingOverlay,
      overlayWidget: modifierHost,
      x: btnRect.left,
      y: btnRect.top - 30
    };
    toolBar.dispatch(overlayEvt);
  }, toolBar);
}

/**
 * Single tool button with optional long-press flyout corner badge.
 */
function MenuButton(labelKey, shortcutBinding, iconId, toolIndex, groupIndex, showCornerBadge) {
  BaseWidget.call(this);
  this.pressTimerId = 0;
  this.longPressHandler = this.dispatchMoverEvent.bind(this);
  this.groupIndex = groupIndex;
  this.toolIndex = toolIndex;
  this.labelKey = labelKey;
  this.shortcutBinding = shortcutBinding;
  this.showCornerBadge = showCornerBadge;
  this.iconId = iconId;
  this.el = makeElement("button", "");
  this.el.innerHTML = iconImgHtml(this.iconId);
  if (this.showCornerBadge) {
    const cornerImg = makeElement("img", "gsicon");
    cornerImg.setAttribute("src", getIconUrl("tools/corner"));
    cornerImg.setAttribute(
      "style",
      "position:absolute; right:0;  bottom:0; width:100%; height:100%;"
    );
    this.el.appendChild(cornerImg);
  }
  this.buildUI();
  addPointerDownListener(this.el, this.onDragStart.bind(this));
  this.el.addEventListener("click", this.onDragEnd.bind(this), false);
  this.el.addEventListener("contextmenu", MenuButton.cancel, false);
}

MenuButton.prototype = Object.create(BaseWidget.prototype);

MenuButton.cancel = function(evt) {
  evt.stopPropagation();
  evt.preventDefault();
  return false;
};

MenuButton.prototype.buildUI = function() {
  const shortcutLabel = this.shortcutBinding ? " (" + this.shortcutBinding.label + ")" : "";
  this.el.setAttribute("title", Locale.get(this.labelKey) + shortcutLabel);
};

MenuButton.prototype.onDragStart = function() {
  this.pressTimerId = setTimeout(this.longPressHandler, LONG_PRESS_MOVER_MS);
};

MenuButton.prototype.onDragEnd = function() {
  clearTimeout(this.pressTimerId);
  const selectEvt = new AppEvent(EventType.widgetSelect, false);
  selectEvt.target = this;
  selectEvt.id = this.toolIndex;
  this.dispatch(selectEvt);
};

MenuButton.prototype.dispatchMoverEvent = function() {
  const moverEvt = new AppEvent("mover", false);
  moverEvt.target = this;
  moverEvt.id = this.toolIndex;
  this.dispatch(moverEvt);
};

MenuButton.prototype.setSelected = function(selected) {
  this.el.setAttribute("class", selected ? "toolbtn active" : "toolbtn");
};

export {
  SideBar,
  ToolBar,
  packToolsIntoRows,
  findToolGroupIndex,
  shouldShowToolbarColorList,
  TOOLBAR_ROW_MERGE_PAIRS
};
