// Splits a filter run across a pool of Web Workers, one horizontal band each, and
// stitches the results. Every worker runs the same FilterPixelOps kernel with a row
// halo and a global row offset, so the stitched output matches the single-threaded
// path exactly (benchFilter below checks this). The point is throughput:
// WKWebView's JavaScriptCore runs these tight integer loops on one core; this uses
// all of them without changing a single output pixel.
//
// Transferable ArrayBuffers are used (not SharedArrayBuffer) so this works under
// WKWebView's custom protocol without cross-origin isolation.
import { PixelEngine } from "./pixel-engine.js";
import { FilterPixelOps } from "./filter-pixel-ops.js";
// Kernel + parameter dispatch table — the single source of truth shared with the
// renderer. Main-thread only (the worker receives just the resolved params array),
// so its dependency on the engine modules is fine here.
import { GalleryFilterDefs } from "./gallery-filter-defs.js";

export const FilterBandRunner = {};

FilterBandRunner._pool = null;
FilterBandRunner._req = 0;
FilterBandRunner.poolSize = Math.max(2, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4);
// Bump when the worker module contract changes so HMR / sticky pools drop dead workers.
FilterBandRunner._workerRev = 6;
FilterBandRunner._poolRev = 0;

// Change the number of bands/workers. Tears down the existing pool so the next
// run rebuilds at the new size. Used to sweep N when measuring.
FilterBandRunner.setPoolSize = function (n) {
  n = Math.max(1, n | 0);
  if (n === this.poolSize && this._pool) return;
  if (this._pool) { this._pool.forEach(function (worker) { worker.terminate(); }); this._pool = null; }
  this.poolSize = n;
  this._poolRev = -1; // force _ensurePool to rebuild
  this._prewarmed = false;
  this._prewarmPromise = null;
};

FilterBandRunner._ensurePool = function () {
  if (this._pool && this._poolRev === this._workerRev) return this._pool;
  if (this._pool) {
    this._pool.forEach(function (worker) { worker.terminate(); });
    this._pool = null;
  }
  this._poolRev = this._workerRev;
  this._prewarmed = false;
  this._prewarmPromise = null;
  var pool = [];
  for (var i = 0; i < this.poolSize; i++) {
    var url = new URL("./workers/filter-band-worker.js", import.meta.url);
    url.searchParams.set("v", "r" + this._workerRev + "-" + Date.now());
    var worker = new Worker(url, { type: "module" });
    worker._pending = new Map();
    worker.onmessage = (function (capturedWorker) {
      return function (ev) {
        var msg = ev.data || {};
        var pendingEntry = capturedWorker._pending.get(msg.id);
        if (!pendingEntry) return;
        capturedWorker._pending.delete(msg.id);
        if (msg.error) pendingEntry.reject(new Error(msg.error));
        else pendingEntry.resolve(msg);
      };
    })(worker);
    worker.onerror = (function (capturedWorker) {
      return function (e) {
        console.error("[BAND] worker error:", e.message || e);
        capturedWorker._pending.forEach(function (p) { p.reject(new Error("worker error")); });
        capturedWorker._pending.clear();
      };
    })(worker);
    pool.push(worker);
  }
  this._pool = pool;
  return pool;
};

FilterBandRunner._call = function (worker, msg, transfer) {
  var id = ++this._req;
  msg.id = id;
  return new Promise(function (resolve, reject) {
    worker._pending.set(id, { resolve: resolve, reject: reject });
    try {
      worker.postMessage(msg, transfer);
    } catch (err) {
      worker._pending.delete(id);
      reject(err);
    }
  });
};

// kernel: name of a FilterPixelOps kernel; src: RGBA Uint8(Clamped)Array of the full
// w*h image; halo: extra rows each band reads beyond its useful region. Returns a
// Promise<Uint8ClampedArray> of the stitched w*h result.
// Ensure the worker pool exists and every worker's WASM kernels have loaded, so a
// subsequent timed run reflects the WASM path (not the JS fallback racing a fetch).
// Resolves to true if all ready, false if it timed out.
FilterBandRunner.warmup = function (timeoutMs) {
  var pool = this._ensurePool();
  var self = this;
  var deadline = performance.now() + (timeoutMs || 4000);
  function pingAll() {
    return Promise.all(pool.map(function (worker) { return self._call(worker, { ping: true }); }))
      .then(function (reps) {
        if (reps.every(function (r) { return r.ready; })) return true;
        if (performance.now() > deadline) return false;
        return new Promise(function (res) { setTimeout(res, 50); }).then(pingAll);
      });
  }
  return pingAll();
};

