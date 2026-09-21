import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType, UiCommand } from "../../../src/core/event-bus.js";

let ToolId;
let EventChannel;
let restoreBrowserGlobals;
let ToolBase;
let findToolIdForActionClass;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId, EventChannel } = await import("../../../src/document/model/tool-base.js"));
  ({ ToolBase, findToolIdForActionClass } = await import("../../../src/document/model/tool-base.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {

}

describe("document/model/tool-base.js", () => {
  it("registers ToolBase plus tool/event ids", () => {
    chainToolPrototypes();
    const tool = new ToolBase(
      "tools.moveTool",
      ToolId.TOOL_MOVE,
      "tools/move",
    );

    assert.equal(ToolBase.length, 3);
    assert.equal(tool.name, "tools.moveTool");
    assert.equal(tool.id, "TOOL_MOVE");
    assert.equal(tool.iconId, "tools/move");
    assert.equal(EventChannel.EVENT_DOCUMENT, "EVENT_DOCUMENT");
    assert.equal(EventChannel.EVENT_FILTER_STACK, "EVENT_FILTER_STACK");
  });

  it("enable and track dispatch the current event payloads", () => {
    chainToolPrototypes();
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        dispatched.push(event);
      },
    };
    const tool = new ToolBase("tools.moveTool", ToolId.TOOL_MOVE);
    tool.appDispatcher = dispatcher;

    tool.enable(null, dispatcher);

    const historyPayload = { actionKind: "move" };
    tool.track(historyPayload);

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].type, EventType.uiDispatch);
    assert.deepEqual(dispatched[0].data, {
      dispatchKind: UiCommand.splashOptionsUpdate,
      cursorOverlayId: "default",
    });
    assert.equal(dispatched[1].type, EventType.historyGrouped);
    assert.equal(dispatched[1].data, historyPayload);
    assert.equal(historyPayload.skipActionRecording, true);
  });

  it("drawToolOverlay writes a floating bitmap overlay", () => {
    chainToolPrototypes();
    const textCalls = [];
    globalThis.document.createElement = () => ({
      width: 0,
      height: 0,
      getContext() {
        return {
          fillStyle: "",
          font: "",
          fillRect() {},
          fillText(text, x, y) {
            textCalls.push([text, x, y]);
          },
          getImageData(_x, _y, width, height) {
            return { data: new Uint8ClampedArray(width * height * 4) };
          },
        };
      },
    });

    ToolBase.overlayCanvas = null;
    const doc = {
      toolOverlayState: {
        floatingBitmapOverlays: [],
      },
    };

    ToolBase.drawToolOverlay(50, 75, ["W: 10 px", "H: 20 px"], doc);

    assert.equal(textCalls.length, 2);
    assert.equal(doc.toolOverlayState.floatingBitmapOverlays.length, 1);
    const [pixels, rect] = doc.toolOverlayState.floatingBitmapOverlays[0];
    assert.equal(rect.x, 50);
    assert.equal(rect.y, 75 - (2 * 17 + 8));
    assert.equal(rect.width, 130);
    assert.equal(rect.height, 2 * 17 + 8);
    assert.ok(pixels instanceof Uint8ClampedArray);
  });

  it("findToolIdForActionClass matches brush preset descriptors", () => {
    chainToolPrototypes();

    assert.equal(
      findToolIdForActionClass([null, { classID: "PbTl" }]),
      ToolId.TOOL_BRUSH,
    );
    assert.equal(
      findToolIdForActionClass([null, { classID: "PcTl" }]),
      ToolId.TOOL_PENCIL,
    );
    assert.equal(findToolIdForActionClass([null, { classID: "none" }]), null);
  });
});
