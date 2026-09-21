/**
 * Template gallery iframe and camera capture dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { Layer } from "../../document/model/layer.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, Label } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";

function TemplatesDialog() {
  BaseDialog.call(this, ["PSD VAR0", "templates.title"], "templates");
  this.body.setAttribute("style", "padding:0");
  this.templatesIframe = makeElement("iframe", "scrollable");
  this.templatesIframe.setAttribute("style", "border:none; margin:0; padding:0;");
  this.body.appendChild(this.templatesIframe)
}
TemplatesDialog.prototype = Object.create(BaseDialog.prototype);
TemplatesDialog.prototype.constructor = TemplatesDialog;
TemplatesDialog.prototype.getOffset = function(dialogWidth, dialogHeight) {
  return new Point(0, 0);
};
TemplatesDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  this.templatesIframe.style.width = dialogWidth + "px";
  this.templatesIframe.style.height = (dialogHeight - 4) + "px"
};
TemplatesDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this)
};
TemplatesDialog.prototype.open = function() {
  this.templatesIframe.setAttribute("src", "plugins/templates.html")
};


function CameraDialog() {
  BaseDialog.call(this, "dialogs.takeAPicture", "camera");
  this.data = null;
  this.liveVideoMeasuredRatio = new Point(1, 1);
  this.enumeratedVideoInputDevices = [];
  const toolbarDiv = makeElement("div", "form hbar");
  this.body.appendChild(toolbarDiv);
  this.unusedChromeDropdownPlaceholder = new Dropdown(null, []);
  this.importTargetDropdown = new Dropdown("importExport.placeInto", [
    "importExport.newProject",
    "importExport.currentProject"
  ]);
  toolbarDiv.appendChild(this.importTargetDropdown.el);
  this.cameraDeviceDropdown = new Dropdown(null, []);
  this.cameraDeviceDropdown.on(EventType.widgetSelect, this.reloadPreviewUsingSelectedCamera, this);
  toolbarDiv.appendChild(this.cameraDeviceDropdown.el);
  this.capturePhotoToolbarButton = new Button("dialogs.takeAPicture", false, null, true);
  this.capturePhotoToolbarButton.on("click", this.captureAccordingToPlacementChoice, this);
  toolbarDiv.appendChild(this.capturePhotoToolbarButton.el);
  this.liveDimensionsLabelBadge = new Label("");
  toolbarDiv.appendChild(this.liveDimensionsLabelBadge.el);
  this.stream = null;
  this.livePreviewVideoEl = makeElement("video", "");
  this.livePreviewVideoEl.setAttribute("autoplay", "true");
  this.body.appendChild(this.livePreviewVideoEl);
  this.onUserMediaGrantedHandler = this.onUserMediaStreamOpened.bind(this);
  this.onUserMediaDeniedHandler = this.onCameraAccessFailed.bind(this);
  this.afterVideoMetadataHandler = this.onLiveVideoSized.bind(this);
  this.on("closebtn", this.stopLiveCameraTracks, this)
}
CameraDialog.prototype = Object.create(BaseDialog.prototype);
CameraDialog.prototype.constructor = CameraDialog;
CameraDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.importTargetDropdown.buildUI();
  this.capturePhotoToolbarButton.buildUI();
  this.resize(this.cachedDialogInteriorWidthPx, this.cachedDialogInteriorHeightPx)
};
CameraDialog.prototype.getRasterData = function() {
  const frameWidth = this.livePreviewVideoEl.videoWidth,
    frameHeight = this.livePreviewVideoEl.videoHeight,
    snapshotCanvas = makeElement("canvas", "");
  snapshotCanvas.width = frameWidth;
  snapshotCanvas.height = frameHeight;
  const snapshotCtx = snapshotCanvas.getContext("2d");
  snapshotCtx.drawImage(this.livePreviewVideoEl, 0, 0, frameWidth, frameHeight);
  const imageData = snapshotCtx.getImageData(0, 0, frameWidth, frameHeight);
  return {
    rect: new Rect(0, 0, frameWidth, frameHeight),
    data: imageData.data.buffer
  };
};
CameraDialog.prototype.captureAccordingToPlacementChoice = function(clickEvent) {
  if (this.importTargetDropdown.getValue() == 0) this.spawnNewProjectFromCurrentFrame();
  else this.placeCurrentFrameIntoOpenDocument()
};
CameraDialog.prototype.placeCurrentFrameIntoOpenDocument = function() {
  const rasterData = this.getRasterData(),
    layerPayload = {
      buffer: new Uint8Array(rasterData.data),
      rect: rasterData.rect
    },
    dispatchEvent = new AppEvent(EventType.documentAction, true);
  dispatchEvent.fromDialog = true;
  dispatchEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  dispatchEvent.data = {
    actionKind: Layer.newLayerFromClipboard,
    clipboardPixelPayload: layerPayload
  };
  this.dispatch(dispatchEvent);
  showToast(Locale.get("importExport.addedIntoTheCurrentProject"))
};
CameraDialog.prototype.spawnNewProjectFromCurrentFrame = function() {
  const rasterData = this.getRasterData(),
    openedDoc = FileFormatRegistry.openFiles("camera.psd", [rasterData]),
    dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.focusDocumentTab,
    openedDocument: openedDoc
  };
  this.dispatch(dispatchEvent);
  showToast(Locale.get("importExport.aNewProjectWasCreated"))
};
CameraDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {
  navigator.mediaDevices.enumerateDevices().then(this.onEnumerateMediaDevicesResolved.bind(this))
};
CameraDialog.prototype.onEnumerateMediaDevicesResolved = function(mediaDevicesList) {
  const videoInputs = this.enumeratedVideoInputDevices = [],
    deviceLabels = [];
  for (let deviceIdx = 0; deviceIdx < mediaDevicesList.length; deviceIdx++)
    if (mediaDevicesList[deviceIdx].kind == "videoinput") {
      videoInputs.push(mediaDevicesList[deviceIdx]);
      deviceLabels.push(Locale.get(["properties.cameraN", String(videoInputs.length)]))
    } this.cameraDeviceDropdown.setItems(deviceLabels);
  this.cameraDeviceDropdown.setValue(0);
  this.reloadPreviewUsingSelectedCamera()
};
CameraDialog.prototype.reloadPreviewUsingSelectedCamera = function(widgetEvent) {
  this.stopLiveCameraTracks();
  const mediaConstraints = {
    video: {
      deviceId: this.enumeratedVideoInputDevices[this.cameraDeviceDropdown.getValue()].deviceId,
      width: {
        ideal: 8e3
      },
      height: {
        ideal: 8e3
      }
    }
  };
  navigator.mediaDevices.getUserMedia(mediaConstraints).then(this.onUserMediaGrantedHandler).catch(this.onUserMediaDeniedHandler)
};
CameraDialog.prototype.onUserMediaStreamOpened = function(mediaStream) {
  this.stream = mediaStream;
  this.livePreviewVideoEl.srcObject = mediaStream;
  this.livePreviewVideoEl.addEventListener("loadedmetadata", this.afterVideoMetadataHandler, false)
};
CameraDialog.prototype.onLiveVideoSized = function(metadataEvent) {
  this.livePreviewVideoEl.play();
  this.resize(this.cachedDialogInteriorWidthPx, this.cachedDialogInteriorHeightPx)
};
CameraDialog.prototype.getOffset = function(dialogWidth, dialogHeight) {
  return new Point(0, 0);
};
CameraDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  const videoWidth = this.livePreviewVideoEl.videoWidth,
    videoHeight = this.livePreviewVideoEl.videoHeight;
  this.liveDimensionsLabelBadge.setValue(videoWidth + " x " + videoHeight + " px");
  this.liveDimensionsLabelBadge.el.setAttribute("style", "position:absolute;  left:14px; bottom:10px; z-index:1;");
  this.liveVideoMeasuredRatio.setXY(videoWidth, videoHeight);
  this.cachedDialogInteriorWidthPx = dialogWidth;
  this.cachedDialogInteriorHeightPx = dialogHeight;
  const aspectRatio = this.liveVideoMeasuredRatio.x / this.liveVideoMeasuredRatio.y;
  let previewWidth = dialogWidth - 28,
    previewHeight = dialogHeight - 28 - 30;
  if (previewWidth / previewHeight > aspectRatio) previewWidth = previewHeight * aspectRatio;
  else previewHeight = previewWidth / aspectRatio;
  this.livePreviewVideoEl.setAttribute("style", "display: block; width: " + Math.round(previewWidth) + "px; height:" + Math.round(previewHeight) + "px;")
};
CameraDialog.prototype.onCameraAccessFailed = function(accessError) {
  showToast(Locale.get("importExport.accessToTheCameraWasDenied"));
  this.close()
};
CameraDialog.prototype.stopLiveCameraTracks = function(closeEvent) {
  if (this.stream != null) {
    const mediaTracks = this.stream.getTracks();
    for (let trackIdx = 0; trackIdx < mediaTracks.length; trackIdx++) mediaTracks[trackIdx].stop();
    this.stream = null
  }
};

export { TemplatesDialog, CameraDialog };
