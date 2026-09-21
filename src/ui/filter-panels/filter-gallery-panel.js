import { Locale } from "../../core/i18n/locale.js";
import { PanelWrapper } from "../widgets/controls/panel-widgets.js";
import { FilterParameterPanel } from "./filter-parameter-panel.js";
import { GalleryFilterDefs } from "../../features/filters/gallery/gallery-filter-defs.js";
import { FilterBandRunner } from "../../features/filters/gallery/filter-band-runner.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import {
  computeFilterGalleryThumbColumnWidth,
  FilterGalleryThumbnailPanel
} from "./filter-gallery-thumbnail-panel.js";
import { FilterStackPanel } from "./filter-stack-panel.js";
import { addClass, makeElement } from "../../core/dom.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../engine/compositing/pixel-ops.js";

/**
 * The Filter Gallery dialog. Three columns:
 *   1. live preview of the source pixels with the filter stack applied,
 *   2. a thumbnail strip to pick the active filter,
 *   3. a stack list + parameter editor for the chosen filter(s).
 *
 * The descriptor it edits keeps these format keys verbatim — they are serialized
 * into the document: `GEfc` (classID), `GEfs` (filter stack VlLs), `GEfk`/`GEft`
 * (filter key), `GELv` (per-filter visibility bool), and the per-filter param keys
 * (`Ptch`, `SqrS`, `Rlf`, …).
 *
 * Preview runs at full source resolution: many gallery filters are pixel-size
 * aware (mosaic tile size, ripple wavelength, glass displacement, grain), so any
 * resample of the source would mislead. For the heavy patchwork filter the render
 * is parallelised across a worker pool ({@link FilterBandRunner}), producing the
 * same pixels as the single-threaded path. Everything else renders synchronously on
 * the main thread.
 */
FilterParameterPanel.GEfc = function () {
  FilterParameterPanel.call(this, "GEfc");
  this.dialogWidth = 0;
  this.dialogHeight = 0;
  this.sourceBuffer = null;
  this.previewBuffer = null;
  this.previewRect = null;
  this._redrawScheduled = false;
  // Single-flight guard for the async banded preview: while a worker render is in
  // flight we don't start another; if the params change meanwhile we re-render once
  // it lands so the final frame always reflects the latest state.
  this._previewBusy = false;
  this._previewDirty = false;
  this._overlayTimer = null;
  this.doc = null;
  this.filterState = null;
  this.activeFilterIndex = 0;
  this.activeFilterKey = "";

  var container = makeElement("div", "flexrow filter-gallery-panel");
  container.style.position = "relative";
  this.containerEl = container;
  this.el.appendChild(container);

  this.view = new PanelWrapper;
  addClass(this.view.el, "filter-gallery-preview");
  this.view.resize(100, 100);
  container.appendChild(this.view.el);

  // Cue shown over the preview while an off-main-thread render is in flight. Sized to
  // the preview column in resize(); pointer-events:none so it never blocks the UI.
  this.previewOverlay = makeElement("div", "ps-preview-overlay");
  this.previewOverlay.textContent = Locale.get("filters.options.previewing");
  this.previewOverlay.style.cssText =
    "position:absolute;left:0;top:0;display:none;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,0.35);color:#fff;font-size:14px;letter-spacing:0.5px;" +
    "pointer-events:none;z-index:5;";
  container.appendChild(this.previewOverlay);

  this.thumbnailPanel = new FilterGalleryThumbnailPanel();
  container.appendChild(this.thumbnailPanel.el);
  this.thumbnailPanel.onSelect = this._onThumbnailSelected.bind(this);

  this.stackPanel = new FilterStackPanel(this);
  container.appendChild(this.stackPanel.el);
  this.stackPanel.onParamChanged = this._onParamChanged.bind(this);
  this.stackPanel.onStackAction = this._onStackAction.bind(this);

  // Stack-list item clicks (select / visibility toggle) bubble here via BaseWidget.
  this.on("click", this.onFilterStackItemClick, this);
};
FilterParameterPanel.GEfc.prototype = Object.create(FilterParameterPanel.prototype);

FilterParameterPanel.GEfc.prototype.opensAsModalDialog = function () {
  return true;
};

