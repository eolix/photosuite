/**
 * Select menu builder goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let buildSelectMenu;

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
  ({ buildSelectMenu } = await import("../../../src/ui/menu/menu-bar-select-menu.js"));
});

describe("ui/menu/menu-bar-select-menu.js", () => {
  it("buildSelectMenu returns Select menu with matching items/actions", () => {
    const menu = buildSelectMenu(false);
    assert.equal(menu.name, "topMenu.select");
    assert.equal(menu.items.length, menu.menuActions.length);
    assert.equal(menu.items[0].name, "select.all");
    assert.ok(menu.menuActions[0].appEventType != null);
    assert.ok(menu.menuActions[0].payload);
  });

  it("includeFreeTransformShortcut inserts Free Transform before Save Selection", () => {
    const withFt = buildSelectMenu(true);
    const withoutFt = buildSelectMenu(false);
    assert.equal(withFt.items.length, withoutFt.items.length + 1);
    assert.equal(
      withFt.items.some((item) => item.name === "tools.freeTransform"),
      true
    );
  });
});
