import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let HistoryEntry;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ HistoryEntry } = await import("../../../src/document/model/document.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/model/document.js — HistoryEntry", () => {
  it("initializes step fields with excludeFromHistoryUI defaulting to false", () => {
    const entry = new HistoryEntry("layer.move", { id: "move-tool" });
    assert.equal(entry.name, "layer.move");
    assert.equal(entry.routingChannel.id, "move-tool");
    assert.equal(entry.excludeFromHistoryUI, false);
    assert.equal(entry.data, null);
  });

  it("accepts excludeFromHistoryUI when provided", () => {
    const entry = new HistoryEntry("Layer visibility", {}, true);
    assert.equal(entry.excludeFromHistoryUI, true);
  });
});
