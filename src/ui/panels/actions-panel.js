/**
 * Actions panel: Action Sets / Actions / Steps tree with record, play, create, delete, export.
 */

import { Locale } from "../../core/i18n/locale.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { BaseTool } from "../widgets/base-tool.js";
import { Button } from "../widgets/form-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { clearElement, makeElement } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";

/** Footer button indices. */
const FOOTER_RECORD = 0;
const FOOTER_PLAY = 1;
const FOOTER_NEW_SET = 2;
const FOOTER_NEW_ACTION = 3;
const FOOTER_DELETE = 4;
const FOOTER_EXPORT = 5;

/** Sentinel for ActionsPanel.selectedPath before any real selection. */
const SELECTED_PATH_SENTINEL = "topMenu.file";

/**
 * Single row in the Actions panel tree. Depth is path.length:
 *
 *   - 1 → Action Set (foldable)
 *   - 2 → Action (foldable)
 *   - 3 → Step (enable toggle, no fold)
 *
 * Row clicks dispatch widgetSelect with rowAction of "sel" / "fold" / "enab";
 * rename confirm emits "nchange".
 */
function ActionsListItem(path, selectedPathJson, isExpanded, label, isEnabled) {
  BaseWidget.call(this);
  this.path = path;
  const depth = path.length - 1;
  this.el = makeElement(
    "div",
    "layeritem" + (JSON.stringify(path) == selectedPathJson ? " selected" : "")
  );
  this.headerEl = makeElement("div", "head");
  this.el.appendChild(this.headerEl);
  this.headerEl.setAttribute("style", "height:24px");
  this.leftEl = makeElement("div", "headL");
  this.headerEl.appendChild(this.leftEl);
  appendDepthIndent(this.leftEl, depth);
  appendFoldOrEnableAffordance(this, isExpanded, isEnabled);
  if (depth == 0) {
    this.leftEl.appendChild(makeElement("div", "folder"));
  }
  const labelEl = this.labelEl = makeElement("div", "label");
  labelEl.textContent = label;
  this.leftEl.appendChild(labelEl);
  this.el.addEventListener("mouseup", this.onMouseUp.bind(this), false);
}
ActionsListItem.prototype = Object.create(BaseWidget.prototype);

ActionsListItem.prototype.onMouseUp = function(evt) {
  if (evt.detail == 1 && evt.target.tagName.toLowerCase() != "input") {
    this.dispatch(buildRowSelectEvent(resolveRowActionKey(evt.target, this), this.path));
  } else if (this.path.length < 3) {
    new BaseTool.InlineRenameInput(this.labelEl, this.onRenameConfirm.bind(this));
  }
};

ActionsListItem.prototype.onRenameConfirm = function(newName) {
  const selectEvt = new AppEvent(EventType.widgetSelect, true);
  selectEvt.data = {
    rowAction: "nchange",
    newName: newName,
    treePath: this.path
  };
  this.dispatch(selectEvt);
};

/**
 * Sidebar panel listing Action Sets, Actions, and steps, with footer controls
 * for record / play / create / delete / export.
 *
 * selectedPath is [setIndex], [setIndex, actionIndex], or
 * [setIndex, actionIndex, stepIndex]. Initialised to sentinel string
 * "topMenu.file" so length checks treat it like a multi-segment path.
 */
function ActionsPanel() {
  BaseTool.call(this, "panels.actions", false, getIconUrl("panels/actions"), BaseTool.PanelId.ACTIONS, true);
  this.doc = null;
  this.selectedPath = SELECTED_PATH_SENTINEL;
  this.listEl = makeElement("div", "padded scrollable");
  this.listEl.setAttribute("style", "width:260px;  height:260px");
  this.panelBody.appendChild(this.listEl);
  this.on(EventType.widgetSelect, this.onItemSelect, this);
  this.footerEl = makeElement("div", "lpfoot");
  this.panelBody.appendChild(this.footerEl);
  this.items = [];
  installFooterButtons(this);
}
ActionsPanel.prototype = Object.create(BaseTool.prototype);

ActionsPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  for (let i = 0; i < this.items.length; i++) this.items[i].buildUI();
};

ActionsPanel.prototype.onFooterClick = function(evt) {
  const btnIndex = this.items.indexOf(evt.currentTarget);
  const selected = this.selectedPath;
  const doc = this.doc;
  const actionSets = doc.actionSets;
  if (btnIndex == FOOTER_RECORD) {
    toggleRecording(this, doc, actionSets, selected);
  } else if (btnIndex == FOOTER_PLAY) {
    this.playSelectedAction();
  } else if (btnIndex == FOOTER_NEW_SET || btnIndex == FOOTER_NEW_ACTION) {
    createSetOrAction(this, actionSets, selected, btnIndex);
  } else if (btnIndex == FOOTER_DELETE) {
    deleteSelectedNode(this, actionSets, selected);
  } else if (btnIndex == FOOTER_EXPORT) {
    exportSelectedActionSet(this, actionSets, selected);
  }
};

