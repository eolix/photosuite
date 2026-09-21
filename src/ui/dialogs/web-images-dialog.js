/**
 * Modal window that searches the Openverse API
 * (Openverse API at api.openverse.org, v1 images collection) for Creative-Commons and
 * public-domain images, then places the chosen result into the active
 * document as a new raster layer.
 *
 * Anonymous limits (see Openverse API docs / response headers):
 * - page_size capped at 20
 * - ~1 search request per second
 * - burst: 20 requests per minute (X-RateLimit-Limit-anon_burst)
 * Previews use each result's source `url` (Flickr, etc.), not Openverse
 * /thumb/ URLs — the thumb proxy often returns HTTP 424 under load.
 */

import { Locale } from "../../core/i18n/locale.js";
import { BaseDialog } from "./base-dialog.js";
import { Button, TextInput } from "../widgets/form-controls.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, clearElement, isInDOM, makeElement, removeClass } from "../../core/dom.js";
import { openExternalUrl } from "../../core/tauri-host.js";
import { AppEvent } from "../../core/event-bus.js";

const API_MIN_INTERVAL_MS = 1000;
const LOAD_MORE_INTERVAL_MS = 3000;
const PREVIEW_STAGGER_MS = 120;
const BURST_EXHAUSTED_WAIT_MS = 60000;
const OPENVERSE_PAGE_SIZE = 20;

function buildOpenverseImagesSearchUrl(query, page) {
  return "https://api.openverse.org/v1/images/"
    + "?q=" + encodeURIComponent(query)
    + "&page=" + page
    + "&page_size=20"
    + "&license_type=commercial,modification";
}

function resolveTotalPages(pageCount, page, pageResultsLength, append, previousTotalPages) {
  if (typeof pageCount === "number" && pageCount > 0) return pageCount;
  if (!append && pageResultsLength >= OPENVERSE_PAGE_SIZE) return page + 1;
  if (append && pageResultsLength >= OPENVERSE_PAGE_SIZE) return Math.max(previousTotalPages, page + 1);
  return previousTotalPages;
}

/** Milliseconds to wait from Openverse rate-limit headers, or 0 when unrestricted. */
function computeRateLimitWaitMs(xhr, burstExhaustedWaitMs) {
  const burstLeft = xhr.getResponseHeader("X-RateLimit-Available-anon_burst");
  if (burstLeft != null && burstLeft !== "" && parseInt(burstLeft, 10) === 0) {
    return burstExhaustedWaitMs;
  }
  const retryAfter = xhr.getResponseHeader("Retry-After");
  if (retryAfter != null) {
    const sec = parseInt(retryAfter, 10);
    if (!isNaN(sec) && sec > 0) return sec * 1000;
  }
  if (xhr.status === 429) return burstExhaustedWaitMs;
  return 0;
}

function buildResultTooltip(result) {
  const parts = [];
  if (result.title) parts.push(result.title);
  if (result.creator) parts.push("by " + result.creator);
  if (result.license) {
    let licenseLabel = String(result.license).toUpperCase();
    if (result.license_version) licenseLabel += " " + result.license_version;
    parts.push("(" + licenseLabel + ")");
  }
  return parts.join(" ") || Locale.get("dialogs.webImages.untitled");
}

function buildPlacementName(result) {
  const base = (result.title || result.id || "openverse")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 60) || "openverse";
  return base + ".jpg";
}

function formatPreviewStatusLine(visibleCount, searchQuery) {
  if (visibleCount === 0 && searchQuery) {
    return Locale.get(["dialogs.webImages.noLoadablePreviews", searchQuery]);
  }
  if (visibleCount > 0) {
    return Locale.get([
      visibleCount === 1 ? "dialogs.webImages.previewSingular" : "dialogs.webImages.previewPlural",
      String(visibleCount),
    ]);
  }
  return null;
}

