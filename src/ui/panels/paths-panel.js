/**
 * Paths panel: lists vector paths for the active document with thumbnails,
 * selection, and footer actions (make selection, selection→path, new, delete).
 */

import { Rect } from "../../core/math/rect.js";
import { ToolId } from "../../document/model/tool-base.js";
import { BaseTool } from "../widgets/base-tool.js";
import { LayerListItem } from "../widgets/layer-list-item.js";
import { ChannelsPanel } from "./channels-panel.js";
import { LayerThumbnails } from "../../document/layer-thumbnails.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { clearElement, isInDOM, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

const FOOTER_MAKE_SELECTION = 0;
const FOOTER_SELECTION_TO_PATH = 1;
const FOOTER_NEW_PATH = 2;
const FOOTER_DELETE_PATH = 3;

const FOOTER_TITLES = [
  "sampleScope.selection",
  "Selection to Path",
  "clipboard.new",
  "clipboard.delete"
];

const FOOTER_ICON_KEYS = ["lrs/makesel", "lrs/makepath", "lrs/newlayer", "lrs/bin"];

const THUMB_BASE_PX = 34;
const SELECTION_TO_PATH_TOLERANCE_PX = 2;

/** Construct the Paths panel: build the list body, footer toolbar, and events. */
function PathsPanel() {
  BaseTool.call(this, "view.paths", false, getIconUrl("panels/paths"), BaseTool.PanelId.PATHS, true);
  this.activeDoc = null;
  this.thumbContexts = [];
  this.footerBtns = [];
  installPathsPanelLayout(this);
  this.on("click", this.onLayerClick, this)
}
PathsPanel.prototype = Object.create(BaseTool.prototype);

PathsPanel.prototype.onFooterPointerDown = function(evt) {
  const btnIndex = ChannelsPanel.indexOfButton(this.footerBtns, evt);
  this.dispatch(buildFooterActionEvent(btnIndex, evt))
};

PathsPanel.prototype.onFooterDrop = function(evt) {
  this.onFooterPointerDown(evt)
};

PathsPanel.prototype.getThumbCtx = function(index) {
  return resolveThumbContext(this.thumbContexts, index)
};

PathsPanel.prototype.onPanelBgClick = function(evt) {
  if (evt.target != this.containerEl) return;
  clearPathSelections(this.activeDoc)
};

PathsPanel.prototype.onLayerClick = function(evt) {
  applyPathListSelection(this.activeDoc, evt.data.idx, evt.data.isMultiSelectModifier)
};

PathsPanel.prototype.refresh = function() {
  this.rebuild()
};

PathsPanel.prototype.open = function(doc) {
  this.activeDoc = doc;
  this.rebuild()
};

PathsPanel.prototype.rebuild = function() {
  rebuildPathList(this)
};

PathsPanel.prototype.resize = function(_width, height) {
  this.containerEl.style.height = height - 9 - 25 + "px"
};

PathsPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  this.rebuild();
  ChannelsPanel.applyFooterIcons(this.footerBtns, FOOTER_ICON_KEYS)
};

/**
 * Order index within work-path or layer-path selection lists for a path id.
 */
PathsPanel.resolvePathSelectionOrder = resolvePathSelectionOrder;

/**
 * Selection-to-path historyGrouped descriptor (fixed 2px tolerance).
 */
PathsPanel.buildSelectionToPathAction = buildSelectionToPathAction;

export { PathsPanel };

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function installPathsPanelLayout(panel) {
  panel.containerEl = makeElement("div", "lpbody scrollable");
  panel.footerEl = makeElement("div", "lpfoot");
  panel.panelBody.appendChild(panel.containerEl);
  panel.panelBody.appendChild(panel.footerEl);
  panel.panelBody.addEventListener("click", panel.onPanelBgClick.bind(panel), false);
  ChannelsPanel.buildFooterButtons(
    FOOTER_TITLES,
    panel.footerBtns,
    panel.footerEl,
    panel.onFooterPointerDown.bind(panel),
    panel.onFooterDrop.bind(panel)
  )
}

