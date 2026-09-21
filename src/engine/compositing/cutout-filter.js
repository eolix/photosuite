/**
 * Filter Gallery Cutout — region-mean flats with hue-gated merge, flood snap,
 * soft low↔chroma averaging, and local chroma-peak accent restore.
 * Worker-safe (no DOM / Canvas2D).
 */

import { tracePolygons, transformPathCoords, Affine2D } from "./region-polygon-trace.js";

const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function ff(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
function fi(t) {
  const c = t * t * t;
  return c > 0.008856 ? c : (t - 16 / 116) / 7.787;
}

function labOf(r, g, b) {
  const lr = SRGB_LUT[r | 0], lg = SRGB_LUT[g | 0], lb = SRGB_LUT[b | 0];
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  return [116 * ff(y) - 16, 500 * (ff(x) - ff(y)), 200 * (ff(y) - ff(z))];
}
function labToRgb(L, a, b) {
  function l2s(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = 0.95047 * fi(fx), y = fi(fy), z = 1.08883 * fi(fz);
  return [
    l2s(x * 3.2406 + y * -1.5372 + z * -0.4986),
    l2s(x * -0.9689 + y * 1.8758 + z * 0.0415),
    l2s(x * 0.0557 + y * -0.2040 + z * 1.0570),
  ];
}
function lum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function sat(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

// --- domain-transform recursive filter (Gastal & Oliveira 2011) ---
function domainTransformRF(src, w, h, sigmaS, sigmaR, iterations) {
  const N = w * h;
  const out = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    out[i * 3] = src[i * 4];
    out[i * 3 + 1] = src[i * 4 + 1];
    out[i * 3 + 2] = src[i * 4 + 2];
  }
  const dHdx = new Float32Array(N), dVdy = new Float32Array(N);
  const rs = sigmaS / sigmaR;
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = y * w + x, p = i * 4, q = (i - 1) * 4;
      dHdx[i] = 1 + rs * (
        Math.abs(src[p] - src[q]) + Math.abs(src[p + 1] - src[q + 1]) + Math.abs(src[p + 2] - src[q + 2])
      );
    }
  }
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4, q = ((y - 1) * w + x) * 4;
      dVdy[i] = 1 + rs * (
        Math.abs(src[p] - src[q]) + Math.abs(src[p + 1] - src[q + 1]) + Math.abs(src[p + 2] - src[q + 2])
      );
    }
  }
  for (let it = 0; it < iterations; it++) {
    const sigmaH = sigmaS * Math.sqrt(3) * Math.pow(2, iterations - (it + 1)) /
      Math.sqrt(Math.pow(4, iterations) - 1);
    const a = Math.exp(-Math.sqrt(2) / sigmaH), lna = Math.log(a);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 1; x < w; x++) {
        const i = row + x, W = Math.exp(lna * dHdx[i]);
        out[i * 3] += W * (out[(i - 1) * 3] - out[i * 3]);
        out[i * 3 + 1] += W * (out[(i - 1) * 3 + 1] - out[i * 3 + 1]);
        out[i * 3 + 2] += W * (out[(i - 1) * 3 + 2] - out[i * 3 + 2]);
      }
      for (let x = w - 2; x >= 0; x--) {
        const i = row + x, W = Math.exp(lna * dHdx[i + 1]);
        out[i * 3] += W * (out[(i + 1) * 3] - out[i * 3]);
        out[i * 3 + 1] += W * (out[(i + 1) * 3 + 1] - out[i * 3 + 1]);
        out[i * 3 + 2] += W * (out[(i + 1) * 3 + 2] - out[i * 3 + 2]);
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 1; y < h; y++) {
        const i = y * w + x, j = (y - 1) * w + x, W = Math.exp(lna * dVdy[i]);
        out[i * 3] += W * (out[j * 3] - out[i * 3]);
        out[i * 3 + 1] += W * (out[j * 3 + 1] - out[i * 3 + 1]);
        out[i * 3 + 2] += W * (out[j * 3 + 2] - out[i * 3 + 2]);
      }
      for (let y = h - 2; y >= 0; y--) {
        const i = y * w + x, j = (y + 1) * w + x, W = Math.exp(lna * dVdy[j]);
        out[i * 3] += W * (out[j * 3] - out[i * 3]);
        out[i * 3 + 1] += W * (out[j * 3 + 1] - out[i * 3 + 1]);
        out[i * 3 + 2] += W * (out[j * 3 + 2] - out[i * 3 + 2]);
      }
    }
  }
  const res = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    res[i * 4] = Math.max(0, Math.min(255, out[i * 3] + 0.5));
    res[i * 4 + 1] = Math.max(0, Math.min(255, out[i * 3 + 1] + 0.5));
    res[i * 4 + 2] = Math.max(0, Math.min(255, out[i * 3 + 2] + 0.5));
    res[i * 4 + 3] = 255;
  }
  return res;
}

// --- 3. Lab k-means on proxy, assign on full (smoothed) image ---
function labKMeansPalette(proxy, K) {
  const M = proxy.length >> 2;
  const lab = new Float32Array(M * 3);
  for (let i = 0; i < M; i++) {
    const t = labOf(proxy[i * 4], proxy[i * 4 + 1], proxy[i * 4 + 2]);
    lab[i * 3] = t[0]; lab[i * 3 + 1] = t[1]; lab[i * 3 + 2] = t[2];
  }
  let seed = 0x9e3779b9;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cen = new Float32Array(K * 3);
  let s0 = (rnd() * M) | 0;
  cen[0] = lab[s0 * 3]; cen[1] = lab[s0 * 3 + 1]; cen[2] = lab[s0 * 3 + 2];
  const d2 = new Float32Array(M).fill(Infinity);
  for (let k = 1; k < K; k++) {
    let sum = 0, pr = (k - 1) * 3;
    for (let i = 0; i < M; i++) {
      const a = lab[i * 3] - cen[pr], b = lab[i * 3 + 1] - cen[pr + 1], c = lab[i * 3 + 2] - cen[pr + 2];
      const dd = a * a + b * b + c * c;
      if (dd < d2[i]) d2[i] = dd;
      sum += d2[i];
    }
    let t = rnd() * sum, pk = M - 1;
    for (let i = 0; i < M; i++) {
      t -= d2[i];
      if (t <= 0) { pk = i; break; }
    }
    cen[k * 3] = lab[pk * 3]; cen[k * 3 + 1] = lab[pk * 3 + 1]; cen[k * 3 + 2] = lab[pk * 3 + 2];
  }
  const asn = new Uint16Array(M);
  for (let it = 0; it < 14; it++) {
    for (let i = 0; i < M; i++) {
      let bk = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const a = lab[i * 3] - cen[k * 3], b = lab[i * 3 + 1] - cen[k * 3 + 1], c = lab[i * 3 + 2] - cen[k * 3 + 2];
        const dd = a * a + b * b + c * c;
        if (dd < bd) { bd = dd; bk = k; }
      }
      asn[i] = bk;
    }
    const sum = new Float64Array(K * 3), cnt = new Uint32Array(K);
    for (let i = 0; i < M; i++) {
      const k = asn[i];
      sum[k * 3] += lab[i * 3]; sum[k * 3 + 1] += lab[i * 3 + 1]; sum[k * 3 + 2] += lab[i * 3 + 2];
      cnt[k]++;
    }
    for (let k = 0; k < K; k++) if (cnt[k]) {
      cen[k * 3] = sum[k * 3] / cnt[k];
      cen[k * 3 + 1] = sum[k * 3 + 1] / cnt[k];
      cen[k * 3 + 2] = sum[k * 3 + 2] / cnt[k];
    }
  }
  const palette = [];
  for (let k = 0; k < K; k++) palette.push(labToRgb(cen[k * 3], cen[k * 3 + 1], cen[k * 3 + 2]));
  return { cen, palette };
}

