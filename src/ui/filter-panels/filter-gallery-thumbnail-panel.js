/**
 * Left scrollable column of Filter Gallery previews: per-filter thumbnails
 * grouped by {@link GalleryFilterDefs.filterGroupLocaleKeys}.
 *
 * Thumbnails are built lazily on first {@link FilterGalleryThumbnailPanel#build}
 * (typically from the gallery dialog's first `setValue`).
 */
import { Locale } from "../../core/i18n/locale.js";
import { Rect } from "../../core/math/rect.js";
import { GalleryFilterDefs } from "../../features/filters/gallery/gallery-filter-defs.js";
import { devToolsBinDb } from "../../document/formats/registry/registry-helpers.js";
import { addClass, clearElement, getDevicePixelRatio, makeElement, removeClass } from "../../core/dom.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../engine/compositing/pixel-ops.js";
import {
  loadPersistedFilterGalleryThumbnails,
  persistFilterGalleryThumbnails,
} from "../../features/filters/gallery/filter-gallery-thumbnail-store.js";

export const FILTER_GALLERY_THUMB_COLUMN_COUNT = 3;
/** Thumbnail strip width = viewport width / this divisor (e.g. 2560px → 320px). */
export const FILTER_GALLERY_THUMB_VIEWPORT_WIDTH_DIVISOR = 10;
/** Floor so three columns stay usable on smaller displays. */
export const FILTER_GALLERY_THUMB_COLUMN_MIN_WIDTH = 240;
/** Matches `.scrollable` scrollbar width in `all.css`. */
const FILTER_GALLERY_THUMB_SCROLLBAR_WIDTH = 10;

/**
 * In-memory rendered thumbnails ({@link filterKey} → data URL), keyed by rasterized
 * size. Filters are deterministic for a given size, so each size is rendered at most
 * once per run. This map is the fast path in front of the persistent store: at load
 * {@link precomputeFilterGalleryThumbnails} fills it from disk when possible and only
 * renders (and re-persists) on a miss. Only a display-resolution change produces a new
 * size key.
 * @type {Map<string, Object.<string, string>>}
 */
const thumbnailsBySignature = new Map();

/**
 * Revision of the rasterized artwork itself, independent of its size. Bump it
 * whenever what gets painted changes, so a persisted set rendered by an earlier
 * revision is treated as a miss instead of being reused at the same size.
 * r2: the filter name moved out of the bitmap into the DOM.
 */
const THUMBNAIL_ARTWORK_REVISION = "r2";

/** Cache key for one rasterized thumbnail size and artwork revision. */
export function filterGalleryThumbnailSignature(thumbW, thumbH) {
  return thumbW + "x" + thumbH + "-" + THUMBNAIL_ARTWORK_REVISION;
}

/**
 * Memoized thumbnail set for a size signature; `computeFn` runs only on a cache
 * miss and its result is cached only when it returns (a throw leaves the slot empty).
 * @param {string} signature
 * @param {function(): Object.<string, string>} computeFn
 * @returns {Object.<string, string>}
 */
export function getOrComputeFilterGalleryThumbnails(signature, computeFn) {
  let thumbnails = thumbnailsBySignature.get(signature);
  if (thumbnails == null) {
    thumbnails = computeFn();
    thumbnailsBySignature.set(signature, thumbnails);
  }
  return thumbnails;
}

/** Drop all in-memory cached thumbnails (test isolation / forced rebuild). */
export function clearFilterGalleryThumbnailCache() {
  thumbnailsBySignature.clear();
}

/**
 * True when `thumbnails` carries a data URL for every current gallery filter.
 * A persisted set that predates a newly added filter fails this check and is
 * treated as a miss so the panel re-renders the full set.
 * @param {Object.<string, string>|null} thumbnails
 * @returns {boolean}
 */
function hasAllFilterGalleryThumbnails(thumbnails) {
  if (thumbnails == null) return false;
  for (const filterKey in GalleryFilterDefs.names) {
    if (typeof thumbnails[filterKey] !== "string") return false;
  }
  return true;
}

