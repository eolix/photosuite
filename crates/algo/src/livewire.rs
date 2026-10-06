//! The Magnetic Lasso's live wire: the cheapest path between two points over an edge-cost image
//! (E. Mortensen, W. Barrett, *Intelligent Scissors for Image Composition*, SIGGRAPH 1995).
//!
//! Each pixel costs `1 − G` where `G` is its Sobel gradient magnitude, normalised to the
//! search window and zeroed below the Contrast threshold, so strong edges are cheap to follow
//! and weak ones count as flat. A small constant per step keeps the wire from wandering, and
//! diagonal steps cost √2. The search is Dijkstra's algorithm inside the box around the two
//! ends (plus a margin), so a wire costs a few hundred thousand node visits at most; the tool
//! keeps it that small by placing anchors as the wire grows.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Largest search window (pixels); beyond it the wire is a straight segment.
const MAX_WINDOW: usize = 1 << 21;
/// Cost every step pays on top of the edge cost (the wire prefers short paths on flat ground).
const STEP_COST: f32 = 0.05;

/// Luminance of an image, the input of every wire.
#[derive(Clone, Debug)]
pub struct EdgeImage {
    pub w: usize,
    pub h: usize,
    lum: Vec<f32>,
}

impl EdgeImage {
    /// From straight RGBA pixels (`w × h`, row-major); transparency reads as black.
    pub fn from_rgba(px: &[[f32; 4]], w: usize, h: usize) -> EdgeImage {
        let lum = px.iter().take(w * h).map(|p| (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) * p[3].clamp(0.0, 1.0)).collect();
        EdgeImage { w, h, lum }
    }

    fn l(&self, x: i64, y: i64) -> f32 {
        let x = x.clamp(0, self.w as i64 - 1) as usize;
        let y = y.clamp(0, self.h as i64 - 1) as usize;
        self.lum.get(y * self.w + x).copied().unwrap_or(0.0)
    }

    /// Sobel gradient magnitude at a pixel (edges clamped).
    pub fn gradient(&self, x: i64, y: i64) -> f32 {
        let l = |dx: i64, dy: i64| self.l(x + dx, y + dy);
        let gx = (l(1, -1) + 2.0 * l(1, 0) + l(1, 1)) - (l(-1, -1) + 2.0 * l(-1, 0) + l(-1, 1));
        let gy = (l(-1, 1) + 2.0 * l(0, 1) + l(1, 1)) - (l(-1, -1) + 2.0 * l(0, -1) + l(1, -1));
        gx.hypot(gy) / 4.0
    }

    fn clamp(&self, p: [i64; 2]) -> [i64; 2] {
        [p[0].clamp(0, self.w as i64 - 1), p[1].clamp(0, self.h as i64 - 1)]
    }

    /// The strongest edge pixel within `radius` of `p` (Width: where the wire snaps to); `p`
    /// itself when nothing there reaches the Contrast threshold `contrast` (0..=1).
    pub fn snap(&self, p: [f64; 2], radius: f64, contrast: f32) -> [i64; 2] {
        let c = self.clamp([p[0].floor() as i64, p[1].floor() as i64]);
        if self.w == 0 || self.h == 0 {
            return c;
        }
        let r = radius.clamp(0.0, 256.0).round() as i64;
        let (mut best, mut at) = (contrast.max(1e-4), c);
        for y in (c[1] - r).max(0)..=(c[1] + r).min(self.h as i64 - 1) {
            for x in (c[0] - r).max(0)..=(c[0] + r).min(self.w as i64 - 1) {
                let (dx, dy) = (x - c[0], y - c[1]);
                if dx * dx + dy * dy > r * r {
                    continue;
                }
                // Ties go to the nearer pixel, so a uniform edge band snaps to its middle.
                let g = self.gradient(x, y) - (dx * dx + dy * dy) as f32 * 1e-6;
                if g > best {
                    best = g;
                    at = [x, y];
                }
            }
        }
        at
    }

