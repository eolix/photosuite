/**
 * Color picker modal: hue/saturation wheel plus RGB and HSB channel inputs.
 */

import { Locale } from "../../core/i18n/locale.js";

import { PopupTypes } from "../config/popup-types.js";
import { ColorWheel } from "../widgets/controls/color-controls.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { Button, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { EyedropperTool } from "../../document/tools/view-tools.js";
import { cmykToRgb, hexToRgb, hsvToRgb, labToRgb, rgbToCmyk, rgbToHex, rgbToHsv, rgbToLab } from "../../engine/compositing/color-math.js";

/**
 * One channel column of the picker. Each spec is
 * `[label, min, max, suffix]`; the fields report edits through `onAdjusted`.
 */
/** A block for one set of channels, so groups can be spaced apart. */
function appendChannelGroup(parentCol) {
  const groupEl = makeElement("div", "colorpicker-group");
  parentCol.appendChild(groupEl);
  return groupEl;
}

function installChannelFields(dialog, parentCol, channelSpecs, onAdjusted) {
  const fields = [];
  for (let channelIdx = 0; channelIdx < channelSpecs.length; channelIdx++) {
    const spec = channelSpecs[channelIdx];
    const field = new SliderDropdown(spec[0] + ":", spec[1], spec[2], null, 0, false, true);
    fields.push(field);
    field.on(EventType.widgetSelect, onAdjusted, dialog);
    // The unit sits beside the box rather than inside it, so every value field
    // is the same width whether or not its channel is measured in something.
    const unitEl = makeElement("span", "unitsuffix");
    unitEl.textContent = spec[3] == null ? "" : spec[3];
    field.el.appendChild(unitEl);
    parentCol.appendChild(field.el);
  }
  return fields;
}

/** Edge of the saturation/brightness field, which sets the dialog's height. */
const COLOR_FIELD_EDGE_PX = 340;

/** Hue in degrees, the rest in percent. */
const HSB_CHANNEL_SPECS = [["H", 0, 360, "\xB0"], ["S", 0, 100, "%"], ["B", 0, 100, "%"]];
const RGB_CHANNEL_SPECS = [["R", 0, 255, null], ["G", 0, 255, null], ["B", 0, 255, null]];
/** CIELAB: lightness 0..100, the two opponent axes signed around neutral. */
const LAB_CHANNEL_SPECS = [["L", 0, 100, null], ["a", -128, 127, null], ["b", -128, 127, null]];
const CMYK_CHANNEL_SPECS = [
  ["C", 0, 100, "%"],
  ["M", 0, 100, "%"],
  ["Y", 0, 100, "%"],
  ["K", 0, 100, "%"],
];

function normalizedRgbFromPackedInt(packedColor) {
  return {
    h: (packedColor >> 16 & 255) / 255,
    l: (packedColor >> 8 & 255) / 255,
    O: (packedColor & 255) / 255,
  };
}

