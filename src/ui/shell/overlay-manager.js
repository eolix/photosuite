/**
 * Top-level chrome overlays: toasts, loading banners, command palette, and
 * anchored popups. Installs `showToast` and `window.alert` at construction.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";

import { KeyboardShortcutsDialog } from "../dialogs/preferences-dialogs.js";
import { InputHandler } from "../tool-options/input-handler.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { MenuBar } from "../menu/menu-bar.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, addPointerDownListener, clearElement, isInDOM, makeElement, removeClass } from "../../core/dom.js";
import { showToast, installToastPainter } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";

/**
 * Top-level chrome for toasts, loading banners, command palette, and anchored
 * popups. Installs showToast and window.alert at construction.
 */
/**
 * Width assumed for a menu popup when deciding whether it still fits to the
 * right of its anchor. Menus render at their natural width; this only drives
 * the flip decision.
 */
const MENU_FLIP_WIDTH_PX = 260;

function OverlayManager() {
  BaseWidget.call(this);
  this.el = makeElement("div", "cmanager");
  this.hostWidth = 0;
  this.hostHeight = 0;
  this.popupStack = [];
  this.loadingBarElements = {};
  this.toastQueueDeadline = 0;
  this.commandPaletteHighlightIndex = -1;
  this.commandPaletteRows = null;
  this.commandPaletteMatchState = null;
  installToastAndAlertBridge(this);
  installOverlayContainers(this);
  installCommandPaletteDom(this);
  addPointerDownListener(document.body, this.onDocumentPointerDownDismiss.bind(this))
}

OverlayManager.prototype = Object.create(BaseWidget.prototype);

OverlayManager.prototype.hideCommandPalette = function() {
  if (isInDOM(this.commandPaletteContainer)) this.el.removeChild(this.commandPaletteContainer)
};

OverlayManager.prototype.openCommandPalette = function(currentDoc, appData) {
  this.commandPaletteRows = buildCommandPaletteRows(currentDoc, appData);
  this.el.appendChild(this.commandPaletteContainer);
  const inputEl = this.inputEl;
  inputEl.focus();
  inputEl.select();
  this.redraw()
};

OverlayManager.prototype.onCommandPaletteInput = function() {
  this.commandPaletteHighlightIndex = -1;
  this.redraw()
};

OverlayManager.prototype.redraw = function() {
  const matchResult = matchCommandPaletteQuery(this.inputEl.value, this.commandPaletteRows),
    matchedRows = matchResult.matchedRows,
    highlightRangesByRow = matchResult.highlightRangesByRow,
    resultRowEls = [],
    resultsListEl = this.commandPaletteResultsList;
  clearElement(resultsListEl);
  for (let matchIdx = 0; matchIdx < matchedRows.length; matchIdx++) {
    const rowLabels = matchedRows[matchIdx][0],
      rowHighlights = highlightRangesByRow[matchIdx];
    let rowClass = "enab",
      rowHtml = "";
    if (matchIdx == this.commandPaletteHighlightIndex) rowClass += " active";
    const rowEl = makeElement("div", rowClass);
    resultRowEls.push(rowEl);
    resultsListEl.appendChild(rowEl);
    rowEl.innerHTML = formatCommandPaletteRowHtml(rowLabels, rowHighlights)
  }
  this.commandPaletteMatchState = [matchedRows, resultRowEls]
};

OverlayManager.prototype.onCommandPaletteKeyDown = function(keyDownEvent) {
  const hasKeyCode = KeyboardHandler.hasKeyCode,
    keyCode = keyDownEvent.code;
  if (hasKeyCode(keyCode, KeyboardHandler.Escape)) this.hideCommandPalette();
  const arrowUp = hasKeyCode(keyCode, KeyboardHandler.ArrowUp),
    arrowDown = hasKeyCode(keyCode, KeyboardHandler.ArrowDown),
    enterKey = hasKeyCode(keyCode, KeyboardHandler.Enter);
  if (arrowUp || arrowDown) {
    this.commandPaletteHighlightIndex = Math.max(
      0,
      Math.min(
        this.commandPaletteMatchState[0].length - 1,
        this.commandPaletteHighlightIndex + (arrowUp ? -1 : 1)
      )
    );
    this.redraw()
  }
  if (enterKey && this.commandPaletteHighlightIndex != -1) {
    this.runCommandPaletteSelection(this.commandPaletteHighlightIndex)
  }
};

