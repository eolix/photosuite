//! Blurs: Gaussian, box, motion, radial, surface.

use photosuite_geom::Rect;

use crate::image::{Edge, Image, premultiply, unpremultiply};
use crate::{Ctx, RadialMethod};

/// Normalized Gaussian kernel with standard deviation `sigma` (radius 3σ).
pub(crate) fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    if sigma < 0.05 {
        return vec![1.0];
    }
    let r = (sigma * 3.0).ceil() as i32;
    let k: Vec<f32> = (-r..=r).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let s: f32 = k.iter().sum();
    k.into_iter().map(|v| v / s).collect()
}

/// Separable convolution of `src` (premultiplied internally) for `out`.
/// `src` must cover `out` grown by the kernel radii.
pub(crate) fn conv_sep(src: &Image, out: Rect, kx: &[f32], ky: &[f32], alpha: bool) -> Vec<f32> {
    let n = src.ch;
    let (rx, ry) = ((kx.len() / 2) as i32, (ky.len() / 2) as i32);
    let (ow, oh) = (out.width() as usize, out.height() as usize);
    let th = oh + 2 * ry as usize;
    // Premultiplied copy of the needed source window.
    let win = Rect::new(out.x0 - rx, out.y0 - ry, out.x1 + rx, out.y1 + ry);
    let ww = win.width() as usize;
    let mut p = vec![0.0f32; ww * win.height() as usize * n];
    for y in win.y0..win.y1 {
        for x in win.x0..win.x1 {
            let o = ((y - win.y0) as usize * ww + (x - win.x0) as usize) * n;
            for c in 0..n {
                p[o + c] = src.get(x, y, c);
            }
        }
    }
    premultiply(&mut p, n, alpha);
    // Horizontal pass: (ow × th).
    let mut tmp = vec![0.0f32; ow * th * n];
    for ty in 0..th {
        let row = &p[ty * ww * n..(ty + 1) * ww * n];
        let dst = &mut tmp[ty * ow * n..(ty + 1) * ow * n];
        for ox in 0..ow {
            let d = &mut dst[ox * n..(ox + 1) * n];
            for (i, kv) in kx.iter().enumerate() {
                let s = &row[(ox + i) * n..(ox + i + 1) * n];
                for c in 0..n {
                    d[c] += s[c] * kv;
                }
            }
        }
    }
    // Vertical pass.
    let mut res = vec![0.0f32; ow * oh * n];
    for oy in 0..oh {
        let d = &mut res[oy * ow * n..(oy + 1) * ow * n];
        for (i, kv) in ky.iter().enumerate() {
            let s = &tmp[(oy + i) * ow * n..(oy + i + 1) * ow * n];
            for (dv, sv) in d.iter_mut().zip(s) {
                *dv += sv * kv;
            }
        }
    }
    unpremultiply(&mut res, n, alpha);
    res
}

pub(crate) fn gaussian(src: &Image, out: Rect, ctx: &Ctx, radius: f32) -> Vec<f32> {
    // Exact kernel for small radii; beyond that three box passes approximate the Gaussian with
    // cost independent of the radius (Kovesi, "Fast almost-Gaussian filtering", 2010).
    if radius <= 4.0 {
        let k = gaussian_kernel(radius);
        return conv_sep(src, out, &k, &k, ctx.alpha);
    }
    gaussian_boxes(src, out, ctx.alpha, radius)
}

/// Box widths (odd) whose `n`-fold convolution has standard deviation `sigma`.
fn boxes_for_gauss(sigma: f32, n: usize) -> Vec<usize> {
    let nf = n as f32;
    let w_ideal = (12.0 * sigma * sigma / nf + 1.0).sqrt();
    let mut wl = w_ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    let m_ideal = (12.0 * sigma * sigma - nf * (wl * wl) as f32 - 4.0 * nf * wl as f32 - 3.0 * nf) / (-4.0 * wl as f32 - 4.0);
    let m = m_ideal.round().clamp(0.0, nf) as usize;
    (0..n).map(|i| if i < m { wl as usize } else { wu as usize }).collect()
}

