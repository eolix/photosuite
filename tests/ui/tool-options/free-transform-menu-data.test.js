/**
 * Free Transform menu / action descriptor goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let getFreeTransformMenuItems;
let getFreeTransformActions;
let resolveWarpMenuRowState;
let CHROME_SCALE;
let CHROME_ROTATE;
let CHROME_DISTORT;
let CHROME_PERSPECTIVE;
let CHROME_WARP;
let Point;

before(async () => {
  ({
    getFreeTransformMenuItems,
    getFreeTransformActions,
    resolveWarpMenuRowState,
    CHROME_SCALE,
    CHROME_ROTATE,
    CHROME_DISTORT,
    CHROME_PERSPECTIVE,
    CHROME_WARP
  } = await import("../../../src/ui/tool-options/free-transform-menu-data.js"));
  ({ Point } = await import("../../../src/core/math/point.js"));
});

describe("ui/tool-options/free-transform-menu-data.js", () => {
  it("menu and action lists stay aligned at length 11", () => {
    assert.equal(getFreeTransformMenuItems().length, 11);
    assert.equal(getFreeTransformActions(99).length, 11);
  });

  it("chrome mode constants and action payloads match their golden values", () => {
    assert.deepEqual(
      [CHROME_SCALE, CHROME_ROTATE, CHROME_DISTORT, CHROME_PERSPECTIVE, CHROME_WARP],
      [3, 4, 2, 1, -1]
    );
    const actions = getFreeTransformActions(42);
    assert.equal(actions[0].payload.actionKind, "again");
    assert.equal(actions[0].documentModelType, 42);
    assert.equal(actions[1].payload.toolOptions.transformChromeMode, 3);
    assert.equal(actions[2].payload.toolOptions.transformChromeMode, 4);
    assert.equal(actions[3].payload.toolOptions.transformChromeMode, 2);
    assert.equal(actions[4].payload.toolOptions.transformChromeMode, 1);
    assert.equal(actions[5].payload.toolOptions.transformChromeMode, -1);
    assert.equal(actions[6].payload.gestureValue, -Math.PI / 2);
    assert.equal(actions[7].payload.gestureValue, -3 * Math.PI / 2);
    assert.equal(actions[8].payload.gestureValue, Math.PI);
    assert.ok(actions[9].payload.gestureValue instanceof Point);
    assert.equal(actions[9].payload.gestureValue.x, -1);
    assert.equal(actions[9].payload.gestureValue.y, 1);
    assert.equal(actions[10].payload.gestureValue.x, 1);
    assert.equal(actions[10].payload.gestureValue.y, -1);
    assert.equal(actions[1].appEventType, EventType.uiDispatch);
    assert.equal(actions[6].appEventType, EventType.documentAction);
  });

  it("resolveWarpMenuRowState enable rules", () => {
    assert.deepEqual(resolveWarpMenuRowState(null), { enabled: false });
    assert.deepEqual(
      resolveWarpMenuRowState({ selectedLayerIndices: [0, 1], layers: [] }),
      { enabled: false }
    );
    assert.deepEqual(
      resolveWarpMenuRowState({
        selectedLayerIndices: [0],
        layers: [{ add: {}, isGroup: () => true }]
      }),
      { enabled: false }
    );
    assert.deepEqual(
      resolveWarpMenuRowState({
        selectedLayerIndices: [0],
        layers: [{ add: { TySh: {} }, isGroup: () => false }]
      }),
      { enabled: false }
    );
    assert.deepEqual(
      resolveWarpMenuRowState({
        selectedLayerIndices: [0],
        layers: [{ add: {}, isGroup: () => false }]
      }),
      { enabled: true }
    );
  });

  it("warp row wires resolveRowState and separators", () => {
    const items = getFreeTransformMenuItems();
    assert.equal(items[0].separatorAfter, true);
    assert.equal(items[5].name, "dialogs.warp");
    assert.equal(items[5].separatorAfter, true);
    assert.equal(items[5].resolveRowState, resolveWarpMenuRowState);
  });
});
