/**
 * Histogram panel: RGB / luminance histograms for the active document.
 * Recomputes on open/refresh; when a selection is active, scopes counts to the
 * selection rect and pads the top bin for transparent coverage.
 */
import { Rect } from "../../core/math/rect.js";
import { ThemeConfig } from "../config/theme-config.js";
import { BaseTool } from "../widgets/base-tool.js";
import { ChannelModeSelect } from "../widgets/controls/panel-widgets.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { isInDOM, makeElement } from "../../core/dom.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { computeHistogram, copyPixels, multiplyAlphaByMask } from "../../engine/compositing/pixel-ops.js";

function HistogramPanel() {
  BaseTool.call(this, "panels.histogram", false, getIconUrl("panels/histogram"), BaseTool.PanelId.HISTOGRAM, true);
  const wrapper = makeElement("div", "padded");
  this.panelBody.appendChild(wrapper);
  this.channelSelect = new ChannelModeSelect(256, true);
  wrapper.appendChild(this.channelSelect.el);
  this.activeDoc = null
}
HistogramPanel.prototype = Object.create(BaseTool.prototype);

HistogramPanel.prototype.open = function(doc) {
  this.activeDoc = doc;
  this.redraw()
};

HistogramPanel.prototype.redraw = function() {
  if (!isInDOM(this.panelBody)) return;
  const doc = this.activeDoc;
  if (doc == null || doc.selectedLayerIndices.length == 0) {
    this.channelSelect.setValue(computeHistogram(allocBuffer(4)));
    return
  }
  const sampled = sampleDocumentPixelsForHistogram(doc),
    hist = computeHistogram(sampled.pixels);
  padHistogramTransparentBins(hist, sampled.area);
  this.channelSelect.setValue(hist, sampled.area)
};

HistogramPanel.prototype.onUpdate = function(doc, popupType) {
  this.channelSelect.setHistogramFillColor(ThemeConfig.themes[doc.theme]["--text-color"])
};

HistogramPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  this.channelSelect.buildUI()
};

HistogramPanel.prototype.refresh = function() {
  this.redraw()
};

export { HistogramPanel };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function sampleDocumentPixelsForHistogram(doc) {
  const pixels = doc.getRasterData(),
    bounds = new Rect(0, 0, doc.width, doc.height),
    area = bounds.area();
  if (!doc.selectionMask) {
    return {
      pixels: pixels,
      area: area
    }
  }
  const selRect = doc.selectionMask.rect,
    clipped = allocBuffer(selRect.area() * 4);
  copyPixels(pixels, bounds, clipped, selRect);
  multiplyAlphaByMask(doc.selectionMask.channel, clipped);
  return {
    pixels: clipped,
    area: measureSelectionCoverage(doc.selectionMask.channel)
  }
}

function measureSelectionCoverage(selMask) {
  let area = 0;
  for (let i = 0; i < selMask.length; i++) area += selMask[i];
  return Math.round(area / 255)
}

/**
 * Inflate the top histogram bin so transparent (or partially covered) pixels
 * still contribute to the plotted area. Channel 0 (luma/RGB composite) gets
 * a 3x residual; R/G/B each get a 1x residual vs hist[5] opaque count.
 */
function padHistogramTransparentBins(hist, area) {
  hist[0][255] += 3 * (area - hist[5]);
  for (let i = 1; i < 4; i++) hist[i][255] += area - hist[5]
}