/** CSS width of the host viewport, read from the enclosing dialog's parent view. */
FilterParameterPanel.GEfc.prototype.getHostViewportCssWidth = function () {
  var dialog = this.parent;
  if (dialog && dialog.parent && dialog.parent.viewWidth > 0) return dialog.parent.viewWidth;
  return 0;
};

FilterParameterPanel.GEfc.prototype.syncThumbnailColumnWidth = function (fallbackCssWidth) {
  var hostCssWidth = this.getHostViewportCssWidth();
  if (fallbackCssWidth > 0) hostCssWidth = Math.max(hostCssWidth, fallbackCssWidth);
  return this.thumbnailPanel.setColumnWidth(computeFilterGalleryThumbColumnWidth(hostCssWidth));
};

FilterParameterPanel.GEfc.prototype.getPreferredDialogSize = function (maxWidth, maxHeight) {
  this.syncThumbnailColumnWidth(maxWidth);
  var thumbWidth = this.thumbnailPanel.thumbnailColumnWidth,
    minWidth = thumbWidth + 120 + 250 + 32,
    minHeight = 420,
    targetWidth = Math.round(maxWidth * 0.78),
    targetHeight = Math.round(maxHeight * 0.72);
  return {
    width: Math.min(Math.max(minWidth, targetWidth), maxWidth),
    height: Math.min(Math.max(minHeight, targetHeight), Math.min(860, maxHeight))
  };
};

FilterParameterPanel.GEfc.prototype.appendCategoryHeader = function (headerEl) {
  this.stackPanel.appendCategoryHeader(headerEl);
};

FilterParameterPanel.GEfc.prototype.onUpdate = function (doc, changeKind) {
  this.doc = doc;
};
FilterParameterPanel.GEfc.prototype.onDocumentUpdate = FilterParameterPanel.GEfc.prototype.onUpdate;

FilterParameterPanel.GEfc.prototype.resize = function (width, height) {
  this.dialogWidth = width;
  this.dialogHeight = height;
  if (this.syncThumbnailColumnWidth(0) && this.thumbnailPanel.thumbnailEls != null) {
    this.thumbnailPanel.build();
    this.thumbnailPanel.setActiveFilter(this.activeFilterKey);
  }
  this.thumbnailPanel.setHeight(height);
  var thumbColumn = this.thumbnailPanel.thumbnailColumnWidth,
    reservedForRight = 260,
    previewWidth = Math.max(160, width - thumbColumn - reservedForRight);
  this.view.resize(previewWidth, Math.max(120, height));
  this.previewOverlay.style.width = previewWidth + "px";
  this.previewOverlay.style.height = Math.max(120, height) + "px";
  this.stackPanel.resize(height);
};

FilterParameterPanel.GEfc.prototype.renderFilterStack = function () {
  this.activeFilterKey = this.stackPanel.render(this.filterState, this.activeFilterIndex);
  this.thumbnailPanel.setActiveFilter(this.activeFilterKey);
  this.resize(this.dialogWidth, this.dialogHeight);
};

FilterParameterPanel.GEfc.prototype._onThumbnailSelected = function (filterKey) {
  this.activeFilterKey = filterKey;
  this.filterState.GEfs.v[this.activeFilterIndex].v = GalleryFilterDefs.create(filterKey);
  this.renderFilterStack();
  this.redraw();
};

FilterParameterPanel.GEfc.prototype._onParamChanged = function (widgetEvent) {
  this.filterState.GEfs.v[this.activeFilterIndex].v = this.stackPanel.getParamValue(this.activeFilterKey);
  // A pure parameter change alters neither the stack structure nor the active
  // filter, so skip renderFilterStack() here: it tears down and rebuilds the
  // stack-list DOM and calls resize(), which forces a synchronous layout reflow
  // and a preview-canvas resize on every slider tick. Only the preview changes.
  this.redraw();
};

FilterParameterPanel.GEfc.prototype._onStackAction = function (buttonIdx) {
  var stack = this.filterState.GEfs.v;
  if (buttonIdx === 0) {
    stack.push(JSON.parse(JSON.stringify(stack[this.activeFilterIndex])));
    this.activeFilterIndex = stack.length - 1;
  } else if (stack.length > 1) {
    stack.splice(this.activeFilterIndex, 1);
    if (this.activeFilterIndex === stack.length) this.activeFilterIndex--;
  }
  this.renderFilterStack();
  this.redraw();
};