function buildProxy(pix, w, h, maxDim) {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  const pw = Math.floor(w / step), ph = Math.floor(h / step);
  const proxy = new Uint8Array(pw * ph * 4);
  for (let oy = 0; oy < ph; oy++) {
    for (let ox = 0; ox < pw; ox++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < step; dy++) {
        let sr = ((oy * step + dy) * w + ox * step) * 4;
        for (let dx = 0; dx < step; dx++) {
          r += pix[sr]; g += pix[sr + 1]; b += pix[sr + 2]; sr += 4;
        }
      }
      const ar = step * step, o = (oy * pw + ox) * 4;
      proxy[o] = r / ar; proxy[o + 1] = g / ar; proxy[o + 2] = b / ar; proxy[o + 3] = 255;
    }
  }
  return proxy;
}

function assignLab(pix, N, cen, K) {
  const lbl = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    const t = labOf(pix[i * 4], pix[i * 4 + 1], pix[i * 4 + 2]);
    let bk = 0, bd = Infinity;
    for (let k = 0; k < K; k++) {
      const a = t[0] - cen[k * 3], b = t[1] - cen[k * 3 + 1], c = t[2] - cen[k * 3 + 2];
      const dd = a * a + b * b + c * c;
      if (dd < bd) { bd = dd; bk = k; }
    }
    lbl[i] = bk;
  }
  return lbl;
}

// --- 4+5. connected components + RAG merge ---
function connectedComponents(lbl, w, h) {
  const N = w * h;
  const comp = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const area = [], sumL = [], sumA = [], sumB = [], color = [];
  let nc = 0;
  // need Lab of each pixel — recompute from labels' mean later; store label id
  for (let s = 0; s < N; s++) {
    if (comp[s] !== -1) continue;
    const id = nc++;
    let sp = 0;
    stack[sp++] = s;
    comp[s] = id;
    let ar = 0;
    const lb = lbl[s];
    while (sp > 0) {
      const p = stack[--sp];
      ar++;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && comp[p - 1] === -1 && lbl[p - 1] === lb) { comp[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && comp[p + 1] === -1 && lbl[p + 1] === lb) { comp[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && comp[p - w] === -1 && lbl[p - w] === lb) { comp[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && comp[p + w] === -1 && lbl[p + w] === lb) { comp[p + w] = id; stack[sp++] = p + w; }
    }
    area.push(ar);
    color.push(lb);
    sumL.push(0); sumA.push(0); sumB.push(0); // filled below if we have Lab
  }
  return { comp, nc, area, color, sumL, sumA, sumB };
}

function fillRegionLab(comp, nc, sm, w, h, sumL, sumA, sumB) {
  const N = w * h;
  for (let i = 0; i < N; i++) {
    const r = comp[i];
    const t = labOf(sm[i * 4], sm[i * 4 + 1], sm[i * 4 + 2]);
    sumL[r] += t[0]; sumA[r] += t[1]; sumB[r] += t[2];
  }
}

/** Lab ab hue angle difference in radians (0..π). Near-neutrals treated as hue-free. */
function labHueDelta(aA, aB, bA, bB) {
  const c1 = Math.hypot(aA, aB), c2 = Math.hypot(bA, bB);
  if (c1 < 10 && c2 < 10) return 0;
  if (c1 < 6 || c2 < 6) return 0; // one near-grey — allow L-only merge
  let d = Math.abs(Math.atan2(aB, aA) - Math.atan2(bB, bA));
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

function labChroma(a, b) {
  return Math.hypot(a, b);
}

/**
 * Small high-chroma patch. Kept out of speck absorb / flood averaging so
 * fine detail survives large flat merges.
 */
function isChromaAccent(area, chroma, minArea, chromaFloor) {
  if (chromaFloor == null) chromaFloor = 24;
  return area < minArea * 4 && chroma >= chromaFloor;
}

/**
 * RAG merge that averages region colours when absorbing a same-hue neighbour.
 * Hue gate blocks cross-hue merges.
 * Tiny speckles may be absorbed into the largest neighbour without tinting its mean.
 * High-chroma accents are never speck-absorbed into flatter neighbours.
 */
function ragMergeMeans(comp, nc, area, sumL, sumA, sumB, w, h, mergeThr, minArea, hueMaxRad) {
  if (hueMaxRad == null) hueMaxRad = 0.4; // ~23°
  const N = w * h;
  const adj = Array.from({ length: nc }, () => new Set());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, r = comp[i];
      if (x < w - 1) {
        const r2 = comp[i + 1];
        if (r2 !== r) { adj[r].add(r2); adj[r2].add(r); }
      }
      if (y < h - 1) {
        const r2 = comp[i + w];
        if (r2 !== r) { adj[r].add(r2); adj[r2].add(r); }
      }
    }
  }
  const par = new Int32Array(nc);
  for (let i = 0; i < nc; i++) par[i] = i;
  function find(a) {
    while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; }
    return a;
  }
  const mL = Float64Array.from(sumL), mA = Float64Array.from(sumA), mB = Float64Array.from(sumB);
  const ar = Float64Array.from(area);
  function meanDist(a, b) {
    const dl = mL[a] / ar[a] - mL[b] / ar[b];
    const da = mA[a] / ar[a] - mA[b] / ar[b];
    const db = mB[a] / ar[a] - mB[b] / ar[b];
    return Math.sqrt(dl * dl + da * da + db * db);
  }
  function hueOk(a, b) {
    return labHueDelta(mA[a] / ar[a], mB[a] / ar[a], mA[b] / ar[b], mB[b] / ar[b]) <= hueMaxRad;
  }
  function chromaOf(r) {
    return labChroma(mA[r] / ar[r], mB[r] / ar[r]);
  }
  /** Refuse eating a punchier patch into a flatter neighbour. */
  function wouldKillAccent(keep, drop) {
    const cDrop = chromaOf(drop), cKeep = chromaOf(keep);
    if (cDrop <= cKeep + 8) return false;
    if (isChromaAccent(ar[drop], cDrop, minArea)) return true;
    // Medium islands of high chroma that already clumped a bit.
    return ar[drop] < minArea * 10 && cDrop >= 30;
  }
  let changed = true, passes = 0;
  while (changed && passes < 60) {
    changed = false;
    passes++;
    for (let r = 0; r < nc; r++) {
      const ra = find(r);
      if (ra !== r) continue;
      for (const nb of adj[r]) {
        const rb = find(nb);
        if (rb === ra) continue;
        const d = meanDist(ra, rb);
        const aSmall = ar[ra] < minArea, bSmall = ar[rb] < minArea;
        const keep = ar[ra] >= ar[rb] ? ra : rb;
        const drop = keep === ra ? rb : ra;
        // Same-hue colour average
        if (d < mergeThr && hueOk(ra, rb)) {
          if (wouldKillAccent(keep, drop)) continue;
          par[drop] = keep;
          mL[keep] += mL[drop]; mA[keep] += mA[drop]; mB[keep] += mB[drop];
          ar[keep] += ar[drop];
          changed = true;
          continue;
        }
        // Speck absorb: paint over with neighbour, do NOT tint neighbour mean/area
        if ((aSmall || bSmall) && ar[drop] < minArea && d < mergeThr * 3) {
          if (wouldKillAccent(keep, drop)) continue;
          par[drop] = keep;
          changed = true;
        }
      }
    }
  }
  const rootId = new Int32Array(N);
  const roots = [];
  const rootIndex = new Map();
  for (let i = 0; i < nc; i++) {
    if (find(i) === i) {
      rootIndex.set(i, roots.length);
      roots.push(i);
    }
  }
  for (let i = 0; i < N; i++) rootId[i] = rootIndex.get(find(comp[i]));
  const meanLab = new Float32Array(roots.length * 3);
  const meanArea = new Float64Array(roots.length);
  for (let ri = 0; ri < roots.length; ri++) {
    const r = roots[ri];
    const a = Math.max(1, ar[r]);
    meanLab[ri * 3] = mL[r] / a;
    meanLab[ri * 3 + 1] = mA[r] / a;
    meanLab[ri * 3 + 2] = mB[r] / a;
    meanArea[ri] = ar[r];
  }
  return { rootId, meanLab, meanArea, roots: roots.length, regionsIn: nc };
}