function resolveThumbContext(thumbContexts, index) {
  let ctx = thumbContexts[index];
  if (ctx == null) {
    const canvas = makeElement("canvas");
    ctx = canvas.getContext("2d");
    thumbContexts.push(ctx)
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Footer actions
// ---------------------------------------------------------------------------

function buildFooterActionEvent(btnIndex, evt) {
  if (btnIndex == FOOTER_MAKE_SELECTION) {
    return LayerListItem.buildSelectionEvent(false, null, evt)
  }
  if (btnIndex == FOOTER_SELECTION_TO_PATH) {
    return buildSelectionToPathAction()
  }
  const actionEvt = new AppEvent(EventType.documentAction, true);
  actionEvt.routingChannel = ToolId.TOOL_PATH_SELECT;
  actionEvt.data = {
    actionKind: "pathedit",
    operation: ["new", "del"][btnIndex - FOOTER_NEW_PATH]
  };
  return actionEvt
}

function buildSelectionToPathAction() {
  const actionEvt = new AppEvent(EventType.historyGrouped, true);
  actionEvt.data = {
    uf: "make",
    actionDescriptor: {
      classID: "null",
      null: {
        t: "obj ",
        v: [{
          t: "Clss",
          v: {
            classID: "Path"
          }
        }]
      },
      From: {
        t: "obj ",
        v: [{
          t: "prop",
          v: {
            classID: "csel",
            keyID: "fsel"
          }
        }]
      },
      Tlrn: {
        t: "UntF",
        v: {
          type: "#Pxl",
          val: SELECTION_TO_PATH_TOLERANCE_PX
        }
      }
    }
  };
  return actionEvt
}

// ---------------------------------------------------------------------------
// Path selection
// ---------------------------------------------------------------------------

function clearPathSelections(doc) {
  doc.selectedWorkPaths = [];
  doc.selectedLayerPaths = [];
  doc.panelsDirty = true;
  doc.dirty = true
}

// A negative pathId denotes a work path (the two selection lists are kept
// separate: selecting in one clears the other). Returns the path's position
// within its list plus which list is the active one for that id.
function resolvePathSelectionOrder(doc, pathId) {
  if (pathId < 0) {
    return {
      pathOrder: -1 - pathId,
      activeList: doc.selectedWorkPaths,
      inactiveList: doc.selectedLayerPaths
    }
  }
  const docPaths = doc.getPaths()[0];
  let pathOrder = 0;
  for (let pathIndex = 0; pathIndex < docPaths.length; pathIndex++) {
    const entryId = docPaths[pathIndex].idx;
    if (entryId == pathId) break;
    if (entryId >= 0) pathOrder++
  }
  return {
    pathOrder,
    activeList: doc.selectedLayerPaths,
    inactiveList: doc.selectedWorkPaths
  }
}

function applyPathListSelection(doc, pathId, isMultiSelectModifier) {
  const { pathOrder, activeList, inactiveList } = resolvePathSelectionOrder(doc, pathId);
  if (isMultiSelectModifier) {
    const existing = activeList.indexOf(pathOrder);
    if (existing == -1) activeList.push(pathOrder);
    else activeList.splice(existing, 1)
  } else {
    while (activeList.length != 0) activeList.pop();
    while (inactiveList.length != 0) inactiveList.pop();
    activeList.push(pathOrder)
  }
  doc.panelsDirty = true;
  doc.dirty = true
}

// ---------------------------------------------------------------------------
// List rebuild
// ---------------------------------------------------------------------------

function resolveThumbPixelSize(docWidth, docHeight) {
  let thumbW = THUMB_BASE_PX,
    thumbH = THUMB_BASE_PX;
  if (docWidth > docHeight) thumbH = Math.round(thumbH * docHeight / docWidth);
  else thumbW = Math.round(thumbW * docWidth / docHeight);
  return { thumbW, thumbH }
}

function rebuildPathList(panel) {
  const doc = panel.activeDoc,
    container = panel.containerEl;
  clearElement(container);
  if (doc == null || !isInDOM(container)) return;
  const docRect = new Rect(0, 0, doc.width, doc.height),
    { thumbW, thumbH } = resolveThumbPixelSize(doc.width, doc.height),
    pathsAndSelections = doc.getPaths(),
    paths = pathsAndSelections[0];
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex],
      thumbCtx = panel.getThumbCtx(pathIndex);
    LayerThumbnails.drawVectorMaskThumbnail(thumbCtx, thumbW, thumbH, docRect, path.add.vmsk);
    const item = new LayerListItem(
      path.idx,
      false,
      path.idx >= 0,
      thumbCtx,
      path.name,
      pathsAndSelections[1].indexOf(pathIndex) != -1,
      false,
      ToolId.TOOL_PATH_SELECT,
      {
        actionKind: "pathedit",
        operation: "rnm",
        idx: path.idx
      }
    );
    item.parent = panel;
    container.appendChild(item.el)
  }
}