/**
 * Recursively flatten a menu tree into [labelPath, indexPath] rows.
 */
OverlayManager.collectMenuCommandRows = function(menuItems, labelPath, indexPath, commandRows, currentDoc, appData) {
  for (let itemIdx = 0; itemIdx < menuItems.length; itemIdx++) {
    const menuItem = menuItems[itemIdx],
      childLabelPath = labelPath.slice(0),
      childIndexPath = indexPath.slice(0);
    let rowLabel = Locale.get(menuItem.name);
    if (menuItem.resolveRowState) {
      const rowState = menuItem.resolveRowState(currentDoc, appData, itemIdx);
      if (rowState.labelOverride) rowLabel = rowState.labelOverride;
      if (rowState.enabled == false) continue
    }
    childLabelPath.push(rowLabel);
    childIndexPath.push(itemIdx);
    if (menuItem.sub) {
      OverlayManager.collectMenuCommandRows(
        menuItem.sub,
        childLabelPath,
        childIndexPath,
        commandRows,
        currentDoc,
        appData
      );
    } else {
      commandRows.push([childLabelPath, childIndexPath])
    }
  }
};

OverlayManager.prototype.onCommandPaletteResultClick = function(clickEvent) {
  let clickTarget = clickEvent.target;
  if (clickTarget.tagName.toLowerCase() == "span") clickTarget = clickTarget.parentNode;
  const matchIndex = this.commandPaletteMatchState[1].indexOf(clickTarget);
  if (matchIndex != -1) this.runCommandPaletteSelection(matchIndex)
};

OverlayManager.prototype.runCommandPaletteSelection = function(matchIndex) {
  const selectionPath = this.commandPaletteMatchState[0][matchIndex][1];
  if (selectionPath[0] == -1) {
    const uiEvent = new AppEvent(EventType.uiDispatch, true);
    uiEvent.data = {
      dispatchKind: UiCommand.setActiveToolPanelMode,
      routingChannel: selectionPath[1]
    };
    this.dispatch(uiEvent)
  } else {
    let menuAction = MenuBar.data[selectionPath[0]].menuActions[selectionPath[1]];
    for (let pathDepth = 2; pathDepth < selectionPath.length; pathDepth++) {
      menuAction = menuAction.sub[selectionPath[pathDepth]];
    }
    const actionEvent = new AppEvent(menuAction.appEventType, true);
    actionEvent.routingChannel =
      menuAction.documentModelType != null ? menuAction.documentModelType : null;
    actionEvent.data = menuAction.payload !== undefined ? menuAction.payload : null;
    this.dispatch(actionEvent)
  }
  this.hideCommandPalette()
};

OverlayManager.prototype.resize = function(widthPx, heightPx) {
  this.hostWidth = widthPx;
  this.hostHeight = heightPx;
  this.commandPaletteResultsList.style["max-height"] = heightPx - 120 + "px"
};

OverlayManager.prototype.showLoadingBar = function(bannerSpec) {
  const identity = resolveBannerIdentity(bannerSpec);
  let loadingBarEl = this.loadingBarElements[identity.key];
  if (!loadingBarEl) {
    loadingBarEl = makeElement("div", "alertpanel");
    this.loadingBarContainer.appendChild(loadingBarEl);
    this.loadingBarElements[identity.key] = loadingBarEl
  }
  loadingBarEl.textContent = Locale.get(identity.text)
};

OverlayManager.prototype.hideLoadingBar = function(bannerSpec) {
  const identity = resolveBannerIdentity(bannerSpec);
  let loadingBarEl = this.loadingBarElements[identity.key];
  if (!loadingBarEl) return;
  this.loadingBarContainer.removeChild(loadingBarEl);
  delete this.loadingBarElements[identity.key]
};