// Registry of gallery filters that are safe to run band-parallel. A filter qualifies
// when its kernel uses only local (haloed) or per-pixel ops — no whole-image region
// tracing, no grid/texture positioned at absolute coordinates. Origin-anchored ops
// that DO appear (gaussBlur tile grid, mergeEdge row pattern, scan-order RNG) are
// handled by PixelEngine's band context.
//
// This table holds ONLY the offload strategy per filter; the kernel name and how to
// read its arguments come from the shared GalleryFilterDefs.KERNELS table, so they
// never drift from the renderer. Each entry:
//   mode  — "band" (split across the pool, stitch) or "whole" (one worker, full
//           image: no speedup but byte-identical and off the main thread)
//   halo  — (band only) params → extra rows each band reads beyond its useful region
//           (cumulative vertical reach of the kernel's neighbourhood ops, padded)
//   field — (band only, optional) for a single scan-order random plane: generate it
//           once on the main thread so workers skip the RNG
// Add a band entry only after confirming its output matches single-thread
// (window.__BAND logs the byte-difference count).
FilterBandRunner.OFFLOAD = {
  // --- mode "band": parallel, verified diffs=0 ---
  Ptch: {
    mode: "band",
    halo: function (kernelParams) {
      var blockSize = kernelParams[0] + 5,
        thirdBlock = (blockSize / 3) | 0,
        halfBlockPlusOne = ((blockSize / 2) | 0) + 1;
      return 2 * (blockSize + 2 * thirdBlock + halfBlockPlusOne + 1) + 16;
    },
    field: function (PE, w, h, kernelParams) {
      PE.seedRandom(kernelParams[2]);
      var randPlane = new Uint8Array(w * h);
      PE.randomFill(randPlane);
      return randPlane;
    }
  },
  DryB: {
    mode: "band",
    halo: function (kernelParams) {
      var blockSize = kernelParams[0] + 5,
        detailReach = 15 - kernelParams[1];
      return 2 * (blockSize + detailReach) + 24;
    }
  },
  AccE: {
    mode: "band",
    halo: function (kernelParams) {
      var edgeWidth = kernelParams[0] + 1,
        smoothness = kernelParams[2];
      return 2 * (edgeWidth + smoothness) + 24;
    }
  },
  ClrP: {
    mode: "band",
    halo: function (kernelParams) {
      var pencilKernel = 2 * kernelParams[0] + 1;
      return 2 * (pencilKernel + 15) + 24;
    }
  },
  AngS: { mode: "band", halo: function (kernelParams) { return 2 * kernelParams[1] + 24; } },
  Crsh: { mode: "band", halo: function (kernelParams) { return 2 * kernelParams[2] * (kernelParams[0] + 3) + 24; } },
  PltK: { mode: "band", halo: function (kernelParams) { return 2 * (5 - kernelParams[1]) * kernelParams[0] + 24; } },

  // --- mode "whole": one worker, full image. Byte-identical for any FilterPixelOps
  // kernel (it sees the whole image, so RNG/histogram/grid all behave normally); no
  // speedup, but decoupled from the main thread. Covers every remaining table filter
  // except the three texture-emboss ones (need texture data plumbed to the worker).
  // Gray-out filters colourise on the main thread. ---
  // auto-levels:
  Wtrc: { mode: "whole" }, Smie: { mode: "whole" }, Frsc: { mode: "whole" },
  PstE: { mode: "whole" }, InkO: { mode: "whole" }, DrkS: { mode: "whole" },
  FlmG: { mode: "whole" }, SmdS: { mode: "whole" },
  // other direct-output:
  NGlw: { mode: "whole" }, Spng: { mode: "whole" }, DfsG: { mode: "whole" },
  ChlC: { mode: "whole" }, NtPr: { mode: "whole" }, WtrP: { mode: "whole" },
  Crql: { mode: "whole" }, Grn:  { mode: "whole" }, MscT: { mode: "whole" },
  // Cutout is whole-image (not band-safe) but must stay off the main thread so
  // gallery sliders keep working while the preview computes.
  Ct:   { mode: "whole" },
  // gray-output (colourised on main after the worker returns the gray plane):
  GraP: { mode: "whole" }, Chrc: { mode: "whole" }, Plst: { mode: "whole" },
  Rtcl: { mode: "whole" }, Stmp: { mode: "whole" }, TrnE: { mode: "whole" }
};
// Still main-thread (not offloaded): texture-emboss (RghP/Undr/CntC — need texture
// data in the worker), and the engine-based filters
// (Phtc/Spt/SprS/BsRl/PlsW/Chrm/Gls/OcnR/Txtz/PntD…, not in KERNELS).

