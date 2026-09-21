/**
 * sidebar plugin spec mapping helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isBundlableRelativePluginPath,
  attachPluginEntryHtml,
  buildSidebarPluginSpecFromDiscovery,
  bundleRelativePluginAssets,
  filterUnregisteredSidebarPluginSpecs,
  inlineRelativePluginScripts,
  joinPluginDirectoryPath,
  resolveSidebarPluginPanelId
} from "../../../src/features/plugins/plugin-spec.js";

describe("features/plugins/plugin-spec.js", () => {
  it("joinPluginDirectoryPath rejects path traversal", () => {
    assert.equal(
      joinPluginDirectoryPath("/tmp/plugins/hello-panel", "../secret.js"),
      null
    );
    assert.equal(
      joinPluginDirectoryPath("/tmp/plugins/hello-panel", "panel.js"),
      "/tmp/plugins/hello-panel/panel.js"
    );
  });

  it("inlineRelativePluginScripts inlines sibling script files", async () => {
    const html = '<html><head></head><body><script src="panel.js"></script></body></html>';
    const bundled = await inlineRelativePluginScripts(
      html,
      "/tmp/plugins/hello-panel",
      function readTextFile(path) {
        if (path === "/tmp/plugins/hello-panel/panel.js") return "console.log('ok');";
        return null;
      }
    );
    assert.match(bundled, /<script>\s*console\.log\('ok'\);\s*<\/script>/);
    assert.doesNotMatch(bundled, /src=["']panel\.js["']/);
  });

  it("bundleRelativePluginAssets leaves remote script tags unchanged", async () => {
    const html = '<script src="https://example.com/x.js"></script>';
    const bundled = await bundleRelativePluginAssets(html, "/tmp/p", function() {
      return "should-not-run";
    });
    assert.equal(bundled, html);
  });

  it("buildSidebarPluginSpecFromDiscovery maps discovery record to runtime spec", () => {
    const spec = buildSidebarPluginSpecFromDiscovery({
      id: "hello-panel",
      name: "Hello Panel",
      version: "1.0.0",
      entryPath: "/tmp/plugins/hello-panel/index.html",
      iconPath: "/tmp/plugins/hello-panel/icon.svg",
      width: 320,
      height: 420,
      themed: true
    }, function fakeConvert(path) {
      return "asset://" + path;
    });

    assert.deepEqual(spec, {
      id: "hello-panel",
      name: "Hello Panel",
      url: "asset:///tmp/plugins/hello-panel/index.html",
      icon: "asset:///tmp/plugins/hello-panel/icon.svg",
      width: 320,
      height: 420,
      themed: true
    });
  });

  it("resolveSidebarPluginPanelId prefers manifest id over display name", () => {
    assert.equal(
      resolveSidebarPluginPanelId({ id: "hello-panel", name: "Hello Panel" }),
      "plg_hello-panel"
    );
    assert.equal(
      resolveSidebarPluginPanelId({ name: "LegacyName" }),
      "plg_LegacyName"
    );
  });

  it("filterUnregisteredSidebarPluginSpecs skips existing panel ids", () => {
    const sidebar = {
      findEntryByPanelId(panelId) {
        return panelId === "plg_existing" ? {} : null;
      }
    };
    const pending = filterUnregisteredSidebarPluginSpecs(sidebar, [
      { id: "existing", name: "Existing" },
      { id: "new-one", name: "New One" }
    ]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "new-one");
  });

  it("bundled HTML rides on the spec and marks the panel sandboxed", () => {
    // The panel renders this with srcdoc under sandbox="allow-scripts". A blob:
    // URL would inherit the host origin instead, letting a plugin reach `parent`
    // and, through it, the Tauri command bridge.
    const spec = attachPluginEntryHtml({ id: "demo", url: "asset:///x/index.html" }, "<p>hi</p>");
    assert.equal(spec.html, "<p>hi</p>");
    assert.equal(spec.sandboxed, true);
    assert.equal(spec.id, "demo");
  });

  it("a relative path may not climb out of the plugin folder", () => {
    assert.equal(isBundlableRelativePluginPath("panel.js"), true);
    assert.equal(isBundlableRelativePluginPath("../../etc/passwd"), false);
    // Separators are normalised before the check, so a Windows-style path
    // cannot slip a `..` segment past it.
    assert.equal(isBundlableRelativePluginPath("..\\..\\etc\\passwd"), false);
    assert.equal(isBundlableRelativePluginPath("/etc/passwd"), false);
    assert.equal(isBundlableRelativePluginPath("https://example.com/x.js"), false);
  });
});