/// Running-sum box blur of every row of an interleaved `w × h × n` buffer (edges clamped).
fn box_rows(buf: &mut [f32], w: usize, n: usize, r: usize) {
    if r == 0 || w == 0 {
        return;
    }
    let norm = 1.0 / (2 * r + 1) as f32;
    let blur_row = |row: &mut [f32]| {
        // The row with clamped edges materialised (r + 1 pixels each side), so the running sum
        // reads without bounds clamping, all channels per step.
        let pad = r + 1;
        let mut src = Vec::with_capacity((w + 2 * pad) * n);
        for _ in 0..pad {
            src.extend_from_slice(&row[..n]);
        }
        src.extend_from_slice(row);
        for _ in 0..pad {
            src.extend_from_slice(&row[(w - 1) * n..w * n]);
        }
        let mut acc = [0.0f32; 8];
        let acc = &mut acc[..n.min(8)];
        if n > 8 {
            // Unusual channel counts: per channel.
            for c in 0..n {
                let mut a: f32 = (0..=2 * r).map(|i| src[(pad - r + i) * n + c]).sum();
                for x in 0..w {
                    row[x * n + c] = a * norm;
                    a += src[(x + pad + r + 1) * n + c] - src[(x + pad - r) * n + c];
                }
            }
            return;
        }
        for i in 0..=2 * r {
            let o = (pad - r + i) * n;
            for c in 0..n {
                acc[c] += src[o + c];
            }
        }
        for x in 0..w {
            let (add, sub) = ((x + pad + r + 1) * n, (x + pad - r) * n);
            for c in 0..n {
                row[x * n + c] = acc[c] * norm;
                acc[c] += src[add + c] - src[sub + c];
            }
        }
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        buf.par_chunks_mut(w * n).for_each(blur_row);
    }
    #[cfg(target_arch = "wasm32")]
    buf.chunks_mut(w * n).for_each(blur_row);
}

fn transpose(buf: &[f32], w: usize, h: usize, n: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; buf.len()];
    if w == 0 || h == 0 {
        return out;
    }
    const B: usize = 32; // cache-friendly blocks
    // Bands of B output rows (= input columns) are independent: transpose them in parallel.
    let band = |(i, chunk): (usize, &mut [f32])| {
        let bx = i * B;
        for by in (0..h).step_by(B) {
            for y in by..(by + B).min(h) {
                for x in bx..(bx + B).min(w) {
                    let (s, d) = ((y * w + x) * n, ((x - bx) * h + y) * n);
                    chunk[d..d + n].copy_from_slice(&buf[s..s + n]);
                }
            }
        }
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        out.par_chunks_mut(B * h * n).enumerate().for_each(band);
    }
    #[cfg(target_arch = "wasm32")]
    out.chunks_mut(B * h * n).enumerate().for_each(band);
    out
}

/// Gaussian blur by three box passes per axis over a premultiplied window.
fn gaussian_boxes(src: &Image, out: Rect, alpha: bool, sigma: f32) -> Vec<f32> {
    box_passes(src, out, alpha, &boxes_for_gauss(sigma, 3))
}

/// Box blurs of the given (odd) widths, one after another along each axis, over a premultiplied
/// window; running sums make the cost independent of the widths.
fn box_passes(src: &Image, out: Rect, alpha: bool, boxes: &[usize]) -> Vec<f32> {
    let n = src.ch;
    let margin: i32 = boxes.iter().map(|w| (*w as i32 - 1) / 2).sum::<i32>() + 1;
    let win = Rect::new(out.x0 - margin, out.y0 - margin, out.x1 + margin, out.y1 + margin);
    let (ww, wh) = (win.width() as usize, win.height() as usize);
    let mut p = vec![0.0f32; ww * wh * n];
    let fill = |yy: usize, row: &mut [f32]| {
        let y = win.y0 + yy as i32;
        for (xx, px) in row.chunks_exact_mut(n).enumerate() {
            for (c, v) in px.iter_mut().enumerate() {
                *v = src.get(win.x0 + xx as i32, y, c);
            }
        }
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        p.par_chunks_mut(ww * n).enumerate().for_each(|(y, row)| fill(y, row));
    }
    #[cfg(target_arch = "wasm32")]
    p.chunks_mut(ww * n).enumerate().for_each(|(y, row)| fill(y, row));
    premultiply(&mut p, n, alpha);
    for w in boxes {
        box_rows(&mut p, ww, n, (w - 1) / 2);
    }
    let mut t = transpose(&p, ww, wh, n);
    for w in boxes {
        box_rows(&mut t, wh, n, (w - 1) / 2);
    }
    let p = transpose(&t, wh, ww, n);
    let (ow, oh) = (out.width() as usize, out.height() as usize);
    let mut res = vec![0.0f32; ow * oh * n];
    for y in 0..oh {
        let s = ((y + margin as usize) * ww + margin as usize) * n;
        res[y * ow * n..(y + 1) * ow * n].copy_from_slice(&p[s..s + ow * n]);
    }
    unpremultiply(&mut res, n, alpha);
    res
}