/**
 * Return the in-memory thumbnails for a size, rendering them on a miss and
 * writing the freshly rendered set to the persistent store (fire-and-forget).
 * @param {string} signature
 * @param {Object} layout
 * @returns {Object.<string, string>}
 */
function ensureFilterGalleryThumbnailsInMemory(signature, layout) {
  let thumbnails = thumbnailsBySignature.get(signature);
  if (thumbnails == null) {
    thumbnails = computeFilterThumbnailDataUrls(layout);
    thumbnailsBySignature.set(signature, thumbnails);
    persistFilterGalleryThumbnails(signature, thumbnails);
  }
  return thumbnails;
}

/**
 * Best-effort host width in CSS pixels (document view, window, or screen).
 * @param {number} [fallbackCssWidth] e.g. dialog `maxW` from DocumentView.
 * @returns {number}
 */
function resolveFilterGalleryHostCssWidth(fallbackCssWidth) {
  let cssW = 0;
  if (typeof window !== "undefined") {
    cssW = Math.max(
      window.innerWidth || 0,
      document.documentElement ? document.documentElement.clientWidth || 0 : 0,
    );
    if (window.screen && window.screen.width > 0) cssW = Math.max(cssW, window.screen.width);
  }
  if (fallbackCssWidth > 0) cssW = Math.max(cssW, fallbackCssWidth);
  return cssW > 0 ? cssW : 1024;
}

/**
 * Thumbnail strip width in CSS pixels. Uses physical horizontal pixels (CSS width × DPR)
 * so a 2560px-wide display at 2× DPR yields ~320px, not 160px clamped to the floor.
 *
 * @param {number} [hostCssWidth] Document-view or dialog `maxW` when known.
 * @returns {number}
 */
export function computeFilterGalleryThumbColumnWidth(hostCssWidth) {
  const cssW = resolveFilterGalleryHostCssWidth(hostCssWidth);
  const horizontalPx = Math.round(cssW * getDevicePixelRatio());
  return Math.max(
    FILTER_GALLERY_THUMB_COLUMN_MIN_WIDTH,
    Math.floor(horizontalPx / FILTER_GALLERY_THUMB_VIEWPORT_WIDTH_DIVISOR),
  );
}

function resolveLocalizedLabel(localeKey, fallbackText) {
  const label = Locale.get(localeKey);
  if (label == null || label === "") return fallbackText || "";
  return label;
}

/** Pixel and CSS cell sizes for one thumbnail grid inside the column. */
function computeThumbnailCellLayout(thumbnailColumnWidth) {
  const columnCount = FILTER_GALLERY_THUMB_COLUMN_COUNT;
  const contentCssW = thumbnailColumnWidth - FILTER_GALLERY_THUMB_SCROLLBAR_WIDTH;
  const cssCellW = Math.floor(contentCssW / columnCount);
  const devicePixelRatio = getDevicePixelRatio();
  const thumbW = Math.max(1, Math.round(cssCellW * devicePixelRatio));
  const thumbH = Math.floor(thumbW * 0.7);
  return {
    columnCount: columnCount,
    cssCellW: cssCellW,
    thumbW: thumbW,
    thumbH: thumbH,
  };
}

function copySourceIntoThumbBuffer(sourceImg, srcBuf, thumbW, thumbH) {
  const sourceRect = sourceImg.rect;
  copyPixels(
    new Uint8Array(sourceImg.data),
    sourceRect,
    srcBuf,
    new Rect(
      Math.round((sourceRect.width - thumbW) / 2),
      Math.round((sourceRect.height - thumbH) / 2),
      thumbW,
      thumbH,
    ),
  );
}

/**
 * The scrollable thumbnail column widget itself. Owns the DOM element (`this.el`)
 * and, once {@link FilterGalleryThumbnailPanel#build} runs, one clickable `<img>`
 * per gallery filter. Fires {@link FilterGalleryThumbnailPanel#onSelect} with the
 * chosen filter key so the gallery dialog can swap the previewed filter.
 * @param {number} [thumbnailColumnWidth] If omitted, uses {@link computeFilterGalleryThumbColumnWidth}.
 */
