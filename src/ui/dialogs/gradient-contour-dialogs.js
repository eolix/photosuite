/**
 * Gradient and contour preset editor dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Rect } from "../../core/math/rect.js";
import { CurveEditor } from "../widgets/controls/canvas-widgets.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, Checkbox, Label, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, addPointerDownListener, addPointerMoveListener, addPointerUpListener, appendBreak, disableTouchGestures, getDevicePixelRatio, getEventPos, makeElement, removePointerMoveListener, removePointerUpListener, setElementCssSizeForDeviceRatio } from "../../core/dom.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { composite } from "../../engine/compositing/compositing-ops.js";
import { drawCheckerboard } from "../../engine/compositing/color-math.js";
import { applyGradient, parseColorStops, sampleGradientColor, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

// Gradient stop lists must keep at least two endpoints.
function canRemoveGradientStop(stopList, selectedStop) {
  return selectedStop != null && stopList.length != 2;
}

function GradientEditorDialog() {
  BaseDialog.call(this, "dialogs.gradientEditor", "gradienteditor");
  this.snapshotOpenedPayload = null;
  this.storedValue = null;
  this.hostDocumentColorSource = null;
  this.finalizeDialogResultCallback = null;
  this.hasPostedEphemeralPreview = false;
  this.allowContinuousMirrorUpdates = false;
  addClass(this.body, "form");
  this.selectedColorStopWrapper = null;
  this.selectedTransparencyStopWrapper = null;
  this.activeColorMidpointIndex = -1;
  this.activeTransparencyMidpointIndex = -1;
  this.lastGradientPointerUpTimeMs = 0;
  this.boundOnGradientPointerMove = this.onGradientPointerMove.bind(this);
  this.boundOnGradientPointerUp = this.onGradientPointerUp.bind(this);
  this.canvas = makeElement("canvas", "");
  this.ctx2d = this.canvas.getContext("2d");
  this.canvas.setAttribute("style", "display:block");
  this.gradientPreviewContentRect = null;
  disableTouchGestures(this.canvas);
  addPointerDownListener(this.canvas, this.onGradientCanvasPointerDown.bind(this));
  this.smoothnessSlider = new SliderDropdown("styleOptions.bevelTechnique.smoothness", 0, 100, "%");
  this.smoothnessSlider.on(EventType.widgetSelect, this.onGradientWidgetChanged, this);
  this.smoothnessSlider.parent = this;
  this.body.appendChild(this.smoothnessSlider.el);
  appendBreak(this.body);
  this.transparencyStopsSectionLabel = new Label("properties.opacity");
  this.body.appendChild(this.transparencyStopsSectionLabel.el);
  this.transparencyStopsPanel = makeElement("div", "bordered padded noalign");
  this.body.appendChild(this.transparencyStopsPanel);
  this.transparencyStopOpacitySlider = new SliderDropdown("properties.opacity", 0, 100, "%");
  this.transparencyStopOpacitySlider.parent = this;
  this.transparencyStopOpacitySlider.on(EventType.widgetSelect, this.onGradientWidgetChanged, this);
  this.transparencyStopsPanel.appendChild(this.transparencyStopOpacitySlider.el);
  this.transparencyStopPositionSlider = new SliderDropdown("properties.position", 0, 100, "%");
  this.transparencyStopPositionSlider.parent = this;
  this.transparencyStopPositionSlider.on(EventType.widgetSelect, this.onGradientWidgetChanged, this);
  this.transparencyStopsPanel.appendChild(this.transparencyStopPositionSlider.el);
  this.removeTransparencyStopButton = new Button("clipboard.delete", false, null, true);
  this.removeTransparencyStopButton.on("click", this.deleteSelectedTransparencyStop, this);
  this.transparencyStopsPanel.appendChild(this.removeTransparencyStopButton.el);
  this.body.appendChild(this.canvas);
  appendBreak(this.body);
  this.colorStopsSectionLabel = new Label("colour.title");
  this.body.appendChild(this.colorStopsSectionLabel.el);
  this.colorStopsPanel = makeElement("div", "bordered padded noalign");
  this.body.appendChild(this.colorStopsPanel);
  this.colorStopKindDropdown = new Dropdown("properties.type", [
    "properties.foreground",
    "properties.background",
    "properties.custom"
  ]);
  this.colorStopKindDropdown.on(EventType.widgetSelect, this.onGradientWidgetChanged, this);
  this.colorStopsPanel.appendChild(this.colorStopKindDropdown.el);
  this.colorStopPicker = new ColorSampleWidget(true);
  this.colorStopPicker.parent = this;
  this.colorStopPicker.on(EventType.widgetSelect, this.onGradientWidgetChanged, this);
  this.colorStopsPanel.appendChild(this.colorStopPicker.el);
  this.colorStopPositionSlider = new SliderDropdown("properties.position", 0, 100, "%");
  this.colorStopPositionSlider.parent = this;
  this.colorStopPositionSlider.on(EventType.widgetSelect, this.onGradientWidgetChanged, this);
  this.colorStopsPanel.appendChild(this.colorStopPositionSlider.el);
  this.removeColorStopButton = new Button("clipboard.delete", false, null, true);
  this.removeColorStopButton.on("click", this.deleteSelectedColorStop, this);
  this.colorStopsPanel.appendChild(this.removeColorStopButton.el);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  this.body.appendChild(this.okBtn.el);
  this.on("closebtn", this.onCancel, this)
}
GradientEditorDialog.prototype = Object.create(BaseDialog.prototype);
GradientEditorDialog.prototype.constructor = GradientEditorDialog;
GradientEditorDialog.prototype.onCancel = function(clickEvent) {
  if (this.hasPostedEphemeralPreview) this.finalizeDialogResultCallback(this.snapshotOpenedPayload)
};
GradientEditorDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.smoothnessSlider.buildUI();
  this.transparencyStopsSectionLabel.buildUI();
  this.colorStopsSectionLabel.buildUI();
  this.removeTransparencyStopButton.buildUI();
  this.removeColorStopButton.buildUI();
  this.transparencyStopOpacitySlider.buildUI();
  this.transparencyStopPositionSlider.buildUI();
  this.colorStopKindDropdown.buildUI();
  this.colorStopPositionSlider.buildUI()
};
GradientEditorDialog.prototype.onUpdate = function(appData, popupType) {
  this.hostDocumentColorSource = appData
};
GradientEditorDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.storedValue = JSON.parse(JSON.stringify(dialogPayload.gradientStyleData));
  this.snapshotOpenedPayload = JSON.parse(JSON.stringify(dialogPayload.gradientStyleData));
  this.selectedColorStopWrapper = this.selectedTransparencyStopWrapper = null;
  this.finalizeDialogResultCallback = dialogPayload.onDialogResult;
  this.hasPostedEphemeralPreview = false;
  this.allowContinuousMirrorUpdates = dialogPayload.allowContinuousMirrorUpdates;
  this.redraw();
  this.syncGradientSidebarWidgets()
};
GradientEditorDialog.prototype.onOK = function(clickEvent) {
  const gradientValue = this.storedValue;
  this.finalizeDialogResultCallback(gradientValue);
  this.close()
};
GradientEditorDialog.prototype.isModifierKey = function(keyCode) {
  return keyCode == KeyboardHandler.Delete || keyCode == KeyboardHandler.Backspace;
};
GradientEditorDialog.prototype.onKeyEvent = function(doc, view, appData, keyboard) {
  if (keyboard.isPressed(KeyboardHandler.Delete) || keyboard.isPressed(KeyboardHandler.Backspace)) {
    if (this.selectedTransparencyStopWrapper) this.deleteSelectedTransparencyStop();
    if (this.selectedColorStopWrapper) this.deleteSelectedColorStop()
  }
};
GradientEditorDialog.prototype.deleteSelectedTransparencyStop = function(clickEvent) {
  const transparencyStops = this.storedValue.Trns.v;
  if (!canRemoveGradientStop(transparencyStops, this.selectedTransparencyStopWrapper)) return;
  transparencyStops.splice(transparencyStops.indexOf(this.selectedTransparencyStopWrapper), 1);
  this.selectedTransparencyStopWrapper = null;
  this.redraw();
  this.syncGradientSidebarWidgets()
};
GradientEditorDialog.prototype.deleteSelectedColorStop = function(clickEvent) {
  const colorStops = this.storedValue.Clrs.v;
  if (!canRemoveGradientStop(colorStops, this.selectedColorStopWrapper)) return;
  colorStops.splice(colorStops.indexOf(this.selectedColorStopWrapper), 1);
  this.selectedColorStopWrapper = null;
  this.redraw();
  this.syncGradientSidebarWidgets()
};
GradientEditorDialog.prototype.redraw = function() {
  const canvas = this.canvas,
    ctx2d = this.ctx2d,
    deviceRatio = getDevicePixelRatio();
  canvas.width = Math.floor(410 * deviceRatio);
  canvas.height = Math.floor(90 * deviceRatio);
  setElementCssSizeForDeviceRatio(canvas, canvas.width, canvas.height);
  this.gradientPreviewContentRect = new Rect(0, 0, Math.floor(380 * deviceRatio), Math.floor(32 * deviceRatio));
  this.gradientPreviewContentRect.x = Math.floor((this.canvas.width - this.gradientPreviewContentRect.width) / 2);
  this.gradientPreviewContentRect.y = Math.floor((this.canvas.height - this.gradientPreviewContentRect.height) / 2);
  const contentRect = this.gradientPreviewContentRect,
    contentWidth = contentRect.width,
    contentHeight = contentRect.height,
    originX = contentRect.x,
    originY = contentRect.y,
    drawRect = new Rect(0, 0, contentWidth, contentHeight),
    imageData = ctx2d.getImageData(0, 0, contentWidth, contentHeight),
    checkerPixels = new Uint8Array(imageData.data.buffer);
  drawCheckerboard(checkerPixels, contentWidth, contentHeight, 8);
  const gradientPixels = allocBuffer(contentWidth * contentHeight * 4);
  applyGradient(this.storedValue, gradientPixels, drawRect, [1 / contentWidth, 0, 0, 1 / contentHeight], contentWidth / 2, contentHeight / 2, false, 0, this.hostDocumentColorSource.colorInt, this.hostDocumentColorSource.bgColor);
  composite("norm", gradientPixels, contentRect, checkerPixels, contentRect, contentRect, 1);
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  ctx2d.putImageData(imageData, originX, originY);
  const transparencyStops = this.storedValue.Trns.v,
    colorStops = this.storedValue.Clrs.v,
    parsedColors = parseColorStops(colorStops, this.hostDocumentColorSource.colorInt, this.hostDocumentColorSource.bgColor),
    stopHalfWidth = Math.round(6 * getDevicePixelRatio()),
    stopHeight = Math.round(14 * getDevicePixelRatio()),
    selectedTransparencyStop = this.selectedTransparencyStopWrapper ? this.selectedTransparencyStopWrapper.v : null,
    selectedColorStop = this.selectedColorStopWrapper ? this.selectedColorStopWrapper.v : null;
  for (let stopIdx = 0; stopIdx < transparencyStops.length; stopIdx++) {
    const transparencyStop = transparencyStops[stopIdx].v,
      grayValue = Math.round(255 - 255 * transparencyStop.Opct.v.val / 100);
    if ((transparencyStop == selectedTransparencyStop || transparencyStops[stopIdx - 1] && transparencyStops[stopIdx - 1].v == selectedTransparencyStop || stopIdx == this.activeTransparencyMidpointIndex) && stopIdx != 0) {
      ctx2d.fillStyle = "#000000";
      ctx2d.fillRect(originX - 3 + contentWidth * (transparencyStops[stopIdx - 1].v.Lctn.v + (transparencyStop.Lctn.v - transparencyStops[stopIdx - 1].v.Lctn.v) * transparencyStop.Mdpn.v / 100) / 4096, originY - 6 - 2, 6, 6)
    }
    if (transparencyStop == selectedTransparencyStop) {
      ctx2d.fillStyle = "#ffffff";
      ctx2d.fillRect(originX - stopHalfWidth + contentWidth * (transparencyStop.Lctn.v / 4096) - 2, originY - 2 - stopHeight - 2, 2 * stopHalfWidth + 4, stopHeight + 4)
    }
    ctx2d.fillStyle = "rgb(" + grayValue + "," + grayValue + "," + grayValue + ")";
    ctx2d.fillRect(originX - stopHalfWidth + contentWidth * (transparencyStop.Lctn.v / 4096), originY - 2 - stopHeight, 2 * stopHalfWidth, stopHeight)
  }
  for (let stopIdx = 0; stopIdx < colorStops.length; stopIdx++) {
    const colorStop = colorStops[stopIdx].v,
      parsedRgb = parsedColors[stopIdx];
    if ((colorStop == selectedColorStop || colorStops[stopIdx - 1] && colorStops[stopIdx - 1].v == selectedColorStop || stopIdx == this.activeColorMidpointIndex) && stopIdx != 0) {
      ctx2d.fillStyle = "#000000";
      ctx2d.fillRect(originX - 3 + contentWidth * (colorStops[stopIdx - 1].v.Lctn.v + (colorStop.Lctn.v - colorStops[stopIdx - 1].v.Lctn.v) * colorStop.Mdpn.v / 100) / 4096, originY + contentHeight + 2, 6, 6)
    }
    if (colorStop == selectedColorStop) {
      ctx2d.fillStyle = "#ffffff";
      ctx2d.fillRect(originX - stopHalfWidth + contentWidth * (colorStop.Lctn.v / 4096) - 2, originY + contentHeight + 2 - 2, 2 * stopHalfWidth + 4, stopHeight + 4)
    }
    ctx2d.fillStyle = "rgb(" + Math.round(parsedRgb.h) + ", " + Math.round(parsedRgb.l) + "," + Math.round(parsedRgb.O) + ")";
    ctx2d.fillRect(originX - stopHalfWidth + contentWidth * (colorStop.Lctn.v / 4096), originY + contentHeight + 2, 2 * stopHalfWidth, stopHeight)
  }
  if (this.allowContinuousMirrorUpdates) {
    this.finalizeDialogResultCallback(this.storedValue);
    this.hasPostedEphemeralPreview = true
  }
};
GradientEditorDialog.prototype.syncGradientSidebarWidgets = function() {
  this.smoothnessSlider.setValue(Math.round(100 * this.storedValue.Intr.v / 4096));
  const transparencyStops = this.storedValue.Trns.v,
    colorStops = this.storedValue.Clrs.v,
    hasSelectedTransparency = this.selectedTransparencyStopWrapper != null,
    hasActiveTransparencyMidpoint = this.activeTransparencyMidpointIndex != -1;
  this.transparencyStopOpacitySlider.setEnabled(hasSelectedTransparency);
  this.transparencyStopPositionSlider.setEnabled(hasSelectedTransparency || hasActiveTransparencyMidpoint);
  this.removeTransparencyStopButton.setEnabled(hasSelectedTransparency);
  if (hasSelectedTransparency) {
    this.transparencyStopsPanel.setAttribute("style", "");
    const selectedTransparencyStop = this.selectedTransparencyStopWrapper.v;
    this.transparencyStopPositionSlider.setValue(Math.round(100 * selectedTransparencyStop.Lctn.v / 4096));
    this.transparencyStopOpacitySlider.setValue(selectedTransparencyStop.Opct.v.val)
  }
  if (hasActiveTransparencyMidpoint) this.transparencyStopPositionSlider.setValue(transparencyStops[this.activeTransparencyMidpointIndex].v.Mdpn.v);
  const hasSelectedColor = this.selectedColorStopWrapper != null,
    hasActiveColorMidpoint = this.activeColorMidpointIndex != -1;
  this.colorStopKindDropdown.setEnabled(hasSelectedColor);
  this.colorStopPicker.setEnabled(hasSelectedColor);
  this.colorStopPositionSlider.setEnabled(hasSelectedColor || hasActiveColorMidpoint);
  this.removeColorStopButton.setEnabled(hasSelectedColor);
  if (hasSelectedColor) {
    this.colorStopsPanel.setAttribute("style", "");
    const selectedColorStop = this.selectedColorStopWrapper.v;
    this.colorStopPositionSlider.setValue(Math.round(100 * selectedColorStop.Lctn.v / 4096));
    const colorStopKind = selectedColorStop.Type.v.Clry;
    this.colorStopKindDropdown.setValue(["FrgC", "BckC", "UsrS"].indexOf(colorStopKind));
    if (colorStopKind == "FrgC") this.colorStopPicker.setPackedRgb(this.hostDocumentColorSource.colorInt);
    if (colorStopKind == "BckC") this.colorStopPicker.setPackedRgb(this.hostDocumentColorSource.bgColor);
    if (colorStopKind == "UsrS") this.colorStopPicker.setValue(selectedColorStop.Clr.v)
  }
  if (hasActiveColorMidpoint) this.colorStopPositionSlider.setValue(colorStops[this.activeColorMidpointIndex].v.Mdpn.v)
};
GradientEditorDialog.prototype.onGradientWidgetChanged = function(widgetEvent) {
  const smoothnessValue = Math.round(4096 * this.smoothnessSlider.getValue() / 100);
  this.storedValue.Intr.v = smoothnessValue;
  const transparencyStops = this.storedValue.Trns.v,
    colorStops = this.storedValue.Clrs.v;
  if (this.selectedTransparencyStopWrapper != null) {
    const selectedTransparencyStop = this.selectedTransparencyStopWrapper.v;
    selectedTransparencyStop.Lctn.v = Math.round(4096 * (this.transparencyStopPositionSlider.getValue() / 100));
    selectedTransparencyStop.Opct.v.val = this.transparencyStopOpacitySlider.getValue()
  }
  if (this.selectedColorStopWrapper != null) {
    const selectedColorStop = this.selectedColorStopWrapper.v;
    selectedColorStop.Lctn.v = Math.round(4096 * (this.colorStopPositionSlider.getValue() / 100));
    if (widgetEvent.target == this.colorStopPicker) this.colorStopKindDropdown.setValue(2);
    const colorStopKindIndex = this.colorStopKindDropdown.getValue();
    selectedColorStop.Type.v.Clry = ["FrgC", "BckC", "UsrS"][colorStopKindIndex];
    if (colorStopKindIndex == 2) selectedColorStop.Clr = {
      t: "Objc",
      v: this.colorStopPicker.getValue()
    };
    else if (selectedColorStop.Clr) delete selectedColorStop.Clr
  }
  if (this.activeTransparencyMidpointIndex != -1) transparencyStops[this.activeTransparencyMidpointIndex].v.Mdpn.v = this.transparencyStopPositionSlider.getValue();
  if (this.activeColorMidpointIndex != -1) colorStops[this.activeColorMidpointIndex].v.Mdpn.v = this.colorStopPositionSlider.getValue();
  this.redraw()
};
GradientEditorDialog.prototype.onGradientCanvasPointerDown = function(pointerEvent) {
  const pointerPos = getEventPos(pointerEvent, this.canvas),
    normalizedX = (pointerPos.x * getDevicePixelRatio() - this.gradientPreviewContentRect.x) / this.gradientPreviewContentRect.width,
    normalizedY = (pointerPos.y * getDevicePixelRatio() - this.gradientPreviewContentRect.y) / this.gradientPreviewContentRect.height,
    transparencyStops = this.storedValue.Trns.v,
    colorStops = this.storedValue.Clrs.v;
  let hitTransparencyWrapper = null,
    hitColorWrapper = null,
    hitTransparencyMidpointIdx = -1,
    hitColorMidpointIdx = -1;
  if (normalizedY < 1)
    for (let stopIdx = 0; stopIdx < transparencyStops.length; stopIdx++) {
      const transparencyStop = transparencyStops[stopIdx].v;
      if (Math.abs(transparencyStop.Lctn.v / 4096 - normalizedX) < .02) hitTransparencyWrapper = transparencyStops[stopIdx];
      if (stopIdx > 0)
        if (Math.abs((transparencyStops[stopIdx - 1].v.Lctn.v + (transparencyStop.Lctn.v - transparencyStops[stopIdx - 1].v.Lctn.v) * transparencyStop.Mdpn.v / 100) / 4096 - normalizedX) < .01) hitTransparencyMidpointIdx = stopIdx
    }
  if (normalizedY > 0)
    for (let stopIdx = 0; stopIdx < colorStops.length; stopIdx++) {
      const colorStop = colorStops[stopIdx].v;
      if (Math.abs(colorStop.Lctn.v / 4096 - normalizedX) < .02) hitColorWrapper = colorStops[stopIdx];
      if (stopIdx > 0)
        if (Math.abs((colorStops[stopIdx - 1].v.Lctn.v + (colorStop.Lctn.v - colorStops[stopIdx - 1].v.Lctn.v) * colorStop.Mdpn.v / 100) / 4096 - normalizedX) < .01) hitColorMidpointIdx = stopIdx
    }
  if (hitColorWrapper == null && hitTransparencyWrapper == null && hitTransparencyMidpointIdx == -1 && hitColorMidpointIdx == -1) {
    if (normalizedY < 0) {
      const newTransparencyStop = {
        t: "Objc",
        v: {
          classID: "TrnS",
          Opct: {
            t: "UntF",
            v: {
              type: "#Prc",
              val: 100
            }
          },
          Lctn: {
            t: "long",
            v: 0
          },
          Mdpn: {
            t: "long",
            v: 50
          }
        }
      };
      newTransparencyStop.v.Lctn.v = Math.round(normalizedX * 4096);
      transparencyStops.push(newTransparencyStop);
      transparencyStops.sort(this.compareGradientStopsByLocation);
      hitTransparencyWrapper = newTransparencyStop
    }
    if (normalizedY > 1) {
      const colorStopsForSample = this.storedValue.Clrs.v,
        parsedColors = parseColorStops(colorStopsForSample, this.hostDocumentColorSource.colorInt, this.hostDocumentColorSource.bgColor),
        sampledColor = sampleGradientColor(this.storedValue, parsedColors, normalizedX),
        newColorStop = {
          t: "Objc",
          v: {
            classID: "Clrt",
            Clr: {
              t: "Objc",
              v: toRGBDesc({
                h: sampledColor & 255,
                l: sampledColor >> 8 & 255,
                O: sampledColor >> 16 & 255
              })
            },
            Type: {
              t: "enum",
              v: {
                Clry: "UsrS"
              }
            },
            Lctn: {
              t: "long",
              v: 0
            },
            Mdpn: {
              t: "long",
              v: 50
            }
          }
        };
      newColorStop.v.Lctn.v = Math.round(normalizedX * 4096);
      colorStopsForSample.push(newColorStop);
      colorStopsForSample.sort(this.compareGradientStopsByLocation);
      hitColorWrapper = newColorStop
    }
  }
  if (hitColorWrapper != null) hitColorMidpointIdx = -1;
  if (hitTransparencyWrapper != null) hitTransparencyMidpointIdx = -1;
  if (hitColorWrapper != null || hitTransparencyWrapper != null || hitTransparencyMidpointIdx > -1 || hitColorMidpointIdx > -1) {
    this.selectedTransparencyStopWrapper = hitTransparencyWrapper;
    this.selectedColorStopWrapper = hitColorWrapper;
    this.activeTransparencyMidpointIndex = hitTransparencyMidpointIdx;
    this.activeColorMidpointIndex = hitColorMidpointIdx;
    this.syncGradientSidebarWidgets();
    this.redraw();
    addPointerMoveListener(window, this.boundOnGradientPointerMove);
    addPointerUpListener(window, this.boundOnGradientPointerUp)
  }
};
GradientEditorDialog.prototype.onGradientPointerMove = function(pointerEvent) {
  const pointerPos = getEventPos(pointerEvent, this.canvas),
    normalizedY = getDevicePixelRatio() * (pointerPos.y - this.gradientPreviewContentRect.y) / this.gradientPreviewContentRect.height;
  let normalizedX = getDevicePixelRatio() * (pointerPos.x - this.gradientPreviewContentRect.x) / this.gradientPreviewContentRect.width;
  normalizedX = Math.max(0, Math.min(1, normalizedX));
  const transparencyStops = this.storedValue.Trns.v,
    colorStops = this.storedValue.Clrs.v;
  if (this.selectedTransparencyStopWrapper != null) {
    const draggedTransparencyStop = this.selectedTransparencyStopWrapper.v;
    draggedTransparencyStop.Lctn.v = Math.round(4096 * normalizedX);
    const transparencyListIdx = transparencyStops.indexOf(this.selectedTransparencyStopWrapper);
    if (transparencyListIdx != -1 && normalizedY < -1 && transparencyStops.length > 2) transparencyStops.splice(transparencyListIdx, 1);
    if (transparencyListIdx == -1 && normalizedY > -1) transparencyStops.push(this.selectedTransparencyStopWrapper);
    transparencyStops.sort(this.compareGradientStopsByLocation)
  }
  if (this.selectedColorStopWrapper != null) {
    const draggedColorStop = this.selectedColorStopWrapper.v;
    draggedColorStop.Lctn.v = Math.round(4096 * normalizedX);
    const colorListIdx = colorStops.indexOf(this.selectedColorStopWrapper);
    if (colorListIdx != -1 && normalizedY > 1.5 && colorStops.length > 2) colorStops.splice(colorListIdx, 1);
    if (colorListIdx == -1 && normalizedY < 1.5) colorStops.push(this.selectedColorStopWrapper);
    colorStops.sort(this.compareGradientStopsByLocation)
  }
  if (this.activeTransparencyMidpointIndex > -1) {
    const activeTransparencyMidpoint = transparencyStops[this.activeTransparencyMidpointIndex].v;
    activeTransparencyMidpoint.Mdpn.v = Math.max(5, Math.min(95, Math.round(100 * (normalizedX * 4096 - transparencyStops[this.activeTransparencyMidpointIndex - 1].v.Lctn.v) / (activeTransparencyMidpoint.Lctn.v - transparencyStops[this.activeTransparencyMidpointIndex - 1].v.Lctn.v))))
  }
  if (this.activeColorMidpointIndex > -1) {
    const activeColorMidpoint = colorStops[this.activeColorMidpointIndex].v;
    activeColorMidpoint.Mdpn.v = Math.max(5, Math.min(95, Math.round(100 * (normalizedX * 4096 - colorStops[this.activeColorMidpointIndex - 1].v.Lctn.v) / (activeColorMidpoint.Lctn.v - colorStops[this.activeColorMidpointIndex - 1].v.Lctn.v))))
  }
  if (this.selectedTransparencyStopWrapper != null || this.selectedColorStopWrapper != null || this.activeTransparencyMidpointIndex > -1 || this.activeColorMidpointIndex > -1) {
    this.syncGradientSidebarWidgets();
    this.redraw()
  }
};
GradientEditorDialog.prototype.onGradientPointerUp = function(pointerEvent) {
  removePointerMoveListener(window, this.boundOnGradientPointerMove);
  removePointerUpListener(window, this.boundOnGradientPointerUp);
  if (Date.now() - this.lastGradientPointerUpTimeMs < 300) {
    if (this.activeColorMidpointIndex != -1 || this.activeTransparencyMidpointIndex != -1) {
      const midpointStop = (this.activeColorMidpointIndex != -1 ? this.storedValue.Clrs.v[this.activeColorMidpointIndex] : this.storedValue.Trns.v[this.activeTransparencyMidpointIndex]).v;
      midpointStop.Mdpn.v = 50;
      this.syncGradientSidebarWidgets();
      this.redraw()
    } else if (this.selectedColorStopWrapper != null) this.colorStopPicker.triggerColorPicker()
  }
  this.lastGradientPointerUpTimeMs = Date.now()
};
GradientEditorDialog.prototype.compareGradientStopsByLocation = function(stopA, stopB) {
  return stopA.v.Lctn.v - stopB.v.Lctn.v;
};


function ContourEditorDialog() {
  BaseDialog.call(this, "dialogs.contourEditor", "contoureditor");
  this.childrenSnapshotForCancel = null;
  this.liveChildrenRoot = null;
  this.response = null;
  this.mainColumnEl = makeElement("div", "cell");
  this.body.appendChild(this.mainColumnEl);
  this.actionColumnEl = makeElement("div", "cell padded");
  this.body.appendChild(this.actionColumnEl);
  const curveHostDiv = makeElement("div", "bordered padded vmargin");
  this.mainColumnEl.appendChild(curveHostDiv);
  this.curveEditor = new CurveEditor();
  this.curveEditor.on(EventType.widgetSelect, this.onContourCurveChanged, this);
  curveHostDiv.appendChild(this.curveEditor.el);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.close, this);
  this.actionColumnEl.appendChild(this.okBtn.el);
  this.coords = makeElement("div", "");
  this.coords.setAttribute("style", "width:250px");
  this.mainColumnEl.appendChild(this.coords);
  this.horizontalPercentInput = new TextInput("properties.contourXIn", "%", 4);
  this.verticalPercentInput = new TextInput("properties.contourYOut", "%", 4);
  this.smoothCornerCheckbox = new Checkbox("styleOptions.bevelTechnique.smooth");
  this.horizontalPercentInput.on(EventType.widgetSelect, this.onContourFieldInputsChanged, this);
  this.verticalPercentInput.on(EventType.widgetSelect, this.onContourFieldInputsChanged, this);
  this.smoothCornerCheckbox.on(EventType.widgetSelect, this.onContourFieldInputsChanged, this);
  this.coords.appendChild(this.horizontalPercentInput.el);
  this.coords.appendChild(this.smoothCornerCheckbox.el);
  this.coords.appendChild(this.verticalPercentInput.el);
  this.on("closebtn", this.cancel, this)
}
ContourEditorDialog.prototype = Object.create(BaseDialog.prototype);
ContourEditorDialog.prototype.constructor = ContourEditorDialog;
ContourEditorDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.smoothCornerCheckbox.buildUI()
};
ContourEditorDialog.prototype.onContourCurveChanged = function(widgetEvent) {
  this.liveChildrenRoot.Crv.v = this.curveEditor.getValue();
  this.response(this.liveChildrenRoot);
  this.refreshCoordinateFieldsFromEditor()
};
ContourEditorDialog.prototype.cancel = function(clickEvent) {
  this.response(this.childrenSnapshotForCancel)
};
ContourEditorDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.childrenSnapshotForCancel = JSON.parse(JSON.stringify(dialogPayload.children));
  this.liveChildrenRoot = dialogPayload.children;
  this.response = dialogPayload.response;
  this.curveEditor.setValue(this.liveChildrenRoot.Crv.v);
  this.refreshCoordinateFieldsFromEditor()
};
ContourEditorDialog.prototype.refreshCoordinateFieldsFromEditor = function() {
  const activePointIdx = this.curveEditor.getActivePointIndex();
  this.coords.setAttribute("class", activePointIdx == -1 ? "disabled" : "");
  if (activePointIdx == -1) return;
  const activePoint = this.liveChildrenRoot.Crv.v[activePointIdx].v;
  this.horizontalPercentInput.setValue(Math.round(activePoint.Hrzn.v * (100 / 255)));
  this.verticalPercentInput.setValue(Math.round(activePoint.Vrtc.v * (100 / 255)));
  this.smoothCornerCheckbox.setValue(activePoint.Cnty.v)
};
ContourEditorDialog.prototype.onContourFieldInputsChanged = function(widgetEvent) {
  const activePointIdx = this.curveEditor.getActivePointIndex(),
    activePointEntry = this.liveChildrenRoot.Crv.v[activePointIdx];
  activePointEntry.v.Hrzn.v = parseFloat(this.horizontalPercentInput.getValue()) * (255 / 100);
  activePointEntry.v.Vrtc.v = parseFloat(this.verticalPercentInput.getValue()) * (255 / 100);
  activePointEntry.v.Cnty.v = this.smoothCornerCheckbox.getValue();
  this.liveChildrenRoot.Crv.v.sort(function(pointA, pointB) {
    return pointA.v.Hrzn.v - pointB.v.Hrzn.v;
  });
  this.curveEditor.setValue(this.liveChildrenRoot.Crv.v, this.liveChildrenRoot.Crv.v.indexOf(activePointEntry));
  this.refreshCoordinateFieldsFromEditor();
  this.response(this.liveChildrenRoot)
};



export { GradientEditorDialog, ContourEditorDialog };
