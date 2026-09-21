/**
 * Startup launch slice of AppController.
 *
 * `applyLaunchHandlers(AppController)` installs `finishLaunchFromQueryString`,
 * which runDeferredStartup calls once the shell is up. It decides how the editor
 * was launched and acts on it: a `?p=`/`#` project payload (JSON describing
 * resources, files, a startup script, and a host `environment` config) is
 * applied here; absent that, the browser File Handling API launch queue is wired
 * so files opened from the OS load into the editor.
 *
 * The `environment` config carries host-embed wire names (`vmode`, `tmnu`,
 * `showtools`, …) taken verbatim from the JSON payload; they are read, not
 * renamed.
 */

import { Locale } from "../../core/i18n/locale.js";
import { ScriptEngine } from "../../features/scripting/script-engine.js";
import { TextLayout } from "../../features/text/text-layout.js";
import { overrideIcon } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";

/** Mixes launch methods onto AppController.prototype. */
export function applyLaunchHandlers(AppController) {
  AppController.prototype.finishLaunchFromQueryString = function() {
    if (this.appData.hasLaunched) return;
    this.appData.hasLaunched = true;
    const parsed = parseLaunchQueryFromHref(window.location.href);
    if (parsed.queryKey == "p" || parsed.queryKey == "state") {
      const launchPayload = JSON.parse(decodeURI(parsed.payloadText));
      if (parsed.queryKey == "p") applyProjectLaunchPayload(this, launchPayload);
    } else {
      installFileHandlingLaunchQueue(this)
    }
  };
}

export {
  parseLaunchQueryFromHref,
  buildFileScriptHostData,
  applyEnvironmentConfig
};

// ---------------------------------------------------------------------------
// URL parse
// ---------------------------------------------------------------------------

/**
 * Extract launch query key and payload slice from a page href.
 * Hash fragments force queryKey "p" with the payload after "#".
 *
 * @param {string} pageUrl
 * @returns {{ queryKey: string|null, payloadText: string|null }}
 */
function parseLaunchQueryFromHref(pageUrl) {
  let queryKey = null;
  let valueStart = pageUrl.indexOf("=");
  const hashStart = pageUrl.indexOf("#");
  if (valueStart != -1) {
    queryKey = pageUrl.substring(pageUrl.indexOf("?") + 1, valueStart);
  }
  if (hashStart != -1 && hashStart != pageUrl.length - 1) {
    queryKey = "p";
    valueStart = hashStart
  }
  const payloadText = valueStart != -1
    ? pageUrl.substring(valueStart + 1, pageUrl.length)
    : null;
  return { queryKey, payloadText }
}

// ---------------------------------------------------------------------------
// Project payload (?p=… / #…)
// ---------------------------------------------------------------------------

// Act on a decoded ?p=/# project payload: queue its resource and file URLs for
// loading, apply the host environment config and persisted app state, and — when
// the payload carries a script but no files to open first — run it immediately.
function applyProjectLaunchPayload(controller, launchPayload) {
  if (launchPayload.script) TextLayout.ensureWasm();
  enqueueLaunchResources(controller, launchPayload);
  enqueueLaunchFiles(controller, launchPayload);
  if (launchPayload.environment == null) launchPayload.environment = {};
  applyEnvironmentConfig(controller, launchPayload.environment);
  controller.applyPersistedAppState(launchPayload.environment);
  if (launchPayload.files == null && launchPayload.script) {
    ScriptEngine.execute(launchPayload.script, controller);
    controller.onComplete()
  }
}

function enqueueLaunchResources(controller, launchPayload) {
  if (launchPayload.resources == null) return;
  for (let resourceIdx = 0; resourceIdx < launchPayload.resources.length; resourceIdx++) {
    controller.fileLoader.enqueueUrlLoad({
      url: launchPayload.resources[resourceIdx]
    })
  }
}

