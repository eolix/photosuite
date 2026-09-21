/**
 * Menu data for the Free Transform overlay menu. `getFreeTransformMenuItems`
 * returns the display rows (scale / rotate / distort / perspective / warp, plus
 * fixed 90°/180° rotations and flips) and `getFreeTransformActions` returns the
 * matching action descriptor for each row, index-for-index — a row and its
 * action share the same position. The CHROME_* constants are the transform
 * chrome modes each row switches the tool into.
 */

import { Point } from "../../core/math/point.js";
import { ToolId } from "../../document/model/tool-base.js";
import { EventType, UiCommand } from "../../core/event-bus.js";

/** transformChromeMode values for Free Transform panel chrome. */
const CHROME_SCALE = 3;
const CHROME_ROTATE = 4;
const CHROME_DISTORT = 2;
const CHROME_PERSPECTIVE = 1;
const CHROME_WARP = -1;

/**
 * Context-menu rows for Free Transform (labels + optional enable/separator).
 * @returns {Array<Object>}
 */
function getFreeTransformMenuItems() {
  return [
    menuRow("clipboard.again", { shortcut: "Shift+Alt+Ctrl + T", separatorAfter: true }),
    menuRow("properties.scale"),
    menuRow("edit.rotate"),
    menuRow("filters.gallery.groups.distort"),
    menuRow("edit.perspective"),
    menuRow("dialogs.warp", {
      resolveRowState: resolveWarpMenuRowState,
      separatorAfter: true
    }),
    menuRow(["VAR0 90\xB0 \u21BB", "edit.rotate"]),
    menuRow(["VAR0 90\xB0 \u21BA", "edit.rotate"]),
    menuRow(["VAR0 180\xB0", "edit.rotate"]),
    menuRow(["edit.flipVar", "warp.orientation.horizontally"]),
    menuRow(["edit.flipVar", "warp.orientation.vertically"])
  ];
}

/**
 * Parallel action descriptors for each Free Transform menu row.
 * @param {number|null|undefined} toolId
 * @returns {Array<Object>}
 */
function getFreeTransformActions(toolId) {
  if (toolId == null) toolId = ToolId.TOOL_FREE_TRANSFORM;
  return [
    documentToolAction(toolId, { actionKind: "again" }),
    setChromeModeAction(toolId, CHROME_SCALE),
    setChromeModeAction(toolId, CHROME_ROTATE),
    setChromeModeAction(toolId, CHROME_DISTORT),
    setChromeModeAction(toolId, CHROME_PERSPECTIVE),
    setChromeModeAction(toolId, CHROME_WARP),
    rotateDocumentAction(toolId, -Math.PI / 2),
    rotateDocumentAction(toolId, -3 * Math.PI / 2),
    rotateDocumentAction(toolId, Math.PI),
    flipScaleDocumentAction(toolId, new Point(-1, 1), [
      "edit.flipVar",
      "warp.orientation.horizontally"
    ]),
    flipScaleDocumentAction(toolId, new Point(1, -1), [
      "edit.flipVar",
      "warp.orientation.vertically"
    ])
  ];
}

/**
 * Warp is disabled for multi-select, groups, and Type layers (TySh present).
 * @param {Object|null} currentDoc
 * @returns {{ enabled: boolean }}
 */
function resolveWarpMenuRowState(currentDoc) {
  if (currentDoc == null || currentDoc.selectedLayerIndices.length != 1) {
    return { enabled: false };
  }
  const activeLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]];
  return {
    enabled: activeLayer.add.TySh == null && !activeLayer.isGroup()
  };
}

function menuRow(name, extras) {
  const row = { name: name };
  if (extras) {
    for (let key in extras) row[key] = extras[key];
  }
  return row
}

function setChromeModeAction(toolId, transformChromeMode) {
  return {
    appEventType: EventType.uiDispatch,
    documentModelType: toolId,
    payload: {
      dispatchKind: UiCommand.setActiveToolPanelMode,
      toolOptions: {
        transformChromeMode: transformChromeMode
      }
    }
  }
}

function documentToolAction(toolId, payload) {
  return {
    appEventType: EventType.documentAction,
    documentModelType: toolId,
    payload: payload
  }
}

function rotateDocumentAction(toolId, gestureValue) {
  return documentToolAction(toolId, {
    actionKind: "rot",
    historyLabelKey: "edit.rotate",
    gestureValue: gestureValue
  })
}

function flipScaleDocumentAction(toolId, gestureValue, historyLabelKey) {
  return documentToolAction(toolId, {
    actionKind: "scl",
    historyLabelKey: historyLabelKey,
    gestureValue: gestureValue
  })
}

export {
  getFreeTransformMenuItems,
  getFreeTransformActions,
  resolveWarpMenuRowState,
  CHROME_SCALE,
  CHROME_ROTATE,
  CHROME_DISTORT,
  CHROME_PERSPECTIVE,
  CHROME_WARP
};
