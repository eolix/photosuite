//! Add Noise, Median, Dust & Scratches.

use photosuite_geom::Rect;

use crate::image::Image;
use crate::{Ctx, Distribution};

/// Deterministic hash → `[0, 1)` from document coordinates, so results do not
/// depend on tiling.
#[inline]
pub(crate) fn hash01(x: i32, y: i32, c: u32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841) ^ c.wrapping_mul(0xcb1a_b31f) ^ seed.wrapping_mul(0x9e37_79b9);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    (h >> 8) as f32 / (1u32 << 24) as f32
}

/// Amount 100 % spans ±50 % of the range (uniform); Gaussian uses the same
/// amount as ~2σ.
#[allow(clippy::too_many_arguments)]
pub(crate) fn add(src: &Image, out: Rect, ctx: &Ctx, amount: f32, dist: Distribution, mono: bool, seed: u32) -> Vec<f32> {
    let n = src.ch;
    let cc = if ctx.alpha { n - 1 } else { n };
    let a = amount.max(0.0) / 100.0 * 0.5;
    let mut res = src.crop(out);
    let w = out.width() as usize;
    for (i, px) in res.chunks_exact_mut(n).enumerate() {
        if ctx.alpha && px[n - 1] <= 0.0 {
            continue;
        }
        let (x, y) = (out.x0 + (i % w) as i32, out.y0 + (i / w) as i32);
        for (c, pv) in px.iter_mut().enumerate().take(cc) {
            let ch = if mono { 0 } else { c as u32 };
            let v = match dist {
                Distribution::Uniform => (hash01(x, y, ch, seed) - 0.5) * 2.0 * a,
                Distribution::Gaussian => {
                    let u1 = hash01(x, y, ch * 2 + 101, seed).max(1e-7);
                    let u2 = hash01(x, y, ch * 2 + 102, seed);
                    (-2.0 * u1.ln()).sqrt() * (std::f32::consts::TAU * u2).cos() * a * 0.5
                }
            };
            // Integer storage clamps on write; float surfaces keep the value.
            *pv += v;
        }
    }
    res
}

/// Median over a disc of `radius`; with `threshold`, a pixel is replaced only
/// when it differs from the median by more than `threshold` levels.
pub(crate) fn median(src: &Image, out: Rect, radius: f32, threshold: Option<f32>) -> Vec<f32> {
    let r = radius.max(0.0).round() as i32;
    if r == 0 {
        return src.crop(out);
    }
    let t = threshold.map(|t| t / 255.0);
    if r >= 3
        && let Some(levels) = eight_bit_levels(&src.data)
    {
        return median_histogram(src, out, r, t, &levels);
    }
    median_sorted(src, out, r, t)
}

/// [`median`] by sorting each window: any sample values.
fn median_sorted(src: &Image, out: Rect, r: i32, t: Option<f32>) -> Vec<f32> {
    let n = src.ch;
    let offs: Vec<(i32, i32)> = (-r..=r).flat_map(|dy| (-r..=r).map(move |dx| (dx, dy))).filter(|(dx, dy)| dx * dx + dy * dy <= r * r + r).collect();
    let mut vals = Vec::with_capacity(offs.len());
    let mut res = Vec::with_capacity(out.width() as usize * out.height() as usize * n);
    for y in out.y0..out.y1 {
        for x in out.x0..out.x1 {
            for c in 0..n {
                vals.clear();
                vals.extend(offs.iter().map(|(dx, dy)| src.get(x + dx, y + dy, c)));
                let mid = vals.len() / 2;
                let (_, m, _) = vals.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
                let m = *m;
                let o = src.get(x, y, c);
                res.push(match t {
                    Some(t) if (o - m).abs() <= t => o,
                    _ => m,
                });
            }
        }
    }
    res
}

/// When every sample is one of 256 levels in `[0, 1]` (8-bit documents), the value each level
/// stands for, so a 256-bin histogram finds exactly the median a sort would. `None` otherwise, or
/// when two different values would share a bin.
fn eight_bit_levels(data: &[f32]) -> Option<[f32; 256]> {
    let mut level = [f32::NAN; 256];
    for &v in data {
        let k = (v * 255.0).round();
        if !(0.0..=255.0).contains(&k) || (k / 255.0 - v).abs() > 1e-6 {
            return None;
        }
        let slot = &mut level[k as usize];
        if slot.is_nan() {
            *slot = v;
        } else if slot.to_bits() != v.to_bits() {
            return None;
        }
    }
    Some(level)
}