function enqueueLaunchFiles(controller, launchPayload) {
  if (launchPayload.files == null) return;
  for (let fileIdx = 0; fileIdx < launchPayload.files.length; fileIdx++) {
    controller.fileLoader.enqueueUrlLoad({
      url: launchPayload.files[fileIdx],
      scriptHostData: buildFileScriptHostData(launchPayload)
    })
  }
}

/**
 * scriptHostData attached to each launched file URL load.
 * @param {{ server?: string, script?: string }} launchPayload
 */
function buildFileScriptHostData(launchPayload) {
  return {
    hostServer: launchPayload.server,
    startupScript: launchPayload.script
  }
}

/**
 * Apply host environment bag onto the controller / appData.
 * Incoming keys (vmode, tmnu, showtools, …) are embed wire names.
 *
 * @param {*} controller
 * @param {object} environmentConfig
 */
function applyEnvironmentConfig(controller, environmentConfig) {
  if (environmentConfig.plugins != null) {
    controller.rightSidebar.registerRuntimePlugins(environmentConfig.plugins);
  }
  if (environmentConfig.customIO != null) {
    controller.appData.customIO = environmentConfig.customIO;
  }
  if (environmentConfig.vmode != null) {
    applyViewMode(controller, environmentConfig.vmode);
  }
  if (environmentConfig.intro != null) {
    controller.appData.intro = environmentConfig.intro;
  }
  if (environmentConfig.menus != null) {
    controller.appData.menuVisibility = environmentConfig.menus;
  }
  if (environmentConfig.tmnu != null) {
    controller.appData.serverToolbarOptions = environmentConfig.tmnu;
  }
  if (environmentConfig.panels != null) {
    controller.appData.effectRows = environmentConfig.panels;
  }
  if (environmentConfig.showtools != null) {
    applyAllowedToolIds(controller, environmentConfig.showtools);
  }
  if (environmentConfig.phrases != null) {
    Locale.registerNumericKeys(environmentConfig.phrases);
  }
  if (environmentConfig.autosave != null) {
    installAutosaveInterval(controller, environmentConfig.autosave);
  }
  if (environmentConfig.icons != null) {
    applyLaunchIcons(controller, environmentConfig.icons);
  }
}

function applyViewMode(controller, viewMode) {
  if (viewMode == 1) controller.appData.compact = true;
  if (viewMode == 2) controller.setChromeLayoutMode(1)
}

function applyAllowedToolIds(controller, allowedToolIds) {
  const activeIdx = allowedToolIds.indexOf(controller.appData.activeToolId);
  controller.appData.allowedToolIds = allowedToolIds;
  if (activeIdx == -1) controller.activateTool(allowedToolIds[0])
}

function installAutosaveInterval(controller, autosaveSeconds) {
  window.setInterval(function() {
    const autosaveEvt = new AppEvent(EventType.uiDispatch);
    autosaveEvt.data = {
      dispatchKind: UiCommand.saveOrCommitDocument
    };
    controller.dispatch(autosaveEvt)
  }.bind(controller), autosaveSeconds * 1e3)
}

function applyLaunchIcons(controller, icons) {
  for (const iconKey in icons) {
    if (icons[iconKey].indexOf("\"") != -1) continue;
    if (iconKey == "intro" && controller.appData.hideIntro) continue;
    overrideIcon(iconKey, icons[iconKey]);
  }
}

// ---------------------------------------------------------------------------
// File Handling API (no ?p= / # payload)
// ---------------------------------------------------------------------------

// Consume the browser File Handling API launch queue: for each file the OS
// hands the app to open, read its blob and load it through the file loader.
function installFileHandlingLaunchQueue(controller) {
  const launchQueue = window.launchQueue;
  if (!launchQueue) return;
  const fileLoader = controller.fileLoader;
  launchQueue.setConsumer(function(launchItem) {
    const fileHandles = launchItem.files;
    for (let handleIdx = 0; handleIdx < fileHandles.length; handleIdx++) {
      const handle = fileHandles[handleIdx];
      handle.getFile().then(function(fileBlob) {
        fileLoader.loadLocalFiles([fileBlob], null, null, null, [handle])
      })
    }
  })
}