pub(crate) fn boxed(src: &Image, out: Rect, ctx: &Ctx, radius: f32) -> Vec<f32> {
    let r = radius.max(0.0).round() as usize;
    // Running sums cost the same at any radius; the direct kernel is quicker for the smallest.
    if r <= 4 {
        let k = vec![1.0 / (2 * r + 1) as f32; 2 * r + 1];
        return conv_sep(src, out, &k, &k, ctx.alpha);
    }
    box_passes(src, out, ctx.alpha, &[2 * r + 1])
}

fn average_samples(src: &Image, out: Rect, ctx: &Ctx, mut offsets: impl FnMut(f32, f32, &mut Vec<(f32, f32)>)) -> Vec<f32> {
    let n = src.ch;
    let mut res = Vec::with_capacity(out.width() as usize * out.height() as usize * n);
    let mut pts = Vec::new();
    let mut tmp = vec![0.0f32; n];
    let mut acc = vec![0.0f32; n];
    for y in out.y0..out.y1 {
        for x in out.x0..out.x1 {
            let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
            pts.clear();
            offsets(cx, cy, &mut pts);
            for a in acc.iter_mut() {
                *a = 0.0;
            }
            for &(sx, sy) in &pts {
                src.sample(sx, sy, Edge::Transparent, src.rect, ctx.alpha, &mut tmp);
                // Accumulate premultiplied.
                let a = if ctx.alpha { tmp[n - 1] } else { 1.0 };
                for c in 0..n {
                    acc[c] += if ctx.alpha && c < n - 1 { tmp[c] * a } else { tmp[c] };
                }
            }
            let k = 1.0 / pts.len().max(1) as f32;
            for a in acc.iter_mut() {
                *a *= k;
            }
            if ctx.alpha {
                let a = acc[n - 1];
                for v in acc.iter_mut().take(n - 1) {
                    *v = if a > 1e-7 { *v / a } else { 0.0 };
                }
            }
            res.extend_from_slice(&acc);
        }
    }
    res
}

pub(crate) fn motion(src: &Image, out: Rect, ctx: &Ctx, angle: f32, distance: f32) -> Vec<f32> {
    let d = distance.abs();
    if d < 0.5 {
        return src.crop(out);
    }
    let (s, c) = angle.to_radians().sin_cos();
    let steps = d.ceil() as i32;
    average_samples(src, out, ctx, |x, y, pts| {
        for i in 0..=steps {
            let t = i as f32 / steps as f32 - 0.5;
            pts.push((x + c * d * t, y - s * d * t));
        }
    })
}

pub(crate) fn radial(src: &Image, out: Rect, ctx: &Ctx, amount: f32, method: RadialMethod, center: (f32, f32)) -> Vec<f32> {
    let b = ctx.bounds;
    let (cx, cy) = (b.x0 as f32 + b.width() as f32 * center.0, b.y0 as f32 + b.height() as f32 * center.1);
    let amount = amount.clamp(0.0, 100.0);
    average_samples(src, out, ctx, |x, y, pts| {
        let (dx, dy) = (x - cx, y - cy);
        let r = (dx * dx + dy * dy).sqrt();
        match method {
            RadialMethod::Spin => {
                // Arc of `amount` degrees centred on the pixel.
                let arc = amount.to_radians();
                let n = ((arc * r).ceil() as i32).clamp(1, 64);
                for i in 0..=n {
                    let t = (i as f32 / n as f32 - 0.5) * arc;
                    let (s, c) = t.sin_cos();
                    pts.push((cx + dx * c - dy * s, cy + dx * s + dy * c));
                }
            }
            RadialMethod::Zoom => {
                // Samples along the ray, up to amount/2 % closer to the centre.
                let span = amount / 200.0;
                let n = ((span * r).ceil() as i32).clamp(1, 64);
                for i in 0..=n {
                    let k = 1.0 - span * i as f32 / n as f32;
                    pts.push((cx + dx * k, cy + dy * k));
                }
            }
        }
    })
}