export function FilterGalleryThumbnailPanel(thumbnailColumnWidth) {
  this.thumbnailColumnWidth = thumbnailColumnWidth != null
    ? thumbnailColumnWidth
    : computeFilterGalleryThumbColumnWidth();
  this.el = makeElement("div", "form scrollable filter-gallery-browser");
  this.applyColumnWidthStyles();
  /** @type {Object.<string, HTMLElement>|null} */
  this.thumbnailEls = null;
  this.activeFilterKey = "";
  /** @type {function(string): void} */
  this.onSelect = null;
}

FilterGalleryThumbnailPanel.prototype.applyColumnWidthStyles = function() {
  const columnWidth = this.thumbnailColumnWidth;
  this.el.setAttribute(
    "style",
    "width:" + columnWidth + "px; min-width:" + columnWidth + "px; flex-shrink:0"
  );
};

/**
 * @param {number} width
 * @returns {boolean} True when the width changed (caller may need to rebuild thumbnails).
 */
FilterGalleryThumbnailPanel.prototype.setColumnWidth = function(width) {
  width = Math.max(FILTER_GALLERY_THUMB_COLUMN_MIN_WIDTH, Math.floor(width));
  if (width === this.thumbnailColumnWidth) return false;
  this.thumbnailColumnWidth = width;
  this.applyColumnWidthStyles();
  return true;
};

FilterGalleryThumbnailPanel.prototype.setHeight = function(heightPx) {
  this.el.style.height = heightPx + "px";
};

FilterGalleryThumbnailPanel.prototype.setActiveFilter = function(key) {
  this.activeFilterKey = key;
  for (const filterKey in this.thumbnailEls) removeClass(this.thumbnailEls[filterKey], "selected");
  if (this.thumbnailEls && this.thumbnailEls[key]) addClass(this.thumbnailEls[key], "selected");
};

/**
 * Rasterize every gallery filter's preview for a layout into a
 * `{ filterKey: dataURL }` map. Deterministic for a given layout size — the same
 * "beach" sample and each filter's default descriptor always yield the same image.
 */
function computeFilterThumbnailDataUrls(layout) {
  const sourceImg = devToolsBinDb.get("img/beach", true)[0];
  const thumbW = layout.thumbW;
  const thumbH = layout.thumbH;
  const thumbRect = new Rect(0, 0, thumbW, thumbH);
  const srcBuf = allocBuffer(thumbW * thumbH * 4);
  const dstBuf = srcBuf.slice(0);
  const imageData = new ImageData(new Uint8ClampedArray(dstBuf.buffer), thumbW, thumbH);

  copySourceIntoThumbBuffer(sourceImg, srcBuf, thumbW, thumbH);

  const canvas = makeElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = thumbW;
  canvas.height = thumbH;

  const dataUrls = {};
  for (const filterKey in GalleryFilterDefs.names) {
    GalleryFilterDefs.applyGalleryFilterToPixels(
      filterKey,
      { rect: thumbRect, buffer: srcBuf },
      GalleryFilterDefs.create(filterKey),
      { h: 0, l: 0, O: 0 }, { h: 255, l: 255, O: 255 },
      { rect: thumbRect, buffer: dstBuf }, {},
    );
    ctx.putImageData(imageData, 0, 0);
    dataUrls[filterKey] = canvas.toDataURL();
  }
  return dataUrls;
}

/**
 * Warm the filter-gallery thumbnails for the current display size so the gallery
 * opens instantly. Reads them from the persistent store when a matching set is on
 * disk; otherwise renders every filter once and writes the result back, so a later
 * app run reads instead of re-rendering. Best-effort and idempotent: resolves false
 * when the sample image or gallery filters are not ready yet, and is safe to call
 * before the gallery is ever opened. Scheduled once at app load (see main.js).
 * @returns {Promise<boolean>} true when thumbnails are cached for the current size.
 */
