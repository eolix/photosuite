import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { getDevicePixelRatio, makeElement } from "../../../src/core/dom.js";
import { countSubpaths } from "../../../src/engine/compositing/path-records.js";
import { createEmptyKeyOrigin } from "../../../src/engine/compositing/key-origins.js";


let ToolId;
let restoreBrowserGlobals;
let DirectSelectTool;
let PathSelectTool;
let PenTool;
let PolyToolBase;

function patchDomForCanvas() {
  const originalCreateElement = makeElement;
  document.createElement = function patchedCreateElement(tagName) {
    if (tagName === "canvas") {
      const pixels = new Uint8ClampedArray(64 * 64 * 4);
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            clearRect() {},
            save() {},
            restore() {},
            translate() {},
            rotate() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            stroke() {},
            fill() {},
            fillRect() {},
            arc() {},
            lineWidth: 1,
            lineJoin: "",
            fillStyle: "",
            getImageData() {
              return { data: pixels };
            },
          };
        },
      };
    }
    return originalCreateElement ? originalCreateElement.apply(this, arguments) : {
      style: {},
      setAttribute() {},
      addEventListener() {},
      appendChild() {
        return this;
      },
    };
  };
  window.devicePixelRatio = 1;
}

// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  await import("../../../src/engine/layer-system.js");
  patchDomForCanvas();
  await import("../../../src/document/tools/pen-path-tools.js");
  ({ DirectSelectTool, PathSelectTool, PenTool, PolyToolBase } = await import("../../../src/document/tools/pen-path-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/pen-path-tools.js", () => {
  it("registerPenPathTools wires pen and path-select constructors", () => {
    chainToolPrototypes();
    const penTool = new PenTool();
    const pathSelect = new PathSelectTool();
    const directSelect = new DirectSelectTool();

    assert.equal(typeof PolyToolBase, "function");
    assert.equal(penTool.id, ToolId.TOOL_PEN);
    assert.equal(pathSelect.id, ToolId.TOOL_PATH_SELECT);
    assert.equal(directSelect.id, ToolId.TOOL_DIRECT_SELECT);
    assert.equal(penTool.isDraggingPathHandle, false);
    assert.equal(penTool.activeHandleHitKind, 0);
    assert.equal(typeof penTool.onMouseDown, "function");
    assert.equal(typeof PolyToolBase.mergePathSegments, "function");
  });

  it("mergePathSegments appends clipboard subpaths and selects them", () => {
    chainToolPrototypes();
    const vectorMask = {
      pathRecords: [
        { type: 0, fillRule: -1 },
        { type: 0, fillRule: -1 },
        { type: 3, length: 1, fillRule: 0 },
        { type: 4, anchor: { x: 0, y: 0 } },
      ],
      C: [],
      selectedComponents: [],
    };
    const keyOrigins = [{ existing: true }];
    const clipboardPath = [
      { type: 0, fillRule: -1 },
      { type: 0, fillRule: -1 },
      { type: 3, length: 1, fillRule: 1 },
      { type: 4, anchor: { x: 10, y: 10 } },
    ];
    const clipboardOrigins = [{ pasted: true }];

    PolyToolBase.mergePathSegments(
      [clipboardPath, clipboardOrigins],
      vectorMask,
      keyOrigins,
    );

    assert.equal(countSubpaths(vectorMask.pathRecords), 2);
    assert.deepEqual(vectorMask.C, [1]);
    assert.equal(keyOrigins.length, 2);
    assert.deepEqual(keyOrigins[1], { pasted: true });
    assert.notEqual(keyOrigins[1], clipboardOrigins[0]);
  });

  it("clonePathSelectionState keeps only selected subpaths", () => {
    chainToolPrototypes();
    const vectorMask = {
      pathRecords: [
        { type: 0, fillRule: -1 },
        { type: 0, fillRule: -1 },
        { type: 3, length: 1, fillRule: 0 },
        { type: 4, anchor: { x: 1, y: 1 } },
        { type: 3, length: 1, fillRule: 1 },
        { type: 4, anchor: { x: 2, y: 2 } },
      ],
      C: [1],
      selectedComponents: [],
    };
    const keyOrigins = [{ a: 0 }, { b: 1 }];
    const [filteredPath, selectedOrigins] = PolyToolBase.clonePathSelectionState(
      vectorMask,
      keyOrigins,
    );

    assert.equal(countSubpaths(filteredPath), 1);
    assert.deepEqual(selectedOrigins, [{ b: 1 }]);
    assert.notEqual(selectedOrigins[0], keyOrigins[1]);
  });

it("Move Anchors history records the active path key, not the layer index", async () => {
    const { Layer } = await import("../../../src/document/model/layer.js");
    const { VectorMask } = await import("../../../src/document/model/layer-masks.js");
    const { KeyboardHandler } = await import("../../../src/core/keyboard-handler.js");
    chainToolPrototypes();
    const tool = new DirectSelectTool();

    const vectorMask = new VectorMask();
    vectorMask.pathRecords = [
      { type: 6 },
      { type: 8, all: 0 },
      { type: 3, length: 1, fillRule: 1, subpathHeaderFlags: 0, subpathUint32A: 0, subpathUint32B: 0 },
      { type: 4, cp1: new Point(1, 1), anchor: new Point(1, 1), anchorOut: new Point(1, 1) },
    ];
    vectorMask.selectedComponents = [3];
    const workPath = { idx: -1, add: { vmsk: vectorMask, vogk: [createEmptyKeyOrigin()] } };

    const pushed = [];
    const doc = {
      paths: [workPath],
      layers: [{}],
      selectedLayerIndices: [0],
      getPaths: () => [[workPath], [0]],
      pushHistory: (entry) => pushed.push(entry),
      getLastHistoryEntry: () => null,
      markDirty() {},
      dirty: false,
      stateChanged: false,
    };
    const keyboard = {
      getArrowMovement: () => new Point(1, 0),
      isPressed: (key) => false,
    };
    tool.onKeyEvent(doc, null, {}, keyboard);
    assert.equal(pushed.length, 1);
    // The history key must match what applyPathMaskToLayer used (work path = -1),
    // so undo/redo replays onto the same owner.
    assert.equal(pushed[0].data.pathLayerKey, -1);
  });

  it("buildPathCursorPreview caches soft-edged cursor bitmaps", () => {
    chainToolPrototypes();
    PenTool.pathCursorPreviewCache = {};
    const first = PenTool.buildPathCursorPreview("add");
    const second = PenTool.buildPathCursorPreview("add");

    assert.equal(first, second);
    assert.equal(first.boundsRect.width, 64);
    assert.equal(first.boundsRect.height, 64);
    assert.equal(first.hotspot.x, 4);
    assert.equal(first.hotspot.y, 4);
    assert.equal(first.pixelSource.length, 64 * 64 * 4);
  });
});
