/**
 * Camera Raw: the window a camera file opens into.
 *
 * The decoder turns the sensor data into camera-native linear RGB once; from
 * there the same develop panels the Camera Raw filter uses drive the image. The
 * dialog owns everything the panels cannot: decoding, the as-shot and auto
 * white balance the camera's own matrix implies, the reduced-size plate the
 * preview develops against, and turning the committed settings into a document
 * or a JPEG at full resolution.
 */

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { XMPData } from "../../document/formats/metadata/xmp-metadata.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import {
  CAMERA_RAW_APP_ID,
  WHITE_BALANCE_AS_SHOT,
} from "../../features/filters/camera-raw-descriptor.js";
import { CAMERA_RAW_CONTROLS_WIDTH_PX } from "../filter-panels/camera-raw-panel.js";
import { FilterParameterPanel } from "../filter-panels/filter-parameter-panel.js";
import { Button, Label } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { allocBuffer, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { decodeRawImage, developRaw, solveIlluminantForNeutral } from "../../engine/compositing/raw-functions.js";
import { planckianLocusFromChromaticity } from "../../engine/compositing/color-temperature.js";

/** Dialog route id the file loader opens camera files with. */
const CAMERA_RAW_DIALOG_ID = "rawdevelop";

/** Opaque white, the fill developRaw's output starts from — it writes no alpha. */
const OPAQUE_WHITE_RGBA = 4294967295;

/** Preview budget before the window has been sized. */
const DEFAULT_PREVIEW_WIDTH_PX = 900;
const DEFAULT_PREVIEW_HEIGHT_PX = 620;

/**
 * Smallest whole-number downsample that fits the full image inside the preview
 * budget. Whole numbers keep the box filter below an exact pixel count.
 */
function chooseDownsampleFactor(fullWidth, fullHeight, budgetWidth, budgetHeight) {
  const pixelRatio = getDevicePixelRatio();
  const maxWidth = Math.max(1, budgetWidth * pixelRatio);
  const maxHeight = Math.max(1, budgetHeight * pixelRatio);
  let factor = 1;
  while (fullWidth / factor > maxWidth || fullHeight / factor > maxHeight) factor++;
  return factor;
}

/**
 * Box-filter camera-native linear RGB down by a whole-number factor.
 * @returns {{ linearRgbBuffer: Float32Array, rawWidth: number, rawHeight: number }}
 */
function downsampleLinearRgb(sourceLinear, fullWidth, fullHeight, factor) {
  const width = Math.floor(fullWidth / factor);
  const height = Math.floor(fullHeight / factor);
  const linearRgbBuffer = new Float32Array(width * height * 3);
  const weight = 1 / (factor * factor);
  for (let outRow = 0; outRow < height; outRow++) {
    const srcRowEnd = (outRow + 1) * factor;
    for (let outCol = 0; outCol < width; outCol++) {
      const srcColEnd = (outCol + 1) * factor;
      let sumRed = 0;
      let sumGreen = 0;
      let sumBlue = 0;
      for (let srcRow = outRow * factor; srcRow < srcRowEnd; srcRow++) {
        for (let srcCol = outCol * factor; srcCol < srcColEnd; srcCol++) {
          const offset = (srcRow * fullWidth + srcCol) * 3;
          sumRed += sourceLinear[offset];
          sumGreen += sourceLinear[offset + 1];
          sumBlue += sourceLinear[offset + 2];
        }
      }
      const outOffset = (outRow * width + outCol) * 3;
      linearRgbBuffer[outOffset] = sumRed * weight;
      linearRgbBuffer[outOffset + 1] = sumGreen * weight;
      linearRgbBuffer[outOffset + 2] = sumBlue * weight;
    }
  }
  return { linearRgbBuffer, rawWidth: width, rawHeight: height };
}

/** Mean camera-native linear RGB, the neutral Auto white balance solves for. */
function averageLinearRgb(linearRgbBuffer) {
  let sumRed = 0;
  let sumGreen = 0;
  let sumBlue = 0;
  const pixelCount = Math.round(linearRgbBuffer.length / 3);
  for (let offset = 0; offset < linearRgbBuffer.length; offset += 3) {
    sumRed += linearRgbBuffer[offset];
    sumGreen += linearRgbBuffer[offset + 1];
    sumBlue += linearRgbBuffer[offset + 2];
  }
  return [sumRed / pixelCount, sumGreen / pixelCount, sumBlue / pixelCount];
}

/** Temperature / Tint that render a camera-native colour neutral. */
function whiteBalanceForNeutral(cameraMetadata, cameraRgb) {
  const illuminant = solveIlluminantForNeutral(cameraMetadata, cameraRgb);
  const locus = planckianLocusFromChromaticity(illuminant);
  return [Math.round(locus.correlatedColorTemp), Math.round(locus.tintBias)];
}

function CameraRawDialog() {
  BaseDialog.call(this, "dialogs.cameraRaw", CAMERA_RAW_DIALOG_ID);
  this.cameraMetadata = null;
  this.decodedRaw = null;
  this.previewDownsampleFactor = 0;
  this.previewBudgetWidth = DEFAULT_PREVIEW_WIDTH_PX;
  this.previewBudgetHeight = DEFAULT_PREVIEW_HEIGHT_PX;
  this.documentName = "Raw Photo.psd";
  this.nativeFilePath = null;
  this.localFileHandle = null;
  this.sourceUrl = null;

  this.developPanel = new FilterParameterPanel.cameraRaw();
  this.developPanel.parent = this;
  if (this.developPanel.dialogClassName) addClass(this.el, this.developPanel.dialogClassName);
  this.body.appendChild(this.developPanel.el);
  this.body.style.padding = "0";

  this.imageSizeLabel = new Label("", true);
  addClass(this.imageSizeLabel.el, "camera-raw-image-size");

  this.openButton = new Button("file.open", true, null, true);
  this.openButton.on("click", this.onOK, this);
  const confirmRowEl = makeElement("div", "camera-raw-open-actions");
  confirmRowEl.appendChild(this.imageSizeLabel.el);
  confirmRowEl.appendChild(this.openButton.el);
  this.developPanel.appendCategoryHeader(confirmRowEl);

  this.on("closebtn", this.releaseDecodedRaw, this);
  this.enableUserResize({ minWidth: 640, minHeight: 420 });
}

CameraRawDialog.prototype = Object.create(BaseDialog.prototype);
CameraRawDialog.prototype.constructor = CameraRawDialog;

CameraRawDialog.prototype.getOffset = function() {
  if (this.isUserResizable && this.isUserResizable()) return null;
  return new Point(0, 0);
};

CameraRawDialog.prototype.getPreferredContentSize = function(maxW, maxH) {
  return this.developPanel.getPreferredDialogSize(maxW, maxH);
};

CameraRawDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.developPanel.buildUI();
  this.openButton.buildUI();
};

