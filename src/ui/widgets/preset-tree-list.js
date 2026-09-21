/**
 * Hierarchical preset picker (swatches / gradients).
 *
 * Tree node tuples:
 * - Folder: [label, null, children[], folderOpen]
 * - Leaf:   [label, value, thumbDataUrl]
 *
 * folderOpen uses !== false so missing/undefined means open.
 */


import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { SwatchFile } from "../../features/swatch/swatch-file.js";
import { FileLoader } from "../shell/file-loader.js";
import { InputHandler } from "../tool-options/input-handler.js";
import { PopupTypes, defaultExportFilename } from "../config/popup-types.js";
import { BaseWidget } from "./base-widget.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, cancel, clearElement, getDevicePixelRatio, getEventPos, makeElement, preventDomDefaultAction, removeClass, setElementCssSizeForDeviceRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Context-menu row: open local preset file. */
const MENU_OPEN_FILE = 0;
/** Context-menu row: export tree. */
const MENU_EXPORT = 1;
/** Context-menu row: load history / replace from file. */
const MENU_LOAD_HISTORY = 2;
/** Context-menu row: delete selection. */
const MENU_DELETE = 3;
/** Context-menu row: toggle tiles vs list. */
const MENU_TOGGLE_VIEW = 4;
/** Context-menu row: define new preset. */
const MENU_DEFINE_NEW = 5;
/** Context-menu row: new folder. */
const MENU_NEW_FOLDER = 6;

/**
 * @param {boolean} useGsIconClass When true, leaf thumbs get the gsicon class.
 * @param {*} presetKind PopupTypes preset resource id.
 */
function PresetTreeList(useGsIconClass, presetKind) {
  BaseWidget.call(this);
  this.useGsIconClass = useGsIconClass;
  this.presetKind = presetKind;
  this.viewMode = 0;
  this.presetTree = null;
  this.rowElements = [];
  this.rowPaths = [];
  this.selectedRowIndexes = [];
  this.contextMenu = buildPresetTreeContextMenu(presetKind);
  this.contextMenu.parent = this;
  this.contextMenu.on("select", this.onContextMenuSelect, this);
  this.el = makeElement("div");
  this.el.className = "imageset scrollable";
  this.el.addEventListener("contextmenu", preventDomDefaultAction, false);
  this.onRowMouseUp = this.onRowMouseUp.bind(this);
  this.onDragStart = function(evt) {
    evt.dataTransfer.setData("text", String(this.rowElements.indexOf(evt.currentTarget)))
  }.bind(this);
  this.onDrop = this.onDrop.bind(this)
}

PresetTreeList.prototype = Object.create(BaseWidget.prototype);
PresetTreeList.prototype.constructor = PresetTreeList;

PresetTreeList.prototype.getContextMenu = function() {
  return this.contextMenu
};

PresetTreeList.prototype.buildUI = function() {
  this.contextMenu.buildUI()
};

PresetTreeList.prototype.getViewMode = function() {
  return this.viewMode
};

PresetTreeList.prototype.setViewMode = function(viewMode) {
  this.viewMode = viewMode;
  if (this.presetTree) this.redraw()
};

PresetTreeList.prototype.setPresetTree = function(tree) {
  this.presetTree = Array.isArray(tree) ? tree : [];
  this.redraw()
};

PresetTreeList.prototype.redraw = function() {
  clearElement(this.el);
  this.rowElements = [];
  this.rowPaths = [];
  this.renderTreeNodes(this.presetTree, this.el, [])
};