// Even-odd scanline fill of a simple polygon (flat [x,y,…] vertices) with one
// colour. Pure JS so it runs in the filter worker (no Canvas2D). Sub-pixel
// vertices are sampled at pixel centres.
function rasterizePolygon(out, W, H, coords, r, g, b) {
  const vertexCount = coords.length >> 1;
  if (vertexCount < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (let k = 1; k < coords.length; k += 2) {
    const y = coords[k];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const yStart = Math.max(0, Math.ceil(minY - 0.5));
  const yEnd = Math.min(H - 1, Math.floor(maxY - 0.5));
  const crossings = [];
  for (let y = yStart; y <= yEnd; y++) {
    const sampleY = y + 0.5;
    crossings.length = 0;
    for (let v = 0; v < vertexCount; v++) {
      const ax = coords[v * 2], ay = coords[v * 2 + 1];
      const w = (v + 1) % vertexCount;
      const bx = coords[w * 2], by = coords[w * 2 + 1];
      if ((ay <= sampleY && by > sampleY) || (by <= sampleY && ay > sampleY)) {
        crossings.push(ax + ((sampleY - ay) / (by - ay)) * (bx - ax));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const xStart = Math.max(0, Math.ceil(crossings[c] - 0.5));
      const xEnd = Math.min(W - 1, Math.floor(crossings[c + 1] - 0.5));
      let p = (y * W + xStart) * 4;
      for (let x = xStart; x <= xEnd; x++) {
        out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
        p += 4;
      }
    }
  }
}

/**
 * Renders the merged regions (segmented at work resolution sw×sh) as flat
 * colours at the full output resolution fullW×fullH.
 *
 * Edge Simplicity (EdgS) is the Douglas–Peucker tolerance applied to the traced
 * region boundaries — the same knob the original filter uses — so higher EdgS
 * yields simpler cut-paper edges. Boundaries are traced at work resolution, then
 * the polygons are scaled up and rasterised at full resolution, so the edges are
 * clean straight segments rather than upscaled stair-steps. A nearest-neighbour
 * upscale of the region colours is laid down first to guarantee full coverage.
 */
function fillFromRegionMeans(rootId, meanLab, sw, sh, fullW, fullH, edgS) {
  const workN = sw * sh;
  const out = new Uint8Array(fullW * fullH * 4);
  const compactId = new Map();
  const paletteR = [0], paletteG = [0], paletteB = [0]; // index 0 = padding border
  const idxMap = new Uint16Array(workN);
  for (let i = 0; i < workN; i++) {
    const r = rootId[i];
    let id = compactId.get(r);
    if (id === undefined) {
      id = paletteR.length;
      compactId.set(r, id);
      const rgb = labToRgb(meanLab[r * 3], meanLab[r * 3 + 1], meanLab[r * 3 + 2]);
      paletteR.push(rgb[0]); paletteG.push(rgb[1]); paletteB.push(rgb[2]);
    }
    idxMap[i] = id;
  }
  const regionCount = paletteR.length - 1;

  // Base fill: nearest-neighbour upscale of the work-resolution region colours.
  for (let y = 0; y < fullH; y++) {
    const rowW = ((y * sh / fullH) | 0) * sw, rowF = y * fullW;
    for (let x = 0; x < fullW; x++) {
      const id = idxMap[rowW + ((x * sw / fullW) | 0)];
      const p = (rowF + x) * 4;
      out[p] = paletteR[id]; out[p + 1] = paletteG[id]; out[p + 2] = paletteB[id]; out[p + 3] = 255;
    }
  }
  // buildRegionBoundaries stores indices in a Uint16Array; past that the base
  // upscale stands.
  if (regionCount >= 65500) return out;

  const paddedW = sw + 2, paddedH = sh + 2;
  const padded = new Uint16Array(paddedW * paddedH);
  for (let y = 0; y < sh; y++) {
    padded.set(idxMap.subarray(y * sw, y * sw + sw), (y + 1) * paddedW + 1);
  }
  // The segmentation pipeline (smoothing + k-means + region merge + flood) has
  // already flattened the image to roughly Photoshop's mid Edge-Simplicity look,
  // so this polygon pass only refines the boundaries. A gentle curve keeps a
  // clean 0.6 baseline and ramps slowly, so the slider spans a sensible range
  // instead of collapsing shapes into angular blobs at mid values.
  const tolerance = 0.6 + Math.max(0, edgS - 1) * 0.18;
  const shapes = tracePolygons(padded, paddedW, paddedH, tolerance);
  const scaleX = fullW / sw, scaleY = fullH / sh;
  const unpadScale = new Affine2D(scaleX, 0, 0, scaleY, -scaleX, -scaleY);
  for (let s = 0; s < shapes.length; s++) {
    transformPathCoords(shapes[s].path.coords, unpadScale, shapes[s].path.coords);
  }
  shapes.sort((a, b) =>
    (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height));
  for (let s = 0; s < shapes.length; s++) {
    const id = shapes[s].color;
    if (id <= 0 || id > regionCount) continue;
    rasterizePolygon(out, fullW, fullH, shapes[s].path.coords, paletteR[id], paletteG[id], paletteB[id]);
  }
  return out;
}

/**
 * Paint back local high-chroma peaks from the reference image.
 * Area-capped connected components miss small accents inside large flats —
 * restore only pixels whose ref chroma is a local peak *and* punchier than
 * the flat fill. Large uniform averaged flats are not peaks.
 */
function restoreSmallChromaAccents(outRgba, refRgba, w, h, chromaFloor, peakMargin, outMargin, radius) {
  if (chromaFloor == null) chromaFloor = 28;
  if (peakMargin == null) peakMargin = 7;
  if (outMargin == null) outMargin = 10;
  if (radius == null) radius = 3;
  const N = w * h;
  // Large docs: skip accent restore — O(N·r²) Lab work dominates preview time
  // and does not change the low↔high chroma flat pairing.
  if (N > 2_500_000) return { nRestored: 0, nComps: 0 };
  if (N > 1_200_000) radius = Math.min(radius, 1);

  // Cheap RGB range gate before full Lab (most pixels are low-chroma flats).
  const cheapFloor = Math.max(12, (chromaFloor * 0.55) | 0);
  const refC = new Float32Array(N);
  const refA = new Float32Array(N);
  const refB = new Float32Array(N);
  const refL = new Float32Array(N);
  const candidate = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    const r = refRgba[p], g = refRgba[p + 1], b = refRgba[p + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mx - mn < cheapFloor) continue;
    const lab = labOf(r, g, b);
    refL[i] = lab[0]; refA[i] = lab[1]; refB[i] = lab[2];
    refC[i] = labChroma(lab[1], lab[2]);
    if (refC[i] >= chromaFloor) candidate[i] = 1;
  }
  let nRestored = 0;
  const hit = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!candidate[i]) continue;
      const p = i * 4;
      const outLab = labOf(outRgba[p], outRgba[p + 1], outRgba[p + 2]);
      const outCh = labChroma(outLab[1], outLab[2]);
      if (outCh < 24) continue;
      const need = outCh >= 40 ? Math.min(outMargin, 5) : outMargin;
      const punchier =
        refC[i] >= outCh + need ||
        Math.hypot(refA[i] - outLab[1], refB[i] - outLab[2]) > 12;
      if (!punchier) continue;
      let s = 0, n = 0, sA = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!candidate[j] && refC[j] === 0) continue;
          s += refC[j];
          sA += refA[j];
          n++;
        }
      }
      if (n < 1) continue;
      const localPeak =
        refC[i] >= s / n + peakMargin ||
        refA[i] >= sA / n + peakMargin;
      if (!localPeak) continue;
      hit[i] = 1;
    }
  }
  const dil = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hit[i]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          dil[yy * w + xx] = 1;
        }
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (!dil[i]) continue;
    if (refC[i] < chromaFloor * 0.75) continue;
    const rgb = labToRgb(refL[i], refA[i], refB[i]);
    const p = i * 4;
    outRgba[p] = rgb[0]; outRgba[p + 1] = rgb[1]; outRgba[p + 2] = rgb[2];
    nRestored++;
  }
  return { nRestored, nComps: nRestored };
}

