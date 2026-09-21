// Web Worker: parse font files with Typr off the main thread.
// Typr is a DOM-free global script (no bundler), loaded via importScripts. It
// probes `window` for TextDecoder support, so shim it onto the worker scope.
self.window = self;
importScripts("../vendor/js/typr/Typr.js");

self.onmessage = (event) => {
  const { id, buf } = event.data || {};
  try {
    // Typr needs a byte view; a bare ArrayBuffer makes some fonts throw.
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    self.postMessage({ id, ok: true, parsed: Typr.parse(bytes) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
