/**
 * PresetTreeList tree-op goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let getNodeAtPath;
let getParentList;
let flattenNodes;
let uniquePaths;
let extractNodes;
let isFolderNode;
let isFolderOpen;
let computeRowSelection;
let PresetTreeList;
let KeyboardHandler;

function sampleTree() {
  return [
    ["Folder A", null, [
      ["Leaf1", { a: 1 }, null],
      ["Leaf2", { a: 2 }, null]
    ], true],
    ["Leaf3", { a: 3 }, null],
    ["Folder B", null, [
      ["Leaf4", { a: 4 }, null]
    ], false]
  ];
}

before(async () => {
  ({ KeyboardHandler } = await import("../../../src/core/keyboard-handler.js"));
  ({
    getNodeAtPath,
    getParentList,
    flattenNodes,
    uniquePaths,
    extractNodes,
    isFolderNode,
    isFolderOpen,
    computeRowSelection,
    PresetTreeList
  } = await import("../../../src/ui/widgets/preset-tree-list.js"));
});

describe("ui/widgets/preset-tree-list.js", () => {
  it("getNodeAtPath / getParentList / flattenNodes goldens", () => {
    var tree = sampleTree();
    assert.equal(getNodeAtPath(tree, [0])[0], "Folder A");
    assert.equal(getNodeAtPath(tree, [0, 0])[0], "Leaf1");
    assert.equal(getParentList(tree, [0, 0])[0], "Folder A");
    assert.deepEqual(flattenNodes(tree).map(function(n) {
      return n[0];
    }), ["Folder A", "Leaf1", "Leaf2", "Leaf3", "Folder B", "Leaf4"]);
  });

  it("uniquePaths drops descendants of selected ancestors", () => {
    var rowPaths = [[0], [0, 0], [0, 1], [1], [2], [2, 0]];
    var up = uniquePaths([1, 2, 3], rowPaths);
    assert.deepEqual(up[0], [[0, 0], [0, 1], [1]]);
    var nested = uniquePaths([0, 1], rowPaths);
    assert.deepEqual(nested[0], [[0]]);
  });

  it("extractNodes copy vs move goldens", () => {
    var treeCopy = sampleTree();
    var copied = extractNodes(treeCopy, [[0, 1], [1]], true);
    assert.deepEqual(copied.map(function(n) {
      return n[0];
    }), ["Leaf2", "Leaf3"]);
    assert.equal(treeCopy[0][2].length, 2);
    assert.equal(treeCopy.length, 3);

    var treeMove = sampleTree();
    var moved = extractNodes(treeMove, [[0, 0], [1]], false);
    assert.deepEqual(moved.map(function(n) {
      return n[0];
    }), ["Leaf1", "Leaf3"]);
    assert.deepEqual(treeMove.map(function(n) {
      return [n[0], n[1] == null ? n[2].map(function(c) {
        return c[0];
      }) : null];
    }), [["Folder A", ["Leaf2"]], ["Folder B", ["Leaf4"]]]);
  });

  it("isFolderNode / isFolderOpen", () => {
    assert.equal(isFolderNode(["F", null, [], true]), true);
    assert.equal(isFolderNode(["L", {}, null]), false);
    assert.equal(isFolderOpen(["F", null, [], false]), false);
    assert.equal(isFolderOpen(["F", null, [], true]), true);
    assert.equal(isFolderOpen(["F", null, []]), true);
  });

  it("computeRowSelection shift / ctrl / replace", () => {
    assert.deepEqual(computeRowSelection([2], 5, null), [5]);
    var shiftKb = {
      isPressed: function(code) {
        return code === KeyboardHandler.Shift;
      }
    };
    assert.deepEqual(computeRowSelection([1, 2], 4, shiftKb), [1, 2, 3, 4]);
    var ctrlKb = {
      isPressed: function(code) {
        return code === KeyboardHandler.Ctrl;
      }
    };
    assert.deepEqual(computeRowSelection([1, 3], 3, ctrlKb), [1]);
    assert.deepEqual(computeRowSelection([1], 4, ctrlKb), [1, 4]);
  });

  it("statics remain on PresetTreeList", () => {
    assert.equal(PresetTreeList.getNodeAtPath, getNodeAtPath);
    assert.equal(PresetTreeList.flattenNodes, flattenNodes);
  });
});