/**
 * Paint-bucket fill snap: flood through adjacent non-walled regions within
 * floodThr, then posterize each component to a few shared L levels with one
 * chroma taken from this component. Geometry unchanged — only fills move.
 *
 * Gates use Lab distance, hue angle, and chroma *ratios* scaled by floodThr —
 * no fixed palette colours.
 */
function floodSnapSimilarFills(rootId, meanLab, meanArea, w, h, floodThr, levelsPerComp, floodMinArea, darkLMax) {
  if (floodThr == null) floodThr = 32;
  if (levelsPerComp == null) levelsPerComp = 3;
  if (floodMinArea == null) floodMinArea = 100;
  if (darkLMax == null) darkLMax = 26;
  const R = meanLab.length / 3;
  const isDark = new Uint8Array(R);
  const isTiny = new Uint8Array(R);
  for (let r = 0; r < R; r++) {
    if (isDarkBackgroundLab(meanLab[r * 3], meanLab[r * 3 + 1], meanLab[r * 3 + 2], darkLMax)) {
      isDark[r] = 1;
    }
    if (meanArea[r] < floodMinArea) isTiny[r] = 1;
  }
  const par = new Int32Array(R);
  for (let i = 0; i < R; i++) par[i] = i;
  function find(a) {
    while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; }
    return a;
  }
  function link(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) par[rb] = ra;
  }
  function labDist(i, j) {
    const dL = meanLab[i * 3] - meanLab[j * 3];
    const dA = meanLab[i * 3 + 1] - meanLab[j * 3 + 1];
    const dB = meanLab[i * 3 + 2] - meanLab[j * 3 + 2];
    return Math.sqrt(dL * dL + dA * dA + dB * dB);
  }
  function canFlood(i, j, maxDist, cheb) {
    const a1 = meanLab[i * 3 + 1], b1 = meanLab[i * 3 + 2];
    const a2 = meanLab[j * 3 + 1], b2 = meanLab[j * 3 + 2];
    const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2);
    const dL = meanLab[i * 3] - meanLab[j * 3];
    const dA = a1 - a2, dB = b1 - b2;
    const thr = maxDist != null ? maxDist : floodThr;
    const cSig = thr * 0.28;

    let hueDelta = 0;
    if (c1 > cSig && c2 > cSig) {
      hueDelta = Math.abs(Math.atan2(b1, a1) - Math.atan2(b2, a2));
      if (hueDelta > Math.PI) hueDelta = 2 * Math.PI - hueDelta;
      if (hueDelta > 0.45) return false;
    }

    // Soft low↔chroma joins are handled in the second pass (each low-chroma
    // region picks one chromatic partner). Linking them here would transitively
    // glue two different chromatics through a low-chroma bridge.
    const lowCut = thr * 0.45;
    if (c1 < lowCut || c2 < lowCut) return false;

    if (labDist(i, j) >= thr) return false;
    return true;
  }
  // Bridge thin dark seams between flats. 4-connected always; long Chebyshev
  // only from pixels that touch dark (seam), never from every region edge
  // (that degenerates to a full-image O(N·gap²) scan and freezes preview).
  const gap = 14;
  const seen = new Set();
  function tryLink(r, r2, cheb) {
    if (isDark[r2] || isTiny[r2] || r2 === r) return;
    const key = r < r2 ? r * R + r2 : r2 * R + r;
    if (seen.has(key)) return;
    seen.add(key);
    const thr = cheb > 1 ? floodThr * 0.55 : floodThr;
    if (canFlood(r, r2, thr, cheb)) link(r, r2);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = rootId[i];
      if (isDark[r] || isTiny[r]) continue;
      if (x + 1 < w) tryLink(r, rootId[i + 1], 1);
      if (y + 1 < h) tryLink(r, rootId[i + w], 1);
      let onDarkSeam = false;
      if (x > 0 && isDark[rootId[i - 1]]) onDarkSeam = true;
      else if (x + 1 < w && isDark[rootId[i + 1]]) onDarkSeam = true;
      else if (y > 0 && isDark[rootId[i - w]]) onDarkSeam = true;
      else if (y + 1 < h && isDark[rootId[i + w]]) onDarkSeam = true;
      if (!onDarkSeam) continue;
      for (let dy = 0; dy <= gap; dy++) {
        for (let dx = dy === 0 ? 1 : -gap; dx <= gap; dx++) {
          const cheb = Math.max(Math.abs(dx), Math.abs(dy));
          if (cheb < 2 || cheb > gap) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          tryLink(r, rootId[yy * w + xx], cheb);
        }
      }
    }
  }
  const comps = new Map();
  for (let r = 0; r < R; r++) {
    if (isDark[r] || isTiny[r]) continue;
    const root = find(r);
    let m = comps.get(root);
    if (!m) { m = []; comps.set(root, m); }
    m.push(r);
  }
  const out = new Float32Array(meanLab.length);
  out.set(meanLab);
  let nComps = 0, nSnapped = 0;
  const samplePalettes = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    nComps++;
    // Shared ab = area-weighted mean of every member (chroma + low-chroma mix).
    let sA = 0, sB = 0, sw = 0;
    for (const i of members) {
      const wt = meanArea[i];
      sA += meanLab[i * 3 + 1] * wt;
      sB += meanLab[i * 3 + 2] * wt;
      sw += wt;
    }
    const a0 = sA / sw;
    const b0 = sB / sw;
    const chromas = members.map((i) => labChroma(meanLab[i * 3 + 1], meanLab[i * 3 + 2])).sort((a, b) => a - b);
    const medC = chromas[(chromas.length / 2) | 0];
    // Lightness-only levels
    const Ls = members.map((i) => meanLab[i * 3]).sort((a, b) => a - b);
    const K = Math.min(levelsPerComp, new Set(Ls.map((v) => Math.round(v))).size, members.length);
    const levels = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const i0 = Math.floor((k * Ls.length) / K);
      const i1 = Math.max(i0 + 1, Math.floor(((k + 1) * Ls.length) / K));
      let s = 0, n = 0;
      for (let j = i0; j < i1; j++) { s += Ls[j]; n++; }
      levels[k] = s / n;
    }
    for (let it = 0; it < 8; it++) {
      const sum = new Float64Array(K), cnt = new Float64Array(K);
      for (const i of members) {
        const L = meanLab[i * 3];
        let bk = 0, bd = Infinity;
        for (let k = 0; k < K; k++) {
          const d = Math.abs(L - levels[k]);
          if (d < bd) { bd = d; bk = k; }
        }
        sum[bk] += L * meanArea[i];
        cnt[bk] += meanArea[i];
      }
      for (let k = 0; k < K; k++) if (cnt[k]) levels[k] = sum[k] / cnt[k];
    }
    for (const i of members) {
      const L = meanLab[i * 3];
      let bk = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = Math.abs(L - levels[k]);
        if (d < bd) { bd = d; bk = k; }
      }
      out[i * 3] = levels[bk];
      // Keep punchy outliers on their own chroma; only share L with the group.
      const cI = labChroma(meanLab[i * 3 + 1], meanLab[i * 3 + 2]);
      if (cI > medC * 1.3 && cI > floodThr * 0.55) {
        out[i * 3 + 1] = meanLab[i * 3 + 1];
        out[i * 3 + 2] = meanLab[i * 3 + 2];
      } else {
        out[i * 3 + 1] = a0;
        out[i * 3 + 2] = b0;
      }
      nSnapped++;
    }
    if (samplePalettes.length < 4) {
      const pal = [];
      for (let k = 0; k < K; k++) {
        const rgb = labToRgb(levels[k], a0, b0);
        pal.push("#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""));
      }
      samplePalettes.push(pal.join(" "));
    }
  }

  // Soft low↔chroma: 4-connected adjacency always; long crease bridge only from
  // dark-touching pixels (same cost trap as flood — every region edge is too many).
  {
    const lowCut = floodThr * 0.45;
    const softGap = 14;
    const peri = Array.from({ length: R }, () => new Map());
    function bumpPeri(r, r2) {
      if (r === r2 || isDark[r] || isDark[r2] || isTiny[r] || isTiny[r2]) return;
      peri[r].set(r2, (peri[r].get(r2) || 0) + 1);
      peri[r2].set(r, (peri[r2].get(r) || 0) + 1);
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const r = rootId[i];
        if (isDark[r] || isTiny[r]) continue;
        if (x + 1 < w) bumpPeri(r, rootId[i + 1]);
        if (y + 1 < h) bumpPeri(r, rootId[i + w]);
        let onDarkSeam = false;
        if (x > 0 && isDark[rootId[i - 1]]) onDarkSeam = true;
        else if (x + 1 < w && isDark[rootId[i + 1]]) onDarkSeam = true;
        else if (y > 0 && isDark[rootId[i - w]]) onDarkSeam = true;
        else if (y + 1 < h && isDark[rootId[i + w]]) onDarkSeam = true;
        if (!onDarkSeam) continue;
        for (let dy = 0; dy <= softGap; dy++) {
          for (let dx = dy === 0 ? 1 : -softGap; dx <= softGap; dx++) {
            const cheb = Math.max(Math.abs(dx), Math.abs(dy));
            if (cheb < 2 || cheb > softGap) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            bumpPeri(r, rootId[yy * w + xx]);
          }
        }
      }
    }
    const groups = new Map();
    for (let r = 0; r < R; r++) {
      if (isDark[r] || isTiny[r]) continue;
      const cR = Math.hypot(out[r * 3 + 1], out[r * 3 + 2]);
      if (cR >= lowCut) continue;
      let best = -1, bestScore = -1;
      for (const [nb, count] of peri[r]) {
        const cN = Math.hypot(out[nb * 3 + 1], out[nb * 3 + 2]);
        if (meanArea[nb] < floodMinArea * 2.5) continue;
        if (cN < Math.max(lowCut * 1.6, cR + 18)) continue;
        if (Math.abs(out[r * 3] - out[nb * 3]) > floodThr * 1.15) continue;
        const score = count * (10 + cN);
        if (score > bestScore) {
          bestScore = score;
          best = nb;
        }
      }
      if (best < 0) continue;
      let g = groups.get(best);
      if (!g) { g = []; groups.set(best, g); }
      g.push(r);
    }
    const families = new Map();
    for (const [chromatic, lows] of groups) {
      const key =
        Math.round(out[chromatic * 3 + 1] * 4) + ":" + Math.round(out[chromatic * 3 + 2] * 4);
      let fam = families.get(key);
      if (!fam) {
        fam = {
          aChr: out[chromatic * 3 + 1],
          bChr: out[chromatic * 3 + 2],
          chromatics: new Set(),
          lows: new Set(),
          chromArea: 0,
        };
        families.set(key, fam);
      }
      fam.chromatics.add(chromatic);
      fam.chromArea += meanArea[chromatic];
      for (const lo of lows) fam.lows.add(lo);
    }
    const ranked = [...families.values()].sort((a, b) => {
      return Math.hypot(b.aChr, b.bChr) - Math.hypot(a.aChr, a.bChr);
    });
    const claimed = new Uint8Array(R);
    for (const fam of ranked) {
      const lows = [...fam.lows].filter((i) => !claimed[i]);
      if (!lows.length) continue;
      let sA = 0, sB = 0, sw = 0;
      for (const i of lows) {
        const wt = Math.max(1, meanArea[i]);
        sA += out[i * 3 + 1] * wt;
        sB += out[i * 3 + 2] * wt;
        sw += wt;
      }
      const aLow = sA / sw, bLow = sB / sw;
      const a0 = 0.5 * (fam.aChr + aLow);
      const b0 = 0.5 * (fam.bChr + bLow);
      const lowSet = new Set(lows);
      const aC = fam.aChr, bC = fam.bChr;
      const updateChromatic = sw >= fam.chromArea * 0.45;
      for (let i = 0; i < R; i++) {
        if (isDark[i] || isTiny[i] || claimed[i]) continue;
        const cI = Math.hypot(out[i * 3 + 1], out[i * 3 + 2]);
        if (isChromaAccent(meanArea[i], cI, floodMinArea, floodThr * 0.5) && !lowSet.has(i)) continue;
        const sameFlat =
          fam.chromatics.has(i) ||
          (Math.abs(out[i * 3 + 1] - aC) < 0.05 && Math.abs(out[i * 3 + 2] - bC) < 0.05);
        const isLow = lowSet.has(i);
        if (!isLow && !(updateChromatic && sameFlat)) continue;
        out[i * 3 + 1] = a0;
        out[i * 3 + 2] = b0;
        claimed[i] = 1;
        nSnapped++;
      }
    }
  }

  return { meanLab: out, nComps, nSnapped, samplePalettes };
}

