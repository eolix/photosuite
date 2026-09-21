/**
 * AppController keyboard helpers (path enter mode, brackets, mask view).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let applyKeyboardHandlers;
let isNonModifierKeyInTextField;
let isEditingTextTool;
let computePathFromEnterMode;
let resolveBracketMoveOperation;
let resolveMaskViewModeFromChannelVisibility;
let buildInvertSelectionHistoryData;
let DocumentModel;
let KeyboardHandler;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ KeyboardHandler } = await import("../../../src/core/keyboard-handler.js"));
  ({
    applyKeyboardHandlers,
    isNonModifierKeyInTextField,
    isEditingTextTool,
    computePathFromEnterMode,
    resolveBracketMoveOperation,
    resolveMaskViewModeFromChannelVisibility,
    buildInvertSelectionHistoryData
  } = await import("../../../src/ui/shell/app-controller-keyboard.js"));
});

describe("ui/shell/app-controller-keyboard.js", () => {
  it("computePathFromEnterMode packs shift/alt bits", () => {
    assert.equal(computePathFromEnterMode(false, false), 0);
    assert.equal(computePathFromEnterMode(true, false), 1);
    assert.equal(computePathFromEnterMode(false, true), 2);
    assert.equal(computePathFromEnterMode(true, true), 3);
  });

  it("resolveBracketMoveOperation maps left/right + shift", () => {
    const left = { isPressed: (k) => k === KeyboardHandler.BracketLeft };
    const right = { isPressed: (k) => k === KeyboardHandler.BracketRight };
    assert.equal(resolveBracketMoveOperation(left, false), 2);
    assert.equal(resolveBracketMoveOperation(left, true), 3);
    assert.equal(resolveBracketMoveOperation(right, false), 1);
    assert.equal(resolveBracketMoveOperation(right, true), 0);
  });

  it("resolveMaskViewModeFromChannelVisibility", () => {
    assert.equal(resolveMaskViewModeFromChannelVisibility(null, {}), 0);
    assert.equal(resolveMaskViewModeFromChannelVisibility({ active: false }, {}), 0);
    assert.equal(
      resolveMaskViewModeFromChannelVisibility(
        { active: true },
        { pathViewport: { channelVisibility: [1, 1, 1] } }
      ),
      1
    );
    assert.equal(
      resolveMaskViewModeFromChannelVisibility(
        { active: true },
        { pathViewport: { channelVisibility: [1, 0, 0] } }
      ),
      2
    );
  });

  it("isNonModifierKeyInTextField rejects Escape/Ctrl/Alt", () => {
    assert.equal(isNonModifierKeyInTextField({ code: "KeyA" }), true);
    assert.equal(isNonModifierKeyInTextField({ code: "Escape" }), false);
  });

  it("isEditingTextTool requires active text tool", () => {
    assert.ok(!isEditingTextTool({
      toolRegistry: { entriesById: { [ToolId.TOOL_TYPE]: { tool: null } } }
    }));
    assert.equal(
      isEditingTextTool({
        toolRegistry: {
          entriesById: {
            [ToolId.TOOL_TYPE]: { tool: { isActive: () => true } }
          }
        }
      }),
      true
    );
  });

  it("applyKeyboardHandlers installs prototype methods and toggleBrowserFullscreen", () => {
    function FakeController() {}
    applyKeyboardHandlers(FakeController);
    assert.equal(typeof FakeController.prototype.onKeyEvent, "function");
    assert.equal(typeof FakeController.prototype.isShortcutKeyHeld, "function");
    assert.equal(typeof FakeController.toggleBrowserFullscreen, "function");
    assert.deepEqual(FakeController.prototype.textInputTagNames, ["input", "textarea", "select"]);
  });

  it("buildInvertSelectionHistoryData keeps uf wire key", () => {
    assert.deepEqual(buildInvertSelectionHistoryData(), { uf: "inverse" });
  });
});
