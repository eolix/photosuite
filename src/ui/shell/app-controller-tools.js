/**
 * Tool-management slice of AppController.
 *
 * `applyToolHandlers(AppController)` installs the controller methods that manage
 * the active tool: activating a tool (`activateTool`), the temporary modifier
 * tool that engages while a key is held (`updateTemporaryToolFromModifiers`),
 * resolving which tool instance is currently in effect (`getActiveToolEntry`),
 * routing `documentAction` input to the tool that owns a channel
 * (`handleInput`), and refreshing every option panel and chrome widget
 * (`updateAllPanels`).
 */
import { Locale } from "../../core/i18n/locale.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { ThemeConfig } from "../config/theme-config.js";
import { PopupTypes } from "../config/popup-types.js";
import { showToast } from "../../core/user-prompts.js";

/** Mixes tool methods onto AppController.prototype. */
export function applyToolHandlers(AppController) {
  AppController.prototype.handleInput = function(inputEvent) {
    routeToolInput(this, inputEvent)
  };
  AppController.prototype.updateAllPanels = function(popupType) {
    refreshAllPanels(this, popupType)
  };
  AppController.prototype.updateTemporaryToolFromModifiers = function() {
    syncTemporaryToolFromModifiers(this)
  };
  AppController.prototype.disableCurrentTool = function() {
    disableActiveTool(this)
  };
  AppController.prototype.ensureToolOptionPanel = function(toolEntry) {
    ensureToolOptionPanel(this, toolEntry)
  };
  AppController.prototype.activateTool = function(toolId, gestureOptions) {
    activateTool(this, toolId, gestureOptions)
  };
  AppController.prototype.getActiveToolEntry = function(preferTemporaryTool) {
    return resolveActiveToolInstance(this, preferTemporaryTool)
  };
}

export {
  resolveTemporaryToolOverride,
  resolveActiveToolId,
  isHandOrZoomChannel,
  isPathOrShapeToolId,
  PATH_OR_SHAPE_TOOL_IDS
};

// ---------------------------------------------------------------------------
// Input routing
// ---------------------------------------------------------------------------

function isHandOrZoomChannel(routingChannel) {
  return routingChannel == ToolId.TOOL_HAND || routingChannel == ToolId.TOOL_ZOOM
}

// Deliver a documentAction event to the tool that owns its routing channel.
// Requires an open document, blocks non-hand/zoom input while a modal dialog is
// active (unless the event came from that dialog), deactivates the outgoing tool
// when switching, then hands the payload to the target tool.
function routeToolInput(controller, inputEvent) {
  const currentDoc = controller.getCurrentDoc();
  if (currentDoc == null) {
    showToast(Locale.get("brushAndMessages.toolHints.openADocumentFirst"));
    return
  }
  const handOrZoom = isHandOrZoomChannel(inputEvent.routingChannel);
  if (controller.documentView.isActive() && inputEvent.fromDialog != true && !handOrZoom) {
    controller.showCloseOverlayOrConfirmAlert();
    return
  }
  maybeDisableActiveToolBeforeRoute(controller, inputEvent, currentDoc, handOrZoom);
  const targetTool = controller.toolRegistry.entriesById[inputEvent.routingChannel].tool;
  targetTool.handleInput(inputEvent.data, controller, currentDoc, controller.keyboardHandler, controller.appData)
}

function maybeDisableActiveToolBeforeRoute(controller, inputEvent, currentDoc, handOrZoom) {
  const toolRegistry = controller.toolRegistry;
  const activeToolId = controller.appData.activeToolId;
  const skipDisableForPuppetToSmartFilter =
    activeToolId == ToolId.TOOL_PUPPET_WARP
    && inputEvent.routingChannel == EventChannel.EVENT_SMART_FILTER;
  if (
    activeToolId != inputEvent.routingChannel
    && toolRegistry.entriesById[activeToolId].tool.isActive()
    && !handOrZoom
    && !skipDisableForPuppetToSmartFilter
  ) {
    toolRegistry.entriesById[activeToolId].tool.disable(
      currentDoc,
      controller,
      controller.appData,
      controller.keyboardHandler
    )
  }
}

// ---------------------------------------------------------------------------
// Panel refresh
// ---------------------------------------------------------------------------