// Context for the shared KERNELS params functions. Offloaded filters don't read
// fg/bg/texture today, but plumb them through for correctness and future gray-out.
FilterBandRunner._ctx = function (descriptor, colors) {
  function pack(c) { return c ? (c.h << 24 | c.l << 16 | c.O << 8 | 255) : 0; }
  colors = colors || {};
  return {
    fg: pack(colors.fg), bg: pack(colors.bg),
    seed: descriptor.FlRs ? descriptor.FlRs.v >>> 1 : 0,
    texture: null
  };
};

// Whether the filter has a worker path (band or whole) — gates the live preview.
FilterBandRunner.canOffload = function (filterKey) {
  return Object.prototype.hasOwnProperty.call(this.OFFLOAD, filterKey) &&
    !!GalleryFilterDefs.KERNELS[filterKey];
};
// Band-mode entries can be vetted via window.__BAND (banded vs single byte diff).
FilterBandRunner.canBench = function (filterKey) {
  var offloadEntry = this.OFFLOAD[filterKey];
  return !!offloadEntry && offloadEntry.mode === "band";
};

// Run a gallery filter on the worker pool, from its descriptor. Mode "whole" sends
// the full image to one worker (byte-identical, decoupled, no speedup); mode "band"
// splits across the pool. Returns Promise<Uint8ClampedArray> or null.
FilterBandRunner.runFilterKey = function (filterKey, descriptor, src, w, h, colors) {
  var offloadEntry = this.OFFLOAD[filterKey], kernelSpec = GalleryFilterDefs.KERNELS[filterKey];
  if (!offloadEntry || !kernelSpec) return null;
  var params = kernelSpec.params(descriptor, this._ctx(descriptor, colors));
  if (offloadEntry.mode === "whole") {
    var promise = this.runWhole(kernelSpec.kernel, params, src, w, h);
    if (kernelSpec.out === "gray") {
      // Kernel returns a gray plane in the R channel; colourise on the main thread
      // with fg/bg (colorizeGrayToRgba needs the engine, which the lean worker doesn't have).
      var fg = (colors && colors.fg) || { h: 0, l: 0, O: 0 };
      var bg = (colors && colors.bg) || { h: 255, l: 255, O: 255 };
      promise = promise.then(function (dst) {
        var pixelCount = w * h, gray = new Uint8Array(pixelCount);
        for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++)
          gray[pixelIndex] = dst[pixelIndex * 4];
        GalleryFilterDefs.colorizeGrayToRgba(gray, dst, fg, bg);
        return dst;
      });
    }
    return promise;
  }
  var opts;
  if (offloadEntry.field) {
    var pixelEngine = PixelEngine;
    pixelEngine._bandOffY = 0; pixelEngine._bandFullH = 0; pixelEngine._randSkip = 0; pixelEngine._randField = null;
    pixelEngine.init(w, h);
    opts = { field: offloadEntry.field(pixelEngine, w, h, params) };
  }
  return this.run(kernelSpec.kernel, src, w, h, params, offloadEntry.halo(params), opts);
};

