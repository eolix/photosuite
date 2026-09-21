/**
 * PluginPanel iframe host + broadcastMessage.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { isInDOM } from "../../../src/core/dom.js";

installBrowserGlobals();

let PluginPanel;
let BaseTool;

before(async () => {
  ({ BaseTool } = await import("../../../src/ui/widgets/base-tool.js"));
  ({ PluginPanel } = await import("../../../src/ui/panels/plugin-panel.js"));
});

describe("ui/panels/plugin-panel.js", () => {
  it("buildIframeSizeStyle formats width/height px", () => {
    assert.equal(
      PluginPanel.buildIframeSizeStyle({ width: 320, height: 240 }),
      "width:320px; height:240px",
    );
  });

  it("null pluginDef seeds a bare BaseTool", () => {
    const panel = new PluginPanel(null);
    assert.ok(panel instanceof BaseTool);
    assert.equal(panel.pluginIframe, undefined);
  });

  it("broadcastMessage posts to iframe contentWindow when mounted", () => {
    const panel = Object.create(PluginPanel.prototype);
    const messages = [];
    panel.pluginIframe = {
      // Attached to the document, so broadcastMessage reaches the plugin.
      parentNode: document,
      contentWindow: {
        postMessage(payload, origin) {
          messages.push({ payload, origin });
        },
      },
    };
    panel.broadcastMessage({ kind: "clipboard" });
    assert.deepEqual(messages, [{ payload: { kind: "clipboard" }, origin: "*" }]);
  });

  it("broadcastMessage no-ops when iframe is not in DOM", () => {
    const panel = Object.create(PluginPanel.prototype);
    let posted = false;
    panel.pluginIframe = {
      // No parent chain: the iframe is not on screen.
      parentNode: null,
      contentWindow: {
        postMessage() {
          posted = true;
        },
      },
    };
    panel.broadcastMessage({ kind: "x" });
    assert.equal(posted, false);
  });
});
