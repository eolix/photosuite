import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { makeElement } from "../../../src/core/dom.js";
import { UiCommand } from "../../../src/core/event-bus.js";

let ToolId;
let repeatOffsetForLayers;
let restoreBrowserGlobals;
let MoveTool;

function patchDomForInputHandler() {
  const createElement = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = function patchedCreateElement() {
    const element = createElement();
    element.setAttribute = () => {};
    element.addEventListener = () => {};
    element.appendChild = () => element;
    return element;
  };
}

// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  await import("../../../src/engine/layer-system.js");
  patchDomForInputHandler();
  await import("../../../src/document/tools/move-tools.js");
  ({ repeatOffsetForLayers } = await import("../../../src/document/model/layer-translate.js"));
  ({ MoveTool } = await import("../../../src/document/tools/move-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/move-tools.js", () => {
  it("registerMoveTools wires MoveTool with TOOL_MOVE", () => {
    chainToolPrototypes();
    const moveTool = new MoveTool();

    assert.equal(typeof MoveTool, "function");
    assert.equal(moveTool.name, "tools.moveTool");
    assert.equal(moveTool.id, ToolId.TOOL_MOVE);
    assert.equal(moveTool.isDragging, false);
    assert.deepEqual(moveTool.toolOptions, {
      autoSelectLayers: false,
      showTransformControls: false,
      showMeasurementGuides: false,
    });
    assert.deepEqual(moveTool.getCursorStyle(), [0, 0, 0]);
  });

  it("distributeGuideSpacings redistributes segment start positions", () => {
    chainToolPrototypes();
    const spans = [[10, 20], [50, 20], [100, 20]];
    MoveTool.distributeGuideSpacings(spans);
    assert.deepEqual(spans, [[10, 20], [55, 20], [100, 20]]);
  });

  it("repeatOffsetForLayers interleaves dx and dy per layer index", () => {
    chainToolPrototypes();
    const offsets = repeatOffsetForLayers([1, 2], 3, 4);
    assert.deepEqual(offsets, [3, 4, 3, 4]);
  });

  it("mergeLayerIndexLists appends unique coordinates per axis", () => {
    chainToolPrototypes();
    const guides = [[1], [2]];
    MoveTool.mergeLayerIndexLists(guides, [[3], [4]]);
    assert.deepEqual(guides, [[1, 3], [2, 4]]);
  });

  it("syncToolbarWidget forwards gesture payload through dispatcher", () => {
    chainToolPrototypes();
    const moveTool = new MoveTool();
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        dispatched.push(event.data);
      },
    };

    moveTool.syncToolbarWidget([1, 0, 1], [true, false], dispatcher);

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].dispatchKind, UiCommand.forwardActiveToolGesture);
    assert.equal(dispatched[0].routingChannel, ToolId.TOOL_MOVE);
    assert.equal(dispatched[0].toolOptions.autoSelectLayers, true);
    assert.equal(dispatched[0].toolOptions.showTransformControls, false);
    assert.equal(dispatched[0].toolOptions.showMeasurementGuides, true);
    assert.deepEqual(dispatched[0].visibleSectionFlags, [true, false]);
  });
});
