/**
 * ToolBar pack / visibility helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let SideBar;
let ToolBar;
let packToolsIntoRows;
let toolbarGroupBudget;
let findToolGroupIndex;
let shouldShowToolbarColorList;
let TOOLBAR_ROW_MERGE_PAIRS;

before(async () => {
  ({
    SideBar,
    ToolBar,
    packToolsIntoRows,
    toolbarGroupBudget,
    findToolGroupIndex,
    shouldShowToolbarColorList,
    TOOLBAR_ROW_MERGE_PAIRS
  } = await import("../../../src/ui/tool-options/option-bar.js"));
});

describe("ui/tool-options/option-bar.js", () => {
  it("packToolsIntoRows merges to maxRows golden", () => {
    const groups = [];
    for (let i = 0; i < 19; i++) groups.push([{ id: i }]);
    const packed = packToolsIntoRows(groups, 12);
    assert.equal(packed.length, 12);
    assert.deepEqual(
      packed.map((row) => row.map((entry) => entry.id)),
      [[0], [1, 2], [3], [4, 5], [6], [7, 8, 9], [10], [11, 12], [13], [14, 15, 16], [17], [18]]
    );
    assert.equal(TOOLBAR_ROW_MERGE_PAIRS.length, 24);
  });

  it("toolbarGroupBudget widens the strip before it merges groups", () => {
    // The registry ships 20 groups. A tall window holds them all in one column,
    // so the budget is never the binding constraint.
    assert.ok(toolbarGroupBudget(835, 32) >= 20);
    // Half that height fits ten rows per column; two merge-free columns still
    // clear 20, so nothing is hidden in a flyout yet.
    assert.equal(toolbarGroupBudget(382, 32), 20);
    // Only once two columns can no longer hold them does merging start.
    assert.ok(toolbarGroupBudget(300, 32) < 20);
    // Never zero, however little height is left.
    assert.equal(toolbarGroupBudget(0, 32), 2);
  });

  it("findToolGroupIndex locates tool id", () => {
    const allGroups = [[{ tool: { id: 10 } }], [{ tool: { id: 20 } }, { tool: { id: 30 } }]];
    assert.equal(findToolGroupIndex(30, allGroups), 1);
    assert.equal(findToolGroupIndex(99, allGroups), undefined);
  });

  it("shouldShowToolbarColorList goldens", () => {
    assert.equal(shouldShowToolbarColorList(1, false, [0, 0, 0]), true);
    assert.equal(shouldShowToolbarColorList(0, false, [1, 0, 0]), true);
    assert.equal(shouldShowToolbarColorList(0, false, [0.5, 0.5, 0]), true);
    assert.equal(shouldShowToolbarColorList(0, false, [0, 0, 0]), false);
    assert.equal(shouldShowToolbarColorList(0, true, [0, 0, 0]), true);
  });

  it("exports SideBar and ToolBar", () => {
    assert.equal(typeof SideBar, "function");
    assert.equal(typeof ToolBar, "function");
  });
});
