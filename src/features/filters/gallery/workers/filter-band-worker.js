// Module worker that runs a single FilterPixelOps kernel on one horizontal band
// of an image. The band buffer carries a halo (extra rows above/below the useful
// region) so neighbourhood ops (blur/median/directional) are exact at the seams,
// and the engine is told the band's global row offset so origin-anchored ops
// (gaussBlur tile grid, mergeEdge pattern, randomFill RNG sequence) reproduce the
// full-image result byte-for-byte. Imports the real modules — no algorithm copy.
import { PixelEngine } from "../pixel-engine.js";
import { FilterPixelOps } from "../filter-pixel-ops.js";

self.onmessage = function (ev) {
  var job = ev.data;

  // Readiness handshake: report whether the WASM kernels have finished loading, so
  // the pool can be pre-warmed before timing (otherwise the kernel runs the slower
  // JS fallback while the fetch is still in flight).
  if (job.ping) {
    self.postMessage({ id: job.id, ready: !!(PixelEngine._medianWasm && PixelEngine._blurWasm) });
    return;
  }

  // job = { id, kernelName, buf, w, h, offY, fullH, randSkip, params }
  var src = new Uint8ClampedArray(job.buf);
  var dst = new Uint8ClampedArray(src.length);

  PixelEngine._bandOffY = job.offY | 0;     // global row of this band's local row 0
  PixelEngine._bandFullH = job.fullH | 0;   // global image height
  // If the main thread pre-computed the random plane, use its slice directly and
  // skip the RNG fast-forward; otherwise fast-forward to this band's offset.
  if (job.randField) {
    PixelEngine._randField = new Uint8Array(job.randField);
    PixelEngine._randSkip = 0;
  } else {
    PixelEngine._randField = null;
    PixelEngine._randSkip = job.randSkip | 0;
  }

  var kernelStartMs = performance.now();
  try {
    FilterPixelOps[job.kernelName](src, job.w, job.h, dst, job.params);
  } catch (err) {
    PixelEngine._bandOffY = 0;
    PixelEngine._bandFullH = 0;
    PixelEngine._randSkip = 0;
    PixelEngine._randField = null;
    self.postMessage({
      id: job.id,
      error: (err && err.message) ? err.message : String(err)
    });
    return;
  } finally {
    PixelEngine._bandOffY = 0;
    PixelEngine._bandFullH = 0;
    PixelEngine._randSkip = 0;
    PixelEngine._randField = null;
  }
  var kernelMs = performance.now() - kernelStartMs;

  var transferBuffer = dst.buffer;
  self.postMessage({
    id: job.id, buf: transferBuffer, kernelMs: kernelMs,
    medianWasmReady: !!PixelEngine._medianWasm, blurWasmReady: !!PixelEngine._blurWasm
  }, [transferBuffer]);
};
