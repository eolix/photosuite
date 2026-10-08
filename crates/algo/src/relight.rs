//! Photographic relight: recover shading with a blur (Retinex) and replace it with a
//! Lambertian lamp whose direction comes from angle / elevation.

use photosuite_geom::Rect;

use crate::Ctx;
use crate::fxutil::{MAXC, rgba, set_rgba, xy};
use crate::image::Image;

/// Neighbourhood the kernel reads: `3σ + 1` at `σ = 32` (the typical cap for parallel tiles).
pub(crate) const HALO_RADIUS: i32 = 97;

/// Dialog units (degrees / 0–100), matching the command params.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Params {
    pub angle: f32,
    pub elevation: f32,
    pub intensity: f32,
    pub ambient: f32,
    pub warmth: f32,
    pub softness: f32,
}

/// Blur σ from softness and the reference bounds, clamped to `[2, 96]`.
pub(crate) fn sigma(softness: f32, bounds: Rect) -> f32 {
    let side = bounds.width().min(bounds.height()) as f32;
    let s = (softness.clamp(1.0, 100.0) / 100.0) * 0.08 * side.max(1.0);
    s.clamp(2.0, 96.0)
}

/// Infinite-light direction: 0° from the right, 90° from above (image space, y down).
fn light_dir(angle: f32, elevation: f32) -> [f32; 3] {
    let (s, co) = angle.to_radians().sin_cos();
    let e = elevation.clamp(0.0, 90.0).to_radians();
    norm3([co * e.cos(), -s * e.cos(), e.sin()])
}

fn norm3(v: [f32; 3]) -> [f32; 3] {
    let m = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if !m.is_finite() || m < 1e-9 { [0.0, 0.0, 1.0] } else { [v[0] / m, v[1] / m, v[2] / m] }
}

fn light_color(warmth: f32) -> [f32; 3] {
    let w = warmth.clamp(-100.0, 100.0) / 100.0;
    if w >= 0.0 {
        [1.0 + 0.15 * w, 1.0 - 0.05 * w, 1.0 - 0.25 * w]
    } else {
        let t = -w;
        [1.0 - 0.20 * t, 1.0 - 0.10 * t, 1.0 + 0.15 * t]
    }
}

fn rec709_y(c: [f32; 4]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn finite_all(v: &[f32]) -> bool {
    v.iter().all(|x| x.is_finite())
}

fn sample_y(buf: &[f32], w: usize, h: usize, rect: Rect, x: i32, y: i32) -> f32 {
    if rect.is_empty() || w == 0 || h == 0 {
        return 0.04;
    }
    let xx = x.clamp(rect.x0, rect.x1.saturating_sub(1));
    let yy = y.clamp(rect.y0, rect.y1.saturating_sub(1));
    let ox = (xx - rect.x0) as usize;
    let oy = (yy - rect.y0) as usize;
    if ox >= w || oy >= h {
        return 0.04;
    }
    buf.get(oy.saturating_mul(w).saturating_add(ox)).copied().filter(|v| v.is_finite()).unwrap_or(0.04)
}

/// Separable Gaussian of a single-channel field. Non-finite samples are skipped (kernel
/// renormalised) so a bad pixel does not poison its neighbours.
fn blur_channel(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let n = w.saturating_mul(h);
    if n == 0 || src.len() < n {
        return vec![0.04; n];
    }
    let k = crate::blur::gaussian_kernel(sigma);
    let r = (k.len() / 2) as i32;
    let acc_at = |buf: &[f32], ww: usize, hh: usize, x: i32, y: i32, col: bool| -> f32 {
        let mut acc = 0.0f64;
        let mut wgt = 0.0f64;
        for (i, kv) in k.iter().enumerate() {
            let t = i as i32 - r;
            let (sx, sy) = if col { (x, y + t) } else { (x + t, y) };
            if sx < 0 || sy < 0 || (sx as usize) >= ww || (sy as usize) >= hh {
                continue;
            }
            let Some(v) = buf.get((sy as usize).saturating_mul(ww).saturating_add(sx as usize)) else {
                continue;
            };
            if !v.is_finite() {
                continue;
            }
            acc += *v as f64 * *kv as f64;
            wgt += *kv as f64;
        }
        if wgt > 1e-12 { (acc / wgt) as f32 } else { 0.5 }
    };
    let mut tmp = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            if let Some(slot) = tmp.get_mut(y.saturating_mul(w).saturating_add(x)) {
                *slot = acc_at(src, w, h, x as i32, y as i32, false);
            }
        }
    }
    let mut out = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            if let Some(slot) = out.get_mut(y.saturating_mul(w).saturating_add(x)) {
                *slot = acc_at(&tmp, w, h, x as i32, y as i32, true);
            }
        }
    }
    out
}