PresetTreeList.prototype.renderTreeNodes = function(nodes, parentEl, pathPrefix) {
  if (!nodes || !nodes.length) return;
  const meta = PopupTypes.getPresetResource(this.presetKind),
    thumbW = Math.floor((meta.thumbWidth || 22) * getDevicePixelRatio()),
    thumbH = Math.floor((meta.thumbHeight || 22) * getDevicePixelRatio()),
    viewMode = this.viewMode;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i],
      path = pathPrefix.concat([i]),
      rowEl = isFolderNode(node)
        ? createFolderRowElement(node, path, this)
        : createLeafRowElement(node, meta, thumbW, thumbH, viewMode, this.useGsIconClass);
    parentEl.appendChild(rowEl);
    if (this.selectedRowIndexes.indexOf(this.rowElements.length) != -1) addClass(rowEl, "selected");
    this.rowElements.push(rowEl);
    this.rowPaths.push(path);
    wireRowDragAndSelect(rowEl, this);
    if (isFolderNode(node) && isFolderOpen(node)) {
      appendExpandedFolderChildren(node, parentEl, path, this)
    }
  }
};

PresetTreeList.prototype.onFolderToggleClick = function(path, evt) {
  cancel(evt);
  evt.stopPropagation();
  const node = getNodeAtPath(this.presetTree, path);
  node[3] = node[3] === false;
  this.redraw()
};

PresetTreeList.prototype.onRowMouseUp = function(evt) {
  const rowIndex = this.rowElements.indexOf(evt.currentTarget),
    node = getNodeAtPath(this.presetTree, this.rowPaths[rowIndex]),
    isFolder = isFolderNode(node);
  if (isFolderToggleTarget(evt.target)) return;
  if (evt.button == 0 || this.selectedRowIndexes.indexOf(rowIndex) == -1) {
    this.selectedRowIndexes = computeRowSelection(
      this.selectedRowIndexes,
      rowIndex,
      window.__kb
    )
  }
  this.redraw();
  if (evt.button == 0 && !isFolder && this.selectedRowIndexes.length == 1) {
    this.dispatch(new AppEvent(EventType.widgetSelect))
  }
  if (evt.button == 2) dispatchContextMenuOverlay(this, evt)
};

PresetTreeList.prototype.onDrop = function(evt) {
  evt.preventDefault();
  const fromIndex = parseInt(evt.dataTransfer.getData("text"), 10),
    toIndex = this.rowElements.indexOf(evt.currentTarget),
    moving = this.selectedRowIndexes.indexOf(fromIndex) == -1
      ? [fromIndex]
      : this.selectedRowIndexes.slice(0),
    targetPath = this.rowPaths[toIndex],
    targetKey = pathKey(targetPath),
    pathSet = uniquePaths(moving, this.rowPaths),
    blocked = pathSet[1];
  for (let key in blocked)
    if (targetKey.startsWith(key)) return;
  const dropTarget = resolveDropInsertTarget(this.presetTree, targetPath),
    movedNodes = extractNodes(this.presetTree, pathSet[0], false);
  for (let n = 0; n < movedNodes.length; n++) {
    dropTarget.siblings.splice(dropTarget.insertIndex + n, 0, movedNodes[n])
  }
  this.selectedRowIndexes = [];
  const flat = flattenNodes(this.presetTree);
  for (let n = 0; n < movedNodes.length; n++) {
    this.selectedRowIndexes.push(flat.indexOf(movedNodes[n]))
  }
  this.redraw();
  this.commitTreeChange()
};

PresetTreeList.prototype.onContextMenuSelect = function(evt) {
  const choice = evt.target.getSelectedIndices()[0],
    selection = this.selectedRowIndexes;
  if (choice == MENU_OPEN_FILE || choice == MENU_LOAD_HISTORY) {
    dispatchPickLocalFiles(this);
    return
  }
  if (choice == MENU_EXPORT) {
    exportPresetTreeFile(this, selection);
    return
  }
  if (choice == MENU_DELETE) {
    deleteSelectedPresetRows(this, selection);
    return
  }
  if (choice == MENU_TOGGLE_VIEW) {
    this.setViewMode(1 - this.viewMode);
    return
  }
  if (choice == MENU_DEFINE_NEW) {
    this.dispatch(new AppEvent("define_new"));
    return
  }
  if (choice == MENU_NEW_FOLDER) {
    this.insertFolder(["New folder", null, [], true])
  }
};