// Run a kernel on the full image in a single worker — same result as the main-thread
// path, just off the main thread so the UI stays responsive.
FilterBandRunner.runWhole = function (kernel, params, src, w, h) {
  var pool = this._ensurePool();
  var buf = src.slice(0); // own transferable buffer
  var msg = { kernelName: kernel, buf: buf.buffer, w: w, h: h, offY: 0, fullH: h, randSkip: 0, params: params };
  return this._call(pool[0], msg, [msg.buf]).then(function (workerReply) {
    return new Uint8ClampedArray(workerReply.buf);
  });
};

// One-time warm-up: load the WASM kernels in every worker and run a tiny filter a
// couple of times so each worker's JIT is hot before the first real preview. Safe to
// call repeatedly (guarded); returns a Promise that resolves when warm.
FilterBandRunner.prewarm = function () {
  if (this._prewarmed) return this._prewarmPromise || Promise.resolve();
  this._prewarmed = true;
  var self = this;
  this._prewarmPromise = this.warmup(4000).then(function () {
    var thumbW = 256, thumbH = 256, src = new Uint8ClampedArray(thumbW * thumbH * 4);
    for (var byteIndex = 0; byteIndex < src.length; byteIndex++)
      src[byteIndex] = (byteIndex * 31) & 255;
    var descriptor = { SqrS: { v: 4 }, Rlf: { v: 8 }, FlRs: { v: 12345 } };
    return self.runFilterKey("Ptch", descriptor, src, thumbW, thumbH).then(function () {
      return self.runFilterKey("Ptch", descriptor, src, thumbW, thumbH);
    });
  }).catch(function () { /* fallback path renders single-threaded if this fails */ });
  return this._prewarmPromise;
};

FilterBandRunner.run = function (kernel, src, w, h, params, halo, opts) {
  var pool = this._ensurePool();
  var self = this;
  var field = opts && opts.field;
  var dst = new Uint8ClampedArray(w * h * 4);
  var workerCount = pool.length;
  var rowsPer = Math.ceil(h / workerCount);
  var bandPromises = [];
  var kernelTimes = [], wasmFlags = { medianWasmReady: true, blurWasmReady: true };

  for (var workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    var bandStartRow = workerIndex * rowsPer;
    var bandEndRow = Math.min(h, bandStartRow + rowsPer);
    if (bandStartRow >= bandEndRow) break;
    var top = Math.max(0, bandStartRow - halo);
    var bot = Math.min(h, bandEndRow + halo);
    var bandH = bot - top;
    var bandBuf = src.slice(top * w * 4, bot * w * 4); // copy → own transferable buffer
    var transfer = [bandBuf.buffer];
    var msg = {
      kernelName: kernel, buf: bandBuf.buffer, w: w, h: bandH,
      offY: top, fullH: h, randSkip: top * w, params: params
    };
    if (field) {
      var bandField = field.slice(top * w, bot * w); // copy → own transferable buffer
      msg.randField = bandField.buffer;
      transfer.push(bandField.buffer);
    }
    bandPromises.push((function (bandStartRow, bandEndRow, top, msg, transfer) {
      return self._call(pool[workerIndex], msg, transfer).then(function (workerReply) {
        var band = new Uint8ClampedArray(workerReply.buf);
        var srcOff = (bandStartRow - top) * w * 4;
        var len = (bandEndRow - bandStartRow) * w * 4;
        dst.set(band.subarray(srcOff, srcOff + len), bandStartRow * w * 4);
        kernelTimes.push(workerReply.kernelMs || 0);
        if (!workerReply.medianWasmReady) wasmFlags.medianWasmReady = false;
        if (!workerReply.blurWasmReady) wasmFlags.blurWasmReady = false;
      });
    })(bandStartRow, bandEndRow, top, msg, transfer));
  }
  this._lastKernelTimes = kernelTimes;
  this._lastWasmFlags = wasmFlags;

  return Promise.all(bandPromises).then(function () { return dst; });
};

