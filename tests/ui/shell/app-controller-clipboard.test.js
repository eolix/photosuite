/**
 * AppController clipboard helpers: action steps, preset store, text gate.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let buildRecordedActionStep;
let resolvePresetStore;
let isEditingTextLayer;
let applyClipboardHandlers;
let COPY_RESULT_PATH;
let PRESET_PANEL_TYPES;
let PopupTypes;
let DocumentModel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({
    buildRecordedActionStep,
    resolvePresetStore,
    isEditingTextLayer,
    applyClipboardHandlers,
    COPY_RESULT_PATH,
    PRESET_PANEL_TYPES
  } = await import("../../../src/ui/shell/app-controller-clipboard.js"));
});

describe("ui/shell/app-controller-clipboard.js", () => {
  it("buildRecordedActionStep matches ActionParser field names", () => {
    const step = buildRecordedActionStep({
      uf: "delete",
      actionDescriptor: { classID: "null", X: { t: "long", v: 1 } }
    });
    assert.equal(step.expanded, false);
    assert.equal(step.enabled, true);
    assert.equal(step.dialogOptionsEnabled, false);
    assert.equal(step.dialogOptions, 0);
    assert.equal(step.uf, "delete");
    assert.deepEqual(step.actionDescriptor, { classID: "null", X: { t: "long", v: 1 } });
    step.actionDescriptor.X.v = 99;
    // deep clone — mutating copy must not mutate input
    assert.equal(
      buildRecordedActionStep({
        uf: "delete",
        actionDescriptor: { classID: "null", X: { t: "long", v: 1 } }
      }).actionDescriptor.X.v,
      1
    );
  });

  it("resolvePresetStore maps panel types by PRESET_PANEL_TYPES order", () => {
    const appData = {
      brushPresets: ["b"],
      gradientPresets: ["g"],
      contourPresets: ["c"],
      patternPresets: ["p"],
      customShapePresets: ["s"],
      stylePresets: ["st"],
      swatchPresets: ["sw"],
      actionSets: ["a"],
      toolPresets: ["t"],
      colorProfilePresets: ["cp"]
    };
    assert.equal(PRESET_PANEL_TYPES.length, 10);
    assert.deepEqual(resolvePresetStore(appData, PopupTypes.BRUSHES), ["b"]);
    assert.deepEqual(resolvePresetStore(appData, PopupTypes.SWATCHES), ["sw"]);
    assert.deepEqual(resolvePresetStore(appData, PopupTypes.COLOR_PROFILES), ["cp"]);
  });

  it("isEditingTextLayer requires active text tool", () => {
    assert.ok(!isEditingTextLayer({ toolRegistry: null }));
    assert.equal(
      isEditingTextLayer({
        toolRegistry: { entriesById: { [ToolId.TOOL_TYPE]: { tool: { isActive: () => true } } } }
      }),
      true
    );
    assert.equal(
      isEditingTextLayer({
        toolRegistry: { entriesById: { [ToolId.TOOL_TYPE]: { tool: { isActive: () => false } } } }
      }),
      false
    );
  });

  it("applyClipboardHandlers installs onHistoryGrouped that records skipActionRecording", () => {
    function FakeController() {}
    applyClipboardHandlers(FakeController);
    assert.equal(typeof FakeController.prototype.onHistoryGrouped, "function");
    assert.equal(typeof FakeController.prototype.copySelectionToClipboard, "function");
    assert.equal(typeof FakeController.prototype.pasteFromInternalClipboard, "function");
    assert.equal(COPY_RESULT_PATH, 1);

    const calls = [];
    const controller = Object.create(FakeController.prototype);
    controller.appData = {
      recordingActionSet: [0, 0, 0],
      actionSets: [{ children: [{ children: [] }] }]
    };
    controller.getCurrentDoc = () => null;
    controller.updateAllPanels = (t) => calls.push(["update", t]);

    // Route the ActionDescUtil path through an event carrying skip
    FakeController.prototype.onHistoryGrouped.call(controller, {
      data: { skipActionRecording: true, uf: "set" }
    });
    assert.equal(controller.appData.actionSets[0].children[0].children.length, 1);
    const recorded = controller.appData.actionSets[0].children[0].children[0];
    assert.equal(recorded.enabled, true);
    assert.equal(recorded.uf, "set");
    assert.deepEqual(calls, [["update", PopupTypes.ACTIONS]]);
  });
});
