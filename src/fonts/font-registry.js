/**
 * Font face registry: system catalog, substitution table, async load queue,
 * and Typr parsing. Catalog entries are `[family, style, postScriptName, …]`.
 */

import { EventEmitter } from "../core/event-emitter.js";
import { Locale } from "../core/i18n/locale.js";
import { getFontCatalog, loadSystemFontBytes } from "./system-font-catalog.js";
import { fontSubstitutionTable } from "./font-substitution-table.js";
import { showToast } from "../core/user-prompts.js";

function FontRegistry() {
  EventEmitter.call(this);
  this.loadedFaces = {};
  this.loadingInFlight = {};
  this.loadGeneration = 0;
  this.substitutionLogged = {};
  this.pendingFontNames = [];
  this.alertDebounceTimer = 0;
  FontRegistry.instance = this;
}
FontRegistry.prototype = Object.create(EventEmitter.prototype);

  function debugFontsLog() {
    if (!globalThis.DEBUG_FONTS) return;
    try {
      console.log.apply(console, arguments);
    } catch (_) {}
  }

  async function registerFontFaceIfPossible(names, bytes) {
    try {
      if (typeof FontFace === "undefined") return;
      if (!globalThis.document || !document.fonts || !document.fonts.add) return;
      if (!bytes) return;
      // Clone the Uint8Array backing store for FontFace; the original buffer may
      // be transferred to the Typr worker.
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      for (let i = 0; i < names.length; i++) {
        const family = names[i];
        if (!family) continue;
        // Avoid re-adding the same family repeatedly.
        if (!FontRegistry.registeredCssFamilies) FontRegistry.registeredCssFamilies = new Set();
        if (FontRegistry.registeredCssFamilies.has(family)) continue;
        const cssFontFace = new FontFace(family, buf);
        await cssFontFace.load();
        document.fonts.add(cssFontFace);
        FontRegistry.registeredCssFamilies.add(family);
        debugFontsLog("fonts:FontFace loaded", family);
      }
    } catch (e) {
      // Non-fatal: Typr parsing path still works.
      debugFontsLog("fonts:FontFace failed", e && e.message ? e.message : e);
    }
  }

  function pickAnyCatalogFontKey(registry) {
    try {
      registry.getCatalogMap();
      const map = FontRegistry.catalogMap;
      if (map) {
        // Prefer common Latin-capable fonts. Private macOS fonts (dot-prefixed)
        // often lack Latin glyphs (numeric, stencil, etc.) and produce squares.
        const preferred = [
          "ArialMT", "Helvetica", "HelveticaNeue",
          "TimesNewRomanPSMT", "Times-Roman",
          "CourierNewPSMT", "Menlo-Regular", "Monaco",
          "LiberationSans", "DejaVuSans"
        ];
        for (let preferredIdx = 0; preferredIdx < preferred.length; preferredIdx++) {
          if (map[preferred[preferredIdx]]) return preferred[preferredIdx];
        }
        // Second pass: any non-private font (skip dot-prefixed macOS internals).
        for (let k in map) {
          if (k.charCodeAt(0) !== 46 /* . */) return k;
        }
        // Last resort: whatever's first.
        for (let k in map) return k;
      }
    } catch (_) {}
    return null;
  }


  // Pick the first PostScript key from a priority list that exists in the catalog.
  function firstCatalogHit(priorityList, catalogMap) {
    if (!Array.isArray(priorityList)) return priorityList;
    for (let i = 0; i < priorityList.length; i++) {
      if (catalogMap[priorityList[i]] != null) return priorityList[i];
    }
    return priorityList[0];
  }

  // Map a missing document font key to a catalog-backed substitute (or any available key).
  function resolveMissingFontSubstitute(registry, fontKey) {
    const catalogMap = registry.getCatalogMap();
    let substituteKey = FontRegistry.substitutionTable[fontKey];
    if (substituteKey != null) return firstCatalogHit(substituteKey, catalogMap);

    const dashIdx = fontKey.lastIndexOf("-");
    if (dashIdx > 0) {
      const familyEntry = FontRegistry.substitutionTable[fontKey.slice(0, dashIdx)];
      if (familyEntry != null) return firstCatalogHit(familyEntry, catalogMap);
    }
    return pickAnyCatalogFontKey(registry);
  }

  FontRegistry.getFallbackScriptName = function(face, scriptFlags) {
    let tableIdx = 0;
    const fallbackTable = FontRegistry.scriptFallbackTable;
    while (tableIdx < fallbackTable.length) {
      if ((scriptFlags >>> tableIdx & 1) == 1) break;
      tableIdx++
    }
    if (scriptFlags == 0 || fallbackTable[tableIdx][1] == "") {
      if ((scriptFlags & 15) != 0 && FontRegistry.measureGlyphCoverageRatio(face, [33, 126]) > .7) tableIdx = 0;
      else if (scriptFlags == 0) tableIdx = 0;
      else {
        tableIdx = 0
      }
    }
    return fallbackTable[tableIdx][1]
  };
  FontRegistry.THUMBNAIL_WIDTH = 120;
  FontRegistry.THUMBNAIL_HEIGHT = 20;
  FontRegistry.glyphGridColumns = 16;
  // One-shot UI context when document font Z substitutes to catalog key P (Z→P on the load event).
  FontRegistry.pendingFontUiContext = null;
  FontRegistry.getPostScriptName = function(face) {
    const psName = face.name.postScriptName;
    if (psName == null) return null;
    return psName.replace(/ /g, "-");
  };
  FontRegistry.extractFamilyStyle = function(face) {
    const names = face.name;
    let family = names.typoFamilyName ? names.typoFamilyName : names.fontFamily;
    let style = names.typoSubfamilyName ? names.typoSubfamilyName : names.fontSubfamily;
    const weightKws = FontRegistry.weightKeywords;
    const familyLower = family.toLowerCase();
    for (let weightIdx = 0; weightIdx < weightKws.length; weightIdx++) {
      if (weightKws[weightIdx] == "roman") continue;
      if (familyLower.endsWith(" " + weightKws[weightIdx]) || familyLower.endsWith("-" + weightKws[weightIdx])) {
        const suffixStart = family.length - weightKws[weightIdx].length;
        var suffix = family.slice(suffixStart);
        family = family.slice(0, suffixStart - 1);
        if (suffix != "") {
          if (style == "Regular" || style == family + " Regular") style = suffix;
          else style = suffix + " " + style
        }
        break
      }
    }
    const specialFamilies = "BPdots,Baloo,Diner,EB Garamond Initials,Encode Sans Semi Condensed,Encode Sans Semi Expanded,Changa,HVD Poster,IM FELL DW,IM FELL Double,IM FELL English,IM FELL FLOWERS,IM FELL French Canon,IM FELL Great Primer,itsadzoke,JUICE,Lacuna,Latin Modern Mono,Latin Modern Sans,Latin Modern Roman,Latinia,Libre Barcode,Libre Caslon,Londrina,Panefresco,UnifrakturMaguntia,WC Rhesus,WC Sold Out,WC Wunderbach,Walkway".split(",");
    for (let familyIdx = 0; familyIdx < specialFamilies.length; familyIdx++)
      if (family.startsWith(specialFamilies[familyIdx])) {
        var suffix = family.slice(specialFamilies[familyIdx].length);
        family = specialFamilies[familyIdx];
        if (suffix.startsWith(" ") || suffix.startsWith("-")) suffix = suffix.slice(1);
        if (suffix != "") {
          if (style == "Regular") style = suffix;
          else style = suffix + " " + style
        }
        break
      }

    const styleOverrides = {
          "Caudex-BoldItalic": "Bold Italic",
          "Comfortaa-Light": "Light",
          "Comfortaa-Medium": "Medium",
          "Comfortaa-SemiBold": "SemiBold",
          DevroyeSCOSF: "Regular SCOSF",
          DevroyeUnicode: "Regular Unicode",
          "LeagueScriptThin-Regular": "Regular",
          "Monda-Bold": "Bold",
          "Nobile-Bold": "Bold",
          "Oswald-BoldItalic": "Bold Italic",
          "Oswald-HeavyItalic": "Heavy Italic",
          "Oswald-LightItalic": "Light Italic",
          "Oswald-MediumItalic": "Medium Italic",
          "Oswald-RegularItalic": "Regular Italic",
          "PaloAlto-Italic": "Heavy Italic"
        };

    const overriddenStyle = styleOverrides[FontRegistry.getPostScriptName(face)];
    if (overriddenStyle) style = overriddenStyle;
    return [family, style]
  };
  FontRegistry.prototype.loadFontsByCategory = function(category) {
    const map = this.getCatalogMap();
    for (let key in map)
      if (map[key][0] == category) this.loadFontFace(key)
  };
  FontRegistry.prototype.loadFontFace = function(fontKey, charCode) {
    // Alias support: system fonts can parse to a PostScript name that differs from
    // the catalog key we used to request them. Keep a stable mapping so lookups
    // (engineData key -> parsed face) resolve correctly.
    if (FontRegistry.fontKeyAliasMap && FontRegistry.fontKeyAliasMap[fontKey]) fontKey = FontRegistry.fontKeyAliasMap[fontKey];
    try {
      const _staleUi = FontRegistry.pendingFontUiContext;
      if (_staleUi != null && _staleUi.mappedKey !== fontKey) FontRegistry.pendingFontUiContext = null;
    } catch (_) {}
    try {
      globalThis.__PS_FONT_LAST_REQUESTED = fontKey;
    } catch (_) {}
    if (this.loadedFaces[fontKey]) {
      // When the caller provides a non-ASCII codepoint, verify the loaded face
      // actually has a glyph for it. Fonts like Noto Sans Mandaic are script-specific
      // and produce .notdef rectangles for characters outside their script.
      // If glyph 0 (.notdef) is returned, try the script-level fallback instead.
      if (charCode != null && charCode > 128) {
        try {
          if (Typr.U.codeToGlyph(this.loadedFaces[fontKey], charCode) === 0) {
            const glyphFallbackKey = this.findScriptFallback(charCode, fontKey);
            if (glyphFallbackKey !== fontKey) return this.loadFontFace(glyphFallbackKey, charCode);
          }
        } catch (_) {}
      }
      return this.loadedFaces[fontKey];
    }
    // Skip private macOS fonts (dot-prefixed): they have non-standard tables and
    // are not meant for external use. Fall through to normal substitution instead.
    if (fontKey && fontKey.charCodeAt(0) === 46 /* . */) return this.loadFontFace(pickAnyCatalogFontKey(this), charCode);
    if (this.loadingInFlight[fontKey]) {
      // Font is already queued/in-flight. Return the first already-loaded face so
      // callers can lay out text now; they'll re-render via photosuite:font-loaded
      // once the real font finishes. Avoid recursive loadFontFace calls — DejaVuSans may
      // not exist on this OS and recursion causes a stack overflow.
      for (let _fk in this.loadedFaces) { if (this.loadedFaces[_fk]) return this.loadedFaces[_fk]; }
      return null;
    }
    let fontUrl = null;
    const catalogMap = this.getCatalogMap();
    if (catalogMap[fontKey] != null) fontUrl = catalogMap[fontKey][5];
    if (typeof fontUrl === "string" && (fontUrl.startsWith("sys:") || fontUrl.startsWith("app:"))) {
      // Don't retry a font that already failed.
      if (FontRegistry.failedSystemFontKeys && FontRegistry.failedSystemFontKeys.has(fontKey)) {
        try {
          if (FontRegistry.pendingFontUiContext && FontRegistry.pendingFontUiContext.mappedKey === fontKey)
            FontRegistry.pendingFontUiContext = null;
        } catch (_) {}
        return this.loadFontFace(pickAnyCatalogFontKey(this) || "DejaVuSans", charCode);
      }

      this.loadingInFlight[fontKey] = "q";
      try {
        let _detailRequested = fontKey;
        let _detailMapped = fontKey;
        let _detailReason = "direct";
        try {
          const _pendingUi = FontRegistry.pendingFontUiContext;
          if (_pendingUi != null && _pendingUi.mappedKey === fontKey) {
            FontRegistry.pendingFontUiContext = null;
            _detailRequested = _pendingUi.requestedKey;
            _detailMapped = _pendingUi.mappedKey;
            _detailReason = "fallback";
          }
        } catch (_) {}
        window.dispatchEvent(new CustomEvent("photosuite:font-loading", {
          detail: { key: fontKey, requestedKey: _detailRequested, mappedKey: _detailMapped, reason: _detailReason }
        }));
      } catch (_) {}
      const requestedKey = fontKey;

      // Build a loader that returns Promise<Uint8Array> regardless of source.
      let loaderFn;
      if (fontUrl.startsWith("sys:")) {
        const fontPath = fontUrl.slice(4);
        debugFontsLog("fonts:NI queue sys", { requestedKey, code: charCode, fontPath });
        loaderFn = () => loadSystemFontBytes(fontPath);
      } else {
        const bundledUrl = fontUrl.slice(4);
        debugFontsLog("fonts:NI queue app", { requestedKey, fontUrl });
        loaderFn = () => fetch(bundledUrl)
          .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
          .then(ab => new Uint8Array(ab));
      }

      try {
        globalThis.__PS_FONT_SYS_QUEUE = (globalThis.__PS_FONT_SYS_QUEUE || 0) + 1;
      } catch (_) {}

      if (!FontRegistry.systemFontLoadQueue) FontRegistry.systemFontLoadQueue = [];
      FontRegistry.systemFontLoadQueue.push({ requestedKey, loaderFn });
      debugFontsLog("fonts:sysQueue size", FontRegistry.systemFontLoadQueue.length);

      if (!FontRegistry.systemFontQueueRunning) {
        FontRegistry.systemFontQueueRunning = true;
        const self = this;
        // Lazy worker init (no bundler; served from /fonts/typr-worker.js).
        if (!FontRegistry.typrParseWorker) {
          try {
            // Cache-bust so worker updates take effect immediately (WebViews can be aggressive).
            const workerUrl = "fonts/typr-worker.js?v=" + Date.now();
            FontRegistry.typrParseWorker = new Worker(workerUrl);
            FontRegistry.typrParseWorker.nextRequestId = 0;
            FontRegistry.typrParseWorker.pendingById = new Map();
            FontRegistry.typrParseWorker.onmessage = (ev) => {
              const msg = ev.data || {};
              const p = FontRegistry.typrParseWorker.pendingById.get(msg.id);
              if (!p) return;
              FontRegistry.typrParseWorker.pendingById.delete(msg.id);
              if (msg.ok) p.resolve(msg.parsed);
              else p.reject(new Error(msg.error || "worker parse failed"));
            };
          } catch (e) {
            console.warn("PhotoSuite: failed to start font worker; system fonts disabled", e);
            FontRegistry.typrParseWorker = null;
          }
        }

        const parseInWorker = (buf) => {
          const w = FontRegistry.typrParseWorker;
          if (!w) return Promise.reject(new Error("font worker unavailable"));
          const id = ++w.nextRequestId;
          return new Promise((resolve, reject) => {
            w.pendingById.set(id, { resolve, reject });
            w.postMessage({ id, buf }, [buf]);
          });
        };

        const runNext = function() {
          const job = FontRegistry.systemFontLoadQueue.shift();
          if (!job) {
            FontRegistry.systemFontQueueRunning = false;
            return;
          }
          // job.loaderFn() handles both sys: (Tauri) and app: (fetch) sources.
          job.loaderFn()
            .then((bytes) => {
              debugFontsLog("fonts:loaded bytes", { requestedKey: job.requestedKey, byteLength: bytes ? bytes.byteLength : 0 });
              try {
                globalThis.__PS_FONT_LAST_LOADED = { key: job.requestedKey, bytes: bytes ? bytes.byteLength : 0 };
              } catch (_) {}
              try {
                const entry = self.getCatalogMap()[job.requestedKey];
                const familyName = entry ? entry[0] : null;
                registerFontFaceIfPossible([familyName, job.requestedKey], bytes);
              } catch (_) {}
              const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
              parseInWorker(buf)
                .then((parsed) => {
                  debugFontsLog("fonts:parsed", { requestedKey: job.requestedKey, faces: parsed ? parsed.length : 0 });
                  for (let i = 0; i < parsed.length; i++) {
                    self.registerParsedFace(parsed[i], true);
                  }
                  if (parsed && parsed[0]) {
                    const realKey = FontRegistry.getPostScriptName(parsed[0]) || job.requestedKey;
                    self.loadedFaces[job.requestedKey] = parsed[0];
                    if (realKey && realKey !== job.requestedKey) {
                      if (!FontRegistry.fontKeyAliasMap) FontRegistry.fontKeyAliasMap = {};
                      FontRegistry.fontKeyAliasMap[job.requestedKey] = realKey;
                      self.loadedFaces[realKey] = parsed[0];
                      debugFontsLog("fonts:alias", job.requestedKey, "->", realKey);
                    }
                    try {
                      globalThis.__PS_FONT_LAST_PARSED = { key: job.requestedKey, realKey: realKey || null };
                    } catch (_) {}
                    try {
                      console.info("PhotoSuite: font ready", job.requestedKey, "->", realKey);
                    } catch (_) {}
                  }
                })
                .catch((e) => {
                  console.error("PhotoSuite: failed to parse font", job.requestedKey, e);
                  try {
                    if (!FontRegistry.failedSystemFontKeys) FontRegistry.failedSystemFontKeys = new Set();
                    FontRegistry.failedSystemFontKeys.add(job.requestedKey);
                  } catch (_) {}
                })
                .finally(() => {
                  delete self.loadingInFlight[job.requestedKey];
                  debugFontsLog("fonts:done", { requestedKey: job.requestedKey });
                  try {
                    let resolvedKey = null;
                    try {
                      resolvedKey = (FontRegistry.fontKeyAliasMap && FontRegistry.fontKeyAliasMap[job.requestedKey]) || null;
                    } catch (_) {}
                    window.dispatchEvent(new CustomEvent("photosuite:font-loaded", {
                      detail: {
                        key: job.requestedKey,
                        requestedKey: job.requestedKey,
                        mappedKey: job.requestedKey,
                        realKey: resolvedKey,
                        reason: resolvedKey ? "alias" : "direct"
                      }
                    }));
                  } catch (_) {}
                  setTimeout(runNext, 0);
                });
            })
            .catch((e) => {
              console.error("PhotoSuite: failed to load font", job.requestedKey, e);
              delete self.loadingInFlight[job.requestedKey];
              debugFontsLog("fonts:load failed", { requestedKey: job.requestedKey });
              // Always signal completion so the UI can close any per-font loading panel.
              try {
                window.dispatchEvent(new CustomEvent("photosuite:font-loaded", {
                  detail: {
                    key: job.requestedKey,
                    requestedKey: job.requestedKey,
                    mappedKey: job.requestedKey,
                    realKey: null,
                    reason: "load-failed"
                  }
                }));
              } catch (_) {}
              setTimeout(runNext, 0);
            });
        };
        setTimeout(runNext, 0);
      }
      return this.loadFontFace(pickAnyCatalogFontKey(this) || "DejaVuSans", charCode);
    }
    if (fontUrl == null) {
      let substituteKey = resolveMissingFontSubstitute(this, fontKey);
      if (charCode != null && charCode > 128) substituteKey = this.findScriptFallback(charCode, substituteKey);
      if (this.substitutionLogged[fontKey] == null) {
        this.substitutionLogged[fontKey] = 1;
        // Avoid blocking modal alerts (can freeze the UI when many fonts are missing).
        // Only log when explicitly debugging.
        debugFontsLog("fonts:fallback", fontKey, "->", substituteKey);
        try {
          console.info("PhotoSuite: font mapped", fontKey, "->", substituteKey);
        } catch (_) {}
      }
      // Only open a loading panel when the fallback font actually needs loading.
      // Never emit photosuite:font-loading here — loadFontFace(P) emits exactly one,
      // under-counting loses refreshTextLayerFonts; double-count breaks in-flight balance.
      if (substituteKey && !this.loadedFaces[substituteKey] && !this.loadingInFlight[substituteKey]) {
        try {
          FontRegistry.pendingFontUiContext = { requestedKey: fontKey, mappedKey: substituteKey };
        } catch (_) {}
      }
      return substituteKey ? this.loadFontFace(substituteKey, charCode) : null;
    }
    // Bundled font binaries are removed; if we ever hit this path, just fall back.
    debugFontsLog("fonts:missing-bundled-font", fontKey, fontUrl);
    return this.loadFontFace(pickAnyCatalogFontKey(this) || "DejaVuSans", charCode);
  };
  FontRegistry.prototype.findScriptFallback = function(codePoint, currentKey, candidates) {
    const face = this.loadedFaces[currentKey];
    if (face && Typr.U.codeToGlyph(face, codePoint) != 0) return currentKey;
    const catalogMap = this.getCatalogMap();
    const scriptInfo = FontRegistry.getScriptBlock(codePoint);
    const scriptFlag = scriptInfo[0];
    if (catalogMap[currentKey] && (catalogMap[currentKey][3] & scriptFlag) == 0) {
      if (candidates)
        for (let candIdx = 0; candIdx < candidates.length; candIdx++) {
          const candidateKey = candidates[candIdx].Name;
          const candidateEntry = catalogMap[candidateKey];
          if (candidateEntry && (candidateEntry[3] & scriptFlag) != 0) return candidateKey
        }
      const fallbackKey = FontRegistry.scriptFallbackTable[scriptInfo[1]][4];
      if (catalogMap[fallbackKey]) return fallbackKey
    }
    return currentKey
  };
  FontRegistry.getScriptBlock = function(codePoint) {
    const table = FontRegistry.scriptFallbackTable;
    const result = [0];
    for (let tableIdx = 0; tableIdx < table.length; tableIdx++) {
      const ranges = table[tableIdx][2];
      for (let rangeIdx = 0; rangeIdx < ranges.length; rangeIdx += 2)
        if (ranges[rangeIdx] <= codePoint && codePoint <= ranges[rangeIdx + 1]) {
          result[0] += 1 << tableIdx;
          result.push(tableIdx)
        }
    }
    if (result.length == 1) result.push(0);
    return result
  };
  FontRegistry.prototype.showMissingFontsAlert = function() {
    const names = this.pendingFontNames;
    const firstName = names[0];
    const extraCount = names.length - 1;
    showToast(Locale.get("warp.fontWarning.font") + " " + firstName + (extraCount == 0 ? "" : ", ... (" + extraCount + ")") + " " + Locale.get("history.loaded") + ".");
    this.pendingFontNames = []
  };
  FontRegistry.prototype.registerParsedFace = function(face, isSilent) {
    if (isSilent != true) {
      this.pendingFontNames.push(face.name.fullName);
      clearTimeout(this.alertDebounceTimer);
      this.alertDebounceTimer = setTimeout(this.showMissingFontsAlert.bind(this), 300)
    }
    const psName = FontRegistry.getPostScriptName(face);
    const catalogMap = this.getCatalogMap();
    const existingEntry = catalogMap[psName];
    const catalogEntry = FontRegistry.buildCatalogEntry(face);
    if (existingEntry == null) {
      var canvas = document.createElement("canvas");
      var ctx = canvas.getContext("2d");
      canvas.width = FontRegistry.THUMBNAIL_WIDTH;
      canvas.height = FontRegistry.THUMBNAIL_HEIGHT;
      var scale = FontRegistry.THUMBNAIL_HEIGHT * 1.2 / face.head.unitsPerEm;
      ctx.translate(4, FontRegistry.THUMBNAIL_HEIGHT * .9);
      ctx.scale(scale, -scale);
      ctx.fillStyle = "#000000";
      var glyphs = Typr.U.shape(face, FontRegistry.getFallbackScriptName(face, catalogEntry[3]), { ltr: true });
      Typr.U.pathToContext(Typr.U.shapeToPath(face, glyphs), ctx);
      ctx.fill();
      catalogEntry.thumbnailDataUrl = canvas.toDataURL();
      this.registerCatalogEntry(catalogEntry)
    } else if (existingEntry.thumbnailDataUrl == null) {
      // System fonts (and some catalogs) don't have a sprite-sheet preview.
      // Generate a thumbnail on first load so the font picker shows correct previews.
      var canvas = document.createElement("canvas");

      var ctx = canvas.getContext("2d");
      canvas.width = FontRegistry.THUMBNAIL_WIDTH;
      canvas.height = FontRegistry.THUMBNAIL_HEIGHT;
      var scale = FontRegistry.THUMBNAIL_HEIGHT * 1.2 / face.head.unitsPerEm;
      ctx.translate(4, FontRegistry.THUMBNAIL_HEIGHT * .9);
      ctx.scale(scale, -scale);
      ctx.fillStyle = "#000000";
      var glyphs = Typr.U.shape(face, FontRegistry.getFallbackScriptName(face, existingEntry[3] != null ? existingEntry[3] : catalogEntry[3]), { ltr: true });
      Typr.U.pathToContext(Typr.U.shapeToPath(face, glyphs), ctx);
      ctx.fill();
      existingEntry.thumbnailDataUrl = canvas.toDataURL();
    }
    delete this.loadingInFlight[psName];
    this.loadedFaces[psName] = face
  };
  FontRegistry.getScriptNames = function() {
    const table = FontRegistry.scriptFallbackTable;
    const names = [];
    for (let tableIdx = 0; tableIdx < table.length; tableIdx++) names.push(table[tableIdx][0]);
    return names
  };
  FontRegistry.scriptFallbackTable = [
    ["Latin-1", "Preview", [161, 169, 192, 246, 248, 255], .7, "DejaVuSans"],
    ["Latin Ext. A", "", [256, 383], .7, "DejaVuSans"],
    ["Greek", "", [913, 929, 931, 969], .7, "DejaVuSans"],
    ["Cyrillic", "", [1040, 1119], .7, "DejaVuSans"],
    ["Hebrew", "", [1473, 1479, 1488, 1514, 1520, 1524], .7, "DejaVuSans"],
    ["Arabic", "", [1569, 1594, 1600, 1749], .4, "DejaVuSans"],
    ["Hangul", "\uC608\uACE0\uD3B8", [4352, 4607, 44032, 55203], .7, "NotoSansKR-Regular"],
    ["Chi-Jap-Kor", "\u9810\u7FD2", [12288, 12351, 12352, 12447, 12448, 12543, 19968, 40895], .05, "DroidSansFallback"],
    ["Tibetan", "\u0F50\u0F74\u0F42\u0F66\u0F0B\u0F62\u0F97\u0F7A\u0F0B\u0F46\u0F7A\u0F0D", [3840, 3948, 3953, 4044], .7, "NotoSerifTibetan-Regular"],
    ["Devanagari", "\u092A\u0942\u0930\u094D\u0935\u093E\u0935\u0932\u094B\u0915\u0928", [2304, 2431], .7, "NotoSansDevanagari-Regular"],
    ["Thai", "\u0E20\u0E32\u0E1E\u0E15\u0E31\u0E27\u0E2D\u0E22\u0E48\u0E32\u0E07", [3585, 3642, 3647, 3675], .7, "NotoSansThai-Regular"],
    ["Khmer", "\u1798\u17BE\u179B\u1787\u17B6\u1798\u17BB\u1793", [6016, 6109, 6112, 6121, 6128, 6137], .7, "NotoSansKhmer-Regular"],
    ["Vietnamese", "Xem tr\u01B0\u1EDBc", [192, 195, 200, 202, 204, 205, 210, 213, 217, 218, 221, 221, 224, 227, 232, 234, 236, 237, 242, 245, 249, 250, 253, 253, 258, 259, 272, 273, 296, 297, 360, 361, 416, 417, 431, 432, 7840, 7929], .95, "DejaVuSans"]
  ];
  FontRegistry.buildCatalogEntry = function(face, url, sortIndex) {
    let scriptFlags = 0;
    if (FontRegistry.getPostScriptName(face) == null) {
      throw "No postScriptName!"
    }
    const table = FontRegistry.scriptFallbackTable;
    const coverage = [];
    for (let tableIdx = 0; tableIdx < table.length; tableIdx++) {
      const ranges = table[tableIdx][2];
      const threshold = table[tableIdx][3];
      coverage[tableIdx] = FontRegistry.measureGlyphCoverageRatio(face, ranges) > threshold ? 1 : 0
    }
    for (let flagIdx = 0; flagIdx < coverage.length; flagIdx++) scriptFlags += coverage[flagIdx] << flagIdx;
    const familyStyle = FontRegistry.extractFamilyStyle(face);
    return [familyStyle[0], familyStyle[1], FontRegistry.getPostScriptName(face), scriptFlags, sortIndex, url]
  };
  FontRegistry.measureGlyphCoverageRatio = function(face, codePointRanges) {
    let hitCount = 0;
    let missCount = 0;
    for (let rangeIdx = 0; rangeIdx < codePointRanges.length; rangeIdx += 2) {
      for (let codePoint = codePointRanges[rangeIdx]; codePoint <= codePointRanges[rangeIdx + 1]; codePoint++) {
        try {
          const glyphId = Typr.U.codeToGlyph(face, codePoint);
          if (glyphId == 0) missCount++; else hitCount++;
        } catch (_) { missCount++; }
      }
    }
    return hitCount / (hitCount + missCount)
  };
  FontRegistry.compareCatalogByName = function(entryA, entryB) {
    if (entryA[2] < entryB[2]) return -1;
    if (entryA[2] > entryB[2]) return 1;
    return 0
  };
  FontRegistry.serializeCatalogRow = function(row, prevRow) {
    if (row[5] == "fs/" + row[2] + ".otf") row[5] = "";
    else if (row[5] == "gf/" + row[2] + ".otf") row[5] = "a";
    if (row[2] == (row[0] + "-" + row[1]).replace(/\s/g, "")) {
      row[2] = ""
    } else if (row[2] == row[0].replace(/\s/g, "")) {
      row[2] = "a"
    }
    if (prevRow) {
      if (row[0] == prevRow[0]) row[0] = "";
      if (row[1] == prevRow[1]) row[1] = "";
      if (row[3] == prevRow[3]) row[3] = "";
      if (row[4] == prevRow[4]) row[4] = ""
    }
    return row.join(",")
  };
  FontRegistry.parseCatalogRow = function(csvRow, prevRow) {
    csvRow = csvRow.split(",");
    if (csvRow[0] == "") csvRow[0] = prevRow[0];
    if (csvRow[1] == "") csvRow[1] = prevRow[1];
    if (csvRow[3] == "") csvRow[3] = prevRow[3];
    else csvRow[3] = parseInt(csvRow[3]);
    if (csvRow[4] == "") csvRow[4] = prevRow[4];
    else csvRow[4] = parseInt(csvRow[4]);
    if (csvRow[2] == "") csvRow[2] = (csvRow[0] + "-" + csvRow[1]).replace(/\s/g, "");
    else if (csvRow[2] == "a") csvRow[2] = csvRow[0].replace(/\s/g, "");
    if (csvRow[5] == "") csvRow[5] = "fs/" + csvRow[2] + ".otf";
    else if (csvRow[5] == "a") csvRow[5] = "gf/" + csvRow[2] + ".otf";
    return csvRow
  };
  FontRegistry.substitutionTable = fontSubstitutionTable;

  FontRegistry.prototype.getCatalogMap = function() {
    if (FontRegistry.catalogMap == null) {
      const catalog = getFontCatalog();
      const rawList = catalog.list || [];
      const parsedRows = [];
      for (let rowIdx = 0; rowIdx < rawList.length; rowIdx++) {
        parsedRows[rowIdx] = FontRegistry.parseCatalogRow(rawList[rowIdx], parsedRows[rowIdx - 1]);
        parsedRows[rowIdx].idx = rowIdx;
        this.registerCatalogEntry(parsedRows[rowIdx])
      }
    }
    // Never return null — callers do catalogMap[key] which would throw on null.
    return FontRegistry.catalogMap || {};
  };
  FontRegistry.prototype.registerCatalogEntry = function(entry) {
    let family = entry[0];
    let style = entry[1];
    if (FontRegistry.catalogMap == null) FontRegistry.catalogMap = {};
    FontRegistry.catalogMap[entry[2]] = entry;
    if (FontRegistry.catalogMapByFamily == null) FontRegistry.catalogMapByFamily = {};
    FontRegistry.catalogMapByFamily[family + "---" + style] = entry;
    if (FontRegistry.catalogMapBySubset == null) FontRegistry.catalogMapBySubset = {};
    let subsetList = FontRegistry.catalogMapBySubset[family];
    if (subsetList == null) subsetList = FontRegistry.catalogMapBySubset[family] = [];
    const existingIdx = subsetList.indexOf(style);
    if (existingIdx == -1) subsetList.push(style);
    else subsetList[existingIdx] = style
  };
  FontRegistry.compareByWeight = function(a, b) {
    return FontRegistry.getWeightSortKey(a) - FontRegistry.getWeightSortKey(b)
  };
  FontRegistry.getWeightSortKey = function(styleName) {
    styleName = styleName.toLowerCase();
    let key = FontRegistry.isItalicStyle(styleName) + (FontRegistry.getWeightIndex(styleName) << 1);
    if (styleName.indexOf("cond") == -1) key += 1 << 25;
    return key
  };
  FontRegistry.isItalicStyle = function(styleName) {
    return styleName.indexOf("italic") != -1 || styleName.indexOf("oblique") != -1 ? 1 : 0
  };
  FontRegistry.weightKeywords = "two,four,eight,hair,thin,ultralight,extralight,exlight,light,regular,roman,book,medium,semi bold,semibold,demibold,extra bold,extrabold,bold,heavy,ultra,x black,black,extra".split(",");
  FontRegistry.weightOrder = ["two", "four", "eight", "hair", "thin", "ultralight", "extralight", "light", ["regular", "roman", "book"], "medium", ["semibold", "demibold"], "bold", "extrabold", "heavy", "ultra", "black", "x black"];
  FontRegistry.getWeightIndex = function(styleName) {
    const order = FontRegistry.weightOrder;
    let bestIdx = -1;
    let bestLen = -1;
    for (let orderIdx = 0; orderIdx < order.length; orderIdx++) {
      const entry = order[orderIdx];
      if (entry instanceof Array)
        for (let aliasIdx = 0; aliasIdx < entry.length; aliasIdx++) {
          const keyword = entry[aliasIdx];
          if (styleName.indexOf(keyword) != -1 && (bestIdx == -1 || bestLen < keyword.length)) {
            bestIdx = orderIdx;
            bestLen = keyword.length
          }
        } else if (styleName.indexOf(entry) != -1 && (bestIdx == -1 || bestLen < entry.length)) {
          bestIdx = orderIdx;
          bestLen = entry.length
        }
    }
    if (bestIdx == -1) bestIdx = 8;
    return bestIdx
  };
  FontRegistry.findClosestStyle = function(styleList, targetStyle) {
    let bestDist = 1e9;
    let bestMatch = null;
    const targetKey = FontRegistry.getWeightSortKey(targetStyle);
    for (let styleIdx = 0; styleIdx < styleList.length; styleIdx++) {
      const dist = Math.abs(FontRegistry.getWeightSortKey(styleList[styleIdx]) - targetKey);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = styleList[styleIdx]
      }
    }
    return bestMatch
  };
  FontRegistry.prototype.lookupByFamilyStyle = function(family, style) {
    this.getCatalogMap();
    return FontRegistry.catalogMapByFamily && FontRegistry.catalogMapByFamily[family + "---" + style]
  };
  FontRegistry.prototype.getSubfamilyList = function(family) {
    this.getCatalogMap();
    return FontRegistry.catalogMapBySubset && FontRegistry.catalogMapBySubset[family]
  };
  FontRegistry.prototype.getSubfamilyMap = function() {
    this.getCatalogMap();
    return FontRegistry.catalogMapBySubset
  };

// Static look-up maps built lazily from the font catalog (null = not yet built).
FontRegistry.catalogMap = null;
FontRegistry.catalogMapByFamily = null;
FontRegistry.catalogMapBySubset = null;

function clearFontCatalogCaches() {
  FontRegistry.catalogMap = null;
  FontRegistry.catalogMapByFamily = null;
  FontRegistry.catalogMapBySubset = null;
  try {
    window.dispatchEvent(new CustomEvent("photosuite:font-loaded", { detail: { key: "catalog" } }));
  } catch (_) {}
}

function installFontCatalogCacheInvalidation() {
  if (typeof window === "undefined" || !window.addEventListener) return;
  window.addEventListener("photosuite:fontcatalog-changed", clearFontCatalogCaches);
}

installFontCatalogCacheInvalidation();

export { FontRegistry };
