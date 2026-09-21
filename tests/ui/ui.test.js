/**
 * UI entry wiring: filter-panel boot modules, MenuBar.data install,
 * and the window.onload AppController boot.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const uiPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/ui/ui.js"
);
const uiSource = fs.readFileSync(uiPath, "utf8");

describe("ui/ui.js", () => {
  it("FILTER_PANEL_BOOT_MODULES lists the panel modules in load order", () => {
    assert.match(
      uiSource,
      /const FILTER_PANEL_BOOT_MODULES = \[\s*"filter-panels\/filter-parameter-panel\.js",\s*"filter-panels\/builtin-filter-panels\.js",\s*"filter-panels\/liquify-panel\.js",\s*"filter-panels\/camera-raw-panel\.js",\s*"filter-panels\/lens-correction-panel\.js",\s*"filter-panels\/filter-gallery-panel\.js",\s*"filter-panels\/adjustment-panels\.js"\s*\]/
    );
  });

  it("exports boot helpers and runs install at module load", () => {
    assert.match(uiSource, /function installMenuBarData\s*\(/);
    assert.match(uiSource, /function mountAppController\s*\(/);
    assert.match(uiSource, /function installWindowLoadBoot\s*\(/);
    assert.match(uiSource, /installMenuBarData\(\);\s*\ninstallWindowLoadBoot\(\);/);
    assert.match(
      uiSource,
      /export \{\s*FILTER_PANEL_BOOT_MODULES,\s*installMenuBarData,\s*mountAppController,\s*installWindowLoadBoot\s*\}/
    );
  });

  it("wires MenuBar.data through createMenuBarData + RightSidebar.panelRegistry", () => {
    assert.match(uiSource, /MenuBar\.data = createMenuBarData/);
    assert.match(uiSource, /RightSidebar\.panelRegistry/);
    assert.match(uiSource, /new AppController\s*\(\)/);
    assert.match(uiSource, /window\.onload\s*=/);
  });
});