CameraRawDialog.prototype.onUpdate = function(appData) {
  this.developPanel.onDocumentUpdate(appData);
};

CameraRawDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  this.previewBudgetWidth = Math.max(240, dialogWidth - CAMERA_RAW_CONTROLS_WIDTH_PX);
  this.previewBudgetHeight = Math.max(160, dialogHeight);
  this.developPanel.resize(dialogWidth, dialogHeight);
  // Re-decimate only when the window has crossed into a different reduction,
  // so dragging the frame does not re-filter the whole sensor image per frame.
  if (this.decodedRaw != null) this.rebuildPreviewPlateIfFactorChanged();
};

CameraRawDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.cameraMetadata = dialogPayload.rawImageDescriptor;
  this.documentName = dialogPayload.documentName || "Raw Photo.psd";
  this.nativeFilePath = dialogPayload.nativeFilePath || null;
  this.localFileHandle = dialogPayload.localFileHandle || null;
  this.sourceUrl = dialogPayload.sourceUrl || null;
  this.decodedRaw = decodeRawImage(this.cameraMetadata);
  const megapixels = this.decodedRaw.rawWidth * this.decodedRaw.rawHeight / 1e6;
  this.imageSizeLabel.setValue(
    this.decodedRaw.rawWidth + " x " + this.decodedRaw.rawHeight + ", " + megapixels.toFixed(1) + " MPx",
  );
  this.previewDownsampleFactor = 0;
  this.rebuildPreviewPlateIfFactorChanged();
};

/**
 * Build the reduced plate the panel previews against, sized to the current
 * window. The as-shot and auto white balances are solved here because both come
 * from the camera's colour matrix, which only the decoder side knows about.
 */