// Measurement harness: runs the single-threaded kernel and the banded path on the
// same input, times both, and counts byte differences. Logs the result. Set
// window.__BAND to a band count (e.g. 4, 8) and trigger a preview of a registered
// filter. The byte-difference count is the gate for adding a filter to FILTERS.
FilterBandRunner.benchFilter = function (filterKey, descriptor, src, w, h, bandCount) {
  var kernelSpec = GalleryFilterDefs.KERNELS[filterKey];
  if (!this.canOffload(filterKey)) { console.warn("[BAND] not offloadable:", filterKey); return Promise.resolve(); }
  if (bandCount > 1) this.setPoolSize(bandCount);
  var pixelEngine = PixelEngine, params = kernelSpec.params(descriptor, this._ctx(descriptor, null));
  pixelEngine._bandOffY = 0; pixelEngine._bandFullH = 0; pixelEngine._randSkip = 0; pixelEngine._randField = null;

  var ref = new Uint8ClampedArray(w * h * 4);
  var singleStartMs = performance.now();
  FilterPixelOps[kernelSpec.kernel](src, w, h, ref, params);
  var single = performance.now() - singleStartMs;

  var self = this;
  var reps = (typeof window !== "undefined" && +window.__BANDREPS) || 4;
  var times = [], lastBanded = null;
  return this.prewarm().then(function () {
    // Run the live banded path repeatedly: if per-run time drops, the workers' JIT
    // was cold (ceiling higher); if it's flat, we're memory-bandwidth bound.
    function once(k) {
      if (k >= reps) return Promise.resolve();
      var runStartMs = performance.now();
      return self.runFilterKey(filterKey, descriptor, src, w, h).then(function (banded) {
        times.push(performance.now() - runStartMs);
        lastBanded = banded;
        return once(k + 1);
      });
    }
    return once(0).then(function () {
      var diff = 0, first = -1;
      for (var byteIndex = 0; byteIndex < ref.length; byteIndex++) {
        if (ref[byteIndex] !== lastBanded[byteIndex]) { diff++; if (first < 0) first = byteIndex; }
      }
      // Per-band diff breakdown: distinguishes whole-band failures (a few bands
      // entirely wrong) from seam stripes (every band wrong only near its edges).
      var workerCount = FilterBandRunner.poolSize, rowsPer = Math.ceil(h / workerCount), perBand = [];
      for (var bandIndex = 0; bandIndex < workerCount; bandIndex++) {
        var bandRowStart = bandIndex * rowsPer, bandRowEnd = Math.min(h, bandRowStart + rowsPer);
        if (bandRowStart >= bandRowEnd) break;
        var bandDiffCount = 0, startByte = bandRowStart * w * 4, endByte = bandRowEnd * w * 4;
        for (var byteIndex = startByte; byteIndex < endByte; byteIndex++)
          if (ref[byteIndex] !== lastBanded[byteIndex]) bandDiffCount++;
        var bandDiffPercent = Math.round(100 * bandDiffCount / (endByte - startByte));
        perBand.push(bandDiffPercent);
      }
      var kernelTimes = self._lastKernelTimes || [];
      var maxKernelMs = kernelTimes.length ? Math.max.apply(null, kernelTimes) : 0;
      var minKernelMs = kernelTimes.length ? Math.min.apply(null, kernelTimes) : 0;
      var wasmFlags = self._lastWasmFlags || {};
      var best = Math.min.apply(null, times);
      console.log(
        "[BAND] " + filterKey + " " + w + "x" + h + " N=" + FilterBandRunner.poolSize +
        " halo=" + FilterBandRunner.OFFLOAD[filterKey].halo(params) +
        " | single=" + single.toFixed(0) +
        "ms banded[" + times.map(function (t) { return t.toFixed(0); }).join(",") + "]" +
        " best=" + best.toFixed(0) + "ms speedup=" + (single / best).toFixed(2) + "x | diffs=" + diff +
        (first >= 0 ? " firstByte=" + first + " (row~" + ((first / 4 / w) | 0) + ")" : " (BYTE-IDENTICAL)") +
        " | per-band-diff%=[" + perBand.join(",") + "]" +
        " | kernel(last) min=" + minKernelMs.toFixed(0) + " max=" + maxKernelMs.toFixed(0) + "ms" +
        " wasm[median=" + (wasmFlags.medianWasmReady ? "Y" : "N") + " blur=" + (wasmFlags.blurWasmReady ? "Y" : "N") + "]"
      );
      return { single: single, best: best, diff: diff, perBand: perBand };
    });
  }).catch(function (e) {
    console.error("[BAND] run failed:", e);
  });
};