function WebImagesDialog() {
  BaseDialog.call(this, "dialogs.placeFromWeb", "webimages");
  this.doc = null;
  this.results = [];
  this.activeRequest = null;
  this.searchQuery = "";
  this.currentPage = 1;
  this.totalPages = 0;
  this.hasMoreResults = false;
  this.lastApiRequestAt = 0;
  this.nextLoadMoreAt = 0;
  this.pendingSearch = null;
  this.apiRequestGeneration = 0;
  this.loadMoreQueued = false;
  this.loadMoreRetryTimer = null;
  this.loadMoreCooldownTimer = null;
  this.thumbStaggerTimer = null;
  this.thumbStaggerQueue = [];
  this.renderedResultCount = 0;

  this.enableUserResize();
  this.body.setAttribute("style", "padding:12px; display:flex; flex-direction:column; box-sizing:border-box; overflow:hidden; height:100%;");

  const searchRow = makeElement("div", "");
  searchRow.setAttribute("style", "display:flex; gap:8px; align-items:center; padding-bottom:8px; flex:0 0 auto;");

  this.searchInput = new TextInput(null, null, null);
  this.searchInput.el.setAttribute("style", "flex:1 1 auto; min-width:0;");
  this.searchInput.inputEl.setAttribute("placeholder", Locale.get("dialogs.webImages.searchPlaceholder"));
  this.searchInput.inputEl.setAttribute("style", "width:100%; box-sizing:border-box; padding:6px 8px;");
  this.searchInput.on(EventType.widgetSelect, this.onSearchSubmit, this);
  searchRow.appendChild(this.searchInput.el);

  this.searchBtn = new Button("properties.find", false, null, true);
  this.searchBtn.el.setAttribute("style", "flex:0 0 auto;");
  this.searchBtn.on("click", this.onSearchSubmit, this);
  searchRow.appendChild(this.searchBtn.el);

  this.statusEl = makeElement("div", "");
  this.statusEl.setAttribute("style", "font-size:0.85em; color:var(--text-muted); padding:4px 0 8px; flex:0 0 auto;");
  this.statusEl.textContent = Locale.get("dialogs.webImages.typeKeywordEnter");

  this.gridEl = makeElement("div", "scrollable");
  this.gridEl.setAttribute("style", "display:grid; grid-template-columns:repeat(5, 1fr); gap:8px; padding:4px 0; overflow-y:auto; flex:1 1 auto; min-height:0; align-items:start;");

  this.loadMoreBtn = new Button("topMenu.more", false, null, true);
  this.loadMoreBtn.el.setAttribute("style", "flex:0 0 auto; margin:8px auto 0; display:none;");
  this.loadMoreBtn.on("click", this.onLoadMore, this);

  this.attributionEl = makeElement("div", "");
  this.attributionEl.setAttribute("style", "font-size:0.75em; color:var(--text-faint); padding:8px 0 0; text-align:center; flex:0 0 auto;");
  this.attributionEl.textContent = "";
  this.attributionEl.appendChild(document.createTextNode(Locale.get("dialogs.webImages.attributionPrefix")));
  const openverseLink = makeElement("span", "");
  openverseLink.setAttribute("style", "color:var(--accent); cursor:pointer; text-decoration:underline;");
  openverseLink.textContent = "Openverse";
  this.attributionEl.appendChild(openverseLink);
  this.attributionEl.appendChild(document.createTextNode(Locale.get("dialogs.webImages.attributionSuffix")));
  openverseLink.addEventListener("click", function() {
    openExternalUrl("https://openverse.org");
  });

  this.body.appendChild(searchRow);
  this.body.appendChild(this.statusEl);
  this.body.appendChild(this.gridEl);
  this.body.appendChild(this.loadMoreBtn.el);
  this.body.appendChild(this.attributionEl);
}
WebImagesDialog.API_MIN_INTERVAL_MS = API_MIN_INTERVAL_MS;
WebImagesDialog.LOAD_MORE_INTERVAL_MS = LOAD_MORE_INTERVAL_MS;
WebImagesDialog.PREVIEW_STAGGER_MS = PREVIEW_STAGGER_MS;
WebImagesDialog.BURST_EXHAUSTED_WAIT_MS = BURST_EXHAUSTED_WAIT_MS;

WebImagesDialog.prototype = Object.create(BaseDialog.prototype);
WebImagesDialog.prototype.constructor = WebImagesDialog;

WebImagesDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.searchInput.buildUI();
  this.searchBtn.buildUI();
  this.loadMoreBtn.buildUI();
};

WebImagesDialog.prototype.onUpdate = function(doc) {
  this.doc = doc;
};

WebImagesDialog.prototype.open = function(doc) {
  this.doc = doc;
  setTimeout(function() {
    this.searchInput.focusAndSelectAll();
  }.bind(this), 0);
};

WebImagesDialog.prototype.onSearchSubmit = function() {
  const query = (this.searchInput.getValue() || "").trim();
  if (query.length === 0) {
    this.statusEl.textContent = Locale.get("dialogs.webImages.typeKeywordFirst");
    return;
  }
  this.runSearch(query, 1, false);
};