// Push an update of the given PopupTypes kind through every UI surface that
// reflects app state: tool option panels, the toolbar, document view, right
// sidebar, and menu bar. Some kinds (scripts, recent files, theme) take
// narrower or extra paths.
function refreshAllPanels(controller, popupType) {
  const activeToolId = controller.appData.activeToolId;
  if (popupType == PopupTypes.SCRIPTS) {
    const activeEntry = controller.toolRegistry.entriesById[activeToolId];
    if (activeEntry.optionPanel) activeEntry.optionPanel.onUpdate(controller.appData, popupType)
  } else {
    for (const toolId in controller.toolRegistry.entriesById) {
      const entry = controller.toolRegistry.entriesById[toolId];
      if (entry.optionPanel) entry.optionPanel.onUpdate(controller.appData, popupType)
    }
  }
  if (popupType == PopupTypes.OPEN_RECENT) {
    if (activeToolId != ToolId.TOOL_TYPE) {
      controller.toolRegistry.entriesById[ToolId.TOOL_TYPE].tool.onUpdate(controller.appData, popupType);
    }
    controller.refreshTextLayerFonts()
  }
  controller.toolBar.onUpdate(controller.appData, popupType);
  controller.documentView.onUpdate(controller.appData, popupType);
  const activeToolPanel = controller.getActiveToolEntry();
  if (activeToolPanel) activeToolPanel.onUpdate(controller.appData, popupType);
  controller.rightSidebar.onUpdate(controller.appData, popupType);
  controller.menuBar.onUpdate(controller.appData, popupType);
  if (popupType == PopupTypes.CHANGE_THEME || popupType == PopupTypes.ALL) {
    ThemeConfig.applyTheme(controller.appData.theme);
    controller.update(true)
  }
}

// ---------------------------------------------------------------------------
// Temporary modifier tools
// ---------------------------------------------------------------------------

/**
 * First matching modifier override, or nulls when none apply.
 * @returns {{ temporaryToolId: number|null, activateWhileInactive: boolean }}
 */
function resolveTemporaryToolOverride(toolRegistry, keyboard, activeToolId, activeTool) {
  let temporaryToolId = null;
  let activateWhileInactive = false;
  for (let overrideIdx = 0; overrideIdx < toolRegistry.modifierToolOverrides.length; overrideIdx++) {
    const modifierOverride = toolRegistry.modifierToolOverrides[overrideIdx];
    if (!modifiersAllPressed(keyboard, modifierOverride.requiredModifierKeys)) continue;
    if (modifierOverride.activateWhileToolInactive && activeTool.isActive()) continue;
    if (
      modifierOverride.allowedBaseToolIds != null
      && modifierOverride.allowedBaseToolIds.indexOf(activeToolId) == -1
    ) continue;
    temporaryToolId = modifierOverride.documentModelType;
    activateWhileInactive = modifierOverride.activateWhileToolInactive;
    break
  }
  return { temporaryToolId, activateWhileInactive }
}

function modifiersAllPressed(keyboard, requiredModifierKeys) {
  for (let modifierKeyIdx = 0; modifierKeyIdx < requiredModifierKeys.length; modifierKeyIdx++) {
    if (!keyboard.isPressed(requiredModifierKeys[modifierKeyIdx])) return false;
  }
  return true
}

// Engage or release the temporary modifier tool (e.g. hold a key to hand-pan)
// based on which modifiers are currently down. Picks the matching override,
// checks it is safe to swap right now, disables the outgoing temporary tool,
// and enables the new one.
function syncTemporaryToolFromModifiers(controller) {
  const keyboard = controller.keyboardHandler;
  const pointerState = controller.pointerState;
  const activeToolId = controller.appData.activeToolId;
  const activeTool = controller.toolRegistry.entriesById[activeToolId].tool;
  const { temporaryToolId, activateWhileInactive } = resolveTemporaryToolOverride(
    controller.toolRegistry,
    keyboard,
    activeToolId,
    activeTool
  );
  const canSwap =
    (!pointerState.isDown || activeToolId == ToolId.TOOL_LASSO_SELECT)
    && controller.toolRegistry.temporaryToolId != temporaryToolId
    && (temporaryToolId != activeToolId || !activateWhileInactive);
  if (!canSwap) return;
  const currentDoc = controller.getCurrentDoc();
  if (controller.toolRegistry.temporaryToolId != null && temporaryToolId == null) {
    controller.getActiveToolEntry().disable(currentDoc, controller, controller.appData, keyboard, true);
  }
  controller.toolRegistry.temporaryToolId = temporaryToolId;
  controller.getActiveToolEntry().enable(
    currentDoc,
    controller,
    controller.appData,
    keyboard,
    temporaryToolId != null && temporaryToolId != activeToolId
  )
}

