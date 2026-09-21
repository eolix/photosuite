/**
 * Layer Comps panel: list document comps, switch the active comp, edit captured
 * attributes, and reload / create / delete comps via documentAction dispatch.
 */

import { EventChannel } from "../../document/model/tool-base.js";
import { BaseTool } from "../widgets/base-tool.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { Button } from "../widgets/form-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, clearElement, makeElement, removeClass } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

const FOOTER_RELOAD = 0;
const FOOTER_ADD = 1;
const FOOTER_DELETE = 2;

const FOOTER_ACTION_KINDS = ["updLC", "addLC", "delLC"];

const FOOTER_ICON_KEYS = ["reload", "lrs/newlayer", "lrs/bin"];
const FOOTER_ICON_TITLES = ["clipboard.update", "clipboard.new", "clipboard.delete"];

const CAPTURED_ATTR_ICON_KEYS = ["lrs/eye", "pos", "lrs/fx"];
const CAPTURED_ATTR_TITLES = ["Visibility", "Position", "Appearance"];

const SYNTHETIC_LAST_STATE_NAME = "Last Document State";

/**
 * Single row in the Layer Comps panel. Shows the comp name, a set-current
 * toggle and, for non-zero comps, attribute capture toggles. Double-clicking
 * the name starts an inline rename.
 */
function LayerCompListItem(compName, compId, capturedFlags, currentCompId, selectedCompId) {
  BaseWidget.call(this);
  this.compId = compId;
  this.el = makeElement("div", "head listitem" + (compId == selectedCompId ? " selected" : ""));
  const isCurrent = compId == currentCompId,
    setCurrentBtn = new Button(isCurrent ? "\u2713" : "\u2014");
  if (isCurrent) setCurrentBtn.markActive();
  this.el.appendChild(setCurrentBtn.el);
  setCurrentBtn.on("click", this.onSetCurrentClick, this);
  this.labelEl = makeElement("span");
  this.labelEl.textContent = compName;
  this.el.appendChild(this.labelEl);
  this.attrButtons = [];
  if (compId != 0) {
    this.el.addEventListener("mouseup", this.onLabelMouseUp.bind(this), false);
    this.attrRow = makeElement("span", "headR");
    this.el.appendChild(this.attrRow);
    installCapturedAttributeButtons(this, capturedFlags)
  }
}
LayerCompListItem.prototype = Object.create(BaseWidget.prototype);

LayerCompListItem.prototype.onLabelMouseUp = function(evt) {
  if (evt.target != this.labelEl && evt.target != this.el) return;
  if (evt.detail == 1) this.dispatch(new AppEvent("activate", false));
  else {
    new BaseTool.InlineRenameInput(this.labelEl, this.onRenameConfirm.bind(this))
  }
};

LayerCompListItem.prototype.onAttrToggleClick = function(evt) {
  const attrIndex = this.attrButtons.indexOf(evt.currentTarget);
  dispatchLayerCompDocumentAction(this, {
    actionKind: "editLC",
    capturedFlagIndex: attrIndex,
    idx: this.compId
  })
};

LayerCompListItem.prototype.onRenameConfirm = function(newName) {
  dispatchLayerCompDocumentAction(this, {
    actionKind: "editLC",
    newName: newName,
    idx: this.compId
  })
};

LayerCompListItem.prototype.onSetCurrentClick = function(_evt) {
  dispatchLayerCompDocumentAction(this, {
    actionKind: "setLC",
    idx: this.compId
  })
};

/**
 * Sidebar panel listing the document Layer Comps. The synthetic Last Document
 * State row always sits at the top; footer buttons reload, create, or delete.
 */
function LayerCompsPanel() {
  BaseTool.call(this, "panels.layerComps", false, getIconUrl("panels/layer-comps"), BaseTool.PanelId.LAYER_COMPS, true);
  this.panelBody.setAttribute("style", "min-width:240px;");
  this.activeDoc = null;
  this.selectedCompId = -1;
  this.compItems = [];
  this.containerEl = makeElement("div", "scrollable");
  this.containerEl.style.height = "160px";
  this.panelBody.appendChild(this.containerEl);
  this.footerEl = makeElement("div", "lpfoot");
  this.panelBody.appendChild(this.footerEl);
  this.footerButtons = [];
  installLayerCompsFooter(this)
}
LayerCompsPanel.prototype = Object.create(BaseTool.prototype);