function ColorPickerDialog() {
  BaseDialog.call(this, "dialogs.colourPicker", "colorpicker");
  this.snapshotOpenedPayload = null;
  this.storedValue = null;
  this.finalizeDialogResultCallback = null;
  this.hasPostedEphemeralPreview = false;
  this.allowContinuousMirrorUpdates = false;
  const layoutRow = makeElement("div", "flexrow colorpicker-layout");
  this.body.appendChild(layoutRow);
  this.hsColorWheel = new ColorWheel(COLOR_FIELD_EDGE_PX);
  this.hsColorWheel.on(EventType.widgetSelect, this.onHueSatWheelChanged, this);
  layoutRow.appendChild(this.hsColorWheel.el);

  const fieldsCol = makeElement("div", "form colorpicker-fields");
  layoutRow.appendChild(fieldsCol);

  // Across the top of the panel: the colour being chosen against the one it
  // replaces, and the actions that accept or abandon the choice.
  const headerRow = makeElement("div", "flexrow colorpicker-header");
  fieldsCol.appendChild(headerRow);

  // The colour being chosen sits directly above the one it would replace, each
  // named, so the swap is legible at a glance.
  const compareEl = makeElement("div", "colorpicker-compare");
  headerRow.appendChild(compareEl);
  const newLabelEl = makeElement("div", "colorpicker-comparelabel");
  newLabelEl.textContent = Locale.get("colour.newColour");
  compareEl.appendChild(newLabelEl);
  const swatchPairEl = makeElement("div", "colorpicker-swatches");
  compareEl.appendChild(swatchPairEl);
  this.editedColorPreviewStripe = makeElement("div", "colorpicker-swatch");
  swatchPairEl.appendChild(this.editedColorPreviewStripe);
  this.originalColorCompareStripe = makeElement("div", "colorpicker-swatch");
  swatchPairEl.appendChild(this.originalColorCompareStripe);
  const currentLabelEl = makeElement("div", "colorpicker-comparelabel");
  currentLabelEl.textContent = Locale.get("colour.currentColour");
  compareEl.appendChild(currentLabelEl);

  // Two columns of channels: the ones that describe the colour on the left,
  // the ones that describe how it is reproduced on the right.
  const channelsRow = makeElement("div", "flexrow colorpicker-channels");
  fieldsCol.appendChild(channelsRow);
  const leftChannelCol = makeElement("div");
  const rightChannelCol = makeElement("div");
  channelsRow.appendChild(leftChannelCol);
  channelsRow.appendChild(rightChannelCol);
  // Each set of channels is its own block, so a gap separates the ways of
  // naming the colour from the ways of reproducing it.
  this.hsbSlidersRow = installChannelFields(this, appendChannelGroup(leftChannelCol), HSB_CHANNEL_SPECS, this.onHsbSlidersAdjusted);
  this.rgbSlidersRow = installChannelFields(this, appendChannelGroup(leftChannelCol), RGB_CHANNEL_SPECS, this.onRgbSlidersAdjusted);
  this.labFieldsRow = installChannelFields(this, appendChannelGroup(rightChannelCol), LAB_CHANNEL_SPECS, this.onLabFieldsAdjusted);
  this.cmykFieldsRow = installChannelFields(this, appendChannelGroup(rightChannelCol), CMYK_CHANNEL_SPECS, this.onCmykFieldsAdjusted);
  // The hex value closes the first column, level with the last ink opposite it.
  this.hexRgbTextInput = new TextInput("properties.hex", null, 6);
  this.hexRgbTextInput.on(EventType.widgetSelect, this.onHexHtmlOrPresetChanged, this);
  const hexGroupEl = appendChannelGroup(leftChannelCol);
  addClass(hexGroupEl, "colorpicker-hex");
  hexGroupEl.appendChild(this.hexRgbTextInput.el);

  // The host's own picker, opened from the Colour Libraries button rather than
  // shown as a second swatch of its own.
  this.nativeColorPickerInput = makeElement("input", "colorpicker-native");
  this.nativeColorPickerInput.setAttribute("type", "color");
  this.nativeColorPickerInput.addEventListener("change", this.onHexHtmlOrPresetChanged.bind(this), false);
  fieldsCol.appendChild(this.nativeColorPickerInput);

  const actionsCol = makeElement("div", "dialog-actions colorpicker-actions");
  headerRow.appendChild(actionsCol);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  actionsCol.appendChild(this.okBtn.el);
  this.cancelBtn = new Button("clipboard.cancel", false, null, true);
  this.cancelBtn.on("click", this.onCancelClicked, this);
  actionsCol.appendChild(this.cancelBtn.el);
  this.colorLibrariesBtn = new Button("colour.libraries", false, null, true);
  this.colorLibrariesBtn.on("click", this.onColorLibrariesClicked, this);
  actionsCol.appendChild(this.colorLibrariesBtn.el);

  this.on("closebtn", this.onCancel, this);
  this.isEyedropperSampling = false;
}
ColorPickerDialog.prototype = Object.create(BaseDialog.prototype);
ColorPickerDialog.prototype.constructor = ColorPickerDialog;
ColorPickerDialog.prototype.hasOverlay = function() {
  return true
};
ColorPickerDialog.prototype.getPreferredContentSize = function(maxW, maxH) {
  const measured = this.measureBodyContentSize(maxW, maxH);
  if (measured != null) return measured;
  return {
    width: Math.min(520, maxW),
    height: Math.min(420, maxH)
  }
};
/**
 * The colour field keeps the size it was built at. Sizing it from the window
 * would be circular — the window is measured from its content — and the canvas
 * would land on a different size depending on when the measurement ran.
 */