ActionsPanel.prototype.onItemSelect = function(evt) {
  const actionSets = this.doc.actionSets;
  const rowAction = evt.data.rowAction;
  const path = evt.data.treePath;
  if (rowAction == "sel") this.selectedPath = path;
  if (rowAction == "fold") toggleExpandedAtPath(actionSets, path);
  if (rowAction == "enab") {
    const step = actionSets[path[0]].children[path[1]].children[path[2]];
    step.enabled = !step.enabled;
  }
  if (rowAction == "nchange") {
    applyRenameAtPath(actionSets, path, evt.data.newName);
  }
  this.redraw();
};

ActionsPanel.prototype.onUpdate = function(doc, popupType) {
  this.doc = doc;
  if (popupType == PopupTypes.ACTIONS || popupType == PopupTypes.ALL) this.redraw();
};

ActionsPanel.prototype.redraw = function() {
  if (this.doc == null) return;
  clearElement(this.listEl);
  const actionSets = this.doc.actionSets;
  if (actionSets.length == 0) return;
  appendActionTreeRows(this, actionSets, JSON.stringify(this.selectedPath));
};

ActionsPanel.prototype.playSelectedAction = function() {
  const actionSets = this.doc.actionSets;
  const selected = this.selectedPath;
  if (actionSets.length == 0) {
    showToast("No Actions Present");
    return;
  }
  if (selected.length == 1) {
    showToast("Select an Action first");
    return;
  }
  if (this.doc.recordingActionSet != null) {
    showToast("You can not apply actions while recording actions");
    return;
  }
  if (selected.length == 1) selected.push(0);
  const actionSet = actionSets[selected[0]];
  const action = actionSet.children[selected[1]];
  const replayEvt = new AppEvent(EventType.uiDispatch, true);
  replayEvt.data = {
    dispatchKind: UiCommand.replayRecordedActionPair,
    recordedActionPair: [action.name, actionSet.name]
  };
  this.dispatch(replayEvt);
};

export { ActionsPanel, ActionsListItem };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function appendDepthIndent(leftEl, depth) {
  if (depth == 0) return;
  const indentEl = makeElement("div");
  indentEl.style.width = depth * 20 + "px";
  leftEl.appendChild(indentEl);
}

function appendFoldOrEnableAffordance(item, isExpanded, isEnabled) {
  if (isExpanded != null) {
    const foldEl = item.foldEl = makeElement("div", isExpanded ? "open" : "closed");
    item.leftEl.appendChild(foldEl);
    return;
  }
  const enableEl = item.enableEl = makeElement("div", "cmark");
  enableEl.setAttribute("style", "background-size:12px 12px; opacity:" + (isEnabled ? 1 : .3));
  item.leftEl.appendChild(enableEl);
}

function resolveRowActionKey(target, item) {
  if (target == item.foldEl) return "fold";
  if (target == item.enableEl) return "enab";
  return "sel";
}

function buildRowSelectEvent(rowAction, treePath) {
  const selectEvt = new AppEvent(EventType.widgetSelect, true);
  selectEvt.data = {
    rowAction: rowAction,
    treePath: treePath
  };
  return selectEvt;
}

function installFooterButtons(panel) {
  const svgOpen = "<svg  class=\"gsicon\" viewBox=\"0 0 14 18\" width=\"14\" height=\"18\" fill=\"black\">";
  const svgClose = "</svg>";
  const downloadGlyph = svgOpen + "<path d=\"M14,6 L10,6 L10,0 L4,0 L4,6 L0,6 L7,13 L14,6 L14,6 Z M0,14 L0,16 L14,16 L14,14 Z\" />" + svgClose;
  const playGlyph = svgOpen + "<path d=\"M0,2 L14,9 L0,16 Z\" />" + svgClose;
  panel.recordGlyph = svgOpen + "<circle cx=\"7\" cy=\"9\" r=\"6\" />" + svgClose;
  panel.stopGlyph = svgOpen + "<path d=\"M2,4 L12,4 L12,14 L2,14 Z\" />" + svgClose;
  const icons = [panel.recordGlyph, playGlyph, "lrs/folder", "lrs/newlayer", "lrs/bin", downloadGlyph];
  const titles = [
    "brushAndMessages.actions.record",
    "Play",
    "brushAndMessages.actions.newActionSet",
    "brushAndMessages.actions.newAction",
    "clipboard.delete",
    "topMenu.more"
  ];
  for (let i = 0; i < icons.length; i++) {
    let icon = icons[i];
    if (1 < i && i != icons.length - 1) icon = "<img src=\"" + getIconUrl(icons[i]) + "\" class=\"gsicon\" />";
    const btn = new Button(icon, false, titles[i]);
    btn.on("click", panel.onFooterClick, panel);
    panel.footerEl.appendChild(btn.el);
    panel.items.push(btn);
  }
}

