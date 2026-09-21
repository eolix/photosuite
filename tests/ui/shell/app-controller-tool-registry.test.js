/**
 * tool registry helpers (no DocumentModel tool ctor bootstrap).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let initToolRegistryMap;
let buildModifierToolOverrides;
let buildToolbarShortcutKeys;
let toolEntry;
let DocumentModel;
let KeyboardHandler;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ KeyboardHandler } = await import("../../../src/core/keyboard-handler.js"));
  ({
    initToolRegistryMap,
    buildModifierToolOverrides,
    buildToolbarShortcutKeys,
    toolEntry
  } = await import("../../../src/ui/shell/app-controller-tool-registry.js"));
});

describe("ui/shell/app-controller-tool-registry.js", () => {
  it("buildToolbarShortcutKeys matches golden length and terminals", () => {
    const keys = buildToolbarShortcutKeys();
    assert.equal(keys.length, 19);
    assert.equal(keys[0], KeyboardHandler.KeyV);
    assert.equal(keys[11], null);
    assert.equal(keys[18], KeyboardHandler.KeyZ);
  });

  it("buildModifierToolOverrides: zoom inactive, move while inactive", () => {
    const overrides = buildModifierToolOverrides();
    assert.equal(overrides.length, 7);
    assert.equal(overrides[0].documentModelType, ToolId.TOOL_ZOOM);
    assert.equal(overrides[0].activateWhileToolInactive, false);
    assert.equal(overrides[6].documentModelType, ToolId.TOOL_MOVE);
    assert.equal(overrides[6].activateWhileToolInactive, true);
    assert.deepEqual(overrides[2].allowedBaseToolIds, [ToolId.TOOL_SLICE_SELECT]);
  });

  it("toolEntry pairs tool and option panel class", () => {
    const entry = toolEntry({ id: 42 }, function Opt() {});
    assert.equal(entry.tool.id, 42);
    assert.equal(typeof entry.optionPanelClass, "function");
  });

  it("initToolRegistryMap indexes toolbar + auxiliary + tracker entries", () => {
    const registry = {
      toolbarGroups: [
        [toolEntry({ id: 10 }, null), toolEntry({ id: 11 }, null)],
        "---",
        [toolEntry({ id: 20 }, null)]
      ],
      selectedVariantByGroup: [],
      auxiliaryToolEntries: [toolEntry({ id: 99 }, null)],
      filterTrackerEntries: [{ tool: { id: 100 } }],
      entriesById: {}
    };
    initToolRegistryMap(registry);
    assert.equal(registry.entriesById[10].toolbarGroupIndex, 0);
    assert.equal(registry.entriesById[10].variantIndexInGroup, 0);
    assert.equal(registry.entriesById[11].variantIndexInGroup, 1);
    assert.equal(registry.entriesById[20].toolbarGroupIndex, 2);
    assert.equal(registry.selectedVariantByGroup[0], 0);
    assert.equal(registry.selectedVariantByGroup[2], 0);
    assert.equal(registry.entriesById[99].tool.id, 99);
    assert.equal(registry.entriesById[100].tool.id, 100);
    assert.equal(registry.entriesById["---"], undefined);
  });
});