/// [`median`] over 8-bit levels with a sliding histogram: one window per row of output, moved
/// one pixel at a time by dropping its left column and adding the next on the right, so a pixel
/// costs O(radius) rather than O(radius²). A coarse 16-bin layer makes finding the median a
/// short walk. The window is the same disc, and samples outside the source read 0, as in
/// [`median`].
fn median_histogram(src: &Image, out: Rect, r: i32, t: Option<f32>, level: &[f32; 256]) -> Vec<f32> {
    let n = src.ch;
    // Half-width of the disc on each row: |dx| <= span[dy + r].
    let span: Vec<i32> = (-r..=r).map(|dy| (0..=r).take_while(|dx| dx * dx + dy * dy <= r * r + r).last().unwrap_or(0)).collect();
    let area: i32 = span.iter().map(|w| 2 * w + 1).sum();
    let target = area / 2 + 1; // the rank `select_nth_unstable(len / 2)` picks
    let bin = |x: i32, y: i32, c: usize| (src.get(x, y, c) * 255.0).round() as usize;
    let w = out.width() as usize;
    let mut res = vec![0.0f32; w * out.height() as usize * n];
    let fill = |(row, line): (usize, &mut [f32])| {
        let y = out.y0 + row as i32;
        for c in 0..n {
            let mut fine = [0i32; 256];
            let mut coarse = [0i32; 16];
            let x0 = out.x0;
            for (j, &hw) in span.iter().enumerate() {
                let sy = y + j as i32 - r;
                for dx in -hw..=hw {
                    let b = bin(x0 + dx, sy, c);
                    fine[b] += 1;
                    coarse[b >> 4] += 1;
                }
            }
            for i in 0..w {
                let x = x0 + i as i32;
                if i > 0 {
                    for (j, &hw) in span.iter().enumerate() {
                        let sy = y + j as i32 - r;
                        let (gone, new) = (bin(x - 1 - hw, sy, c), bin(x + hw, sy, c));
                        fine[gone] -= 1;
                        coarse[gone >> 4] -= 1;
                        fine[new] += 1;
                        coarse[new >> 4] += 1;
                    }
                }
                let (mut seen, mut k) = (0, 0usize);
                while seen + coarse[k >> 4] < target {
                    seen += coarse[k >> 4];
                    k += 16;
                }
                while seen + fine[k] < target {
                    seen += fine[k];
                    k += 1;
                }
                // Outside the source reads 0.0, which is level 0.
                let m = if level[k].is_nan() { 0.0 } else { level[k] };
                let o = src.get(x, y, c);
                line[i * n + c] = match t {
                    Some(t) if (o - m).abs() <= t => o,
                    _ => m,
                };
            }
        }
    };
    // Rows in parallel on native; wasm builds stay single-threaded.
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        res.par_chunks_mut((w * n).max(1)).enumerate().for_each(fill);
    }
    #[cfg(target_arch = "wasm32")]
    res.chunks_mut((w * n).max(1)).enumerate().for_each(fill);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An 8-bit-valued image (with a transparent-ish alpha channel), off-origin so the window
    /// also reads outside it.
    fn image(w: i32, h: i32, ch: usize, seed: u32) -> Image {
        let rect = Rect::new(3, -2, 3 + w, -2 + h);
        let data = (0..(w * h) as usize * ch).map(|i| (hash01(i as i32, 7, 0, seed) * 256.0).floor().min(255.0) / 255.0).collect();
        Image { rect, ch, data }
    }

    #[test]
    fn histogram_median_matches_sorting_exactly() {
        for (r, ch, t) in [(3, 4, None), (5, 3, Some(20.0 / 255.0)), (8, 1, None), (12, 2, Some(0.0))] {
            let src = image(41, 29, ch, r as u32);
            let out = Rect::new(src.rect.x0 - 2, src.rect.y0 + 1, src.rect.x1 + 1, src.rect.y1 - 3);
            let levels = eight_bit_levels(&src.data).expect("8-bit levels");
            let fast = median_histogram(&src, out, r, t, &levels);
            let slow = median_sorted(&src, out, r, t);
            assert_eq!(fast.len(), slow.len());
            let diff = fast.iter().zip(&slow).position(|(a, b)| a.to_bits() != b.to_bits());
            assert_eq!(diff, None, "radius {r}, {ch} channels");
        }
    }

    #[test]
    fn deep_values_skip_the_histogram() {
        assert!(eight_bit_levels(&[0.0, 0.5, 1.0]).is_none(), "0.5 is not an 8-bit level");
        assert!(eight_bit_levels(&[0.0, 128.0 / 255.0, 1.0]).is_some());
        assert!(eight_bit_levels(&[1.5]).is_none());
    }
}