OverlayManager.prototype.showToastAlert = function(messageText, durationMs) {
  const toastContainer = this.toastContainer;
  for (let toastIdx = 0; toastIdx < toastContainer.children.length; toastIdx++) {
    if (toastContainer.children[toastIdx].textContent == messageText) return;
  }
  const toastEl = makeElement("div", "alertpanel tpanel");
  toastEl.textContent = messageText;
  toastEl.setAttribute("style", "opacity:0.5; transform:scale(0.9)\t");
  toastContainer.appendChild(toastEl);
  if (durationMs == null) durationMs = 1500;
  const toastDuration = durationMs,
    dismissDeadline = Math.max(Date.now() + toastDuration, this.toastQueueDeadline + toastDuration);
  setTimeout(function() {
    toastEl.setAttribute("style", "transform:scale(1); opacity:1;")
  }, 10);
  setTimeout(function() {
    toastContainer.setAttribute("style", "margin-top: -3.6em; transform: translateY(3.6em);")
  }, dismissDeadline - Date.now() - 30);
  setTimeout(function() {
    toastContainer.removeChild(toastContainer.firstChild);
    toastContainer.setAttribute(
      "style",
      "transition: transform 0.7s;  margin-top: 1em;  transform: translateY(0em);"
    )
  }, dismissDeadline - Date.now());
  this.toastQueueDeadline = dismissDeadline
};

OverlayManager.prototype.onDocumentPointerDownDismiss = function(pointerEvent) {
  if (pointerEvent.skipOverlayDismiss) return;
  const popupStack = this.popupStack;
  for (let popupIdx = popupStack.length - 1; popupIdx >= 0; popupIdx--) {
    const popupWidget = popupStack[popupIdx];
    let hitTarget = pointerEvent.target;
    while (hitTarget != null) {
      if (hitTarget == popupWidget.el) {
        this.removeScrollablePopups(popupWidget);
        return
      }
      hitTarget = hitTarget.parentNode
    }
  }
  this.removeScrollablePopups();
  let clickTarget = pointerEvent.target;
  if (clickTarget == null) {
    this.hideCommandPalette();
    return
  }
  while (
    clickTarget != null &&
    clickTarget != this.commandPaletteContainer &&
    clickTarget != document.body
  ) {
    clickTarget = clickTarget.parentNode;
  }
  if (clickTarget == null || clickTarget != this.commandPaletteContainer) {
    this.hideCommandPalette()
  }
};

OverlayManager.prototype.removeScrollablePopups = function(ancestorPopup) {
  const popupStack = this.popupStack;
  for (let popupIdx = 0; popupIdx < popupStack.length; popupIdx++) {
    if (ancestorPopup && ancestorPopup.isDescendantOf(popupStack[popupIdx])) continue;
    const popupEl = popupStack[popupIdx].el;
    popupEl.style.height = "auto";
    removeClass(popupEl, "scrollable");
    this.el.removeChild(popupEl);
    popupStack.splice(popupIdx, 1);
    popupIdx--
  }
};

OverlayManager.prototype.showPopup = function(popupPayload) {
  this.removeScrollablePopups(popupPayload.overlayWidget);
  const popupWidget = popupPayload.overlayWidget,
    popupEl = popupWidget.el;
  if (this.popupStack.indexOf(popupWidget) != -1) return;
  this.popupStack.push(popupWidget);
  this.el.appendChild(popupWidget.el);
  const hostWidth = this.hostWidth,
    hostHeight = this.hostHeight,
    managerRect = this.el.getBoundingClientRect(),
    isInputHandlerPopup = popupWidget instanceof InputHandler;
  let anchorX = popupPayload.x,
    anchorY = popupPayload.y;
  if (isInputHandlerPopup || popupPayload.measureForPosition) {
    const popupHeight = popupWidget.getHeight();
    let popupWidth = popupWidget.getWidth();
    if (isInputHandlerPopup) popupWidth = Math.min(popupWidth, MENU_FLIP_WIDTH_PX);
    const placed = computePopupAnchorPlacement(
      hostWidth,
      hostHeight,
      anchorX,
      anchorY,
      popupWidth,
      popupHeight,
      popupPayload
    );
    anchorX = placed.anchorX;
    anchorY = placed.anchorY
  }
  anchorY = Math.max(2, anchorY);
  const topPx = Math.round(anchorY - managerRect.y + this.el.offsetTop);
  popupEl.style.position = "absolute";
  popupEl.style["z-index"] = 10;
  popupEl.style.left = Math.round(anchorX) + "px";
  popupEl.style.top = topPx + "px";
  if (anchorY + popupWidget.getHeight() > hostHeight - 3) {
    popupEl.style.height = hostHeight - 3 - anchorY + "px";
    addClass(popupEl, "scrollable")
  }
};

