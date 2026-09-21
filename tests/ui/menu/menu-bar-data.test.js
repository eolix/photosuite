/**
 * menu-bar data structure goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = globalThis.SmartFilterBase || {};

const EXPECTED_TOP_MENU_NAMES = [
  "topMenu.file",
  "topMenu.edit",
  "topMenu.image",
  "topMenu.layer",
  "topMenu.select",
  "topMenu.filter",
  "topMenu.view",
  "topMenu.window",
  "topMenu.more",
];

let createMenuBarData;
let TrackerRegistry;
let buildSelectMenu;
let importError = null;
let buildError = null;
let menus = null;

before(async () => {
  ({ TrackerRegistry } = await import(
    "../../../src/features/trackers/tracker-registry.js"
  ));
  try {
    // Shape tools copy a fill descriptor through the tracker; the menu build
    // only needs the call to exist.
    TrackerRegistry.LayerEffectsTracker = TrackerRegistry.LayerEffectsTracker || {
      copyContentFillToDescriptor() {},
    };
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/pen-path-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  await import("../../../src/document/tools/crop-tools.js");
  await import("../../../src/document/tools/retouch-tools.js");
  await import("../../../src/document/tools/shape-tools.js");
  await import("../../../src/document/tools/view-tools.js");
  await import("../../../src/document/tools/move-tools.js");
  await import("../../../src/document/tools/text-tools.js");
  await import("../../../src/document/transform/transform-tools.js");
    ({ createMenuBarData } = await import("../../../src/ui/menu/menu-bar-data.js"));
    ({ buildSelectMenu } = await import("../../../src/ui/menu/menu-bar-select-menu.js"));
    menus = createMenuBarData(function () {
      return [
        {
          windowMoreMenuOnly: false,
          panel: { panelId: 1, name: "panels.layers" },
        },
        {
          windowMoreMenuOnly: true,
          panel: { panelId: 2, name: "panels.history" },
        },
      ];
    });
  } catch (err) {
    if (!createMenuBarData && !buildSelectMenu) {
      importError = err;
    } else {
      buildError = err;
    }
  }
});

describe("ui/menu/menu-bar-data.js (split)", () => {
  it("exports createMenuBarData and buildSelectMenu", () => {
    if (importError) {
      assert.fail("import failed: " + String(importError));
    }
    assert.equal(typeof createMenuBarData, "function");
    assert.equal(typeof buildSelectMenu, "function");
  });

  it("createMenuBarData top-level order and item/action counts", () => {
    if (importError) return;
    if (buildError) {
      assert.fail("createMenuBarData failed: " + String(buildError));
    }
    assert.equal(menus.length, 9);
    assert.deepEqual(
      menus.map((menu) => menu.name),
      EXPECTED_TOP_MENU_NAMES
    );
    for (const menu of menus) {
      assert.ok(Array.isArray(menu.items), menu.name + " items");
      assert.ok(Array.isArray(menu.menuActions), menu.name + " menuActions");
      assert.equal(
        menu.items.length,
        menu.menuActions.length,
        menu.name + " items/actions length"
      );
    }
  });

  it("Save row needs an open document; openPlace uses openAsPlaced", () => {
    if (importError || buildError) return;
    const fileMenu = menus[0];
    assert.equal(fileMenu.name, "topMenu.file");
    const saveItem = fileMenu.items.find((item) => item.name === "Save ...");
    assert.ok(saveItem);
    assert.equal(typeof saveItem.resolveRowState, "function");
    const src = Function.prototype.toString.call(saveItem.resolveRowState);
    assert.doesNotMatch(src, /\bwO\b/);

    const openPlaceAction = fileMenu.menuActions[2];
    assert.equal(openPlaceAction.payload.openAsPlaced, true);
    assert.equal("ad7" in openPlaceAction.payload, false);
  });

  it("buildSelectMenu Select menu name and free-transform option", () => {
    if (importError) return;
    let withoutFt;
    let withFt;
    try {
      withoutFt = buildSelectMenu(false);
      withFt = buildSelectMenu(true);
    } catch (err) {
      assert.fail("buildSelectMenu failed: " + String(err));
    }
    assert.equal(withoutFt.name, "topMenu.select");
    assert.ok(withoutFt.items.length >= 1);
    assert.equal(withoutFt.items.length, withoutFt.menuActions.length);
    assert.equal(
      withoutFt.items.some((item) => item.name === "tools.freeTransform"),
      false
    );
    assert.equal(
      withFt.items.some((item) => item.name === "tools.freeTransform"),
      true
    );
    assert.equal(withFt.items.length, withFt.menuActions.length);
  });
});
