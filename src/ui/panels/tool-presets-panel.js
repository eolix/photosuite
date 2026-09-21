/**
 * Sidebar panel for per-tool presets. Hosts a ToolPresetButton and syncs
 * its list from the document toolPresets store; resize rebinds the button
 * to the active tool id.
 */
import { ToolId } from "../../document/model/tool-base.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseTool } from "../widgets/base-tool.js";
import { ToolPresetButton } from "../widgets/controls/brush-preset-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { makeElement } from "../../core/dom.js";

function ToolPresetsPanel() {
  BaseTool.call(this, "panels.toolPresets", false, getIconUrl("panels/tool-presets"), BaseTool.PanelId.TOOL_PRESETS, true);
  this.doc = null;
  installToolPresetsPanelLayout(this)
}
ToolPresetsPanel.prototype = Object.create(BaseTool.prototype);

ToolPresetsPanel.prototype.refresh = function() {
  syncPresetList(this, this.doc.toolPresets)
};

ToolPresetsPanel.prototype.onUpdate = function(doc, popupType) {
  this.doc = doc;
  if (shouldSyncToolPresets(popupType)) syncPresetList(this, doc.toolPresets)
};

ToolPresetsPanel.prototype.resize = function(_width, _height) {
  syncActiveToolOnPresetButton(this)
};

ToolPresetsPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  this.presetBtn.buildUI()
};

/**
 * True when the popup type should refresh the embedded preset list.
 */
ToolPresetsPanel.shouldSyncToolPresets = shouldSyncToolPresets;

export { ToolPresetsPanel };

// ---------------------------------------------------------------------------
// Layout + sync
// ---------------------------------------------------------------------------

function installToolPresetsPanelLayout(panel) {
  panel.presetBtn = new ToolPresetButton(ToolId.TOOL_BRUSH);
  panel.presetBtn.parent = panel;
  const wrapper = makeElement("div", "padded");
  wrapper.setAttribute("style", "width:20em");
  panel.panelBody.appendChild(wrapper);
  wrapper.appendChild(panel.presetBtn.popupToolbar)
}

function shouldSyncToolPresets(popupType) {
  return popupType == PopupTypes.ALL || popupType == PopupTypes.TOOL_PRESETS
}

function syncPresetList(panel, toolPresets) {
  panel.presetBtn.setPresets(toolPresets)
}

function syncActiveToolOnPresetButton(panel) {
  panel.presetBtn.setToolId(panel.doc.activeToolId)
}