    /// The cheapest pixel path from `a` to `b` (both included), searched in their bounding box
    /// grown by `margin`. `contrast` (0..=1) is the gradient below which an edge doesn't count.
    pub fn wire(&self, a: [i64; 2], b: [i64; 2], margin: i64, contrast: f32) -> Vec<[i64; 2]> {
        if self.w == 0 || self.h == 0 {
            return Vec::new();
        }
        let (a, b) = (self.clamp(a), self.clamp(b));
        if a == b {
            return vec![a];
        }
        let m = margin.max(2);
        let x0 = (a[0].min(b[0]) - m).max(0);
        let y0 = (a[1].min(b[1]) - m).max(0);
        let x1 = (a[0].max(b[0]) + m).min(self.w as i64 - 1);
        let y1 = (a[1].max(b[1]) + m).min(self.h as i64 - 1);
        let (ww, wh) = ((x1 - x0 + 1) as usize, (y1 - y0 + 1) as usize);
        if ww.saturating_mul(wh) > MAX_WINDOW {
            return line(a, b);
        }
        // Edge cost per window pixel.
        let mut g: Vec<f32> = Vec::with_capacity(ww * wh);
        for y in y0..=y1 {
            for x in x0..=x1 {
                g.push(self.gradient(x, y));
            }
        }
        let gmax = g.iter().copied().fold(0.0f32, f32::max).max(1e-6);
        let cost: Vec<f32> = g
            .iter()
            .map(|v| {
                let n = v / gmax;
                1.0 - if n < contrast { 0.0 } else { n }
            })
            .collect();
        let idx = |p: [i64; 2]| ((p[1] - y0) as usize) * ww + (p[0] - x0) as usize;
        let (start, goal) = (idx(a), idx(b));
        let mut dist = vec![f32::INFINITY; ww * wh];
        let mut from = vec![u32::MAX; ww * wh];
        let mut heap = BinaryHeap::new();
        dist[start] = 0.0;
        // Non-negative f32 bit patterns order like their values.
        heap.push(Reverse((0.0f32.to_bits(), start as u32)));
        while let Some(Reverse((dbits, i))) = heap.pop() {
            let i = i as usize;
            let d = f32::from_bits(dbits);
            if d > dist[i] {
                continue;
            }
            if i == goal {
                break;
            }
            let (x, y) = ((i % ww) as i64, (i / ww) as i64);
            for (dx, dy, step) in [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)] {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 || nx >= ww as i64 || ny >= wh as i64 {
                    continue;
                }
                let j = ny as usize * ww + nx as usize;
                let nd = d + (STEP_COST + cost[j]) * step;
                if nd < dist[j] {
                    dist[j] = nd;
                    from[j] = i as u32;
                    heap.push(Reverse((nd.to_bits(), j as u32)));
                }
            }
        }
        if from[goal] == u32::MAX {
            return line(a, b);
        }
        let mut path = vec![b];
        let mut i = goal;
        while i != start {
            i = from[i] as usize;
            path.push([x0 + (i % ww) as i64, y0 + (i / ww) as i64]);
        }
        path.reverse();
        path
    }
}

/// A straight pixel line from `a` to `b` (both included).
fn line(a: [i64; 2], b: [i64; 2]) -> Vec<[i64; 2]> {
    let n = (b[0] - a[0]).abs().max((b[1] - a[1]).abs()).max(1);
    (0..=n).map(|k| [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]).collect()
}

/// Length of a pixel path.
pub fn path_length(p: &[[i64; 2]]) -> f64 {
    p.windows(2).map(|w| ((w[1][0] - w[0][0]) as f64).hypot((w[1][1] - w[0][1]) as f64)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A white disc of radius 30 on black, 100 × 100.
    fn disc() -> EdgeImage {
        let (w, h) = (100, 100);
        let px: Vec<[f32; 4]> = (0..w * h)
            .map(|i| {
                let (x, y) = ((i % w) as f32 - 50.0, (i / w) as f32 - 50.0);
                if x.hypot(y) < 30.0 { [1.0; 4] } else { [0.0, 0.0, 0.0, 1.0] }
            })
            .collect();
        EdgeImage::from_rgba(&px, w, h)
    }

    #[test]
    fn snaps_to_the_nearby_edge() {
        let e = disc();
        let s = e.snap([74.0, 50.0], 15.0, 0.1);
        let r = ((s[0] - 50) as f64).hypot((s[1] - 50) as f64);
        assert!((r - 30.0).abs() < 2.0, "{s:?} at radius {r}");
        // Nothing within reach: the point itself.
        assert_eq!(e.snap([5.0, 5.0], 5.0, 0.1), [5, 5]);
    }

    #[test]
    fn the_wire_follows_the_edge_not_the_chord() {
        let e = disc();
        // Two points on the circle a quarter turn apart: the straight chord cuts through the
        // flat inside; the wire bends along the rim.
        let (a, b) = ([80, 50], [50, 80]);
        let w = e.wire(a, b, 12, 0.1);
        assert_eq!((w.first().copied(), w.last().copied()), (Some(a), Some(b)));
        let off_rim = w.iter().map(|p| (((p[0] - 50) as f64).hypot((p[1] - 50) as f64) - 30.0).abs()).fold(0.0f64, f64::max);
        assert!(off_rim < 2.5, "wire left the rim by {off_rim}");
        assert!(path_length(&w) > 42.0 * 1.05, "longer than the chord: it bends");
        // Steps are 8-connected.
        assert!(w.windows(2).all(|s| (s[1][0] - s[0][0]).abs() <= 1 && (s[1][1] - s[0][1]).abs() <= 1));
    }

    #[test]
    fn degenerate_inputs_are_safe() {
        let e = EdgeImage::from_rgba(&[], 0, 0);
        assert!(e.wire([0, 0], [5, 5], 4, 0.1).is_empty());
        let d = disc();
        assert_eq!(d.wire([10, 10], [10, 10], 4, 0.1), vec![[10, 10]]);
        assert_eq!(d.wire([-50, 500], [10, 10], 4, 0.1).first(), Some(&[0, 99]));
    }
}