function toggleRecording(panel, doc, actionSets, selected) {
  if (actionSets.length == 0) {
    showToast("Create an Action Set first.");
    return;
  }
  if (selected.length < 2) {
    showToast("Select a target action first.");
    return;
  }
  let recordingSet = doc.recordingActionSet;
  let icon;
  if (recordingSet == null) {
    icon = panel.stopGlyph;
    recordingSet = panel.selectedPath;
  } else {
    icon = panel.recordGlyph;
    recordingSet = null;
  }
  panel.items[FOOTER_RECORD].setLabel(icon);
  doc.recordingActionSet = recordingSet;
}

function createEmptyActionSet(actionSetsLength) {
  return {
    name: "Action Set " + actionSetsLength,
    children: [],
    expanded: true
  };
}

function createEmptyAction(actionsListLength) {
  return {
    name: "Action " + actionsListLength,
    color: 0,
    children: [],
    commandKeyEnabled: false,
    shift: false,
    expanded: true,
    index: actionsListLength
  };
}

function createSetOrAction(panel, actionSets, selected, btnIndex) {
  const newSet = createEmptyActionSet(actionSets.length);
  if (btnIndex == FOOTER_NEW_SET || actionSets.length == 0) {
    selected = [actionSets.length];
    actionSets.push(newSet);
  }
  if (btnIndex == FOOTER_NEW_ACTION) {
    const actionsList = actionSets[selected[0]].children;
    selected = [selected[0], actionsList.length];
    actionsList.push(createEmptyAction(actionsList.length));
  }
  panel.selectedPath = selected;
  panel.redraw();
}

function siblingListForPath(actionSets, selected) {
  if (selected.length == 1) return actionSets;
  if (selected.length == 2) return actionSets[selected[0]].children;
  return actionSets[selected[0]].children[selected[1]].children;
}

function deleteSelectedNode(panel, actionSets, selected) {
  const siblings = siblingListForPath(actionSets, selected);
  const lastIdx = selected.length - 1;
  siblings.splice(selected[lastIdx], 1);
  if (siblings.length == 0) selected.pop();
  else while (selected[lastIdx] >= siblings.length) selected[lastIdx]--;
  if (selected.length == 0) selected.push(0);
  panel.redraw();
}

function exportSelectedActionSet(panel, actionSets, selected) {
  if (actionSets.length == 0) {
    showToast("No Actions Present.");
    return;
  }
  const exportEvt = new AppEvent(EventType.uiDispatch, true);
  exportEvt.data = {
    dispatchKind: UiCommand.exportPopupResourceBundle,
    popupTypeId: PopupTypes.ACTIONS,
    actionSetIndex: selected[0]
  };
  panel.dispatch(exportEvt);
}

function toggleExpandedAtPath(actionSets, path) {
  if (path.length == 1) actionSets[path[0]].expanded = !actionSets[path[0]].expanded;
  else actionSets[path[0]].children[path[1]].expanded = !actionSets[path[0]].children[path[1]].expanded;
}

function applyRenameAtPath(actionSets, path, newName) {
  if (path.length == 1) actionSets[path[0]].name = newName;
  else actionSets[path[0]].children[path[1]].name = newName;
}

function appendActionTreeRows(panel, actionSets, selectedJson) {
  for (let setIdx = 0; setIdx < actionSets.length; setIdx++) {
    const set = actionSets[setIdx];
    const setItem = new ActionsListItem(
      [setIdx],
      selectedJson,
      set.expanded,
      set.name.split("=").pop()
    );
    setItem.parent = panel;
    panel.listEl.appendChild(setItem.el);
    if (!set.expanded) continue;
    for (let actionIdx = 0; actionIdx < set.children.length; actionIdx++) {
      const action = set.children[actionIdx];
      const actionItem = new ActionsListItem(
        [setIdx, actionIdx],
        selectedJson,
        action.expanded,
        action.name.split("=").pop()
      );
      actionItem.parent = panel;
      panel.listEl.appendChild(actionItem.el);
      if (!action.expanded) continue;
      for (let stepIdx = 0; stepIdx < action.children.length; stepIdx++) {
        const step = action.children[stepIdx];
        const stepItem = new ActionsListItem(
          [setIdx, actionIdx, stepIdx],
          selectedJson,
          null,
          Locale.get(ActionDescUtil.getActionStepLocaleKey(step)),
          step.enabled
        );
        stepItem.parent = panel;
        panel.listEl.appendChild(stepItem.el);
      }
    }
  }
}