/// [`surface`] for 8-bit samples (every colour sample in the window is `k / 255`; `None`
/// otherwise): a 256-bin histogram of each channel over the window slides along the row, adding
/// and removing one column per step, so a pixel costs O(radius + levels) instead of O(radius^2).
/// Each level is weighted with the same expression as the direct sum.
fn surface_8bit(src: &Image, out: Rect, ctx: &Ctx, r: i32, t: f32, reach: usize) -> Option<Vec<f32>> {
    let n = src.ch;
    let cc = if ctx.alpha { n - 1 } else { n };
    let win = out.inflate(r);
    let (ww, wh) = (win.width() as usize, win.height() as usize);
    // Level of every colour sample in the window; `SKIP` where the pixel is transparent (the
    // direct sum skips those). Outside the source reads as 0, as `Image::get` does.
    const SKIP: u16 = 256;
    let mut lv = vec![0u16; ww * wh * cc];
    for y in win.y0..win.y1 {
        for x in win.x0..win.x1 {
            let i = ((y - win.y0) as usize * ww + (x - win.x0) as usize) * cc;
            let skip = ctx.alpha && src.get(x, y, n - 1) <= 0.0;
            for c in 0..cc {
                let v = src.get(x, y, c);
                let k = (v * 255.0).round();
                if !(0.0..=255.0).contains(&k) || (k / 255.0).to_bits() != v.to_bits() {
                    return None;
                }
                lv[i + c] = if skip { SKIP } else { k as u16 };
            }
        }
    }
    let (ow, oh) = (out.width() as usize, out.height() as usize);
    let side = (2 * r + 1) as usize;
    let mut res = vec![0.0f32; ow * oh * n];
    let mut hist = [0u32; 257];
    for oy in 0..oh {
        for c in 0..cc {
            hist.fill(0);
            // Window of output column 0: window rows oy..oy + side, columns 0..side.
            let col = |hist: &mut [u32; 257], wx: usize, add: bool| {
                for wy in oy..oy + side {
                    let k = lv[(wy * ww + wx) * cc + c] as usize;
                    if add {
                        hist[k] += 1;
                    } else {
                        hist[k] -= 1;
                    }
                }
            };
            for wx in 0..side {
                col(&mut hist, wx, true);
            }
            for ox in 0..ow {
                let p = src.px(out.x0 + ox as i32, out.y0 + oy as i32);
                let v0 = p[c];
                let k0 = (v0 * 255.0).round() as usize;
                let (mut acc, mut wsum) = (0.0f64, 0.0f64);
                for (k, &cnt) in hist.iter().enumerate().take(256.min(k0 + reach + 1)).skip(k0.saturating_sub(reach)) {
                    if cnt == 0 {
                        continue;
                    }
                    let v = k as f32 / 255.0;
                    let w = (1.0 - (v - v0).abs() / t).max(0.0);
                    acc += f64::from(v * w) * f64::from(cnt);
                    wsum += f64::from(w) * f64::from(cnt);
                }
                res[(oy * ow + ox) * n + c] = if wsum > 0.0 { (acc / wsum) as f32 } else { v0 };
                if ox + 1 < ow {
                    col(&mut hist, ox, false);
                    col(&mut hist, ox + side, true);
                }
            }
        }
        if ctx.alpha {
            for ox in 0..ow {
                res[(oy * ow + ox) * n + n - 1] = src.px(out.x0 + ox as i32, out.y0 + oy as i32)[n - 1];
            }
        }
    }
    Some(res)
}

pub(crate) fn surface(src: &Image, out: Rect, ctx: &Ctx, radius: f32, threshold: f32) -> Vec<f32> {
    let r = radius.max(0.0).round() as i32;
    let t = (threshold.max(1.0) / 255.0) * 2.5;
    // Levels within the threshold of the centre (the only ones with any weight), on each side.
    let reach = ((t * 255.0).ceil() as usize).min(255);
    let side = (2 * r + 1) as usize;
    if side * side > 2 * reach + 1 + 4 * side
        && let Some(res) = surface_8bit(src, out, ctx, r, t, reach)
    {
        return res;
    }
    surface_direct(src, out, ctx, r, t)
}

