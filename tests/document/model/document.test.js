import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let EventChannel;
let Document;
let HistoryEntry;
let DocumentModel;
let Rect;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ EventChannel } = await import("../../../src/document/model/tool-base.js"));
  await import("../../../src/engine/layer-system.js");
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ Document, HistoryEntry } = await import("../../../src/document/model/document.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/model/document.js", () => {
  it("HistoryEntry stores routing metadata", () => {
    const channel = { id: "brush" };
    const entry = new HistoryEntry("edit.paint", channel, true);
    assert.equal(entry.name, "edit.paint");
    assert.equal(entry.routingChannel, channel);
    assert.equal(entry.excludeFromHistoryUI, true);
    assert.equal(entry.data, null);
  });

  it("new Document seeds history and viewport state", () => {
    const doc = new Document("demo.psd");
    assert.equal(doc.name, "demo.psd");
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].name, "file.open");
    assert.equal(doc.historyIndex, 0);
    assert.equal(doc.savedHistoryIndex, 0);
    assert.equal(doc.paths[0].name, "Work Path");
    assert.ok(doc.pathViewport);
  });

  it("isModified reflects saved history index", () => {
    const doc = new Document("demo.psd");
    assert.equal(doc.isModified(), false);
    doc.historyIndex = 1;
    assert.equal(doc.isModified(), true);
    doc.savedHistoryIndex = 1;
    assert.equal(doc.isModified(), false);
  });

  it("markDirty unions dirty rectangles", () => {
    const doc = new Document("demo.psd");
    doc.width = 100;
    doc.height = 80;
    doc.markDirty(new Rect(0, 0, 10, 10));
    doc.markDirty(new Rect(5, 5, 20, 20));
    assert.equal(doc.dirtyRect.x, 0);
    assert.equal(doc.dirtyRect.y, 0);
    assert.equal(doc.dirtyRect.width, 25);
    assert.equal(doc.dirtyRect.height, 25);
  });

  it("setMeta applies filtered linked-resource lists", () => {
    const doc = new Document("demo.psd");
    const links = [{ tag: "lnk-a" }];
    const placed = [{ id: "placed-a" }];
    const patterns = [{ id: "pat-a" }];
    doc.setMeta({ links, placedItems: placed, patterns });
    assert.deepEqual(doc.add.lnk2, links);
    assert.deepEqual(doc.add.FEid, placed);
    assert.deepEqual(doc.add.Patt, patterns);
    doc.setMeta({ links: null, placedItems: null, patterns: null });
    assert.equal(doc.add.lnk2, undefined);
    assert.equal(doc.add.FEid, undefined);
    assert.equal(doc.add.Patt, undefined);
  });

  it("pushHistory trims to one hundred visible entries", () => {
    const doc = new Document("demo.psd");
    const filterChannel = { id: EventChannel.EVENT_FILTER_STACK };
    for (let step = 0; step < 105; step++) {
      doc.pushHistory(new HistoryEntry(`step-${step}`, filterChannel));
    }
    const visibleEntries = doc.history.filter((entry) => !entry.excludeFromHistoryUI);
    assert.equal(visibleEntries.length, 100);
    assert.equal(doc.history.length, 100);
    assert.equal(doc.historyIndex, 99);
    assert.equal(doc.history[99].name, "step-104");
  });

  it("pushHistory keeps hidden entries out of the visible cap", () => {
    const doc = new Document("demo.psd");
    const filterChannel = { id: EventChannel.EVENT_FILTER_STACK };
    for (let step = 0; step < 50; step++) {
      doc.pushHistory(new HistoryEntry(`visible-${step}`, filterChannel));
      doc.pushHistory(new HistoryEntry(`hidden-${step}`, filterChannel, true));
    }
    assert.equal(doc.history.length, 101);
    assert.equal(doc.historyIndex, 100);
  });

  it("findLinkedItemByTag resolves linked smart-object records", () => {
    const doc = new Document("demo.psd");
    const linkedItem = { tag: "smart-1", raw: new Uint8Array([1, 2, 3]) };
    doc.add.lnk2 = [linkedItem];
    assert.equal(doc.findLinkedItemByTag("smart-1"), linkedItem);
    assert.equal(doc.findLinkedItemByTag("missing"), null);
  });

  it("Document.generateUID returns a random UUID", () => {
    const uid = Document.generateUID();
    // Version 4 and the RFC 4122 variant: no timestamp, no hardware address.
    assert.match(uid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("Document.generateUID does not repeat itself", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(Document.generateUID());
    assert.equal(seen.size, 1000);
  });

  it("Document.createPathEntry builds a work-path record", () => {
    const pathEntry = Document.createPathEntry("Vector Path");
    assert.equal(pathEntry.name, "Vector Path");
    assert.equal(pathEntry.idx, 0);
    assert.ok(pathEntry.add.vmsk);
    assert.ok(Array.isArray(pathEntry.add.vogk));
  });

  it("Document.cloneLinkedItem copies placed-item payload", () => {
    const source = {
      id: "12345678-abcd",
      buffer: new Uint8Array([9, 8, 7]),
      rect: new Rect(1, 2, 3, 4),
      d: null,
    };
    const clone = Document.cloneLinkedItem(source);
    // A copy is a different item and gets an identity of its own, so nothing
    // downstream can confuse it with the item it came from.
    assert.notEqual(clone.id, source.id);
    assert.match(clone.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(clone.buffer, source.buffer);
    assert.deepEqual(clone.buffer, source.buffer);
    assert.notEqual(clone.rect, source.rect);
    assert.equal(clone.rect.width, 3);
    assert.equal(clone.d, null);
  });
});