PresetTreeList.prototype.insertFolder = function(folderNode) {
  const insert = resolveInsertBesideSelection(this.presetTree, this.selectedRowIndexes, this.rowPaths, true);
  insert.siblings.splice(insert.insertAt + 1, 0, folderNode);
  this.selectedRowIndexes = [flattenNodes(this.presetTree).indexOf(folderNode)];
  this.redraw();
  this.promptRenameSelected()
};

PresetTreeList.prototype.promptRenameSelected = function() {
  const node = getNodeAtPath(this.presetTree, this.rowPaths[this.selectedRowIndexes[0]]),
    dispatchEvt = new AppEvent(EventType.uiDispatch, true);
  dispatchEvt.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "namewindow",
    initialValue: node[0],
    deferredDispatch: {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.openResourcePresetPopup,
        popupType: this.presetKind,
        scriptHostData: "rnm",
        presetSelectionPath: this.rowPaths[this.selectedRowIndexes[0]]
      }
    }
  };
  this.dispatch(dispatchEvt)
};

PresetTreeList.prototype.commitTreeChange = function() {
  const evt = new AppEvent(EventType.uiDispatch, true);
  evt.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: this.presetKind,
    scriptHostData: "mdf"
  };
  this.dispatch(evt)
};

/** The selected leaf's preset value (node[1]), or null. */
PresetTreeList.prototype.getSelectedPreset = function() {
  if (this.selectedRowIndexes.length == 0) return null;
  return getNodeAtPath(this.presetTree, this.rowPaths[this.selectedRowIndexes[0]])[1]
};

// getValue/setValue speak in flat row indexes (position in the rendered list),
// not preset values; use getSelectedPreset for the picked preset itself.
PresetTreeList.prototype.getValue = function() {
  return this.selectedRowIndexes.length ? this.selectedRowIndexes[0] : -1
};

PresetTreeList.prototype.setValue = function(rowIndex) {
  this.selectedRowIndexes = rowIndex >= 0 ? [rowIndex] : [];
  this.redraw()
};

PresetTreeList.prototype.highlightRowAtIndex = function(rowIndex) {
  for (let i = 0; i < this.rowElements.length; i++) {
    const row = this.rowElements[i];
    if (row == null) continue;
    if (i == rowIndex) addClass(row, "selected");
    else removeClass(row, "selected")
  }
};

PresetTreeList.prototype.defineNewPreset = function(value) {
  const leaf = ["New item", value, null],
    insert = resolveInsertBesideSelection(this.presetTree, this.selectedRowIndexes, this.rowPaths, false);
  insert.siblings.splice(insert.insertAt, 0, leaf);
  this.selectedRowIndexes = [flattenNodes(this.presetTree).indexOf(leaf)];
  this.redraw();
  this.commitTreeChange()
};

PresetTreeList.getNodeAtPath = getNodeAtPath;
PresetTreeList.getParentList = getParentList;
PresetTreeList.flattenNodes = flattenNodes;
PresetTreeList.uniquePaths = uniquePaths;
PresetTreeList.extractNodes = extractNodes;

export {
  PresetTreeList,
  getNodeAtPath,
  getParentList,
  flattenNodes,
  uniquePaths,
  extractNodes,
  isFolderNode,
  isFolderOpen,
  computeRowSelection,
  pathKey
};

// --- Context menu / DOM helpers ----------------------------------------------

function buildPresetTreeContextMenu(presetKind) {
  const ext = PopupTypes.getPresetResource(presetKind).extension.toUpperCase();
  return new InputHandler([{
    name: ["VAR0 ." + ext, "file.open"]
  }, {
    name: ["VAR0 ." + ext, "file.exportAs"]
  }, {
    name: ["history.loadVar", "." + ext]
  }, {
    name: "clipboard.delete"
  }, {
    name: "Tiles/List"
  }, {
    name: "properties.defineNew"
  }, {
    name: "layer.newFolder"
  }])
}

function isFolderNode(node) {
  return node[1] == null
}