function isDarkBackgroundLab(L, a, b, darkLMax) {
  if (darkLMax == null) darkLMax = 26;
  if (L < darkLMax) return true;
  const chroma = Math.hypot(a, b);
  return L < darkLMax + 10 && chroma < darkLMax * 0.7;
}

// A cutout only reads as "subject on a flat ground" when the dark actually is
// the ground. Below this coverage the dark pixels are more likely a dark subject
// or dark detail, and merging them all into one flat would destroy it.
const MIN_DARK_GROUND_FRACTION = 0.25;

/**
 * Collapse the dark regions onto one flat equal to their area-weighted mean
 * (content-derived — no fixed target colour), but only when the dark covers a
 * large enough fraction of the image to be a background rather than a subject.
 */
function collapseDarkBackground(rootId, meanLab, meanArea, darkLMax) {
  if (darkLMax == null) darkLMax = 26;
  const R = meanLab.length / 3;
  const N = rootId.length;
  const darkIds = [];
  let sumL = 0, sumA = 0, sumB = 0, sumW = 0;
  let keeper = -1, keeperArea = -1;
  for (let r = 0; r < R; r++) {
    const L = meanLab[r * 3], a = meanLab[r * 3 + 1], b = meanLab[r * 3 + 2];
    if (!isDarkBackgroundLab(L, a, b, darkLMax)) continue;
    darkIds.push(r);
    const weight = meanArea[r];
    sumL += L * weight; sumA += a * weight; sumB += b * weight; sumW += weight;
    if (weight > keeperArea) { keeperArea = weight; keeper = r; }
  }
  if (keeper < 0 || sumW < 1 || sumW < N * MIN_DARK_GROUND_FRACTION) {
    return { rootId, meanLab, meanArea, darkKeeper: -1, nDark: darkIds.length };
  }
  const flatL = sumL / sumW;
  const flatA = sumA / sumW;
  const flatB = sumB / sumW;
  const remap = new Int32Array(R);
  for (let r = 0; r < R; r++) remap[r] = r;
  let collapsedArea = 0;
  for (const r of darkIds) { remap[r] = keeper; collapsedArea += meanArea[r]; }
  const newRoot = new Int32Array(N);
  for (let i = 0; i < N; i++) newRoot[i] = remap[rootId[i]];
  const outMean = new Float32Array(meanLab);
  const outArea = Float64Array.from(meanArea);
  outMean[keeper * 3] = flatL;
  outMean[keeper * 3 + 1] = flatA;
  outMean[keeper * 3 + 2] = flatB;
  outArea[keeper] = collapsedArea;
  for (const r of darkIds) {
    if (r === keeper) continue;
    outMean[r * 3] = flatL; outMean[r * 3 + 1] = flatA; outMean[r * 3 + 2] = flatB;
    outArea[r] = 0;
  }
  return { rootId: newRoot, meanLab: outMean, meanArea: outArea, darkKeeper: keeper, nDark: darkIds.length };
}