WebImagesDialog.prototype.onLoadMore = function() {
  if (!this.searchQuery || !this.hasMoreResults) return;
  this.loadMoreQueued = true;
  this.tryExecuteLoadMore();
};

/** One user click queues a single load-more; retries until cooldown and xhr slot are free. */
WebImagesDialog.prototype.tryExecuteLoadMore = function() {
  if (!this.loadMoreQueued) return;
  if (!this.searchQuery || !this.hasMoreResults) {
    this.loadMoreQueued = false;
    return;
  }
  if (this.activeRequest) {
    clearTimeout(this.loadMoreRetryTimer);
    this.loadMoreRetryTimer = setTimeout(this.tryExecuteLoadMore.bind(this), 150);
    return;
  }
  const waitMs = this.getApiCooldownMs(true);
  if (waitMs > 0) {
    clearTimeout(this.loadMoreRetryTimer);
    this.loadMoreRetryTimer = setTimeout(this.tryExecuteLoadMore.bind(this), waitMs + 50);
    return;
  }
  this.loadMoreQueued = false;
  clearTimeout(this.loadMoreRetryTimer);
  this.runSearch(this.searchQuery, this.currentPage + 1, true);
};

WebImagesDialog.prototype.getApiCooldownMs = function(append) {
  const minGap = append ? LOAD_MORE_INTERVAL_MS : API_MIN_INTERVAL_MS;
  const sinceLast = Date.now() - this.lastApiRequestAt;
  const sinceLoadMore = this.nextLoadMoreAt - Date.now();
  return Math.max(0, minGap - sinceLast, sinceLoadMore);
};

WebImagesDialog.prototype.applyRateLimitFromHeaders = function(xhr) {
  const waitMs = computeRateLimitWaitMs(xhr, BURST_EXHAUSTED_WAIT_MS);
  if (waitMs > 0) this.nextLoadMoreAt = Date.now() + waitMs;
};

WebImagesDialog.prototype.updateHasMoreResults = function() {
  if (this.totalPages > 0) {
    this.hasMoreResults = this.currentPage < this.totalPages;
  } else {
    this.hasMoreResults = false;
  }
};

WebImagesDialog.prototype.getLoadMoreBaseLabel = function() {
  return Locale.get("topMenu.more");
};

WebImagesDialog.prototype.getLoadingLabel = function() {
  return Locale.get("history.loading");
};

WebImagesDialog.prototype.formatPlacingStatus = function(fileName) {
  return Locale.get("layer.smartObject.placingSmartObject")
    + " \u201C" + fileName + "\u201D\u2026";
};

WebImagesDialog.prototype.setLoadMoreInteractable = function(interactable) {
  const el = this.loadMoreBtn.el;
  el.disabled = !interactable;
  if (interactable) removeClass(el, "disabled");
  else addClass(el, "disabled");
};

WebImagesDialog.prototype.updateLoadMoreButton = function() {
  this.updateHasMoreResults();
  if (!this.hasMoreResults) {
    this.loadMoreBtn.el.style.display = "none";
    this.setLoadMoreInteractable(false);
    return;
  }
  const moreLabel = this.getLoadMoreBaseLabel();
  const waitMs = this.getApiCooldownMs(true);
  if (this.activeRequest) {
    this.loadMoreBtn.el.style.display = "block";
    this.loadMoreBtn.el.textContent = this.getLoadingLabel() + "\u2026";
    this.setLoadMoreInteractable(false);
    return;
  }
  if (waitMs > 0) {
    this.loadMoreBtn.el.style.display = "block";
    this.loadMoreBtn.el.textContent = moreLabel + " (" + Math.ceil(waitMs / 1000) + "s)";
    this.setLoadMoreInteractable(false);
    return;
  }
  this.loadMoreBtn.el.style.display = "block";
  this.loadMoreBtn.el.textContent = moreLabel + "\u2026";
  this.setLoadMoreInteractable(true);
};

WebImagesDialog.prototype.startLoadMoreCooldownTicker = function() {
  const self = this;
  globalThis.clearInterval(this.loadMoreCooldownTimer);
  this.loadMoreCooldownTimer = globalThis.setInterval(function() {
    self.updateLoadMoreButton();
    if (!self.hasMoreResults) {
      globalThis.clearInterval(self.loadMoreCooldownTimer);
      self.loadMoreCooldownTimer = null;
    }
  }, 250);
};