function isFolderOpen(node) {
  return node[3] !== false
}

function isFolderToggleTarget(target) {
  if (!target.getAttribute) return false;
  const className = target.getAttribute("class");
  return className == "open" || className == "closed"
}

function createFolderRowElement(node, path, list) {
  const rowEl = makeElement("div", "listitem head");
  rowEl.setAttribute("style", "clear:both; padding:4px 4px; height:16px; background-color:rgba(0,0,0,0.1);  margin:1.5px;");
  const headL = makeElement("div", "headL");
  rowEl.appendChild(headL);
  const toggleBtn = makeElement("div", isFolderOpen(node) ? "open" : "closed");
  toggleBtn.addEventListener("click", list.onFolderToggleClick.bind(list, path), false);
  headL.appendChild(toggleBtn);
  headL.appendChild(makeElement("div", "folder"));
  const titleSpan = makeElement("span");
  titleSpan.textContent = node[0];
  headL.appendChild(titleSpan);
  return rowEl
}

function createLeafRowElement(node, meta, thumbW, thumbH, viewMode, useGsIconClass) {
  let thumb = node[2];
  if (thumb == null) thumb = node[2] = SwatchFile.renderSwatchThumb(node, thumbW, thumbH);
  let rowEl = makeElement("img", "image");
  rowEl.setAttribute("src", thumb);
  setElementCssSizeForDeviceRatio(rowEl, thumbW, thumbH);
  if (useGsIconClass) addClass(rowEl, "gsicon");
  if (viewMode == 1) {
    const listRow = makeElement("div", "listitem");
    listRow.appendChild(rowEl);
    listRow.style.height = (meta.thumbHeight || 22) + "px";
    const caption = makeElement("span");
    caption.textContent = node[0];
    caption.setAttribute("style", "margin-left:4px;");
    listRow.appendChild(caption);
    rowEl = listRow
  }
  rowEl.setAttribute("title", node[0]);
  return rowEl
}

function wireRowDragAndSelect(rowEl, list) {
  rowEl.addEventListener("mouseup", list.onRowMouseUp, false);
  rowEl.setAttribute("draggable", "true");
  rowEl.addEventListener("dragover", preventDomDefaultAction, false);
  rowEl.addEventListener("dragstart", list.onDragStart, false);
  rowEl.addEventListener("drop", list.onDrop, false)
}

function appendExpandedFolderChildren(node, parentEl, path, list) {
  const childWrap = makeElement("div");
  childWrap.style.marginLeft = "14px";
  parentEl.appendChild(childWrap);
  let children = node[2];
  if (!Array.isArray(children)) children = node[2] = [];
  list.renderTreeNodes(children, childWrap, path)
}

function pathKey(path) {
  return path.join(",") + ","
}

/**
 * Shift-range / Ctrl-toggle / replace selection. Returns sorted indexes.
 */
function computeRowSelection(previousSelection, rowIndex, keyboard) {
  let selection = previousSelection.slice(0);
  if (keyboard && keyboard.isPressed(KeyboardHandler.Shift)) {
    const lo = Math.min(selection[0], selection[selection.length - 1], rowIndex),
      hi = Math.max(selection[0], selection[selection.length - 1], rowIndex);
    selection = [];
    for (let n = lo; n <= hi; n++) selection.push(n)
  } else if (keyboard && keyboard.isPressed(KeyboardHandler.Ctrl)) {
    const at = selection.indexOf(rowIndex);
    if (at == -1) selection.push(rowIndex);
    else selection.splice(at, 1)
  } else selection = [rowIndex];
  selection.sort(function(a, b) {
    return a - b
  });
  return selection
}

function dispatchContextMenuOverlay(list, evt) {
  list.contextMenu.update(null);
  const bodyPos = getEventPos(evt, document.body),
    overlayEvt = new AppEvent(EventType.uiDispatch, true);
  overlayEvt.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: list.contextMenu,
    x: bodyPos.x,
    y: bodyPos.y + 2
  };
  list.dispatch(overlayEvt)
}