/**
 * Asymmetric Edge Simplicity: dark ground eats into neighbours.
 * Never merges two non-dark flats into each other — keeps multi-level large
 * flats that a full majority wipe would flatten.
 * High-chroma accents are not eroded.
 */
function erodeIntoDark(rootId, darkKeeper, w, h, radius, iterations, meanLab, meanArea, minArea) {
  if (darkKeeper < 0 || radius < 1 || iterations < 1) return rootId;
  const R = meanLab ? meanLab.length / 3 : 0;
  const protect = new Uint8Array(R);
  if (meanLab && meanArea && minArea != null) {
    for (let r = 0; r < R; r++) {
      const c = labChroma(meanLab[r * 3 + 1], meanLab[r * 3 + 2]);
      if (isChromaAccent(meanArea[r], c, minArea, 24)) protect[r] = 1;
    }
  }
  let cur = rootId;
  for (let it = 0; it < iterations; it++) {
    const next = new Int32Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i] === darkKeeper) continue;
        if (protect[cur[i]]) continue;
        let darkVotes = 0, total = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            total++;
            if (cur[yy * w + xx] === darkKeeper) darkVotes++;
          }
        }
        if (darkVotes * 2 > total) next[i] = darkKeeper;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Second-stage merge: adjacent regions whose means are close get averaged.
 * hueMaxRad = π disables the hue gate (Lab distance alone decides).
 */