export async function precomputeFilterGalleryThumbnails() {
  if (GalleryFilterDefs.names == null) return false;
  const binDb = devToolsBinDb;
  if (binDb == null || typeof binDb.get !== "function") return false;
  const sampleImg = binDb.get("img/beach", true);
  if (!sampleImg || !sampleImg[0]) return false;
  const layout = computeThumbnailCellLayout(computeFilterGalleryThumbColumnWidth());
  const signature = filterGalleryThumbnailSignature(layout.thumbW, layout.thumbH);
  if (thumbnailsBySignature.has(signature)) return true;

  const persisted = await loadPersistedFilterGalleryThumbnails(signature);
  if (hasAllFilterGalleryThumbnails(persisted)) {
    thumbnailsBySignature.set(signature, persisted);
    return true;
  }

  ensureFilterGalleryThumbnailsInMemory(signature, layout);
  return true;
}

/**
 * (Re)builds the thumbnail column DOM. Clears it first so it is safe to call
 * multiple times (e.g. after a width change). Thumbnails come from the in-memory
 * cache warmed at load; on a miss (e.g. the column width changed at runtime) they
 * are rendered and persisted here (see {@link precomputeFilterGalleryThumbnails}).
 */
FilterGalleryThumbnailPanel.prototype.build = function() {
  clearElement(this.el);
  this.thumbnailEls = {};

  const container = this.el;
  const layout = computeThumbnailCellLayout(this.thumbnailColumnWidth);
  const signature = filterGalleryThumbnailSignature(layout.thumbW, layout.thumbH);
  const thumbnailDataUrls = ensureFilterGalleryThumbnailsInMemory(signature, layout);
  const columnCount = layout.columnCount;
  const clickHandler = this.onThumbnailClick.bind(this);

  for (let groupIdx = 0; groupIdx < GalleryFilterDefs.filterGroupLocaleKeys.length; groupIdx++) {
    const groupKey = GalleryFilterDefs.filterGroupLocaleKeys[groupIdx];
    const groupEl = makeElement("div", "filter-gallery-group");
    container.appendChild(groupEl);
    groupEl.textContent = resolveLocalizedLabel(
      groupKey,
      typeof groupKey === "string" ? groupKey : "",
    );

    const thumbGridEl = makeElement("div", "filter-gallery-grid");
    thumbGridEl.setAttribute(
      "style",
      "grid-template-columns:repeat(" + columnCount + "," + layout.cssCellW + "px);",
    );
    container.appendChild(thumbGridEl);

    for (const filterKey in GalleryFilterDefs.names) {
      const filterMeta = GalleryFilterDefs.names[filterKey];
      if (filterMeta[0] !== groupIdx) continue;

      const thumbEl = makeElement("div");
      thumbGridEl.appendChild(thumbEl);
      addClass(thumbEl, "filter-gallery-thumb");
      thumbEl.addEventListener("click", clickHandler, false);
      const img = makeElement("img");
      thumbEl.appendChild(img);
      img.setAttribute("src", thumbnailDataUrls[filterKey]);
      // The name lives in the DOM rather than baked into the thumbnail so it
      // follows the theme, elides when long, and keeps a full-text tooltip.
      const filterLabel = resolveLocalizedLabel(filterMeta[1], filterMeta[2] || "");
      const labelEl = makeElement("div", "filter-gallery-thumb-label");
      labelEl.textContent = filterLabel;
      labelEl.setAttribute("title", filterLabel);
      thumbEl.appendChild(labelEl);
      this.thumbnailEls[filterKey] = thumbEl;
    }
  }
};

FilterGalleryThumbnailPanel.prototype.onThumbnailClick = function(evt) {
  for (const filterKey in this.thumbnailEls) {
    if (this.thumbnailEls[filterKey] === evt.currentTarget) {
      this.activeFilterKey = filterKey;
      break;
    }
  }
  if (this.onSelect) this.onSelect(this.activeFilterKey);
};
