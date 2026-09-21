/**
 * native menu spec: accelerators, labels, paths, enabled/checked state.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let shortcutKeysToTauriAccelerator;
let buildNativeMenuSpec;
let KeyboardHandler;
let isMacOSHost;

before(async () => {
  ({ shortcutKeysToTauriAccelerator, buildNativeMenuSpec, isMacOSHost } = await import(
    "../../../src/ui/menu/native-menu-spec.js"
  ));
  ({ KeyboardHandler } = await import("../../../src/core/keyboard-handler.js"));
  const { Locale } = await import("../../../src/core/i18n/locale.js");
  Locale.get = (key) => {
    if (typeof key === "string") return key;
    if (Array.isArray(key)) return key.join("+");
    return String(key);
  };
});

describe("ui/menu/native-menu-spec.js", () => {
  it("shortcutKeysToTauriAccelerator goldens", () => {
    assert.equal(shortcutKeysToTauriAccelerator(null), null);
    assert.equal(shortcutKeysToTauriAccelerator("Cmd+S"), "Cmd+S");
    assert.equal(
      shortcutKeysToTauriAccelerator([KeyboardHandler.Ctrl, KeyboardHandler.KeyZ]),
      "CmdOrCtrl+KeyZ"
    );
    assert.equal(
      shortcutKeysToTauriAccelerator([KeyboardHandler.Shift, KeyboardHandler.Ctrl, KeyboardHandler.KeyZ]),
      "Shift+CmdOrCtrl+KeyZ"
    );
    assert.equal(
      shortcutKeysToTauriAccelerator([KeyboardHandler.Ctrl, KeyboardHandler.Plus]),
      "CmdOrCtrl+Plus"
    );
    assert.equal(
      shortcutKeysToTauriAccelerator([KeyboardHandler.Ctrl, KeyboardHandler.Digit0]),
      "CmdOrCtrl+Digit0"
    );
  });

  it("buildNativeMenuSpec resolves labels, paths, submenu, separators", () => {
    const menuData = [
      {
        name: "topMenu.file",
        items: [
          { name: "file.open", shortcut: [KeyboardHandler.Ctrl, KeyboardHandler.KeyO] },
          {
            name: ["VAR0 PSD", "file.save"],
            opensDialog: true,
            resolveRowState: () => ({ labelOverride: "Save custom", enabled: false }),
          },
          { name: "parent", sub: [{ name: "child.leaf" }] },
          { separatorAfter: true, name: "after.sep" },
        ],
        menuActions: [
          { appEventType: "ui" },
          { appEventType: "ui" },
          { sub: [{ appEventType: "doc" }] },
          { appEventType: "x" },
        ],
      },
    ];
    const spec = buildNativeMenuSpec(menuData, {}, { theme: 0 });
    assert.deepEqual(Object.keys(spec).sort(), ["hideHtmlMenuBar", "menus"]);
    assert.equal(spec.hideHtmlMenuBar, isMacOSHost());
    assert.equal(spec.menus[0].title, "topMenu.file");
    assert.deepEqual(spec.menus[0].items[0], {
      label: "file.open",
      enabled: true,
      path: [0, 0],
      accelerator: "CmdOrCtrl+KeyO",
    });
    assert.deepEqual(spec.menus[0].items[1], {
      label: "Save custom...",
      enabled: false,
      path: [0, 1],
    });
    assert.equal(spec.menus[0].items[2].label, "parent");
    assert.deepEqual(spec.menus[0].items[2].submenu, [
      { label: "child.leaf", enabled: true, path: [0, 2, 0] },
    ]);
    // The rule belongs to the row that declares it, not the row before.
    assert.equal(spec.menus[0].items[2].separatorAfter, undefined);
    assert.equal(spec.menus[0].items[3].separatorAfter, true);
  });

  it("formatNativeMenuLabel escapes ampersands", () => {
    const spec = buildNativeMenuSpec(
      [{ name: "A&B", items: [{ name: "X&Y" }], menuActions: [{}] }],
      null,
      null
    );
    assert.equal(spec.menus[0].items[0].label, "X&&Y");
  });

  it("resolveRowState checked propagates to native entry", () => {
    const spec = buildNativeMenuSpec(
      [{
        name: "topMenu.view",
        items: [{ name: "view.grid", resolveRowState: () => ({ checked: true }) }],
        menuActions: [{ appEventType: "ui" }],
      }],
      null,
      { extras: true }
    );
    assert.equal(spec.menus[0].items[0].checked, true);
  });

  it("isMacOSHost matches navigator platform string", () => {
    if (typeof navigator === "undefined") {
      assert.equal(isMacOSHost(), false);
      return;
    }
    const platform = navigator.userAgentData && navigator.userAgentData.platform
      ? navigator.userAgentData.platform
      : navigator.platform || "";
    assert.equal(isMacOSHost(), /mac/i.test(platform));
  });
});