function mergeAdjacentByMean(rootId, meanLab, meanArea, w, h, mergeThr, minArea, hueMaxRad) {
  if (hueMaxRad == null) hueMaxRad = 0.4;
  const N = w * h;
  const R = meanLab.length / 3;
  const adj = Array.from({ length: R }, () => new Set());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, r = rootId[i];
      if (x < w - 1) {
        const r2 = rootId[i + 1];
        if (r2 !== r) { adj[r].add(r2); adj[r2].add(r); }
      }
      if (y < h - 1) {
        const r2 = rootId[i + w];
        if (r2 !== r) { adj[r].add(r2); adj[r2].add(r); }
      }
    }
  }
  const par = new Int32Array(R);
  for (let i = 0; i < R; i++) par[i] = i;
  function find(a) {
    while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; }
    return a;
  }
  const mL = new Float64Array(R), mA = new Float64Array(R), mB = new Float64Array(R), ar = new Float64Array(R);
  for (let i = 0; i < R; i++) {
    mL[i] = meanLab[i * 3] * meanArea[i];
    mA[i] = meanLab[i * 3 + 1] * meanArea[i];
    mB[i] = meanLab[i * 3 + 2] * meanArea[i];
    ar[i] = meanArea[i];
  }
  function dist(a, b) {
    const dl = mL[a] / ar[a] - mL[b] / ar[b];
    const da = mA[a] / ar[a] - mA[b] / ar[b];
    const db = mB[a] / ar[a] - mB[b] / ar[b];
    return Math.sqrt(dl * dl + da * da + db * db);
  }
  function hueOk(a, b) {
    return labHueDelta(mA[a] / ar[a], mB[a] / ar[a], mA[b] / ar[b], mB[b] / ar[b]) <= hueMaxRad;
  }
  function chromaOf(r) {
    return labChroma(mA[r] / ar[r], mB[r] / ar[r]);
  }
  function wouldKillAccent(keep, drop) {
    const cDrop = chromaOf(drop), cKeep = chromaOf(keep);
    if (cDrop <= cKeep + 8) return false;
    if (isChromaAccent(ar[drop], cDrop, minArea)) return true;
    return ar[drop] < minArea * 10 && cDrop >= 30;
  }
  let changed = true, passes = 0;
  while (changed && passes < 60) {
    changed = false;
    passes++;
    for (let r = 0; r < R; r++) {
      const ra = find(r);
      if (ra !== r) continue;
      for (const nb of adj[r]) {
        const rb = find(nb);
        if (rb === ra) continue;
        const d = dist(ra, rb);
        const keep = ar[ra] >= ar[rb] ? ra : rb;
        const drop = keep === ra ? rb : ra;
        if (d < mergeThr && hueOk(ra, rb)) {
          if (wouldKillAccent(keep, drop)) continue;
          par[drop] = keep;
          mL[keep] += mL[drop]; mA[keep] += mA[drop]; mB[keep] += mB[drop];
          ar[keep] += ar[drop];
          changed = true;
          continue;
        }
        if (ar[drop] < minArea && d < mergeThr * 3) {
          if (wouldKillAccent(keep, drop)) continue;
          par[drop] = keep; // speck: no mean tint
          changed = true;
        }
      }
    }
  }
  const roots = [];
  const map = new Map();
  for (let i = 0; i < R; i++) if (find(i) === i) {
    map.set(i, roots.length);
    roots.push(i);
  }
  const newRootId = new Int32Array(N);
  for (let i = 0; i < N; i++) newRootId[i] = map.get(find(rootId[i]));
  const newMean = new Float32Array(roots.length * 3);
  const newArea = new Float64Array(roots.length);
  for (let ni = 0; ni < roots.length; ni++) {
    const r = roots[ni];
    const a = Math.max(1, ar[r]);
    newMean[ni * 3] = mL[r] / a;
    newMean[ni * 3 + 1] = mA[r] / a;
    newMean[ni * 3 + 2] = mB[r] / a;
    newArea[ni] = ar[r];
  }
  return { rootId: newRootId, meanLab: newMean, meanArea: newArea, roots: roots.length };
}

