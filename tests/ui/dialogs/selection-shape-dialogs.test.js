/**
 * Slice / selection / create-shape dialogs: the OK paths that turn widget
 * values into the AppEvent or callback the rest of the app acts on, and the
 * gate that refuses to open Modify Selection without an active selection.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";
import { showToast, installToastPainter } from "../../../src/core/user-prompts.js";
import { AppEvent } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let ToolId;
let SelectionOptionsDialog;
let SelectOptionsDialog;
let MakeSelectionDialog;
let CreateShapeDialog;
let DocumentModel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  // BaseDialog’s close button renders an icon from the registry.
  await import("../../../src/assets/icon-registry.js");
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ SelectionOptionsDialog, SelectOptionsDialog, MakeSelectionDialog, CreateShapeDialog } =
    await import("../../../src/ui/dialogs/selection-shape-dialogs.js"));
});

/** Capture what a dialog dispatches instead of letting it reach the app. */
function captureDispatch(dialog) {
  const dispatched = [];
  dialog.dispatch = (appEvent) => dispatched.push(appEvent);
  dialog.close = () => { dialog.closed = true; };
  return dispatched;
}

describe("ui/dialogs/selection-shape-dialogs.js", () => {
  it("SelectOptionsDialog.canOpen requires an active selection", () => {
    const dialog = new SelectOptionsDialog("expand", "select.expand", "px");
    const toasts = [];    installToastPainter((message) => toasts.push(message));
    try {
      assert.equal(dialog.canOpen(null, {}), undefined, "no document means nothing to open");
      assert.equal(dialog.canOpen({ selectionMask: {} }, {}), true);
      assert.equal(toasts.length, 0);
      assert.equal(dialog.canOpen({ selectionMask: null }, {}), false);
      assert.equal(toasts.length, 1, "the user is told why the dialog refused");
    } finally {
      installToastPainter(null);
    }
  });

  it("CreateShapeDialog.onOK hands the confirm callback its width, height and from-centre flag", () => {
    const dialog = new CreateShapeDialog();
    captureDispatch(dialog);
    const calls = [];
    dialog.dialogPayload = {
      confirmArgs: { tool: "ellipse" },
      onConfirm: (...args) => calls.push(args),
    };
    // Constructor defaults, overridden here to prove the values are read live.
    dialog.widthInput.setValue(320);
    dialog.heightSlider.setValue(240);
    dialog.drawFromCenterCheckbox.setValue(true);

    dialog.onOK({});

    assert.deepEqual(calls, [[{ tool: "ellipse" }, 320, 240, true]]);
    assert.equal(dialog.closed, true, "OK closes the dialog");
  });

  it("CreateShapeDialog starts at a 100x100 shape drawn from its corner", () => {
    const dialog = new CreateShapeDialog();
    assert.equal(dialog.widthInput.getValue(), 100);
    assert.equal(dialog.heightSlider.getValue(), 100);
    // Reads inputEl.checked, which a browser defaults to false and the DOM
    // stub leaves unset — either way the shape is drawn from its corner.
    assert.ok(!dialog.drawFromCenterCheckbox.getValue());
  });

  it("SelectionOptionsDialog.onOK dispatches slice edits on the slice tool channel", () => {
    const dialog = new SelectionOptionsDialog();
    const dispatched = captureDispatch(dialog);

    // `v` payloads are PSD descriptor wire values; open() seeds them from the slice.
    dialog.open(null, { sliceDescriptor: { Nm: { v: "hero" }, urlLink: { v: "/a" } } }, []);
    const firstKey = Object.keys(dialog.sliceFieldLabelByKey)[0];
    dialog.sliceOptionInputs[firstKey].setValue("edited");

    dialog.onOK({});

    assert.equal(dispatched.length, 1);
    const [event] = dispatched;
    assert.equal(event.type, EventType.documentAction);
    assert.equal(event.routingChannel, ToolId.TOOL_SLICE);
    assert.equal(event.fromDialog, true);
    assert.equal(event.data[firstKey].v, "edited", "the edited field reaches the tool");
    assert.equal(dialog.closed, true);
  });

  it("MakeSelectionDialog constructs and exposes an OK path", () => {
    const dialog = new MakeSelectionDialog();
    captureDispatch(dialog);
    assert.equal(typeof dialog.onOK, "function");
  });
});