fn read_rgba(src: &Image, ctx: &Ctx, x: i32, y: i32) -> [f32; 4] {
    let n = src.ch.min(MAXC);
    let mut tmp = [0.0f32; MAXC];
    for c in 0..n {
        if let Some(slot) = tmp.get_mut(c) {
            *slot = src.get(x, y, c);
        }
    }
    rgba(ctx, &tmp[..n])
}

/// Relight `out` of `src`. Identity when `intensity` is 0 (or not finite).
pub(crate) fn relight(src: &Image, out: Rect, ctx: &Ctx, p: Params) -> Vec<f32> {
    let n = src.ch;
    if out.is_empty() || n == 0 {
        return src.crop(out);
    }
    let mut res = src.crop(out);
    if !p.intensity.is_finite() || p.intensity == 0.0 {
        return res;
    }
    let sig = sigma(p.softness, ctx.bounds);
    let radius = (sig * 3.0).ceil() as i32;
    // Finite differences at the shading scale (`σ`), not 1 px: a 1 px step vanishes on
    // large documents and the lamp collapses to a flat multiply.
    const SCALE: f32 = 2.0;
    let step = sig.round().clamp(1.0, 32.0) as i32;
    let s_rect = out.inflate(step.max(1));
    let y_rect = s_rect.inflate(radius.max(0));
    if y_rect.is_empty() {
        return res;
    }
    let yw = y_rect.width() as usize;
    let yh = y_rect.height() as usize;
    let n_px = yw.saturating_mul(yh);
    if n_px == 0 || n_px > 8_000_000 {
        return res;
    }
    let mut ybuf = vec![0.5f32; n_px];
    for y in y_rect.y0..y_rect.y1 {
        for x in y_rect.x0..y_rect.x1 {
            let ox = (x - y_rect.x0) as usize;
            let oy = (y - y_rect.y0) as usize;
            let Some(slot) = ybuf.get_mut(oy.saturating_mul(yw).saturating_add(ox)) else {
                continue;
            };
            let c = read_rgba(src, ctx, x, y);
            if !finite_all(&c) {
                *slot = f32::NAN;
                continue;
            }
            let a = if ctx.alpha { c[3] } else { 1.0 };
            *slot = if a > 0.0 && a.is_finite() { rec709_y(c) } else { f32::NAN };
        }
    }
    let sbuf = blur_channel(&ybuf, yw, yh, sig);
    let ldir = light_dir(p.angle, p.elevation);
    let lcol = light_color(p.warmth);
    let amb = (if p.ambient.is_finite() { p.ambient } else { 0.0 }).clamp(0.0, 100.0) / 100.0;
    let inten = p.intensity.clamp(0.0, 100.0) / 100.0;
    for (i, px) in res.chunks_exact_mut(n).enumerate() {
        let (x, y) = xy(out, i);
        if !finite_all(px) {
            continue;
        }
        let a = if ctx.alpha { px[n - 1] } else { 1.0 };
        if ctx.alpha && a <= 0.0 {
            continue;
        }
        let c = rgba(ctx, px);
        if !finite_all(&c) {
            continue;
        }
        let s0 = sample_y(&sbuf, yw, yh, y_rect, x, y).max(0.04);
        let nx = (sample_y(&sbuf, yw, yh, y_rect, x - step, y) - sample_y(&sbuf, yw, yh, y_rect, x + step, y)) * SCALE;
        let ny = (sample_y(&sbuf, yw, yh, y_rect, x, y - step) - sample_y(&sbuf, yw, yh, y_rect, x, y + step)) * SCALE;
        let nrm = norm3([nx, ny, 1.0]);
        let ndl = (nrm[0] * ldir[0] + nrm[1] * ldir[1] + nrm[2] * ldir[2]).max(0.0);
        let shade = amb + inten * ndl;
        let mut out_c = c;
        for (k, lc) in lcol.iter().enumerate() {
            let Some(ch) = c.get(k).copied() else { continue };
            let Some(slot) = out_c.get_mut(k) else { continue };
            *slot = (ch / s0) * shade * *lc;
        }
        if !finite_all(&out_c) {
            continue;
        }
        set_rgba(ctx, px, out_c);
        if ctx.alpha
            && let Some(slot) = px.get_mut(n - 1)
        {
            *slot = a;
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FilterParams, Halo, apply, apply_tiled, output_area};
    use photosuite_color::{ColorMode, PixelFormat, SampleType};
    use photosuite_raster::Surface;

    fn fmt(s: SampleType) -> PixelFormat {
        PixelFormat::new(ColorMode::Rgb, s, true)
    }

    fn gray_fmt(s: SampleType) -> PixelFormat {
        PixelFormat::new(ColorMode::Grayscale, s, true)
    }

    fn params(intensity: f32, angle: f32, warmth: f32, softness: f32) -> FilterParams {
        FilterParams::Relight { angle, elevation: 40.0, intensity, ambient: 55.0, warmth, softness }
    }

    fn relight_p(angle: f32, elevation: f32, intensity: f32, ambient: f32, warmth: f32, softness: f32) -> FilterParams {
        FilterParams::Relight { angle, elevation, intensity, ambient, warmth, softness }
    }

    fn run(s: &Surface, p: &FilterParams, bounds: Rect) -> Surface {
        let area = output_area(p, s.content_bounds(), bounds, None);
        apply(s, p, area, bounds, None)
    }

    fn max_diff(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
    }

    fn luma(px: &[f32]) -> f32 {
        0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]
    }

    fn shaded_sphere(st: SampleType, size: i32) -> Surface {
        let r = Rect::new(0, 0, size, size);
        let mut surf = Surface::new(fmt(st));
        let cx = size as f32 / 2.0;
        let rad = size as f32 * 0.42;
        let mut v = Vec::new();
        for y in 0..size {
            for x in 0..size {
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - cx;
                let d2 = dx * dx + dy * dy;
                if d2 <= rad * rad {
                    let nz = (rad * rad - d2).max(0.0).sqrt() / rad;
                    let sh = 0.22 + 0.78 * nz;
                    v.extend_from_slice(&[0.55 * sh, 0.55 * sh, 0.55 * sh, 1.0]);
                } else {
                    v.extend_from_slice(&[0.18, 0.18, 0.18, 1.0]);
                }
            }
        }
        surf.write_region(r, &v);
        surf
    }

    fn sphere_half_mean(s: &Surface, size: i32, left: bool) -> f32 {
        let cx = size as f32 / 2.0;
        let rad = size as f32 * 0.42;
        let mut sum = 0.0;
        let mut n: f32 = 0.0;
        for y in 0..size {
            for x in 0..size {
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - cx;
                if dx * dx + dy * dy > rad * rad {
                    continue;
                }
                if left && (x as f32) >= cx - 4.0 {
                    continue;
                }
                if !left && (x as f32) < cx + 4.0 {
                    continue;
                }
                sum += luma(&s.pixel(x, y));
                n += 1.0;
            }
        }
        sum / n.max(1.0)
    }

    fn pattern(st: SampleType, r: Rect) -> Surface {
        let mut surf = Surface::new(fmt(st));
        let mut v = Vec::new();
        for y in r.y0..r.y1 {
            for x in r.x0..r.x1 {
                v.extend_from_slice(&[((x * 7 + y * 3) % 64) as f32 / 63.0, ((x * x + y) % 50) as f32 / 49.0, (y % 9) as f32 / 8.0, 1.0]);
            }
        }
        surf.write_region(r, &v);
        surf
    }

    fn flat(st: SampleType, r: Rect, px: [f32; 4]) -> Surface {
        let mut surf = Surface::new(fmt(st));
        surf.fill_rect(r, &px);
        surf
    }

    #[test]
    fn halo_is_zero_at_identity_and_97_otherwise() {
        assert_eq!(params(0.0, 45.0, 0.0, 25.0).halo(), Halo::Radius(0));
        assert_eq!(params(40.0, 45.0, 0.0, 25.0).halo(), Halo::Radius(HALO_RADIUS));
    }

    #[test]
    fn identity_at_zero_intensity_all_depths() {
        let r = Rect::new(0, 0, 24, 16);
        let p = params(0.0, 120.0, 80.0, 90.0);
        for st in [SampleType::U8, SampleType::U16, SampleType::F32] {
            let s = pattern(st, r);
            let out = run(&s, &p, r);
            assert_eq!(out.read_region(r), s.read_region(r), "{st:?}");
        }
        let mut g = Surface::new(gray_fmt(SampleType::U8));
        g.fill_rect(r, &[0.4, 1.0]);
        let out = run(&g, &p, r);
        assert_eq!(out.read_region(r), g.read_region(r));
        let mut g32 = Surface::new(gray_fmt(SampleType::F32));
        g32.fill_rect(r, &[0.4, 1.0]);
        let out = run(&g32, &p, r);
        assert_eq!(out.read_region(r), g32.read_region(r));
        let mut g16 = Surface::new(gray_fmt(SampleType::U16));
        g16.fill_rect(r, &[0.4, 1.0]);
        let out = run(&g16, &p, r);
        assert_eq!(out.read_region(r), g16.read_region(r));
    }

    fn assert_direction_flips(size: i32) {
        let bounds = Rect::new(0, 0, size, size);
        let s = shaded_sphere(SampleType::F32, size);
        let left_lit = run(&s, &relight_p(180.0, 30.0, 90.0, 12.0, 0.0, 15.0), bounds);
        let right_lit = run(&s, &relight_p(0.0, 30.0, 90.0, 12.0, 0.0, 15.0), bounds);
        let l_left = sphere_half_mean(&left_lit, size, true);
        let l_right = sphere_half_mean(&left_lit, size, false);
        let r_left = sphere_half_mean(&right_lit, size, true);
        let r_right = sphere_half_mean(&right_lit, size, false);
        assert!(l_left - l_right >= 0.05, "light from the left ({size}px): {l_left} vs {l_right}");
        assert!(r_right - r_left >= 0.05, "light from the right ({size}px): {r_left} vs {r_right}");
    }

    #[test]
    fn direction_flips_on_a_shaded_sphere() {
        assert_direction_flips(64);
    }

    #[test]
    fn direction_flips_on_a_large_shaded_sphere() {
        // A 1 px gradient vanishes at this size unless the kernel steps by σ.
        assert_direction_flips(256);
    }

    #[test]
    fn warmth_tints_a_neutral_field() {
        let r = Rect::new(0, 0, 32, 32);
        let s = flat(SampleType::F32, r, [0.5, 0.5, 0.5, 1.0]);
        let warm = run(&s, &relight_p(45.0, 40.0, 50.0, 55.0, 80.0, 25.0), r);
        let cool = run(&s, &relight_p(45.0, 40.0, 50.0, 55.0, -80.0, 25.0), r);
        let w = warm.pixel(16, 16);
        let c = cool.pixel(16, 16);
        assert!(w[0] > w[2], "warmth should raise R over B: {w:?}");
        assert!(c[2] > c[0], "cool light should raise B over R: {c:?}");
    }

    #[test]
    fn high_ambient_keeps_white_finite() {
        let r = Rect::new(0, 0, 16, 16);
        let s = flat(SampleType::F32, r, [1.0, 1.0, 1.0, 1.0]);
        let out = run(&s, &relight_p(45.0, 40.0, 40.0, 100.0, 0.0, 25.0), r);
        let px = out.pixel(8, 8);
        assert!(finite_all(&px), "{px:?}");
    }

    #[test]
    fn alpha_is_preserved() {
        let r = Rect::new(0, 0, 16, 16);
        let mut s = Surface::new(fmt(SampleType::F32));
        s.fill_rect(r, &[0.4, 0.4, 0.5, 1.0]);
        s.write_pixel(3, 3, &[0.4, 0.4, 0.5, 0.0]);
        s.write_pixel(4, 4, &[0.2, 0.3, 0.4, 0.5]);
        let out = run(&s, &params(50.0, 180.0, 20.0, 25.0), r);
        assert_eq!(out.pixel(3, 3)[3], 0.0);
        assert!((out.pixel(5, 5)[3] - 1.0).abs() < 1e-6);
        assert!((out.pixel(4, 4)[3] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn tiles_match_a_full_apply() {
        let size = 64;
        let bounds = Rect::new(0, 0, size, size);
        let s = shaded_sphere(SampleType::F32, size);
        let p = relight_p(180.0, 40.0, 60.0, 40.0, 0.0, 25.0);
        let area = output_area(&p, s.content_bounds(), bounds, None);
        let full = apply_tiled(&s, &p, area, bounds, None, 256, None);
        let tiled = apply_tiled(&s, &p, area, bounds, None, 32, None);
        let inner = Rect::new(0, 0, size, size);
        let d = max_diff(&full.read_region(inner), &tiled.read_region(inner));
        assert!(d <= 1e-4, "tile seam {d}");
    }

    #[test]
    fn hostile_sizes_do_not_panic() {
        let p = params(40.0, 45.0, 0.0, 25.0);
        for (w, h) in [(1, 1), (2, 2), (1, 2), (0, 0)] {
            let r = Rect::new(0, 0, w, h);
            let mut s = Surface::new(fmt(SampleType::F32));
            if w > 0 && h > 0 {
                s.fill_rect(r, &[0.4, 0.5, 0.6, 1.0]);
            }
            let _ = run(&s, &p, if r.is_empty() { Rect::new(0, 0, 1, 1) } else { r });
            let _ = apply(&s, &p, Rect::EMPTY, Rect::new(0, 0, 4, 4), None);
        }
    }

    #[test]
    fn nan_and_inf_pixels_pass_through() {
        let r = Rect::new(0, 0, 24, 24);
        let mut s = pattern(SampleType::F32, r);
        s.write_pixel(5, 5, &[f32::NAN, 0.4, 0.4, 1.0]);
        s.write_pixel(6, 8, &[f32::INFINITY, 0.2, 0.2, 1.0]);
        let before_n = s.pixel(7, 5);
        let out = run(&s, &params(50.0, 180.0, 0.0, 20.0), r);
        assert!(out.pixel(5, 5)[0].is_nan());
        assert!(out.pixel(6, 8)[0].is_infinite());
        let n = out.pixel(7, 5);
        assert!(finite_all(&n));
        assert_ne!(n, before_n);
    }
}