LayerCompsPanel.prototype.onFooterBtnClick = function(evt) {
  const btnIndex = this.footerButtons.indexOf(evt.currentTarget);
  if (btnIndex != FOOTER_ADD && this.selectedCompId == -1) return;
  dispatchLayerCompDocumentAction(this, {
    actionKind: FOOTER_ACTION_KINDS[btnIndex],
    idx: this.selectedCompId
  });
  if (btnIndex == FOOTER_DELETE) this.selectedCompId = -1
};

LayerCompsPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  for (let btnIndex = 0; btnIndex < this.footerButtons.length; btnIndex++) {
    this.footerButtons[btnIndex].buildUI()
  }
};

LayerCompsPanel.prototype.open = function(doc) {
  if (doc == null) addClass(this.panelBody, "disabled");
  else removeClass(this.panelBody, "disabled");
  this.activeDoc = doc;
  clearElement(this.containerEl);
  this.compItems = [];
  if (doc == null) return;
  const currentCompId = resolveAppliedCompId(doc),
    comps = buildCompDescriptorList(doc);
  for (let compIndex = 0; compIndex < comps.length; compIndex++) {
    const compData = comps[compIndex].v,
      item = new LayerCompListItem(
        compData.Nm.v,
        compData.compID.v,
        compData.capturedInfo.v,
        currentCompId,
        this.selectedCompId
      );
    item.on("activate", this.onItemActivate, this);
    item.parent = this;
    this.containerEl.appendChild(item.el);
    this.compItems.push(item)
  }
};

LayerCompsPanel.prototype.onItemActivate = function(evt) {
  this.selectedCompId = evt.currentTarget.compId;
  this.open(this.activeDoc)
};

/**
 * Applied comp id from descriptor state, or `0` when none is recorded.
 */
LayerCompsPanel.resolveAppliedCompId = resolveAppliedCompId;

/**
 * Synthetic Last Document State row plus document comp entries (mutable copy).
 */
LayerCompsPanel.buildCompDescriptorList = buildCompDescriptorList;

export { LayerCompsPanel, LayerCompListItem };

// ---------------------------------------------------------------------------
// Dispatch + list build
// ---------------------------------------------------------------------------

function dispatchLayerCompDocumentAction(target, data) {
  const evt = new AppEvent(EventType.documentAction, true);
  evt.data = data;
  evt.routingChannel = EventChannel.EVENT_FILTER_STACK;
  target.dispatch(evt)
}

function resolveAppliedCompId(doc) {
  return doc.layerComps.lastAppliedComp ? doc.layerComps.lastAppliedComp.v : 0
}

function buildCompDescriptorList(doc) {
  const comps = doc.layerComps.list.v.slice(0);
  comps.unshift({
    v: {
      Nm: { v: SYNTHETIC_LAST_STATE_NAME },
      compID: { v: 0 },
      capturedInfo: { v: 0 }
    }
  });
  return comps
}

// ---------------------------------------------------------------------------
// DOM install
// ---------------------------------------------------------------------------

function installLayerCompsFooter(panel) {
  for (let btnIndex = 0; btnIndex < FOOTER_ICON_KEYS.length; btnIndex++) {
    const btn = new Button(
      "<img src=\"" + getIconUrl(FOOTER_ICON_KEYS[btnIndex]) + "\" class=\"gsicon\" />",
      false,
      FOOTER_ICON_TITLES[btnIndex]
    );
    btn.on("click", panel.onFooterBtnClick, panel);
    panel.footerEl.appendChild(btn.el);
    panel.footerButtons.push(btn)
  }
}

function installCapturedAttributeButtons(item, capturedFlags) {
  for (let attrIndex = 0; attrIndex < CAPTURED_ATTR_ICON_KEYS.length; attrIndex++) {
    const attrBtn = new Button(
      "<img src=\"" + getIconUrl(CAPTURED_ATTR_ICON_KEYS[attrIndex]) + "\" class=\"autoscale gsicon\" />",
      false,
      CAPTURED_ATTR_TITLES[attrIndex]
    );
    if ((capturedFlags >> attrIndex & 1) == 0) attrBtn.el.setAttribute("style", "opacity:0.3");
    attrBtn.on("click", item.onAttrToggleClick, item);
    item.attrRow.appendChild(attrBtn.el);
    item.attrButtons.push(attrBtn)
  }
}
