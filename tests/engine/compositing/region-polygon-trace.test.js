/**
 * Golden values for region-polygon-trace (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let IndexRect;
let Affine2D;
let UnionFind;
let copyIndexBufferRect;
let quantizeRgbaBuffer;
let quantizePerceptualViaProxy;
let mergeSmallRegions;
let tracePolygons;
let transformPathCoords;
let pathBounds;
let pointInPolygon;
let padIndexMapOnePixel;

before(async () => {
  globalThis.UPNG = {
    quantize(buf, n) {
      const inds = new Uint8Array(buf.byteLength / 4);
      for (let i = 0; i < inds.length; i++) inds[i] = i % Math.min(n, 4);
      return {
        inds,
        plte: Array.from({ length: Math.min(n, 4) }, (_, i) => ({
          est: { q: [i / 4, (i + 1) / 5, (i + 2) / 6, 1] },
        })),
      };
    },
  };
  ({
    IndexRect,
    Affine2D,
    UnionFind,
    copyIndexBufferRect,
    quantizeRgbaBuffer,
    quantizePerceptualViaProxy,
    mergeSmallRegions,
    tracePolygons,
    transformPathCoords,
    pathBounds,
    pointInPolygon,
    padIndexMapOnePixel,
  } = await import("../../../src/engine/compositing/region-polygon-trace.js"));
});

describe("engine/compositing/region-polygon-trace.js", () => {
  it("IndexRect intersect / contains / isEmpty", () => {
    const a = new IndexRect(0, 0, 10, 10);
    const inter = a.intersectRect(new IndexRect(5, 5, 10, 10));
    assert.equal(inter.x, 5);
    assert.equal(inter.y, 5);
    assert.equal(inter.width, 5);
    assert.equal(inter.height, 5);
    assert.equal(a.containsRect(new IndexRect(1, 1, 2, 2)), true);
    assert.equal(a.containsRect(new IndexRect(5, 5, 10, 10)), false);
    assert.equal(new IndexRect().isEmpty(), true);
  });

  it("UnionFind links components to a shared root", () => {
    const uf = new UnionFind(5);
    uf.link(0, 1);
    uf.link(2, 3);
    uf.link(1, 2);
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => uf.find(i)), [3, 3, 3, 3, 4]);
  });

  it("Affine2D transformPathCoords scales and translates", () => {
    const out = [];
    transformPathCoords([1, 1, 2, 3], new Affine2D(2, 0, 0, 2, 1, 3), out);
    assert.deepEqual(out, [3, 5, 5, 9]);
  });

  it("padIndexMapOnePixel embeds the map with a 1px zero border", () => {
    const pad = padIndexMapOnePixel(new Uint8Array([1, 2, 3, 4]), 2, 2);
    assert.equal(pad.width, 4);
    assert.equal(pad.height, 4);
    assert.deepEqual(Array.from(pad.buffer), [
      0, 0, 0, 0,
      0, 1, 2, 0,
      0, 3, 4, 0,
      0, 0, 0, 0,
    ]);
  });

  it("copyIndexBufferRect copies a full overlapping rect", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const dst = new Uint8Array(9);
    copyIndexBufferRect(src, new IndexRect(0, 0, 3, 3), dst, new IndexRect(0, 0, 3, 3));
    assert.deepEqual(Array.from(dst), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("mergeSmallRegions absorbs undersized neighbors", () => {
    const map = new Uint8Array([
      1, 1, 1, 2,
      1, 1, 1, 2,
      1, 1, 1, 2,
      3, 3, 3, 3,
    ]);
    mergeSmallRegions(map, 4, 4, 5);
    assert.deepEqual(Array.from(map), new Array(16).fill(1));
  });

  it("pointInPolygon and pathBounds", () => {
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    assert.equal(pointInPolygon(sq, 5, 5), true);
    assert.equal(pointInPolygon(sq, 15, 5), false);
    assert.equal(pointInPolygon(sq, 0, 5), true);
    const bounds = pathBounds([1, 2, 5, 2, 5, 8, 1, 8]);
    assert.equal(bounds.x, 1);
    assert.equal(bounds.y, 2);
    assert.equal(bounds.width, 4);
    assert.equal(bounds.height, 6);
  });

  it("tracePolygons with and without Douglas–Peucker simplify", () => {
    const map = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 1, 1, 1, 1, 1, 1, 0,
      0, 1, 1, 1, 1, 1, 1, 0,
      0, 1, 1, 1, 1, 1, 1, 0,
      0, 1, 1, 1, 1, 1, 1, 0,
      0, 1, 1, 1, 1, 1, 1, 0,
      0, 1, 1, 1, 1, 1, 1, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const raw = tracePolygons(map.slice(0), 8, 8, 0);
    const simplified = tracePolygons(map.slice(0), 8, 8, 1.5);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].path.coords.length, 48);
    assert.deepEqual(simplified[0].path.coords, [1, 7, 1, 1, 7, 1, 7, 7]);
  });

  it("quantizeRgbaBuffer wraps UPNG palette entries", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = i;
      rgba[i + 1] = 50;
      rgba[i + 2] = 100;
      rgba[i + 3] = 255;
    }
    const q = quantizeRgbaBuffer(rgba.buffer, 4, 4, 4);
    assert.deepEqual(Array.from(q.indices), [
      0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3,
    ]);
    assert.deepEqual(q.palette[0][1], { red: 0, green: 51, blue: 85, alpha: 255 });
  });

  it("quantizePerceptualViaProxy is deterministic on a two-tone proxy", () => {
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        rgba[i] = x < 4 ? 200 : 20;
        rgba[i + 1] = x < 4 ? 30 : 180;
        rgba[i + 2] = x < 4 ? 30 : 40;
        rgba[i + 3] = 255;
      }
    }
    const pq = quantizePerceptualViaProxy(rgba.buffer, 2, 8, 8, 8);
    assert.deepEqual(Array.from(pq.indices.slice(0, 16)), [
      0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1,
    ]);
    assert.deepEqual(pq.palette, [
      ["", { red: 200, green: 30, blue: 30, alpha: 255 }],
      ["", { red: 20, green: 180, blue: 40, alpha: 255 }],
    ]);
  });
});
