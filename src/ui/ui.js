/**
 * UI shell entry: load filter/adjustment panel modules (registry side effects),
 * install MenuBar.data from the right-sidebar panel registry, then boot
 * AppController on window load. Feature code lives in subfolders — import those
 * modules directly elsewhere to avoid cycles.
 */

// Panel constructors register onto the filter/adjustment panel map as import
// side effects, so the registry is populated before menu data and AppController
// resolve panels by filter id.
import "./filter-panels/filter-parameter-panel.js";
import "./filter-panels/builtin-filter-panels.js";
import "./filter-panels/liquify-panel.js";
import "./filter-panels/camera-raw-panel.js";
import "./filter-panels/lens-correction-panel.js";
import "./filter-panels/filter-gallery-panel.js";
import "./filter-panels/adjustment-panels.js";
import "./config/popup-type-parsers.js";
import { createMenuBarData } from "./menu/menu-bar-data.js";
import { RightSidebar } from "./layout/right-sidebar.js";
import { MenuBar } from "./menu/menu-bar.js";
import { AppController } from "./shell/app-controller.js";

/** Side-effect panel modules loaded above (order is load order). */
const FILTER_PANEL_BOOT_MODULES = [
  "filter-panels/filter-parameter-panel.js",
  "filter-panels/builtin-filter-panels.js",
  "filter-panels/liquify-panel.js",
  "filter-panels/camera-raw-panel.js",
  "filter-panels/lens-correction-panel.js",
  "filter-panels/filter-gallery-panel.js",
  "filter-panels/adjustment-panels.js"
];

/**
 * Bind MenuBar.data to createMenuBarData, reading RightSidebar.panelRegistry lazily.
 */
function installMenuBarData() {
  MenuBar.data = createMenuBarData(function getPanelRegistry() {
    return RightSidebar.panelRegistry;
  });
  return MenuBar.data;
}

/**
 * Construct AppController and attach its root element to document.body.
 * @returns {AppController}
 */
function mountAppController() {
  const app = new AppController();
  document.body.appendChild(app.el);
  return app;
}

/**
 * Schedule mountAppController for window.onload.
 */
function installWindowLoadBoot() {
  window.onload = function onWindowLoadBoot() {
    mountAppController();
  };
}

installMenuBarData();
installWindowLoadBoot();

export {
  FILTER_PANEL_BOOT_MODULES,
  installMenuBarData,
  mountAppController,
  installWindowLoadBoot
};
