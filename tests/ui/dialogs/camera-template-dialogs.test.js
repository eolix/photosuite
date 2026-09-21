/**
 * Camera capture and the template gallery.
 *
 * CameraDialog enumerates the machine's cameras, keeps only video inputs, and
 * fits the live preview inside the dialog without distorting it. TemplatesDialog
 * is a thin frame around a bundled gallery page.
 *
 * Constructing either boots the widget stack, so the prototype methods are
 * driven against the state they read.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TemplatesDialog;
let CameraDialog;
let Point;

before(async () => {
  ({ Point } = await import("../../../src/core/math/point.js"));
  ({ TemplatesDialog, CameraDialog } = await import(
    "../../../src/ui/dialogs/camera-template-dialogs.js"
  ));
});

/** A CameraDialog whose widgets and <video> are recording stand-ins. */
function cameraDialogSpy({ videoWidth = 1920, videoHeight = 1080 } = {}) {
  const dialog = Object.create(CameraDialog.prototype);
  let deviceIndex = 0;
  let importTarget = 0;
  dialog.reloadCalls = 0;
  dialog.videoStyle = null;
  dialog.livePreviewVideoEl = {
    videoWidth,
    videoHeight,
    setAttribute(name, value) { if (name === "style") dialog.videoStyle = value; },
  };
  dialog.liveDimensionsLabelBadge = {
    value: null,
    setValue(value) { this.value = value; },
    el: { setAttribute() {} },
  };
  dialog.liveVideoMeasuredRatio = new Point(0, 0);
  dialog.cameraDeviceDropdown = {
    items: null,
    setItems(items) { this.items = items; },
    setValue(value) { deviceIndex = value; },
    getValue: () => deviceIndex,
  };
  dialog.importTargetDropdown = { getValue: () => importTarget };
  dialog.setImportTarget = (value) => { importTarget = value; };
  dialog.reloadPreviewUsingSelectedCamera = () => { dialog.reloadCalls += 1; };
  return dialog;
}

/** Parse "width: 640px; height:360px" out of the inline style the dialog writes. */
function previewSizeFromStyle(style) {
  const [, width, height] = style.match(/width:\s*(\d+)px;\s*height:\s*(\d+)px/);
  return { width: Number(width), height: Number(height) };
}

describe("ui/dialogs/camera-template-dialogs.js", () => {
  it("keeps only video inputs and names them in order", () => {
    const dialog = cameraDialogSpy();

    dialog.onEnumerateMediaDevicesResolved([
      { kind: "audioinput", deviceId: "mic" },
      { kind: "videoinput", deviceId: "front" },
      { kind: "audiooutput", deviceId: "speaker" },
      { kind: "videoinput", deviceId: "back" },
    ]);

    assert.deepEqual(
      dialog.enumeratedVideoInputDevices.map((device) => device.deviceId),
      ["front", "back"],
      "microphones and speakers are not cameras",
    );
    assert.equal(dialog.cameraDeviceDropdown.items.length, 2);
    assert.equal(dialog.cameraDeviceDropdown.getValue(), 0, "the first camera is selected");
    assert.equal(dialog.reloadCalls, 1, "selecting a camera starts its preview");
  });

  it("copes with a machine that has no camera at all", () => {
    const dialog = cameraDialogSpy();
    dialog.onEnumerateMediaDevicesResolved([{ kind: "audioinput", deviceId: "mic" }]);
    assert.deepEqual(dialog.enumeratedVideoInputDevices, []);
    assert.deepEqual(dialog.cameraDeviceDropdown.items, []);
  });

  it("fits a wide preview to the dialog width and letterboxes the height", () => {
    // 16:9 video in a tall dialog: width is the binding constraint.
    const dialog = cameraDialogSpy({ videoWidth: 1920, videoHeight: 1080 });

    dialog.resize(628, 800);

    const { width, height } = previewSizeFromStyle(dialog.videoStyle);
    assert.equal(width, 628 - 28, "the preview spans the dialog interior");
    assert.equal(height, Math.round((628 - 28) / (1920 / 1080)));
    assert.equal(dialog.liveDimensionsLabelBadge.value, "1920 x 1080 px");
  });

  it("fits a tall preview to the dialog height instead", () => {
    // 9:16 video in a wide dialog: height is the binding constraint.
    const dialog = cameraDialogSpy({ videoWidth: 1080, videoHeight: 1920 });

    dialog.resize(1200, 428);

    const { width, height } = previewSizeFromStyle(dialog.videoStyle);
    assert.equal(height, 428 - 28 - 30);
    assert.equal(width, Math.round((428 - 28 - 30) * (1080 / 1920)));
  });

  it("routes capture to a new project or the open document by dropdown choice", () => {
    const dialog = cameraDialogSpy();
    const calls = [];
    dialog.spawnNewProjectFromCurrentFrame = () => calls.push("new");
    dialog.placeCurrentFrameIntoOpenDocument = () => calls.push("place");

    dialog.setImportTarget(0);
    dialog.captureAccordingToPlacementChoice({});
    dialog.setImportTarget(1);
    dialog.captureAccordingToPlacementChoice({});

    assert.deepEqual(calls, ["new", "place"]);
  });

  it("TemplatesDialog sizes its gallery frame to the dialog and loads the bundled page", () => {
    const dialog = Object.create(TemplatesDialog.prototype);
    const attributes = {};
    dialog.templatesIframe = {
      style: {},
      setAttribute(name, value) { attributes[name] = value; },
    };

    dialog.resize(900, 640);
    assert.equal(dialog.templatesIframe.style.width, "900px");
    assert.equal(dialog.templatesIframe.style.height, "636px");

    dialog.open();
    assert.equal(attributes.src, "plugins/templates.html");
  });
});