WebImagesDialog.prototype.cancelThumbStagger = function() {
  clearTimeout(this.thumbStaggerTimer);
  this.thumbStaggerTimer = null;
  this.thumbStaggerQueue = [];
};

/** Source CDN URL only — Openverse thumb CDN returns 424 when overloaded. */
WebImagesDialog.prototype.getPreviewImageUrl = function(result) {
  return result.url || null;
};

WebImagesDialog.prototype.enqueuePreviewLoad = function(cellEl, imgEl, previewUrl, result) {
  this.thumbStaggerQueue.push({
    cellEl: cellEl,
    imgEl: imgEl,
    url: previewUrl,
    result: result
  });
  if (this.thumbStaggerTimer == null) this.pumpPreviewQueue();
};

WebImagesDialog.prototype.removeBrokenResult = function(result) {
  const idx = this.results.indexOf(result);
  if (idx !== -1) this.results.splice(idx, 1);
  this.refreshStatusLine();
};

WebImagesDialog.prototype.refreshStatusLine = function() {
  const statusText = formatPreviewStatusLine(this.gridEl.childElementCount, this.searchQuery);
  if (statusText != null) this.statusEl.textContent = statusText;
  this.updateLoadMoreButton();
};

WebImagesDialog.prototype.pumpPreviewQueue = function() {
  const self = this;
  if (this.thumbStaggerQueue.length === 0) {
    this.thumbStaggerTimer = null;
    return;
  }
  const item = this.thumbStaggerQueue.shift();
  if (!isInDOM(item.imgEl)) {
    this.thumbStaggerTimer = setTimeout(function() {
      self.pumpPreviewQueue();
    }, 0);
    return;
  }
  item.imgEl.onerror = function() {
    if (item.cellEl && item.cellEl.parentNode) {
      item.cellEl.parentNode.removeChild(item.cellEl);
    }
    self.removeBrokenResult(item.result);
  };
  item.imgEl.onload = function(evt) {
    evt.target.style.opacity = "1";
  };
  item.imgEl.src = item.url;
  this.thumbStaggerTimer = setTimeout(function() {
    self.pumpPreviewQueue();
  }, PREVIEW_STAGGER_MS);
};

WebImagesDialog.prototype.runSearch = function(query, page, append) {
  const cooldown = this.getApiCooldownMs(append);
  if (cooldown > 0) {
    this.pendingSearch = {
      query: query,
      page: page,
      append: append
    };
    if (append) {
      this.statusEl.textContent = Locale.get(["dialogs.webImages.waitLoadMore", String(Math.ceil(cooldown / 1000))]);
    } else {
      this.statusEl.textContent = Locale.get(["dialogs.webImages.waitRateLimit", String(Math.ceil(cooldown / 1000))]);
    }
    this.updateLoadMoreButton();
    this.startLoadMoreCooldownTicker();
    clearTimeout(this.apiThrottleTimer);
    this.apiThrottleTimer = setTimeout(function() {
      const pending = this.pendingSearch;
      this.pendingSearch = null;
      if (pending) this.runSearch(pending.query, pending.page, pending.append);
    }.bind(this), cooldown);
    return;
  }
  this.pendingSearch = null;
  clearTimeout(this.apiThrottleTimer);

  if (!append) {
    this.statusEl.textContent = Locale.get(["dialogs.webImages.searching", query]);
    clearElement(this.gridEl);
    this.results = [];
    this.renderedResultCount = 0;
    this.searchQuery = query;
    this.currentPage = 1;
    this.totalPages = 0;
    this.hasMoreResults = false;
    this.nextLoadMoreAt = 0;
    this.loadMoreQueued = false;
    clearTimeout(this.loadMoreRetryTimer);
    this.loadMoreRetryTimer = null;
    this.cancelThumbStagger();
  } else {
    this.statusEl.textContent = this.getLoadingLabel() + "\u2026";
  }
  this.updateLoadMoreButton();

  if (this.activeRequest) {
    this.activeRequest.abort();
    this.activeRequest = null;
  }

  const endpoint = buildOpenverseImagesSearchUrl(query, page);

  this.apiRequestGeneration++;
  const requestGeneration = this.apiRequestGeneration;
  const xhr = new globalThis.XMLHttpRequest();
  this.activeRequest = xhr;
  xhr.open("GET", endpoint, true);
  xhr.responseType = "json";
  xhr.onload = function() {
    if (requestGeneration !== this.apiRequestGeneration) return;
    this.activeRequest = null;
    this.lastApiRequestAt = Date.now();
    if (append) {
      this.nextLoadMoreAt = Date.now() + LOAD_MORE_INTERVAL_MS;
    }
    this.applyRateLimitFromHeaders(xhr);
    if (xhr.status < 200 || xhr.status >= 300) {
      const hint = xhr.status === 429 ? Locale.get("dialogs.webImages.rateLimitHint") : "";
      this.statusEl.textContent = Locale.get(["dialogs.webImages.searchFailed", String(xhr.status)]) + hint;
      this.updateLoadMoreButton();
      this.startLoadMoreCooldownTicker();
      return;
    }
    const payload = xhr.response || {};
    const pageResults = Array.isArray(payload.results) ? payload.results : [];
    const prevCount = this.results.length;
    if (append) {
      this.results = this.results.concat(pageResults);
    } else {
      this.results = pageResults;
    }
    this.currentPage = page;
    this.totalPages = resolveTotalPages(
      payload.page_count,
      page,
      pageResults.length,
      append,
      this.totalPages,
    );
    this.updateHasMoreResults();
    if (this.results.length === 0) {
      this.statusEl.textContent = Locale.get(["dialogs.webImages.noResults", query]);
    }
    this.appendResultCells(prevCount);
    this.refreshStatusLine();
    this.startLoadMoreCooldownTicker();
  }.bind(this);
  xhr.onerror = function() {
    if (requestGeneration !== this.apiRequestGeneration) return;
    this.activeRequest = null;
    this.lastApiRequestAt = Date.now();
    this.statusEl.textContent = Locale.get("dialogs.webImages.networkError");
    this.updateLoadMoreButton();
  }.bind(this);
  xhr.send();
};