FilterParameterPanel.GEfc.prototype.onFilterStackItemClick = function (event) {
  var data = event.data,
    idx = data.idx,
    stack = this.filterState.GEfs.v;
  // isVisibilityEyeClick is set by LayerListItem when the visibility (eye)
  // control was the click target; otherwise the click just selects the row.
  if (data.isVisibilityEyeClick) {
    stack[idx].v.GELv.v = !stack[idx].v.GELv.v;
    this.redraw();
  } else {
    this.activeFilterIndex = idx;
  }
  this.renderFilterStack();
};

FilterParameterPanel.GEfc.prototype.setValue = function (
  descriptor, sourceBuffer, sourceRect, priorRect, _rasterUnderLayer, _dialogContext
) {
  this.syncThumbnailColumnWidth(this.dialogWidth);
  if (this.thumbnailPanel.thumbnailEls === null) this.thumbnailPanel.build();

  descriptor = this.filterState = JSON.parse(JSON.stringify(descriptor));
  // A bare single-filter descriptor (no stack) is wrapped into a one-entry stack.
  if (descriptor.GEfs == null) {
    descriptor = this.filterState = {
      __name: "Filter Gallery",
      classID: "GEfc",
      GEfs: { t: "VlLs", v: [{ t: "Objc", v: descriptor }] }
    };
  }
  var stack = descriptor.GEfs.v;
  for (var i = 0; i < stack.length; i++) {
    if (stack[i].v.GELv == null) stack[i].v.GELv = { t: "bool", v: true };
  }
  this.activeFilterIndex = stack.length - 1;
  this.renderFilterStack();

  sourceRect = sourceRect.clone();
  if (sourceBuffer == null) return;
  // If the filter's effect extends beyond the selection (K3 reports a non-zero
  // extent) and the prior rect differs, expand to the union and copy the source
  // pixels into a buffer covering that larger region so edges render correctly.
  if (!priorRect.equals(sourceRect) && GalleryFilterDefs.galleryFilterPadding(descriptor).x != 0) {
    var union = sourceRect.union(priorRect),
      expanded = allocBuffer(union.area() * 4);
    copyPixels(sourceBuffer, sourceRect, expanded, union);
    sourceBuffer = expanded;
    sourceRect = union;
  }
  sourceRect.x = sourceRect.y = 0;

  this.sourceBuffer = sourceBuffer;
  this.previewBuffer = sourceBuffer.slice(0);
  this.previewRect = sourceRect;
  this.redraw();

  // Spin up (and JIT-warm) the worker pool while the dialog is opening, so the
  // first banded preview isn't paying cold-start costs.
  FilterBandRunner.prewarm();

  var self = this;
  setTimeout(function () {
    if (self.dialogWidth > 40 && self.dialogHeight > 40) self.resize(self.dialogWidth, self.dialogHeight);
  }, 300);
};

FilterParameterPanel.GEfc.prototype.getValue = function () {
  return JSON.parse(JSON.stringify(this.filterState));
};

FilterParameterPanel.GEfc.prototype.redraw = function () {
  // Coalesce bursts of parameter changes (sliders fire many events per second)
  // into at most one render per frame. The rAF callback always reads the latest
  // filterState (callers mutate it in place first), so dropped ticks cost nothing.
  if (this._redrawScheduled) return;
  this._redrawScheduled = true;
  var self = this;
  requestAnimationFrame(function () {
    self._redrawScheduled = false;
    self._renderPreview();
  });
};