OverlayManager.prototype.removePopup = function(popupPayload) {
  const popupWidget = popupPayload.overlayWidget,
    stackIndex = this.popupStack.indexOf(popupWidget);
  if (stackIndex == -1) return;
  this.popupStack.splice(stackIndex, 1);
  this.el.removeChild(popupWidget.el)
};

OverlayManager.prototype.getTopPopup = function() {
  const popupStack = this.popupStack;
  return popupStack.length == 0 ? null : popupStack[popupStack.length - 1]
};

OverlayManager.prototype.dismissTopPopup = function() {
  this.removePopup({
    overlayWidget: this.getTopPopup()
  })
};

function installToastAndAlertBridge(overlayManager) {
  // core/user-prompts.js showToast() is silent until the chrome exists; this is
  // where it gets the banner to paint into.
  installToastPainter(overlayManager.showToastAlert.bind(overlayManager));
  window.alert = function(messageText, durationMs) {
    overlayManager.showToastAlert(messageText, durationMs);
  };
  window.onblur = function() {
    overlayManager.removeScrollablePopups()
  };
}

function installOverlayContainers(overlayManager) {
  overlayManager.loadingBarContainer = makeElement("div", "alertcont");
  overlayManager.el.appendChild(overlayManager.loadingBarContainer);
  overlayManager.toastContainer = makeElement("div", "alertcont");
  overlayManager.el.appendChild(overlayManager.toastContainer);
  overlayManager.commandPaletteContainer = makeElement("div", "alertcont");
}

function installCommandPaletteDom(overlayManager) {
  const commandPalettePanelEl = overlayManager.commandPalettePanel =
    makeElement("div", "alertpanel cmdpalette");
  overlayManager.commandPaletteContainer.appendChild(commandPalettePanelEl);
  const commandPaletteInputEl = overlayManager.inputEl = makeElement("input");
  commandPaletteInputEl.setAttribute("type", "text");
  commandPaletteInputEl.setAttribute("placeholder", Locale.get("properties.find"));
  commandPaletteInputEl.addEventListener(
    "input",
    overlayManager.onCommandPaletteInput.bind(overlayManager),
    false
  );
  commandPaletteInputEl.addEventListener(
    "keydown",
    overlayManager.onCommandPaletteKeyDown.bind(overlayManager),
    false
  );
  commandPalettePanelEl.appendChild(commandPaletteInputEl);
  const commandPaletteResultsEl = overlayManager.commandPaletteResultsList =
    makeElement("div", "contextpanel scrollable cmdresults");
  commandPaletteResultsEl.addEventListener(
    "click",
    overlayManager.onCommandPaletteResultClick.bind(overlayManager),
    false
  );
  commandPalettePanelEl.appendChild(commandPaletteResultsEl)
}

function buildCommandPaletteRows(currentDoc, appData) {
  const commandRows = [];
  for (let menuIdx = 0; menuIdx < MenuBar.data.length; menuIdx++) {
    const menuRoot = MenuBar.data[menuIdx],
      labelPath = [Locale.get(menuRoot.name)],
      indexPath = [menuIdx];
    OverlayManager.collectMenuCommandRows(
      menuRoot.items,
      labelPath,
      indexPath,
      commandRows,
      currentDoc,
      appData
    )
  }
  const toolShortcutRows = KeyboardShortcutsDialog.toolShortcutKeyRows;
  for (let shortcutRowIdx = 0; shortcutRowIdx < toolShortcutRows.length; shortcutRowIdx += 3) {
    commandRows.push([
      ["Tools", Locale.get(toolShortcutRows[shortcutRowIdx])],
      [-1, toolShortcutRows[shortcutRowIdx + 2]]
    ])
  }
  return commandRows
}

/**
 * Filter command-palette rows by whitespace-tokenized query (AND across tokens).
 * @param {string} rawQuery
 * @param {Array} allRows
 * @returns {{ matchedRows: Array, highlightRangesByRow: Array, queryTokens: string[] }}
 */