/// [`surface`] by summing the whole (2r + 1)^2 window of every pixel.
fn surface_direct(src: &Image, out: Rect, ctx: &Ctx, r: i32, t: f32) -> Vec<f32> {
    let n = src.ch;
    let cc = if ctx.alpha { n - 1 } else { n };
    let mut res = Vec::with_capacity(out.width() as usize * out.height() as usize * n);
    for y in out.y0..out.y1 {
        for x in out.x0..out.x1 {
            let p = src.px(x, y);
            for (c, &v0) in p.iter().enumerate().take(cc) {
                let (mut acc, mut wsum) = (0.0, 0.0);
                for yy in y - r..=y + r {
                    for xx in x - r..=x + r {
                        if ctx.alpha && src.get(xx, yy, n - 1) <= 0.0 {
                            continue;
                        }
                        let v = src.get(xx, yy, c);
                        let w = (1.0 - (v - v0).abs() / t).max(0.0);
                        acc += v * w;
                        wsum += w;
                    }
                }
                res.push(if wsum > 0.0 { acc / wsum } else { v0 });
            }
            if ctx.alpha {
                res.push(p[n - 1]);
            }
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_gaussian_matches_exact_kernel() {
        // A hard vertical edge (premultiplied RGBA-ish, 2 channels) blurred with σ = 12.
        let src_rect = Rect::new(-60, -60, 180, 68);
        let mut img = Image::new(src_rect, 2);
        for y in src_rect.y0..src_rect.y1 {
            for x in src_rect.x0..src_rect.x1 {
                let i = ((y - src_rect.y0) as usize * src_rect.width() as usize + (x - src_rect.x0) as usize) * 2;
                img.data[i] = if x < 60 { 1.0 } else { 0.0 };
                img.data[i + 1] = 1.0;
            }
        }
        let out = Rect::new(0, 0, 120, 8);
        let k = gaussian_kernel(12.0);
        let exact = conv_sep(&img, out, &k, &k, true);
        let fast = gaussian_boxes(&img, out, true, 12.0);
        let err = exact.iter().zip(&fast).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 0.02, "max error {err}");
        assert_eq!(boxes_for_gauss(10.0, 3).len(), 3);
    }

    #[test]
    fn box_passes_match_the_direct_box_kernel() {
        // Noisy RGBA with varying alpha, so premultiplication and every channel are exercised.
        for r in [5usize, 17, 60] {
            let (w, h, m) = (40, 24, r as i32 + 2);
            let src_rect = Rect::new(-m, -m, w + m, h + m);
            let mut img = Image::new(src_rect, 4);
            let mut s = 0x9e37_79b9u32;
            for v in img.data.iter_mut() {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                *v = (s % 256) as f32 / 255.0;
            }
            let out = Rect::new(0, 0, w, h);
            let k = vec![1.0 / (2 * r + 1) as f32; 2 * r + 1];
            let direct = conv_sep(&img, out, &k, &k, true);
            let ctx = Ctx { bounds: src_rect, mode: crate::ColorMode::Rgb, alpha: true };
            let fast = boxed(&img, out, &ctx, r as f32);
            let err = direct.iter().zip(&fast).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(err < 1e-5, "radius {r}: max error {err}");
        }
    }

    #[test]
    fn surface_blur_8bit_histogram_matches_the_direct_sum() {
        // 8-bit levels with some fully transparent pixels, which the sum skips.
        let src_rect = Rect::new(-14, -14, 40, 34);
        let mut img = Image::new(src_rect, 4);
        let mut s = 0x6c07_8965u32;
        for px in img.data.as_chunks_mut::<4>().0 {
            for v in px.iter_mut() {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                *v = (s % 256) as f32 / 255.0;
            }
            if s.is_multiple_of(7) {
                px[3] = 0.0;
            }
        }
        let ctx = Ctx { bounds: src_rect, mode: crate::ColorMode::Rgb, alpha: true };
        // The output reaches the source edge, where samples read as transparent.
        let out = Rect::new(-2, 0, 26, 20);
        for (r, threshold) in [(1, 2.0), (4, 15.0), (12, 60.0), (12, 255.0)] {
            let t = (threshold / 255.0) * 2.5;
            let reach = ((t * 255.0f32).ceil() as usize).min(255);
            let fast = surface_8bit(&img, out, &ctx, r, t, reach).expect("8-bit input");
            let direct = surface_direct(&img, out, &ctx, r, t);
            let err = direct.iter().zip(&fast).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(err < 1e-5, "r {r} threshold {threshold}: max error {err}");
        }
        // Not 8-bit: the histogram declines and the direct sum is used.
        // (0, 0) is inside every window above.
        let i = (14 * src_rect.width() as usize + 14) * 4;
        img.data[i] = 0.5 / 255.0;
        assert!(surface_8bit(&img, out, &ctx, 4, 0.1, 26).is_none());
    }
}
