/**
 * Read-only panel showing the CSS for the selected layer. Refreshes on open
 * and when the OPEN_RECENT popup fires.
 */
import { CSS } from "../../features/css-export/css.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseTool } from "../widgets/base-tool.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { isInDOM, makeElement } from "../../core/dom.js";

function CSSPanel() {
  BaseTool.call(this, "CSS", false, getIconUrl("panels/css"), BaseTool.PanelId.CSS, true);
  this.activeDoc = null;
  installCssTextarea(this)
}
CSSPanel.prototype = Object.create(BaseTool.prototype);

CSSPanel.prototype.open = function(doc) {
  this.activeDoc = doc;
  this.redraw()
};

CSSPanel.prototype.onUpdate = function(doc, popupType) {
  if (popupType == PopupTypes.OPEN_RECENT) this.redraw()
};

CSSPanel.prototype.redraw = function() {
  const doc = this.activeDoc;
  if (!canRedrawCssPanel(this, doc)) return;
  const activeLayer = doc.layers[doc.selectedLayerIndices[0]];
  this.cssArea.value = formatLayerCssText(CSS.generateLayerCSS(activeLayer, doc))
};

CSSPanel.prototype.refresh = function() {
  this.redraw()
};

export { CSSPanel };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function installCssTextarea(panel) {
  const wrapper = makeElement("div", "padded");
  panel.panelBody.appendChild(wrapper);
  panel.cssArea = makeElement("textarea");
  panel.cssArea.setAttribute("rows", 16);
  panel.cssArea.setAttribute("style", "display:block;tab-size:4; font-family:monospace; width:98%; min-width:270px;");
  wrapper.appendChild(panel.cssArea)
}

function canRedrawCssPanel(panel, doc) {
  if (doc == null || doc.selectedLayerIndices.length == 0) return false;
  if (!isInDOM(panel.panelBody)) return false;
  return true
}

function formatLayerCssText(cssRules) {
  if (cssRules.length != 0) return cssRules.join(";\n") + ";";
  return ""
}
