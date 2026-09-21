/**
 * HistoryPanel / HistoryItem (list build + h_itemchange dispatch).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { clearElement } from "../../../src/core/dom.js";

installBrowserGlobals();

let EventChannel;
let HistoryPanel;
let HistoryItem;
let DocumentModel;

before(async () => {
  ({ EventChannel } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ HistoryPanel, HistoryItem } = await import("../../../src/ui/panels/history-panel.js"));
});

function makeHistoryDoc(entries, historyIndex) {
  return {
    history: entries,
    historyIndex,
  };
}

describe("ui/panels/history-panel.js", () => {
  it("resolveCurrentHistoryIndex skips excluded entries", () => {
    const doc = makeHistoryDoc(
      [
        { name: "Open", excludeFromHistoryUI: false },
        { name: "Internal", excludeFromHistoryUI: true },
        { name: "Brush", excludeFromHistoryUI: false },
      ],
      2,
    );
    assert.equal(HistoryPanel.resolveCurrentHistoryIndex(doc), 2);
    assert.equal(HistoryPanel.resolveCurrentHistoryIndex(makeHistoryDoc(doc.history, 1)), 0);
  });

  it("HistoryItem click dispatches h_itemchange", () => {
    const panel = Object.create(HistoryPanel.prototype);
    panel.activeIndex = -1;
    const item = new HistoryItem({ name: "panels.history" }, 2, 2);
    item.parent = panel;
    const events = [];
    item.dispatch = (evt) => events.push(evt);
    item.onMouseDown({});
    assert.equal(events.length, 1);
    assert.equal(events[0].data.actionKind, "h_itemchange");
    assert.equal(events[0].data.index, 2);
    assert.equal(events[0].routingChannel, EventChannel.EVENT_HISTORY);
  });

  it("open skips excludeFromHistoryUI rows", () => {
    const panel = new HistoryPanel();
    const doc = makeHistoryDoc(
      [
        { name: "A", excludeFromHistoryUI: false },
        { name: "B", excludeFromHistoryUI: true },
        { name: "C", excludeFromHistoryUI: false },
      ],
      2,
    );
    panel.open(doc);
    assert.equal(panel.containerEl.children.length, 2);
    assert.equal(panel.items.length, 2);
  });

  it("open with null clears container and lastDocSignature", () => {
    const panel = new HistoryPanel();
    panel.containerEl.appendChild(document.createElement("div"));
    panel.lastDocSignature = "was-set";
    panel.open(null);
    assert.equal(panel.containerEl.firstChild, undefined);
    assert.equal(panel.lastDocSignature, "");
  });

  it("refresh scrolls container to bottom", () => {
    const panel = Object.create(HistoryPanel.prototype);
    panel.containerEl = { scrollTop: 0, scrollHeight: 500 };
    panel.refresh();
    assert.equal(panel.containerEl.scrollTop, 500);
  });
});
