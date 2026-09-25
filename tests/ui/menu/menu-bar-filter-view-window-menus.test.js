/**
 * Filter/View/Window/More menu builders.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let buildFilterMenu;
let buildViewMenu;
let buildWindowMenu;
let buildMoreMenu;

before(async () => {
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
  ({
    buildFilterMenu,
    buildViewMenu,
    buildWindowMenu,
    buildMoreMenu,
  } = await import("../../../src/ui/menu/menu-bar-filter-view-window-menus.js"));
});

describe("ui/menu/menu-bar-filter-view-window-menus.js", () => {
  it("buildFilterMenu starts with lastFilter then FilterDefs groups", () => {
    const filterMenu = buildFilterMenu();
    assert.equal(filterMenu.name, "topMenu.filter");
    assert.equal(filterMenu.items[0].name, "filters.menu.lastFilter");
    assert.ok(filterMenu.items.length > 1);
    assert.equal(filterMenu.items.length, filterMenu.menuActions.length);
  });

  it("buildViewMenu snap-to actions use showToggleIndex", () => {
    const viewMenu = buildViewMenu();
    assert.equal(viewMenu.name, "topMenu.view");
    assert.equal(viewMenu.items.length, viewMenu.menuActions.length);
    const snapActions = viewMenu.menuActions.find((action) => Array.isArray(action.sub));
    // snap-to is the second nested sub after show extras; find by showToggleIndex
    let found = null;
    for (const action of viewMenu.menuActions) {
      if (action.sub && action.sub[0] && "showToggleIndex" in (action.sub[0].payload || {})) {
        found = action.sub;
        break;
      }
    }
    assert.ok(found);
    assert.equal(found[0].payload.showToggleIndex, 0);
    assert.equal(found[4].payload.showToggleIndex, 4);
  });

  it("buildWindowMenu places windowMoreMenuOnly panels under More", () => {
    const windowMenu = buildWindowMenu(function () {
      return [
        { windowMoreMenuOnly: false, panel: { panelId: 10, name: "panels.layers" } },
        { windowMoreMenuOnly: true, panel: { panelId: 11, name: "panels.history" } },
      ];
    });
    assert.equal(windowMenu.name, "topMenu.window");
    assert.equal(windowMenu.items[0].name, "topMenu.more");
    assert.equal(windowMenu.items[0].sub.length, 1);
    assert.equal(windowMenu.items[0].sub[0].name, "panels.history");
    assert.equal(windowMenu.items[1].name, "panels.layers");
  });

  // Theme and language moved to Preferences → Interface: one place to change a
  // setting, one place to look for it. What is left here is not a setting.
  it("buildMoreMenu offers the translation link and the reference dialogs", () => {
    const moreMenu = buildMoreMenu();
    assert.equal(moreMenu.name, "topMenu.more");
    assert.deepEqual(moreMenu.items.map((item) => item.name), [
      "topMenu.createTranslation",
      "dialogs.keyboardShortcuts",
      "dialogs.licences",
    ]);
    assert.equal(moreMenu.items.length, moreMenu.menuActions.length);
    for (const item of moreMenu.items) assert.equal(item.sub, undefined, item.name + " is a submenu");
  });

  // The rows and their actions are parallel arrays: a row added to one and not
  // the other silently fires the neighbouring row's action.
  it("buildMoreMenu opens the licences dialog from its own row", () => {
    const moreMenu = buildMoreMenu();
    const rowIndex = moreMenu.items.findIndex((item) => item.name === "dialogs.licences");
    assert.notEqual(rowIndex, -1, "the More menu has no licences row");
    assert.deepEqual(moreMenu.menuActions[rowIndex].payload, {
      dispatchKind: "dispatchAppDialogRouter",
      dialogRouteId: "licenses",
    });
  });
});