CameraRawDialog.prototype.rebuildPreviewPlateIfFactorChanged = function() {
  const fullWidth = this.decodedRaw.rawWidth;
  const fullHeight = this.decodedRaw.rawHeight;
  const factor = chooseDownsampleFactor(
    fullWidth, fullHeight, this.previewBudgetWidth, this.previewBudgetHeight,
  );
  if (factor === this.previewDownsampleFactor) return;
  this.previewDownsampleFactor = factor;

  const previewLinear = downsampleLinearRgb(
    this.decodedRaw.linearRgbBuffer, fullWidth, fullHeight, factor,
  );
  const asShot = whiteBalanceForNeutral(
    this.cameraMetadata, this.cameraMetadata.t50728 || [1, 1, 1],
  );
  const auto = whiteBalanceForNeutral(
    this.cameraMetadata, averageLinearRgb(previewLinear.linearRgbBuffer),
  );
  const plate = allocBuffer(previewLinear.rawWidth * previewLinear.rawHeight * 4);
  const plateRect = new Rect(0, 0, previewLinear.rawWidth, previewLinear.rawHeight);

  const keepSettings = this.developPanel.isRawMode() ? this.developPanel.getValue() : null;
  this.developPanel.setRawSource({
    previewLinear: previewLinear,
    cameraMetadata: this.cameraMetadata,
    asShot: asShot,
    auto: auto,
  });
  if (keepSettings) {
    this.developPanel.setValue(keepSettings, plate, plateRect, plateRect);
  } else {
    const initial = FilterDefs.create(CAMERA_RAW_APP_ID);
    this.developPanel.setValue(initial, plate, plateRect, plateRect);
    this.developPanel.setTemperatureAndTint(asShot[0], asShot[1]);
    this.developPanel.setWhiteBalanceEnum(WHITE_BALANCE_AS_SHOT);
    this.developPanel.refresh();
  }
};

/**
 * Develop the sensor data at full resolution with the panel's settings.
 * @returns {{ buffer: Uint8Array, rect: Rect }}
 */
CameraRawDialog.prototype.developFullResolution = function() {
  const width = this.decodedRaw.rawWidth;
  const height = this.decodedRaw.rawHeight;
  const rect = new Rect(0, 0, width, height);
  const buffer = allocBuffer(width * height * 4);
  fillBuffer(buffer, OPAQUE_WHITE_RGBA);
  const settings = this.developPanel.getValue();
  developRaw(
    this.decodedRaw,
    buffer,
    this.cameraMetadata,
    this.developPanel.readRawDecoderSettings(),
  );
  // The develop stack reads its float copy before writing back, so the plate
  // can be its own destination — at full sensor resolution the second buffer
  // this would otherwise need is worth avoiding.
  const pixels = { buffer: buffer, rect: rect };
  FilterDefs.applyFilterToPixels(CAMERA_RAW_APP_ID, pixels, settings, null, null, pixels);
  return pixels;
};

CameraRawDialog.prototype.onOK = function() {
  let developed;
  try {
    developed = this.developFullResolution();
  } catch (developError) {
    // A full-size develop is the largest allocation the app makes; say so
    // rather than leaving the button looking dead.
    showToast("Camera Raw could not develop this image: " + developError, 7000);
    return;
  }
  const openedDocument = FileFormatRegistry.openFiles(this.documentName, [{
    rect: developed.rect,
    data: developed.buffer.buffer,
    xmpMetadata: XMPData.readExifMetadata(this.cameraMetadata),
  }]);
  // Carry the on-disk origin through so recent-files / Save As can see it.
  openedDocument.nativeFilePath = this.nativeFilePath;
  openedDocument.localFileHandle = this.localFileHandle;
  if (this.sourceUrl) openedDocument.sourceUrl = this.sourceUrl;
  const focusEvent = new AppEvent(EventType.uiDispatch, true);
  focusEvent.fromDialog = true;
  focusEvent.data = {
    dispatchKind: UiCommand.focusDocumentTab,
    openedDocument: openedDocument,
  };
  this.dispatch(focusEvent);
  this.releaseDecodedRaw();
  this.close();
};

/** Sensor-sized buffers are large; drop them as soon as the window is done. */
CameraRawDialog.prototype.releaseDecodedRaw = function() {
  this.cameraMetadata = null;
  this.decodedRaw = null;
  this.previewDownsampleFactor = 0;
  this.developPanel.releaseRawSource();
};

export { CameraRawDialog, CAMERA_RAW_DIALOG_ID };