function matchCommandPaletteQuery(rawQuery, allRows) {
  const queryText = rawQuery.toLowerCase().trim().replace(/  +/g, " "),
    matchedRows = [],
    highlightRangesByRow = [],
    queryTokens = queryText.split(" ");
  if (queryText != "") {
    for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
      const labelSegments = allRows[rowIdx][0],
        segmentHighlights = [];
      let matchedTokenCount = 0;
      for (let segmentIdx = 0; segmentIdx < labelSegments.length; segmentIdx++) {
        segmentHighlights[segmentIdx] = -1;
      }
      for (let tokenIdx = 0; tokenIdx < queryTokens.length; tokenIdx++) {
        for (let segIdx = 0; segIdx < labelSegments.length; segIdx++) {
          const matchStart = labelSegments[segIdx].toLowerCase().indexOf(queryTokens[tokenIdx]);
          if (matchStart != -1) {
            segmentHighlights[segIdx] = [matchStart, matchStart + queryTokens[tokenIdx].length];
            matchedTokenCount++;
            break
          }
        }
      }
      if (matchedTokenCount == queryTokens.length) {
        matchedRows.push(allRows[rowIdx]);
        highlightRangesByRow.push(segmentHighlights)
      }
    }
  }
  return {
    matchedRows: matchedRows,
    highlightRangesByRow: highlightRangesByRow,
    queryTokens: queryTokens
  }
}

function formatCommandPaletteRowHtml(rowLabels, rowHighlights) {
  let rowHtml = "";
  for (let segmentIdx = 0; segmentIdx < rowLabels.length; segmentIdx++) {
    const highlightRange = rowHighlights[segmentIdx];
    let segmentHtml = rowLabels[segmentIdx];
    if (highlightRange != -1) {
      segmentHtml =
        segmentHtml.slice(0, highlightRange[0]) +
        "<span class=\"cmdmatch\">" +
        segmentHtml.slice(highlightRange[0], highlightRange[1]) +
        "</span>" +
        segmentHtml.slice(highlightRange[1]);
    }
    rowHtml += segmentHtml;
    if (segmentIdx < rowLabels.length - 1) rowHtml += " \uFE65 "
  }
  return rowHtml
}

/**
 * Normalize loading-banner args to a stable map key plus display text.
 * @param {string|Object} bannerSpec
 * @returns {{ id: *, text: *, key: string }}
 */
function resolveBannerIdentity(bannerSpec) {
  let id = bannerSpec,
    text = bannerSpec;
  if (bannerSpec && typeof bannerSpec == "object" && !Array.isArray(bannerSpec)) {
    if (bannerSpec.id != null) id = bannerSpec.id;
    else if (bannerSpec.key != null) id = bannerSpec.key;
    if (bannerSpec.text != null) text = bannerSpec.text;
  }
  return {
    id: id,
    text: text,
    key: JSON.stringify(id)
  }
}

/**
 * Flip / clamp popup anchors so the panel stays inside the host.
 * @returns {{ anchorX: number, anchorY: number }}
 */
function computePopupAnchorPlacement(
  hostWidth,
  hostHeight,
  anchorX,
  anchorY,
  popupWidth,
  popupHeight,
  popupPayload
) {
  if (anchorY + popupHeight < hostHeight) {
    anchorX = Math.min(anchorX, hostWidth - popupWidth - 5)
  } else if (anchorX + popupWidth < hostWidth) {
    anchorY = Math.min(anchorY, hostHeight - popupHeight - 5)
  } else if (popupHeight < anchorY) {
    anchorY = anchorY - popupHeight - 2;
    anchorX = Math.min(anchorX, hostWidth - popupWidth - 5)
  } else {
    anchorX = anchorX - popupWidth;
    anchorY = Math.min(anchorY, hostHeight - popupHeight - 5)
  }
  if (popupPayload.anchorAbove) {
    anchorY = Math.max(2, popupPayload.y - popupHeight - 2);
  }
  if (popupPayload.pinToAnchorY) anchorY = popupPayload.y;
  return {
    anchorX: anchorX,
    anchorY: anchorY
  }
}

export {
  OverlayManager,
  matchCommandPaletteQuery,
  resolveBannerIdentity,
  computePopupAnchorPlacement
};