WebImagesDialog.prototype.appendResultCells = function(startIndex) {
  for (let i = startIndex; i < this.results.length; i++) {
    const result = this.results[i];
    const previewUrl = this.getPreviewImageUrl(result);
    if (previewUrl == null) continue;

    let cellStyle = "display:flex; align-items:center; justify-content:center; cursor:pointer; background:#1a1a1a; border-radius:3px; padding:4px; box-sizing:border-box; width:100%;";
    if (result.width > 0 && result.height > 0) {
      cellStyle += " aspect-ratio:" + result.width + " / " + result.height + ";";
    }
    const cell = makeElement("div", "");
    cell.setAttribute("style", cellStyle);

    const imgEl = makeElement("img", "");
    imgEl.setAttribute("alt", result.title || "");
    imgEl.setAttribute("title", buildResultTooltip(result));
    imgEl.setAttribute("referrerpolicy", "no-referrer");
    imgEl.setAttribute("style", "display:block; max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain; opacity:0; transition:opacity 0.15s;");
    cell.appendChild(imgEl);

    cell.addEventListener("click", this.onPickResult.bind(this, result));
    this.gridEl.appendChild(cell);
    this.enqueuePreviewLoad(cell, imgEl, previewUrl, result);
  }
  this.renderedResultCount = this.results.length;
};

WebImagesDialog.prototype.buildResultTooltip = function(result) {
  return buildResultTooltip(result);
};

WebImagesDialog.prototype.onPickResult = function(result) {
  if (this.doc == null) {
    this.statusEl.textContent = Locale.get("dialogs.webImages.openOrCreateDocFirst");
    return;
  }
  const imageUrl = this.getPreviewImageUrl(result);
  if (imageUrl == null) {
    this.statusEl.textContent = Locale.get("dialogs.webImages.noUsableUrl");
    return;
  }
  this.statusEl.textContent = this.formatPlacingStatus(result.title || "image");

  const evt = new AppEvent(EventType.uiDispatch, true);
  evt.data = {
    dispatchKind: UiCommand.importFromUrl,
    importSpec: {
      url: imageUrl,
      name: buildPlacementName(result),
      placeIntoDocIndex: "$active",
    },
  };
  this.dispatch(evt);
  this.close();
};

WebImagesDialog.prototype.buildPlacementName = function(result) {
  return buildPlacementName(result);
};

export {
  WebImagesDialog,
  buildOpenverseImagesSearchUrl,
  resolveTotalPages,
  computeRateLimitWaitMs,
  buildResultTooltip,
  buildPlacementName,
  formatPreviewStatusLine,
};
