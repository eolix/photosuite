/**
 * History panel: lists undo/redo steps; row clicks dispatch h_itemchange to
 * jump the document history index. Future steps render at reduced opacity.
 */

import { Locale } from "../../core/i18n/locale.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { BaseTool } from "../widgets/base-tool.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { clearElement, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Opacity applied to history rows after the current undo point. */
const FUTURE_HISTORY_OPACITY = 0.4;

/**
 * One row in the History panel. Clicking dispatches h_itemchange so the
 * document replays history up to this index.
 */
function HistoryItem(historyEntry, index, currentIndex) {
  BaseWidget.call(this);
  this.index = index;
  this.el = buildHistoryListItemElement(index, currentIndex);
  this.labelKey = historyEntry.name;
  this.buildUI();
  if (index > currentIndex) this.el.style.opacity = FUTURE_HISTORY_OPACITY;
  this.el.addEventListener("click", this.onMouseDown.bind(this), false)
}
HistoryItem.prototype = Object.create(BaseWidget.prototype);

HistoryItem.prototype.buildUI = function() {
  this.el.textContent = Locale.get(this.labelKey)
};

HistoryItem.prototype.onMouseDown = function(evt) {
  if (this.index == this.parent.activeIndex) return;
  dispatchHistoryItemChange(this, {
    actionKind: "h_itemchange",
    index: this.index
  })
};

/**
 * Sidebar panel listing the document undo/redo history.
 */
function HistoryPanel() {
  BaseTool.call(this, "panels.history", false, getIconUrl("panels/history"), BaseTool.PanelId.HISTORY, true);
  this.panelBody.setAttribute("style", "min-width:200px;");
  this.containerEl = makeElement("div", "hpbody scrollable");
  this.containerEl.style.height = "160px";
  this.panelBody.appendChild(this.containerEl);
  this.activeIndex = -1;
  this.items = [];
  this.lastDocSignature = ""
}
HistoryPanel.prototype = Object.create(BaseTool.prototype);

HistoryPanel.prototype.open = function(doc) {
  if (doc == null) {
    clearElement(this.containerEl);
    this.lastDocSignature = "";
    return
  }
  clearElement(this.containerEl);
  const currentIndex = HistoryPanel.resolveCurrentHistoryIndex(doc);
  appendVisibleHistoryItems(this, doc, currentIndex);
  if (doc.historyIndex == doc.history.length - 1) this.refresh()
};

HistoryPanel.prototype.refresh = function() {
  this.containerEl.scrollTop = this.containerEl.scrollHeight
};

HistoryPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  for (let i = 0; i < this.items.length; i++) this.items[i].buildUI()
};

/**
 * Last visible history index at or before doc.historyIndex (skips
 * excludeFromHistoryUI entries).
 */
HistoryPanel.resolveCurrentHistoryIndex = function(doc) {
  let currentIndex = 0;
  for (let i = 0; i < doc.history.length; i++)
    if (i <= doc.historyIndex && !doc.history[i].excludeFromHistoryUI) currentIndex = i;
  return currentIndex
};

export { HistoryPanel, HistoryItem };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildHistoryListItemElement(index, currentIndex) {
  return makeElement("div", index == currentIndex ? "listitem selected" : "listitem")
}

function dispatchHistoryItemChange(item, data) {
  const evt = new AppEvent(EventType.documentAction, true);
  evt.data = data;
  evt.routingChannel = EventChannel.EVENT_HISTORY;
  item.dispatch(evt)
}

function appendVisibleHistoryItems(panel, doc, currentIndex) {
  for (let i = 0; i < doc.history.length; i++) {
    const entry = doc.history[i];
    if (entry.excludeFromHistoryUI) continue;
    const item = new HistoryItem(entry, i, currentIndex);
    item.parent = panel;
    panel.containerEl.appendChild(item.el);
    panel.items.push(item)
  }
}
