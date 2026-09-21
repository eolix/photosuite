/**
 * The bitmap-to-vector trace dialog. It shows the source raster and the traced
 * preview side by side, so every resize splits the interior width between the
 * two panes and gives both the same box; the dialog also claims the canvas
 * while it is open so the document view stops handling pointer input.
 *
 * Constructing it boots the widget stack, so the prototype methods are driven
 * against the state they read.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { getDevicePixelRatio } from "../../../src/core/dom.js";

installBrowserGlobals();

let VectorizeBitmapDialog;

before(async () => {
  ({ VectorizeBitmapDialog } = await import(
    "../../../src/ui/dialogs/vectorize-bitmap-dialog.js"
  ));
});

/** Padding and border the dialog measures its preview budget against. */
const BODY_PADDING_PX = 13;
const WINDOW_BORDER_PX = 1;
const TOOLBAR_HEIGHT_PX = 34;
const PREVIEW_ROW_GAP_PX = 12;

/** A dialog whose preview canvas and raster pane record how they are sized. */
function vectorizeDialogSpy() {
  const dialog = Object.create(VectorizeBitmapDialog.prototype);
  dialog.vectorPreviewCanvas = { style: {} };
  dialog.rasterSized = null;
  dialog.rasterPanZoomPanel = {
    resize: (width, height) => { dialog.rasterSized = { width, height }; },
    onKeyEvent: (keyboard) => { dialog.lastKeyboard = keyboard; },
  };
  const px = `${BODY_PADDING_PX}px`;
  const border = `${WINDOW_BORDER_PX}px`;
  dialog.body = {
    computedStyle: { paddingTop: px, paddingBottom: px, paddingLeft: px, paddingRight: px },
  };
  dialog.el = {
    computedStyle: {
      borderTopWidth: border, borderBottomWidth: border,
      borderLeftWidth: border, borderRightWidth: border,
    },
  };
  dialog.formDiv = { offsetHeight: TOOLBAR_HEIGHT_PX };
  return dialog;
}

describe("ui/dialogs/vectorize-bitmap-dialog.js", () => {
  it("splits the interior width between the raster and vector previews", () => {
    const dialog = vectorizeDialogSpy();

    dialog.resize(1028, 700);

    // Each pane takes half of what the body's padding, the window border and
    // the gap between the panes leave; the height also loses the toolbar.
    const chromeH = BODY_PADDING_PX * 2 + WINDOW_BORDER_PX * 2;
    const chromeV = chromeH;
    const expectedWidth = Math.floor((1028 - chromeH - PREVIEW_ROW_GAP_PX) / 2);
    const expectedHeight = 700 - chromeV - TOOLBAR_HEIGHT_PX - PREVIEW_ROW_GAP_PX;
    assert.deepEqual(dialog.rasterSized, { width: expectedWidth, height: expectedHeight });

    // The vector pane is sized to match, in device pixels.
    const scale = getDevicePixelRatio();
    assert.equal(dialog.vectorPreviewCanvas.width, Math.floor(expectedWidth * scale));
    assert.equal(dialog.vectorPreviewCanvas.height, Math.floor(expectedHeight * scale));
    assert.equal(dialog.vectorPreviewCanvas.style.width, `${expectedWidth}px`);
  });

  it("opens flush against the document view and holds pointer input", () => {
    const dialog = vectorizeDialogSpy();
    const offset = dialog.getOffset();
    assert.equal(offset.x, 0);
    assert.equal(offset.y, 0);
    assert.equal(dialog.isActive(), true, "the document view must not also handle input");
  });

  it("forwards key events to the raster pane so it can be panned and zoomed", () => {
    const dialog = vectorizeDialogSpy();
    const keyboard = { key: "ArrowLeft" };

    dialog.onKeyEvent({}, {}, {}, keyboard);

    assert.equal(dialog.lastKeyboard, keyboard);
  });
});