// --- 7. Edge Fidelity: snap boundary pixels toward strong original gradients ---
function computeGradientMag(src, w, h) {
  const N = w * h;
  const mag = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // luminance sobel
      const l = (yy, xx) => {
        const p = (yy * w + xx) * 4;
        return 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
      };
      const gx =
        -l(y - 1, x - 1) + l(y - 1, x + 1) +
        -2 * l(y, x - 1) + 2 * l(y, x + 1) +
        -l(y + 1, x - 1) + l(y + 1, x + 1);
      const gy =
        -l(y - 1, x - 1) - 2 * l(y - 1, x) - l(y - 1, x + 1) +
        l(y + 1, x - 1) + 2 * l(y + 1, x) + l(y + 1, x + 1);
      mag[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return mag;
}

function snapBoundaries(lbl, w, h, gradMag, fidelity, srcLabPix) {
  // Edge Fidelity 2..3: nudge boundary pixels toward the labels sitting on the
  // strongest original gradients, so region edges follow real contours. The
  // radius stays 1 (a boundary pixel only re-votes among its immediate
  // neighbours) — a wider window would average distinct regions together and
  // erase detail, which is the opposite of "fidelity". Higher fidelity only
  // raises the pull toward high-gradient neighbours.
  if (fidelity < 1) return lbl;
  const N = w * h;
  const out = lbl.slice();
  const radius = 1;
  const strength = 0.35 + fidelity * 0.25; // weight boost for high-grad neighbors
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // only reconsider boundary pixels
      const self = lbl[i];
      let isBoundary = false;
      if (lbl[i - 1] !== self || lbl[i + 1] !== self || lbl[i - w] !== self || lbl[i + w] !== self) {
        isBoundary = true;
      }
      if (!isBoundary) continue;
      // weighted vote by gradient magnitude among neighborhood labels
      const scores = new Map();
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          const wgt = 1 + strength * (gradMag[j] / (gradMag[j] + 40));
          scores.set(lbl[j], (scores.get(lbl[j]) || 0) + wgt);
        }
      }
      let best = self, bestS = -1;
      for (const [lab, sc] of scores) {
        if (sc > bestS) { bestS = sc; best = lab; }
      }
      out[i] = best;
    }
  }
  return out;
}

// --- fill ---

/**
 * Apply Cutout into `dst` (RGBA Uint8ClampedArray / Uint8Array).
 * @param {Uint8Array|Uint8ClampedArray} src
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} dst
 * @param {number[]} params [NmbL, EdgS, EdgF]
 *   NmbL — levels / seed palette scale (2–8)
 *   EdgS — edge simplicity (higher → more merge / smoother regions)
 *   EdgF — edge fidelity (1–3): snap region boundaries toward strong source gradients
 */
export function applyCutout(src, width, height, dst, params) {
  const NmbL = Math.max(2, Math.min(8, (params && params[0]) | 0 || 4));
  const EdgS = Math.max(1, Math.min(10, (params && params[1]) | 0 || 3));
  const EdgF = Math.max(1, Math.min(3, (params && params[2]) != null ? (params[2] | 0) : 1));
  const W = width | 0, H = height | 0, N = W * H;
  if (dst.length < N * 4 || src.length < N * 4) {
    throw new Error("cutout: buffer length mismatch");
  }

  // Segment at a bounded working resolution, then rasterise the regions to full
  // size. Every per-pixel stage runs on ≤ WORK_CAP² pixels, so cost and the
  // pixel-tuned constants (blur radius, seam gap, min-area) are the same at any
  // document size — preview and full render match.
  const WORK_CAP = 1500;
  const step = Math.max(1, Math.ceil(Math.max(W, H) / WORK_CAP));
  const sw = Math.max(1, Math.floor(W / step));
  const sh = Math.max(1, Math.floor(H / step));
  const segPix = step > 1 ? buildProxy(src, W, H, WORK_CAP) : src;
  const sn = sw * sh;

  const K = 24;
  const sigmaS = 3;
  const dtIters = 2;
  const mergeThr = 5;
  const mergeThr2 = 6;
  const minArea = Math.max(8, Math.floor(sn * 0.00005));
  const hueMax = 0.4;
  const floodThr = 50;
  const floodLevels = Math.max(2, Math.min(6, NmbL));
  const floodMinArea = 60;
  const darkLMax = 26;

  const sm = domainTransformRF(segPix, sw, sh, sigmaS, 120, dtIters);
  const proxy = buildProxy(sm, sw, sh, Math.min(512, Math.max(256, Math.round(Math.max(sw, sh) / 3))));
  const { cen } = labKMeansPalette(proxy, K);
  const seedLbl = assignLab(sm, sn, cen, K);

  const cc = connectedComponents(seedLbl, sw, sh);
  fillRegionLab(cc.comp, cc.nc, sm, sw, sh, cc.sumL, cc.sumA, cc.sumB);
  let merged = ragMergeMeans(
    cc.comp, cc.nc, cc.area, cc.sumL, cc.sumA, cc.sumB,
    sw, sh, mergeThr, minArea, hueMax
  );
  let rootId = merged.rootId;
  let meanLab = merged.meanLab;
  let meanArea = merged.meanArea;

  {
    const m2 = mergeAdjacentByMean(rootId, meanLab, meanArea, sw, sh, mergeThr2, minArea, hueMax);
    rootId = m2.rootId; meanLab = m2.meanLab; meanArea = m2.meanArea;
  }

  // Flood + soft low↔chroma pairing before dark collapse.
  {
    const fl = floodSnapSimilarFills(rootId, meanLab, meanArea, sw, sh, floodThr, floodLevels, floodMinArea, darkLMax);
    meanLab = fl.meanLab;
  }

  let darkKeeper = -1;
  {
    const dark = collapseDarkBackground(rootId, meanLab, meanArea, darkLMax);
    rootId = dark.rootId; meanLab = dark.meanLab; meanArea = dark.meanArea;
    darkKeeper = dark.darkKeeper;
  }

  // Boundary cleanup where the dark ground meets a subject; kept small and fixed
  // so it does not double up with Edge Simplicity (which drives the polygon
  // simplification in fillFromRegionMeans).
  if (darkKeeper >= 0) {
    rootId = erodeIntoDark(rootId, darkKeeper, sw, sh, 1, 2, meanLab, meanArea, minArea);
  }

  // EdgF ≥ 2: nudge region borders toward the strong gradients in the original
  // image so edges follow real contours. snapBoundaries only relabels boundary
  // pixels among existing regions, so the flood-paired region colours in meanLab
  // stay valid — we keep them rather than recomputing from raw pixels, which
  // would discard the soft low↔chroma pairing (e.g. the beak's grey lower
  // mandible taking the beige of its upper half). Detail is preserved because no
  // regions are re-merged. EdgF = 1 leaves borders unsnapped (gallery default).
  if (EdgF >= 2) {
    const grad = computeGradientMag(segPix, sw, sh);
    rootId = snapBoundaries(new Uint16Array(rootId), sw, sh, grad, EdgF, null);
  }

  const out = fillFromRegionMeans(rootId, meanLab, sw, sh, W, H, EdgS);
  restoreSmallChromaAccents(out, src, W, H, 28, 7, 10, 2);
  dst.set(out.subarray(0, N * 4));
}