ColorPickerDialog.prototype.resize = function(dialogWidth, dialogHeight) {};
ColorPickerDialog.prototype.onHueSatWheelChanged = function(widgetEvent) {
  this.storedValue = this.hsColorWheel.getValue();
  this.update()
};
ColorPickerDialog.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.isEyedropperSampling = true;
  this.absorbCanvasEyedropperSample(doc, pointerState)
};
ColorPickerDialog.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (!this.isEyedropperSampling) return;
  this.absorbCanvasEyedropperSample(doc, pointerState)
};
ColorPickerDialog.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.isEyedropperSampling = false
};
ColorPickerDialog.prototype.absorbCanvasEyedropperSample = function(doc, pointerState) {
  const packedColor = EyedropperTool.sampleCompositeColor(doc, pointerState, 1);
  this.storedValue = normalizedRgbFromPackedInt(packedColor);
  this.update()
};
ColorPickerDialog.prototype.onRgbSlidersAdjusted = function(widgetEvent) {
  const rgbSliders = this.rgbSlidersRow,
    redByte = this.clampRgbByte(parseInt(rgbSliders[0].getValue())),
    greenByte = this.clampRgbByte(parseInt(rgbSliders[1].getValue())),
    blueByte = this.clampRgbByte(parseInt(rgbSliders[2].getValue()));
  this.storedValue = {
    h: redByte / 255,
    l: greenByte / 255,
    O: blueByte / 255
  };
  this.update()
};
ColorPickerDialog.prototype.onHsbSlidersAdjusted = function(widgetEvent) {
  const hsbSliders = this.hsbSlidersRow,
    hue = this.clampUnitFloat(parseInt(hsbSliders[0].getValue()) / 360),
    saturation = this.clampUnitFloat(parseInt(hsbSliders[1].getValue()) / 100),
    brightness = this.clampUnitFloat(parseInt(hsbSliders[2].getValue()) / 100);
  this.storedValue = hsvToRgb(hue, saturation, brightness);
  this.update()
};
ColorPickerDialog.prototype.onLabFieldsAdjusted = function(widgetEvent) {
  const labFields = this.labFieldsRow;
  const rgb = labToRgb(
    parseFloat(labFields[0].getValue()),
    parseFloat(labFields[1].getValue()),
    parseFloat(labFields[2].getValue()),
  );
  this.storedValue = { h: rgb.h / 255, l: rgb.l / 255, O: rgb.O / 255 };
  this.update()
};
ColorPickerDialog.prototype.onCmykFieldsAdjusted = function(widgetEvent) {
  const cmykFields = this.cmykFieldsRow;
  const rgb = cmykToRgb(
    this.clampUnitFloat(parseFloat(cmykFields[0].getValue()) / 100),
    this.clampUnitFloat(parseFloat(cmykFields[1].getValue()) / 100),
    this.clampUnitFloat(parseFloat(cmykFields[2].getValue()) / 100),
    this.clampUnitFloat(parseFloat(cmykFields[3].getValue()) / 100),
  );
  this.storedValue = { h: rgb.h / 255, l: rgb.l / 255, O: rgb.O / 255 };
  this.update()
};
/** Hand over to the host's own picker. */
ColorPickerDialog.prototype.onColorLibrariesClicked = function(clickEvent) {
  this.nativeColorPickerInput.click()
};
ColorPickerDialog.prototype.onCancelClicked = function(clickEvent) {
  this.onCancel(clickEvent);
  this.close()
};
ColorPickerDialog.prototype.onHexHtmlOrPresetChanged = function(widgetEvent) {
  let packedRgb = widgetEvent.currentTarget == this.hexRgbTextInput
    ? this.hexRgbTextInput.getValue()
    : this.nativeColorPickerInput.value;
  if (packedRgb.charAt(0) == "#") packedRgb = packedRgb.slice(1);
  if (packedRgb.length == 3) packedRgb = packedRgb[0] + packedRgb[0] + packedRgb[1] + packedRgb[1] + packedRgb[2] + packedRgb[2];
  packedRgb = hexToRgb(packedRgb);
  this.storedValue = {
    h: (packedRgb >> 16 & 255) / 255,
    l: (packedRgb >> 8 & 255) / 255,
    O: (packedRgb & 255) / 255
  };
  this.update()
};
ColorPickerDialog.prototype.packRgbIntFromNormalizedChannels = function(normalizedRgb) {
  const redChannel = normalizedRgb.h,
    greenChannel = normalizedRgb.l,
    blueChannel = normalizedRgb.O;
  return Math.round(redChannel * 255) << 16 | Math.round(greenChannel * 255) << 8 | Math.round(blueChannel * 255)
};
ColorPickerDialog.prototype.onOK = function(clickEvent) {
  this.dismissSplashCursorOverlay();
  const packedRgb = this.packRgbIntFromNormalizedChannels(this.storedValue);
  this.finalizeDialogResultCallback(packedRgb);
  this.close();
  this.allowContinuousMirrorUpdates = false;
  this.storedValue = null
};
ColorPickerDialog.prototype.onCancel = function(clickEvent) {
  this.dismissSplashCursorOverlay();
  if (this.hasPostedEphemeralPreview) this.finalizeDialogResultCallback(this.packRgbIntFromNormalizedChannels(this.snapshotOpenedPayload));
  this.allowContinuousMirrorUpdates = false;
  this.storedValue = null
};
ColorPickerDialog.prototype.dismissSplashCursorOverlay = function(clickEvent) {
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.splashIntroDismiss
  };
  this.dispatch(dispatchEvent)
};
ColorPickerDialog.prototype.onUpdate = function(appData, popupType) {
  if (popupType != PopupTypes.COLOR_CHANGE) return;
  const colorInt = appData.colorInt;
  if (this.storedValue != null) {
    this.storedValue = {
      h: (colorInt >> 16 & 255) / 255,
      l: (colorInt >> 8 & 255) / 255,
      O: (colorInt >> 0 & 255) / 255
    };
    this.update()
  }
};
ColorPickerDialog.prototype.open = function(currentDoc, dialogPayload) {
  const initialColorInt = dialogPayload.colorIntArgb,
    normalizedRgb = {
      h: (initialColorInt >> 16 & 255) / 255,
      l: (initialColorInt >> 8 & 255) / 255,
      O: (initialColorInt >> 0 & 255) / 255
    };
  if (this.storedValue == null) {
    const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
    dispatchEvent.data = {
      dispatchKind: UiCommand.splashOptionsUpdate,
      cursorOverlayId: "crosshair",
      push: true
    };
    this.dispatch(dispatchEvent);
    this.isEyedropperSampling = false;
    this.finalizeDialogResultCallback = dialogPayload.onDialogResult;
    this.hasPostedEphemeralPreview = false;
    this.allowContinuousMirrorUpdates = dialogPayload.allowContinuousMirrorUpdates;
    this.snapshotOpenedPayload = JSON.parse(JSON.stringify(normalizedRgb));
    this.originalColorCompareStripe.setAttribute("style", "background-color:#" + rgbToHex(initialColorInt) + ";")
  }
  this.storedValue = normalizedRgb;
  this.update()
};
ColorPickerDialog.prototype.update = function() {
  const normalizedRgb = this.storedValue,
    packedRgb = this.packRgbIntFromNormalizedChannels(normalizedRgb);
  let rgbSliders = this.rgbSlidersRow;
  rgbSliders[0].setValue(Math.round(normalizedRgb.h * 255));
  rgbSliders[1].setValue(Math.round(normalizedRgb.l * 255));
  rgbSliders[2].setValue(Math.round(normalizedRgb.O * 255));
  this.hexRgbTextInput.setValue(rgbToHex(packedRgb));
  this.nativeColorPickerInput.value = "#" + rgbToHex(packedRgb);
  this.editedColorPreviewStripe.setAttribute("style", "background-color:#" + rgbToHex(packedRgb) + ";");
  const hsv = rgbToHsv(normalizedRgb.h, normalizedRgb.l, normalizedRgb.O);
  rgbSliders = this.hsbSlidersRow;
  rgbSliders[0].setValue(Math.round(hsv.hue * 360));
  rgbSliders[1].setValue(Math.round(hsv.saturation * 100));
  rgbSliders[2].setValue(Math.round(hsv.value * 100));
  const lab = rgbToLab(normalizedRgb.h * 255, normalizedRgb.l * 255, normalizedRgb.O * 255);
  this.labFieldsRow[0].setValue(Math.round(lab.labL));
  this.labFieldsRow[1].setValue(Math.round(lab.labA));
  this.labFieldsRow[2].setValue(Math.round(lab.labB));
  const cmyk = rgbToCmyk(normalizedRgb.h * 255, normalizedRgb.l * 255, normalizedRgb.O * 255);
  this.cmykFieldsRow[0].setValue(Math.round(cmyk.cyan * 100));
  this.cmykFieldsRow[1].setValue(Math.round(cmyk.magenta * 100));
  this.cmykFieldsRow[2].setValue(Math.round(cmyk.yellow * 100));
  this.cmykFieldsRow[3].setValue(Math.round(cmyk.black * 100));
  this.hsColorWheel.setValue(normalizedRgb);
  if (this.allowContinuousMirrorUpdates) {
    this.finalizeDialogResultCallback(this.packRgbIntFromNormalizedChannels(this.storedValue));
    this.hasPostedEphemeralPreview = true
  }
};
ColorPickerDialog.prototype.clampRgbByte = function(byteValue) {
  return Math.max(0, Math.min(255, byteValue))
};
ColorPickerDialog.prototype.clampUnitFloat = function(unitFloat) {
  return Math.max(0, Math.min(1, unitFloat))
};


export { ColorPickerDialog };