// ---------------------------------------------------------------------------
// Activate / resolve
// ---------------------------------------------------------------------------

function disableActiveTool(controller) {
  const activeToolId = controller.appData.activeToolId;
  if (activeToolId == null) return;
  controller.toolRegistry.entriesById[activeToolId].tool.disable(
    controller.getCurrentDoc(),
    controller,
    controller.appData,
    controller.keyboardHandler
  )
}

function ensureToolOptionPanel(controller, toolEntry) {
  if (toolEntry.optionPanel != null) return;
  toolEntry.optionPanel = new toolEntry.optionPanelClass();
  toolEntry.optionPanel.initialize(toolEntry.tool.id, toolEntry.tool.iconId);
  toolEntry.optionPanel.onUpdate(controller.appData, PopupTypes.ALL);
  toolEntry.optionPanel.buildUI()
}

/** The tools that draw or edit vector paths. */
const PATH_OR_SHAPE_TOOL_IDS = new Set([
  ToolId.TOOL_PEN,
  ToolId.TOOL_FREE_PEN,
  ToolId.TOOL_RECT_SHAPE,
  ToolId.TOOL_ELLIPSE_SHAPE,
  ToolId.TOOL_PARAMETRIC_SHAPE,
  ToolId.TOOL_LINE_SHAPE,
  ToolId.TOOL_CUSTOM_SHAPE,
  ToolId.TOOL_PATH_SELECT,
  ToolId.TOOL_DIRECT_SELECT
]);

function isPathOrShapeToolId(toolId) {
  return PATH_OR_SHAPE_TOOL_IDS.has(toolId)
}

// Make the given tool the active tool: disable the current tool, record it as
// the active/saved id, rebuild the toolbar selection, ensure the tool's option
// panel exists and is shown in the confirm bar, then enable the tool. Vetoed if
// the tool declines the gesture, or for free-transform while a dialog is open.
function activateTool(controller, toolId, gestureOptions) {
  if (toolId == ToolId.TOOL_FREE_TRANSFORM && controller.documentView.getTopDialog()) return;
  const currentDoc = controller.getCurrentDoc();
  const appData = controller.appData;
  const toolEntry = controller.toolRegistry.entriesById[toolId];
  if (toolEntry == null || toolEntry.tool == null) return;
  if (!toolEntry.tool.canActivateWithGesture(currentDoc, appData)) return;

  controller.disableCurrentTool();
  const wasPathOrShapeToolActive = isPathOrShapeToolId(appData.activeToolId);
  controller.toolRegistry.savedActiveToolId = appData.activeToolId ? appData.activeToolId : ToolId.TOOL_MOVE;
  appData.activeToolId = toolId;
  controller.toolBar.open(controller.toolRegistry, controller.appData);
  controller.toolRegistry.selectedVariantByGroup[toolEntry.toolbarGroupIndex] = toolEntry.variantIndexInGroup;
  controller.ensureToolOptionPanel(toolEntry);
  controller.confirmBar.setOptionPanel(toolEntry.optionPanel);
  toolEntry.tool.enable(
    currentDoc,
    controller,
    controller.appData,
    controller.keyboardHandler,
    false,
    gestureOptions,
    wasPathOrShapeToolActive
  );
  if (currentDoc) currentDoc.stateChanged = true;
  controller.onResize()
}

/**
 * Resolve which tool id is "active" for getActiveToolEntry.
 * @param {*} controller
 * @param {boolean|null|undefined} preferTemporaryTool
 *   When null/undefined, temporary modifier tool wins over activeToolId.
 *   When explicitly set (e.g. false), temporary tool is ignored unless pointerDown.
 */
function resolveActiveToolId(controller, preferTemporaryTool) {
  const toolRegistry = controller.toolRegistry;
  let resolvedToolId = controller.appData.activeToolId;
  if (toolRegistry.pointerDownToolId) {
    resolvedToolId = toolRegistry.pointerDownToolId
  } else if (toolRegistry.temporaryToolId && preferTemporaryTool == null) {
    resolvedToolId = toolRegistry.temporaryToolId
  }
  return resolvedToolId
}

function resolveActiveToolInstance(controller, preferTemporaryTool) {
  const entry = controller.toolRegistry.entriesById[resolveActiveToolId(controller, preferTemporaryTool)];
  return entry ? entry.tool : null
}