FilterParameterPanel.GEfc.prototype._renderPreview = function () {
  if (this.sourceBuffer == null) return;
  // Single-flight: one render at a time; rapid slider moves coalesce to the latest
  // (we re-render once the in-flight one lands).
  if (this._previewBusy) { this._previewDirty = true; return; }
  this._previewBusy = true;

  var self = this, stack = this.filterState.GEfs.v;
  var offloadable = stack.length === 1 && typeof Worker !== "undefined" &&
    FilterBandRunner.canOffload(this.activeFilterKey);

  // Diagnostic (window.__BAND): run the bench standalone (its byte-diff count must
  // not be muddied by a concurrent live banded run) and render the preview on the
  // main thread instead. Only band-mode filters are benchable.
  if (typeof window !== "undefined" && window.__BAND && stack.length === 1 &&
      FilterBandRunner.canBench(this.activeFilterKey)) {
    FilterBandRunner.benchFilter(this.activeFilterKey, stack[0].v,
      this.sourceBuffer, this.previewRect.width, this.previewRect.height, +window.__BAND || 0);
    offloadable = false;
  }

  // Show the "Previewing…" cue. Parallel renders defer it 150 ms so quick ones don't
  // flash; blocking (main-thread) renders show it immediately so it paints before the
  // thread locks up. A single timer/flag spans any mid-flight re-render chain.
  this._showOverlay(offloadable ? 150 : 0);

  var work;
  try {
    if (offloadable) {
      var rect = this.previewRect, key = this.activeFilterKey, descriptor = stack[0].v;
      work = FilterBandRunner.runFilterKey(key, descriptor, this.sourceBuffer, rect.width, rect.height, this._paletteColors())
        .then(
          function (dst) { self.view.setValue([{ rect: rect, data: dst.buffer }]); },
          function (err) {
            console.error("[GEfc] worker preview failed:", err && err.message ? err.message : err);
            return self._renderSyncDeferred();
          }
        );
    } else {
      work = this._renderSyncDeferred();
    }
  } catch (err) {
    console.error("[GEfc] preview setup failed:", err && err.message ? err.message : err);
    work = this._renderSyncDeferred();
  }

  Promise.resolve(work).then(function () {
    self._previewBusy = false;
    if (self._previewDirty) { self._previewDirty = false; self._renderPreview(); }
    else self._hideOverlay();
  }, function () {
    self._previewBusy = false;
    self._hideOverlay();
  });
};

FilterParameterPanel.GEfc.prototype._showOverlay = function (delayMs) {
  if (delayMs <= 0) { this.previewOverlay.style.display = "flex"; return; }
  if (this._overlayTimer != null) return;
  var self = this;
  this._overlayTimer = setTimeout(function () {
    if (self._previewBusy) self.previewOverlay.style.display = "flex";
  }, delayMs);
};

FilterParameterPanel.GEfc.prototype._hideOverlay = function () {
  if (this._overlayTimer != null) { clearTimeout(this._overlayTimer); this._overlayTimer = null; }
  this.previewOverlay.style.display = "none";
};

/** Foreground and background colours the filters colourise with, unpacked to {h,l,O} = R,G,B. */
FilterParameterPanel.GEfc.prototype._paletteColors = function () {
  // Palette state stores packed 0xRRGGBB ints under either {ui,VY} or
  // {colorInt,bgColor} depending on the producer.
  var palette = this.doc || { colorInt: 0, bgColor: 16777215 };
  var fgPacked =
    palette.ui != null ? palette.ui >>> 0 :
    palette.colorInt != null ? palette.colorInt >>> 0 : 0;
  var bgPacked =
    palette.VY != null ? palette.VY >>> 0 :
    palette.bgColor != null ? palette.bgColor >>> 0 : 16777215;
  function unpack(packed) {
    return { h: packed >>> 16, l: packed >>> 8 & 255, O: packed & 255 };
  }
  return { fg: unpack(fgPacked), bg: unpack(bgPacked) };
};

// Main-thread render of the full filter stack. It blocks the thread, so it's deferred
// across two animation frames first — that lets the browser paint the "Previewing…"
// cue (already shown) before the compute locks everything up. Returns a Promise that
// resolves once the result is on screen.
FilterParameterPanel.GEfc.prototype._renderSyncDeferred = function () {
  var self = this;
  return new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var rect = self.previewRect, colors = self._paletteColors();
        FilterDefs.applyFilterToPixels("GEfc",
          { rect: rect, buffer: self.sourceBuffer },
          self.filterState, colors.fg, colors.bg,
          { rect: rect, buffer: self.previewBuffer }, null);
        self.view.setValue([{ rect: rect, data: self.previewBuffer.buffer }]);
        resolve();
      });
    });
  });
};

FilterParameterPanel.GEfc.prototype.buildUI = function () {
  this.stackPanel.buildUI();
  if (this.thumbnailPanel.thumbnailEls !== null) {
    this.thumbnailPanel.build();
    this.renderFilterStack();
  }
};
