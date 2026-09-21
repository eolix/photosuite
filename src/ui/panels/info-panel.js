/**
 * Info panel: RGBA under the cursor plus document coordinates (X/Y) and the
 * width/height of the active selection or transform overlay.
 */
import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { BaseTool } from "../widgets/base-tool.js";
import { Label } from "../widgets/form-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { appendBreak, isInDOM, makeElement } from "../../core/dom.js";
import { formatDocLength } from "../../engine/compositing/geometry.js";

function InfoPanel() {
  BaseTool.call(this, "panels.info", false, getIconUrl("panels/info"), BaseTool.PanelId.INFO, true);
  this.panelBody.setAttribute("style", "min-width:240px;");
  this.activeLayer = null;
  this.doc = null;
  installInfoPanelLayout(this)
}
InfoPanel.prototype = Object.create(BaseTool.prototype);

InfoPanel.prototype.onMouseMove = function(documentLayer, _appController, appData, _keyboard, pointerState) {
  if (!isInDOM(this.panelBody) || documentLayer == null) return;
  const docPoint = documentLayer.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    pixelPoint = new Point(Math.floor(docPoint.x), Math.floor(docPoint.y));
  if (!pointerState.isDown) {
    const rgba = samplePixelRgba(documentLayer, pixelPoint);
    setRgbaLabelValues(this.rgbaLabels, rgba)
  }
  setCoordinateLabels(this, documentLayer, appData, pixelPoint);
  this.updateSize()
};

InfoPanel.prototype.updateSize = function() {
  const measured = resolveMeasuredDimensions(this.activeLayer),
    layer = this.activeLayer,
    doc = this.doc;
  let widthText = 0,
    heightText = 0;
  if (layer && doc) {
    widthText = formatDocLength(Math.abs(measured.width), layer.dpi, doc, layer.width);
    heightText = formatDocLength(Math.abs(measured.height), layer.dpi, doc, layer.height)
  }
  this.widthLabel.setValue(Locale.get("properties.width").charAt(0) + ": " + widthText);
  this.heightLabel.setValue(Locale.get("properties.height").charAt(0) + ": " + heightText)
};

InfoPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  this.updateSize()
};

InfoPanel.prototype.open = function(layer, _mode, doc) {
  this.activeLayer = layer;
  this.doc = doc;
  this.updateSize()
};

/**
 * Read RGBA from layer raster at a floored document pixel, or zeros when the
 * layer is dirty or the point lies outside the document bounds.
 */
InfoPanel.samplePixelRgba = function(layer, pixelPoint) {
  return samplePixelRgba(layer, pixelPoint)
};

/**
 * Pixel width/height from dimension overlay or selection mask when present.
 */
InfoPanel.resolveMeasuredDimensions = function(layer) {
  return resolveMeasuredDimensions(layer)
};

export { InfoPanel };

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function installInfoPanelLayout(panel) {
  const topRow = makeElement("div", "marged row");
  panel.panelBody.appendChild(topRow);
  let leftCol = makeElement("div", "cell");
  leftCol.setAttribute("style", "width:10em");
  topRow.appendChild(leftCol);
  let rightCol = makeElement("div", "cell");
  rightCol.setAttribute("style", "width:10em");
  topRow.appendChild(rightCol);
  panel.rgbaLabels = [];
  for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
    const channelLabel = new Label("");
    panel.rgbaLabels.push(channelLabel);
    leftCol.appendChild(channelLabel.el);
    appendBreak(leftCol)
  }
  panel.panelBody.appendChild(makeElement("hr", ""));
  const bottomRow = makeElement("div", "marged row");
  panel.panelBody.appendChild(bottomRow);
  leftCol = makeElement("div", "cell");
  leftCol.setAttribute("style", "width:10em");
  rightCol = makeElement("div", "cell");
  rightCol.setAttribute("style", "width:10em");
  bottomRow.appendChild(leftCol);
  bottomRow.appendChild(rightCol);
  panel.xLabel = new Label("");
  leftCol.appendChild(panel.xLabel.el);
  appendBreak(leftCol);
  panel.yLabel = new Label("");
  leftCol.appendChild(panel.yLabel.el);
  panel.widthLabel = new Label("");
  rightCol.appendChild(panel.widthLabel.el);
  appendBreak(rightCol);
  panel.heightLabel = new Label("");
  rightCol.appendChild(panel.heightLabel.el);
  panel.xLabel.setValue("X: 100 px");
  panel.yLabel.setValue("Y: 100 px");
  panel.widthLabel.setValue("W: 0");
  panel.heightLabel.setValue("H: 0")
}

// ---------------------------------------------------------------------------
// Readout helpers
// ---------------------------------------------------------------------------

function samplePixelRgba(layer, pixelPoint) {
  let r = 0,
    g = 0,
    b = 0,
    a = 0;
  if (!layer.hasDirtyRect() && new Rect(0, 0, layer.width - 1, layer.height - 1).containsPoint(pixelPoint)) {
    const raster = layer.getRasterData(),
      offset = layer.width * pixelPoint.y + pixelPoint.x << 2;
    r = raster[offset + 0];
    g = raster[offset + 1];
    b = raster[offset + 2];
    a = raster[offset + 3]
  }
  return { r, g, b, a }
}

function resolveMeasuredDimensions(layer) {
  let width = 0,
    height = 0;
  if (layer) {
    if (layer.pathViewport.dimensionOverlay) {
      width = layer.pathViewport.dimensionOverlay.width;
      height = layer.pathViewport.dimensionOverlay.height
    } else if (layer.selectionMask) {
      width = layer.selectionMask.rect.width;
      height = layer.selectionMask.rect.height
    }
  }
  return { width, height }
}

function setRgbaLabelValues(labels, rgba) {
  labels[0].setValue("R: " + rgba.r);
  labels[1].setValue("G: " + rgba.g);
  labels[2].setValue("B: " + rgba.b);
  labels[3].setValue("A: " + rgba.a)
}

function setCoordinateLabels(panel, layer, appData, pixelPoint) {
  panel.xLabel.setValue("X: " + formatDocLength(pixelPoint.x, layer.dpi, appData, layer.width));
  panel.yLabel.setValue("Y: " + formatDocLength(pixelPoint.y, layer.dpi, appData, layer.height))
}