function dispatchPickLocalFiles(list) {
  const dispatchEvt = new AppEvent(EventType.uiDispatch, true);
  dispatchEvt.data = {
    dispatchKind: UiCommand.pickLocalFiles
  };
  list.dispatch(dispatchEvt)
}

function exportPresetTreeFile(list, selection) {
  const paths = uniquePaths(selection, list.rowPaths)[0];
  extractNodes(list.presetTree, paths, true);
  const meta = PopupTypes.getPresetResource(list.presetKind);
  FileLoader.save(SwatchFile.serializeTree(list.presetTree), defaultExportFilename(meta))
}

function deleteSelectedPresetRows(list, selection) {
  const paths = uniquePaths(selection, list.rowPaths)[0];
  extractNodes(list.presetTree, paths, false);
  list.selectedRowIndexes = [];
  list.redraw();
  list.commitTreeChange()
}

function resolveDropInsertTarget(tree, targetPath) {
  const targetNode = getNodeAtPath(tree, targetPath);
  if (isFolderNode(targetNode)) {
    return {
      siblings: targetNode[2],
      insertIndex: targetNode[2].length
    }
  }
  const parentInfo = getParentList(tree, targetPath);
  return {
    siblings: parentInfo[2],
    insertIndex: parentInfo[2].indexOf(targetNode) + 1
  }
}

/**
 * @param {boolean} folderMode When true, insert after selection (folders);
 *        when false, insert at/after selection for new leaves.
 */
function resolveInsertBesideSelection(tree, selection, rowPaths, folderMode) {
  let siblings = tree,
    insertAt = folderMode ? siblings.length - 1 : siblings.length;
  if (selection.length == 0) {
    return {
      siblings: siblings,
      insertAt: insertAt
    }
  }
  const path = rowPaths[selection[0]],
    parentInfo = getParentList(tree, path),
    node = getNodeAtPath(tree, path);
  siblings = parentInfo[2];
  if (folderMode) {
    insertAt = siblings.indexOf(node);
    if (isFolderNode(node)) {
      siblings = node[2];
      insertAt = siblings.length - 1
    }
  } else {
    insertAt = siblings.indexOf(node) + 1;
    if (isFolderNode(node)) {
      siblings = node[2];
      insertAt = siblings.length
    }
  }
  return {
    siblings: siblings,
    insertAt: insertAt
  }
}

// --- Pure tree operations ----------------------------------------------------

function getNodeAtPath(tree, path) {
  let cursor = ["", null, tree];
  for (let i = 0; i < path.length; i++) cursor = cursor[2][path[i]];
  return cursor
}

function getParentList(tree, path) {
  let cursor = ["", null, tree];
  for (let i = 0; i < path.length - 1; i++) cursor = cursor[2][path[i]];
  return cursor
}

function flattenNodes(tree) {
  const out = [];
  walkFlatten(tree, out);
  return out
}

function walkFlatten(nodes, out) {
  for (let i = 0; i < nodes.length; i++) {
    out.push(nodes[i]);
    if (isFolderNode(nodes[i])) walkFlatten(nodes[i][2], out)
  }
}

function uniquePaths(rowIndexes, rowPaths) {
  const paths = [],
    seen = {};
  for (let i = 0; i < rowIndexes.length; i++) {
    const path = rowPaths[rowIndexes[i]],
      key = pathKey(path);
    let blocked = false;
    for (let prefix in seen)
      if (key.startsWith(prefix)) blocked = true;
    if (!blocked) {
      seen[key] = true;
      paths.push(path)
    }
  }
  return [paths, seen]
}

function extractNodes(tree, paths, copyOnly) {
  const collected = [];
  for (let p = paths.length - 1; p >= 0; p--) {
    const path = paths[p],
      parent = getParentList(tree, path),
      siblings = parent[2],
      index = path[path.length - 1],
      node = siblings[index];
    collected.unshift(node);
    if (!copyOnly) siblings.splice(index, 1)
  }
  return collected
}
