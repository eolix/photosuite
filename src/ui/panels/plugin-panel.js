/**
 * Sidebar host for an external HTML plugin. Renders the plugin in an iframe;
 * broadcastMessage forwards host payloads via postMessage.
 *
 * When pluginDef is null, constructs a bare BaseTool (prototype seed only).
 */
import { BaseTool } from "../widgets/base-tool.js";
import { PLUGIN_FRAME_ATTRIBUTE } from "../../features/plugins/plugin-host-ipc.js";
import { isInDOM, makeElement } from "../../core/dom.js";

function PluginPanel(pluginDef, panelId) {
  if (pluginDef == null) {
    BaseTool.call(this);
    return
  }
  BaseTool.call(this, pluginDef.name, false, pluginDef.icon, panelId, pluginDef.themed === true);
  this.pluginIframe = installPluginIframe(this.panelBody, pluginDef)
}
PluginPanel.prototype = Object.create(BaseTool.prototype);

PluginPanel.prototype.broadcastMessage = function(payload) {
  postMessageToPluginIframe(this.pluginIframe, payload)
};

/**
 * Build iframe CSS size string from plugin width/height.
 */
PluginPanel.buildIframeSizeStyle = buildIframeSizeStyle;

export { PluginPanel };

// ---------------------------------------------------------------------------
// Iframe helpers
// ---------------------------------------------------------------------------

function buildIframeSizeStyle(pluginDef) {
  return "width:" + pluginDef.width + "px; height:" + pluginDef.height + "px"
}

function installPluginIframe(panelBody, pluginDef) {
  const iframe = makeElement("iframe", "padded");
  // Marks this frame as a plugin panel. The host answers IPC requests only from
  // frames carrying it, which is the only workable identity check: a sandboxed
  // plugin has an opaque origin, so `event.origin` cannot tell one frame from
  // another, or from any other sandboxed content the app embeds.
  iframe.setAttribute(PLUGIN_FRAME_ATTRIBUTE, "");
  // A plugin installed from disk is untrusted code. "allow-scripts" without
  // "allow-same-origin" puts it in an opaque origin, so it can postMessage the
  // host but cannot reach `parent` — and through it the Tauri command bridge.
  if (pluginDef.sandboxed) iframe.setAttribute("sandbox", "allow-scripts");
  if (pluginDef.html != null) iframe.setAttribute("srcdoc", pluginDef.html);
  else iframe.setAttribute("src", pluginDef.url);
  iframe.setAttribute("style", buildIframeSizeStyle(pluginDef));
  panelBody.appendChild(iframe);
  return iframe
}

function postMessageToPluginIframe(iframe, payload) {
  if (isInDOM(iframe)) iframe.contentWindow.postMessage(payload, "*")
}
