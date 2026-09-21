/**
 * Text Warp and Refine Edge.
 *
 * TextWarpDialog is a live control surface: every widget change, the close
 * button and OK all dispatch a documentAction on the type-tool channel,
 * distinguished only by `actionKind` — so the type tool applies, reverts or
 * commits the warp. RefineEdgeDialog splits whatever height its toolbar leaves
 * between two preview panes.
 *
 * Both constructors boot the widget stack (canvas thumbnails, the Typr font
 * engine), so these drive the prototype methods against the state they read.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";
import { showToast, installToastPainter } from "../../../src/core/user-prompts.js";

installBrowserGlobals();

let ToolId;
let TextWarpDialog;
let RefineEdgeDialog;
let DocumentModel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ TextWarpDialog, RefineEdgeDialog } = await import(
    "../../../src/ui/dialogs/text-warp-refine-dialogs.js"
  ));
});

/** A TextWarpDialog that records what it dispatches instead of reaching the app. */
function warpDialogSpy(warpMesh = { Style: "arc", Value: 30 }) {
  const dialog = Object.create(TextWarpDialog.prototype);
  dialog.dispatched = [];
  dialog.dispatch = (appEvent) => dialog.dispatched.push(appEvent);
  dialog.close = () => { dialog.closed = true; };
  dialog.warpDisplayOptions = { getValue: () => warpMesh };
  return dialog;
}

describe("ui/dialogs/text-warp-refine-dialogs.js", () => {
  it("TextWarpDialog routes warp actions to the type tool", () => {
    const dialog = warpDialogSpy();

    dialog.dispatchWarpAction({ actionKind: "warp", warpMesh: { Style: "arc" } });

    assert.equal(dialog.dispatched.length, 1);
    const [event] = dialog.dispatched;
    assert.equal(event.type, EventType.documentAction);
    assert.equal(event.routingChannel, ToolId.TOOL_TYPE);
    assert.equal(event.fromDialog, true);
    assert.deepEqual(event.data, { actionKind: "warp", warpMesh: { Style: "arc" } });
  });

  it("OK commits the warp and closes; cancel reverts it and leaves closing alone", () => {
    const okDialog = warpDialogSpy();
    okDialog.onOK({});
    assert.equal(okDialog.dispatched.at(-1).data.actionKind, "warpConfirm");
    assert.equal(okDialog.closed, true);

    const cancelDialog = warpDialogSpy();
    cancelDialog.onCancel({});
    assert.equal(cancelDialog.dispatched.at(-1).data.actionKind, "warpCancel");
    assert.notEqual(cancelDialog.closed, true, "the close button already closes it");
  });

  it("refresh republishes the live mesh on every widget change", () => {
    const mesh = { Style: "flag", Value: 12 };
    const dialog = warpDialogSpy(mesh);

    dialog.refresh({});

    assert.equal(dialog.dispatched.length, 1);
    assert.equal(dialog.dispatched[0].data.actionKind, "warp");
    assert.equal(dialog.dispatched[0].data.warpMesh, mesh);
  });

  it("RefineEdgeDialog.canOpen refuses an empty layer and says why", () => {
    const dialog = Object.create(RefineEdgeDialog.prototype);
    const toasts = [];    installToastPainter((message) => toasts.push(message));
    try {
      const docWithLayer = (isEmpty) => ({
        selectedLayerIndices: [0],
        layers: [{ rect: { isEmpty: () => isEmpty } }],
      });
      assert.equal(dialog.canOpen(docWithLayer(false), {}), true);
      assert.equal(toasts.length, 0);
      assert.equal(dialog.canOpen(docWithLayer(true), {}), false);
      assert.equal(toasts.length, 1, "the user is told the layer is empty");
    } finally {
      installToastPainter(null);
    }
  });

  it("RefineEdgeDialog.resize halves the width between previews and floors their size", () => {
    const sized = { left: null, right: null };
    const dialog = Object.create(RefineEdgeDialog.prototype);
    dialog.body = {};
    dialog.el = {};
    dialog.formDiv = { offsetHeight: 0 };  // toolbar not laid out yet
    dialog.leftPreviewPanel = { resize: (w, h) => { sized.left = { w, h }; } };
    dialog.rightPreviewPanel = { resize: (w, h) => { sized.right = { w, h }; } };
    const realGetComputedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = () => ({});   // no padding or border to subtract

    try {
      dialog.resize(1000, 700);
      assert.deepEqual(sized.left, sized.right, "both panes get the same box");
      // Half the width less the 12px gap; the height loses that gap and the
      // 34px toolbar fallback that stands in until the strip is laid out.
      assert.equal(sized.left.w, Math.floor((1000 - 12) / 2));
      assert.equal(sized.left.h, 700 - 34 - 12);
      assert.deepEqual(dialog.lastLayoutSize, { width: 1000, height: 700 });

      // A viewport too small to divide still yields a usable pane.
      dialog.resize(40, 40);
      assert.equal(sized.left.w, 120);
      assert.equal(sized.left.h, 120);
    } finally {
      globalThis.getComputedStyle = realGetComputedStyle;
    }
  });
});
