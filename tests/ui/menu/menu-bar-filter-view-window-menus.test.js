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

  it("buildMoreMenu includes language and theme submenus", () => {
    const moreMenu = buildMoreMenu();
    assert.equal(moreMenu.name, "topMenu.more");
    assert.equal(moreMenu.items[0].name, "topMenu.language");
    assert.equal(moreMenu.items[1].name, "topMenu.theme");
    assert.equal(moreMenu.items.length, moreMenu.menuActions.length);
  });
});
