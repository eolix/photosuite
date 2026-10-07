//! Filter Gallery › Cutout: the image as flat pieces of coloured paper.
//!
//! A purely geometric method, with nothing that looks at what the picture shows:
//!
//! 1. Each pixel's brightness (the mean of R, G and B) is posterized into Number of Levels equal
//!    bands.
//! 2. The band map is smoothed by a 3×3 majority filter; connected areas of one band are the
//!    regions, and those under a minimum size join the neighbour they share most border with.
//! 3. Each region's outline is traced along the pixel edges and simplified (Douglas–Peucker),
//!    keeping fixed the corners where three or more regions meet so neighbours keep sharing
//!    their edges; the outlines are filled as polygons, largest first.
//! 4. Every region is filled with the mean of the original pixels it covers.
//!
//! Edge Simplicity and Edge Fidelity set the majority passes, the minimum size and the outline
//! tolerance ([`Shape::from_sliders`]), fitted to Photoshop's output across the sliders' ranges.

use std::collections::HashMap;

type Rgb = [f32; 3];

const NONE: u32 = u32::MAX;

// ---- regions ---------------------------------------------------------------------------------

/// Brightness band of every pixel (0..levels), on a 0–255 scale.
fn bands(src: &[Rgb], levels: u32) -> Vec<u8> {
    let lv = levels as f32;
    src.iter().map(|p| (((p[0] + p[1] + p[2]) / 3.0 / 256.0 * lv).floor().clamp(0.0, lv - 1.0)) as u8).collect()
}

/// One 3×3 majority pass: each pixel takes the band most of its neighbourhood has (its own on a
/// tie), edges clamped.
fn majority(labels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = labels.to_vec();
    for y in 0..h {
        for x in 0..w {
            let mut counts = [0u8; 256];
            let mut seen = [0u8; 9];
            let mut n = 0;
            for yy in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    let l = labels[yy * w + xx];
                    if counts[l as usize] == 0 {
                        seen[n] = l;
                        n += 1;
                    }
                    counts[l as usize] += 1;
                }
            }
            let me = labels[y * w + x];
            let mut best = (me, counts[me as usize]);
            for &l in &seen[..n] {
                if counts[l as usize] > best.1 {
                    best = (l, counts[l as usize]);
                }
            }
            out[y * w + x] = best.0;
        }
    }
    out
}

/// 4-connected components of equal `labels`: (component of every pixel, count).
fn components<T: Copy + PartialEq>(labels: &[T], w: usize, h: usize) -> (Vec<u32>, usize) {
    let n = w * h;
    let mut comp = vec![NONE; n];
    let mut stack = Vec::new();
    let mut nc = 0usize;
    for s in 0..n {
        if comp[s] != NONE {
            continue;
        }
        let id = nc as u32;
        nc += 1;
        let lb = labels[s];
        comp[s] = id;
        stack.push(s);
        while let Some(p) = stack.pop() {
            let x = p % w;
            let mut visit = |q: usize| {
                if comp[q] == NONE && labels[q] == lb {
                    comp[q] = id;
                    stack.push(q);
                }
            };
            if x > 0 {
                visit(p - 1);
            }
            if x + 1 < w {
                visit(p + 1);
            }
            if p >= w {
                visit(p - w);
            }
            if p + w < n {
                visit(p + w);
            }
        }
    }
    let _ = h;
    (comp, nc)
}

fn find(par: &mut [u32], mut a: u32) -> u32 {
    while par[a as usize] != a {
        par[a as usize] = par[par[a as usize] as usize];
        a = par[a as usize];
    }
    a
}

/// Regions under `min_area` px join the neighbour they share most border with, smallest first
/// (a few rounds, as joins make new neighbours). Returns compact region ids.
fn absorb_small(comp: &[u32], nc: usize, w: usize, h: usize, min_area: f64) -> Vec<u32> {
    let mut par: Vec<u32> = (0..nc as u32).collect();
    let mut area = vec![0.0f64; nc];
    for &c in comp {
        area[c as usize] += 1.0;
    }
    for _ in 0..4 {
        let mut border: HashMap<(u32, u32), u32> = HashMap::new();
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let a = find(&mut par, comp[i]);
                for j in [(x + 1 < w).then(|| i + 1), (y + 1 < h).then(|| i + w)].into_iter().flatten() {
                    let b = find(&mut par, comp[j]);
                    if a != b && (area[a as usize] < min_area || area[b as usize] < min_area) {
                        *border.entry((a, b)).or_insert(0) += 1;
                        *border.entry((b, a)).or_insert(0) += 1;
                    }
                }
            }
        }
        let mut best: HashMap<u32, (u32, u32)> = HashMap::new();
        for (&(a, b), &n) in &border {
            let e = best.entry(a).or_insert((b, 0));
            if n > e.1 || (n == e.1 && b < e.0) {
                *e = (b, n);
            }
        }
        let mut order: Vec<u32> = (0..nc as u32).filter(|&r| par[r as usize] == r && area[r as usize] < min_area).collect();
        order.sort_by(|a, b| area[*a as usize].total_cmp(&area[*b as usize]).then(a.cmp(b)));
        let mut changed = false;
        for r in order {
            if find(&mut par, r) != r || area[r as usize] >= min_area {
                continue;
            }
            if let Some(&(nb, _)) = best.get(&r) {
                let to = find(&mut par, nb);
                if to != r {
                    par[r as usize] = to;
                    area[to as usize] += area[r as usize];
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    let mut index = vec![NONE; nc];
    let mut next = 0u32;
    comp.iter()
        .map(|&c| {
            let r = find(&mut par, c) as usize;
            if index[r] == NONE {
                index[r] = next;
                next += 1;
            }
            index[r]
        })
        .collect()
}

// ---- outlines --------------------------------------------------------------------------------

/// A traced region outline: its region, polygon (pixel-corner coordinates) and bounding-box
/// area.
struct Outline {
    region: u32,
    points: Vec<[f32; 2]>,
    bbox_area: f32,
}

/// Directions on the pixel-corner lattice: east, south, west, north.
const DIRS: [(i64, i64); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];

/// The outlines of the 4-connected regions of `labels`. Every pixel edge between two regions
/// is walked with its region on the left; at a corner where a region touches itself diagonally
/// the walk turns toward the region, keeping 4-connected regions apart. Only outer outlines are
/// kept: a hole is filled by the region inside it. Each outline is simplified (Douglas–Peucker,
/// `tolerance` px) between the vertices where three or more regions meet (or a region meets the
/// image edge), which stay fixed so neighbours keep sharing their boundaries. Edges are worked
/// out as they are walked, so memory stays at a byte per pixel corner.
fn trace_outlines(labels: &[u32], w: usize, h: usize, tolerance: f32) -> Vec<Outline> {
    let (comp, nc) = components(labels, w, h);
    let mut comp_label = vec![0u32; nc];
    for (i, &c) in comp.iter().enumerate() {
        comp_label[c as usize] = labels[i];
    }
    let (vw, vh) = (w + 1, h + 1);
    let pc = |x: i64, y: i64| if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 { NONE } else { comp[y as usize * w + x as usize] };
    // The region left of the edge leaving vertex (x, y) in direction d, when the edge is a
    // boundary (the pixel on its right is another region or outside).
    let edge = |x: i64, y: i64, d: usize| {
        let (l, r) = match d {
            0 => (pc(x, y - 1), pc(x, y)),
            1 => (pc(x, y), pc(x - 1, y)),
            2 => (pc(x - 1, y), pc(x - 1, y - 1)),
            _ => (pc(x - 1, y - 1), pc(x, y - 1)),
        };
        if l != NONE && l != r { l } else { NONE }
    };
    let junction = |x: i64, y: i64| {
        let around = [pc(x - 1, y - 1), pc(x, y - 1), pc(x - 1, y), pc(x, y)];
        (0..4).filter(|&k| !around[..k].contains(&around[k])).count() >= 3
    };
    let mut visited = vec![0u8; vw * vh];
    let mut out = Vec::new();
    for v0 in 0..vw * vh {
        for d0 in 0..4 {
            if visited[v0] & (1 << d0) != 0 {
                continue;
            }
            let (x0, y0) = ((v0 % vw) as i64, (v0 / vw) as i64);
            let c = edge(x0, y0, d0);
            if c == NONE {
                continue;
            }
            // Walk the loop, keeping the vertices where the direction changes and the junctions.
            let mut pts: Vec<([f32; 2], bool)> = Vec::new();
            let (mut x, mut y, mut d) = (x0, y0, d0);
            let mut guard = 0usize;
            loop {
                visited[y as usize * vw + x as usize] |= 1 << d;
                let (nx, ny) = (x + DIRS[d].0, y + DIRS[d].1);
                if nx < 0 || ny < 0 || nx >= vw as i64 || ny >= vh as i64 {
                    break;
                }
                let Some(nd) = [(d + 3) % 4, d, (d + 1) % 4].into_iter().find(|&nd| edge(nx, ny, nd) == c) else { break };
                let j = junction(nx, ny);
                if nd != d || j {
                    pts.push(([nx as f32, ny as f32], j));
                }
                (x, y, d) = (nx, ny, nd);
                guard += 1;
                if (x, y, d) == (x0, y0, d0) || guard > 4 * vw * vh {
                    break;
                }
            }
            if pts.len() < 3 {
                continue;
            }
            let poly: Vec<[f32; 2]> = pts.iter().map(|p| p.0).collect();
            // Outer outlines run one way round, holes the other.
            let twice_area: f32 = (0..poly.len())
                .map(|i| {
                    let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
                    p[0] * q[1] - q[0] * p[1]
                })
                .sum();
            if twice_area >= 0.0 {
                continue;
            }
            let anchors: Vec<bool> = pts.iter().map(|p| p.1).collect();
            let points = simplify_closed(&poly, &anchors, tolerance);
            let (mut lo, mut hi) = ([f32::INFINITY; 2], [f32::NEG_INFINITY; 2]);
            for p in &points {
                lo = [lo[0].min(p[0]), lo[1].min(p[1])];
                hi = [hi[0].max(p[0]), hi[1].max(p[1])];
            }
            out.push(Outline { region: comp_label[c as usize], points, bbox_area: (hi[0] - lo[0]) * (hi[1] - lo[1]) });
        }
    }
    out
}

/// Douglas–Peucker on a closed polygon, keeping every `anchor` vertex (or, with none, the first
/// vertex and the one farthest from it).
fn simplify_closed(poly: &[[f32; 2]], anchor: &[bool], tolerance: f32) -> Vec<[f32; 2]> {
    let n = poly.len();
    let mut keep_at: Vec<usize> = (0..n).filter(|&i| anchor[i]).collect();
    if keep_at.is_empty() {
        let far = (0..n).max_by(|&a, &b| dist2(poly[0], poly[a]).total_cmp(&dist2(poly[0], poly[b]))).unwrap_or(0);
        keep_at = if far == 0 { vec![0] } else { vec![0, far] };
    }
    let mut keep = vec![false; n];
    for &k in &keep_at {
        keep[k] = true;
    }
    for (s, &a) in keep_at.iter().enumerate() {
        let b = keep_at[(s + 1) % keep_at.len()];
        // The run of vertices from a to b (going round), b included.
        let len = (b + n - a) % n;
        let len = if len == 0 { n } else { len };
        let run: Vec<usize> = (0..=len).map(|k| (a + k) % n).collect();
        douglas_peucker(poly, &run, tolerance, &mut keep);
    }
    (0..n).filter(|&i| keep[i]).map(|i| poly[i]).collect()
}

fn dist2(p: [f32; 2], q: [f32; 2]) -> f32 {
    (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)
}

/// Marks the vertices of `run` (indices into `poly`, endpoints kept) that Douglas–Peucker keeps.
fn douglas_peucker(poly: &[[f32; 2]], run: &[usize], tolerance: f32, keep: &mut [bool]) {
    let mut stack = vec![(0usize, run.len().saturating_sub(1))];
    while let Some((s, e)) = stack.pop() {
        if e <= s + 1 {
            continue;
        }
        let (a, b) = (poly[run[s]], poly[run[e]]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = (dx * dx + dy * dy).sqrt();
        let mut far = (s, -1.0f32);
        for (k, &idx) in run.iter().enumerate().take(e).skip(s + 1) {
            let p = poly[idx];
            let d = if len < 1e-6 { dist2(p, a).sqrt() } else { ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len };
            if d > far.1 {
                far = (k, d);
            }
        }
        if far.1 > tolerance {
            keep[run[far.0]] = true;
            stack.push((s, far.0));
            stack.push((far.0, e));
        }
    }
}

/// Even-odd scanline fill of a polygon (pixel centres sampled) with `value`: each edge adds its
/// crossings to the rows it spans, so the cost follows the outline's length and height, not
/// their product.
fn fill_polygon<T: Copy>(out: &mut [T], w: usize, h: usize, pts: &[[f32; 2]], value: T) {
    let n = pts.len();
    if n < 3 || w == 0 || h == 0 {
        return;
    }
    let (mut min_y, mut max_y) = (f32::INFINITY, f32::NEG_INFINITY);
    for p in pts {
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    let first = (min_y - 0.5).ceil().max(0.0);
    let last = ((max_y - 0.5).ceil() - 1.0).min(h as f32 - 1.0);
    if !(first.is_finite() && last.is_finite()) || last < first {
        return;
    }
    let (first, last) = (first as usize, last as usize);
    let mut rows: Vec<Vec<f32>> = vec![Vec::new(); last - first + 1];
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        if a[1] == b[1] {
            continue;
        }
        let (lo, hi) = (a[1].min(b[1]), a[1].max(b[1]));
        // Rows whose centre y + 0.5 lies in [lo, hi).
        let y0 = ((lo - 0.5).ceil().max(first as f32)) as usize;
        let y1 = (hi - 0.5).ceil() - 1.0;
        if y1 < y0 as f32 {
            continue;
        }
        for y in y0..=(y1 as usize).min(last) {
            let sy = y as f32 + 0.5;
            rows[y - first].push(a[0] + (sy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
    }
    for (k, xs) in rows.iter_mut().enumerate() {
        xs.sort_by(f32::total_cmp);
        let y = first + k;
        for pair in xs.chunks_exact(2) {
            let x0 = (pair[0] - 0.5).ceil().max(0.0) as usize;
            let x1 = (pair[1] - 0.5).floor().min(w as f32 - 1.0);
            if x1 < 0.0 {
                continue;
            }
            for x in x0..=x1 as usize {
                out[y * w + x] = value;
            }
        }
    }
}

// ---- the filter ------------------------------------------------------------------------------

/// Cutout over a `w × h` sRGB image (0..1). `levels` 2–8 (Number of Levels), `simplicity` 0–10
/// (Edge Simplicity), `fidelity` 1–3 (Edge Fidelity).
pub fn cutout(src: &[[f32; 3]], w: usize, h: usize, levels: f32, simplicity: f32, fidelity: f32) -> Vec<[f32; 3]> {
    if w == 0 || h == 0 || src.len() < w * h {
        return src.to_vec();
    }
    let levels = if levels.is_finite() { levels.round().clamp(2.0, 8.0) as u32 } else { 4 };
    let simplicity = if simplicity.is_finite() { simplicity.round().clamp(0.0, 10.0) } else { 4.0 };
    let fidelity = if fidelity.is_finite() { fidelity.round().clamp(1.0, 3.0) } else { 2.0 };
    let s = Shape::from_sliders(levels, simplicity, fidelity);
    cutout_shaped(src, w, h, levels, s)
}

/// How Edge Simplicity and Edge Fidelity shape the regions.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Shape {
    /// 3×3 majority passes on the band map.
    pub passes: u32,
    /// Smallest region kept, in pixels.
    pub min_area: f64,
    /// Outline simplification tolerance, in pixels.
    pub tolerance: f32,
}

impl Shape {
    /// Fitted to Photoshop's output at seven slider settings (levels 2 / 4 / 8, simplicity
    /// 0 / 4 / 10, fidelity 1 / 2 / 3): the smallest region stays near 30 px over most of the
    /// simplicity range and climbs steeply toward 10; the outline tolerance grows with its cube;
    /// higher fidelity divides both (by the square of fidelity / 2); and more levels (finer
    /// bands) keep smaller regions (the minimum scales by 4 / levels).
    fn from_sliders(levels: u32, simplicity: f32, fidelity: f32) -> Self {
        let k = (2.0 / fidelity).powi(2);
        Shape {
            passes: ((simplicity / 2.0).round() as u32).min(2),
            min_area: (30.0 + 3e-4 * f64::from(simplicity).powi(8)) * f64::from(k) * 4.0 / f64::from(levels.max(1)),
            tolerance: 0.02 * simplicity.powi(3) * k,
        }
    }
}

pub(crate) fn cutout_shaped(src: &[[f32; 3]], w: usize, h: usize, levels: u32, shape: Shape) -> Vec<[f32; 3]> {
    let full: Vec<Rgb> = src[..w * h].iter().map(|p| [p[0] * 255.0, p[1] * 255.0, p[2] * 255.0]).collect();

    let mut band = bands(&full, levels);
    for _ in 0..shape.passes {
        band = majority(&band, w, h);
    }
    let (comp, nc) = components(&band, w, h);
    let regions = absorb_small(&comp, nc, w, h, shape.min_area);

    let mut ids = regions.clone();
    let mut outlines = trace_outlines(&regions, w, h, shape.tolerance);
    outlines.sort_by(|a, b| b.bbox_area.total_cmp(&a.bbox_area));
    for o in &outlines {
        fill_polygon(&mut ids, w, h, &o.points, o.region);
    }

    let count = ids.iter().copied().max().map_or(0, |m| m as usize + 1);
    let mut sum = vec![[0.0f64; 3]; count];
    let mut n = vec![0u64; count];
    for (&id, p) in ids.iter().zip(&full) {
        let s = &mut sum[id as usize];
        *s = [s[0] + f64::from(p[0]), s[1] + f64::from(p[1]), s[2] + f64::from(p[2])];
        n[id as usize] += 1;
    }
    let colour: Vec<Rgb> = sum.iter().zip(&n).map(|(s, &c)| if c == 0 { [0.0; 3] } else { s.map(|v| (v / c as f64 / 255.0) as f32) }).collect();
    ids.iter().map(|&id| colour[id as usize]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// A test picture: a dark ground with a red disc, a blue square and a noisy green band.
    fn picture(w: usize, h: usize) -> Vec<Rgb> {
        let mut v = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
                let noise = ((x * 7919 + y * 104_729) % 97) as f32 / 97.0 * 0.06;
                let p = if (fx - 0.3).powi(2) + (fy - 0.4).powi(2) < 0.04 {
                    [0.85, 0.15 + noise, 0.12]
                } else if fx > 0.6 && fx < 0.85 && fy > 0.2 && fy < 0.6 {
                    [0.15, 0.3, 0.8 + noise * 0.5]
                } else if fy > 0.75 {
                    [0.2 + noise, 0.6 + noise, 0.25]
                } else {
                    [0.06 + noise * 0.3, 0.06, 0.08]
                };
                v.push(p);
            }
        }
        v
    }

    fn distinct(px: &[Rgb]) -> usize {
        px.iter().map(|p| p.map(|v| (v * 255.0).round() as i32)).collect::<HashSet<_>>().len()
    }

    #[test]
    fn flat_regions_filled_with_their_mean_colour() {
        let (w, h) = (160, 120);
        let src = picture(w, h);
        let out = cutout(&src, w, h, 4.0, 4.0, 2.0);
        assert_eq!(out.len(), w * h);
        assert!(distinct(&out) <= 12, "flat regions: {} colours", distinct(&out));
        assert!(distinct(&src) > 40);
        let at = |x: usize, y: usize| out[y * w + x];
        let red = at(48, 48);
        assert!(red[0] > red[1] + 0.3 && red[0] > red[2] + 0.3, "{red:?}");
        let blue = at(115, 48);
        assert!(blue[2] > blue[0] + 0.3, "{blue:?}");
        let green = at(80, 110);
        assert!(green[1] > green[0] + 0.2 && green[1] > green[2] + 0.2, "{green:?}");
    }

    /// Number of Levels: more bands, more regions.
    #[test]
    fn more_levels_keep_more_detail() {
        let (w, h) = (120, 90);
        let src: Vec<Rgb> = (0..w * h).map(|i| [(i % w) as f32 / w as f32; 3]).collect();
        let few = distinct(&cutout(&src, w, h, 2.0, 0.0, 2.0));
        let many = distinct(&cutout(&src, w, h, 8.0, 0.0, 2.0));
        assert_eq!((few, many), (2, 8), "a horizontal ramp posterized into 2 and 8 bands");
    }

    #[test]
    fn deterministic_and_every_parameter_is_usable() {
        let (w, h) = (90, 70);
        let src = picture(w, h);
        assert_eq!(cutout(&src, w, h, 4.0, 4.0, 2.0), cutout(&src, w, h, 4.0, 4.0, 2.0));
        for (l, s, f) in [(2.0, 0.0, 1.0), (8.0, 10.0, 3.0), (f32::NAN, f32::INFINITY, -5.0), (100.0, -3.0, 99.0)] {
            let out = cutout(&src, w, h, l, s, f);
            assert_eq!(out.len(), w * h);
            assert!(out.iter().flatten().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "{l} {s} {f}");
        }
    }

    #[test]
    fn odd_sizes_never_panic() {
        for (w, h) in [(1, 1), (1, 9), (9, 1), (2, 2), (3, 50)] {
            let src = picture(w, h);
            assert_eq!(cutout(&src, w, h, 4.0, 4.0, 2.0).len(), w * h, "{w}x{h}");
        }
        assert!(cutout(&[], 0, 0, 4.0, 4.0, 2.0).is_empty());
        assert_eq!(cutout(&[[0.5; 3]; 3], 4, 4, 4.0, 4.0, 2.0).len(), 3, "short input is returned as is");
    }

    #[test]
    fn outlines_cover_their_regions_and_share_edges() {
        // Two regions side by side and a third inside the first.
        let (w, h) = (20, 10);
        let labels: Vec<u32> = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                if (3..6).contains(&x) && (3..6).contains(&y) {
                    2
                } else if x < 10 {
                    0
                } else {
                    1
                }
            })
            .collect();
        let outlines = trace_outlines(&labels, w, h, 0.6);
        let regions: HashSet<u32> = outlines.iter().map(|o| o.region).collect();
        assert_eq!(regions, HashSet::from([0, 1, 2]), "one outer outline per region");
        assert_eq!(outlines.len(), 3, "no hole outlines");
        // Filling them largest first reproduces the label image exactly.
        let mut sorted: Vec<&Outline> = outlines.iter().collect();
        sorted.sort_by(|a, b| b.bbox_area.total_cmp(&a.bbox_area));
        let mut img = vec![9u32; w * h];
        for o in sorted {
            fill_polygon(&mut img, w, h, &o.points, o.region);
        }
        assert_eq!(img, labels);
    }

    #[test]
    fn a_region_touching_itself_diagonally_traces_cleanly() {
        // A ring whose corner pixels touch diagonally, and a checkerboard (every pixel its own
        // 4-connected region).
        let (w, h) = (6, 6);
        let labels: Vec<u32> = (0..w * h).map(|i| ((i % w + i / w) % 2) as u32).collect();
        let outlines = trace_outlines(&labels, w, h, 0.0);
        assert_eq!(outlines.len(), w * h, "one outline per square");
        assert!(outlines.iter().all(|o| o.points.len() == 4), "each a square");
    }

    #[test]
    fn small_regions_join_their_longest_neighbour() {
        // A 1-pixel speck always goes; a 12×12 block (144 px) stays at simplicity 4 and goes at
        // 10, where the minimum region is far larger.
        let (w, h) = (60, 60);
        let mut src = vec![[0.1f32; 3]; w * h];
        src[5 * w + 5] = [0.9; 3];
        assert_eq!(distinct(&cutout(&src, w, h, 2.0, 0.0, 2.0)), 1, "the speck is absorbed");
        for y in 30..42 {
            for x in 30..42 {
                src[y * w + x] = [0.9; 3];
            }
        }
        assert_eq!(distinct(&cutout(&src, w, h, 2.0, 4.0, 2.0)), 2, "the block stays");
        assert_eq!(distinct(&cutout(&src, w, h, 2.0, 10.0, 2.0)), 1, "and goes at simplicity 10");
    }
}

#[cfg(test)]
mod reference {
    /// Compares against a Photoshop render: `CUTOUT_SRC` and `CUTOUT_REF` are binary PPMs of the
    /// same size (the source, and Photoshop's Cutout of it); `CUTOUT_SETTINGS` its sliders as
    /// "levels/simplicity/fidelity" (default 4/4/2); `CUTOUT_OUT` (optional) receives ours.
    /// Prints the mean absolute difference per channel, in 0–255 levels.
    /// `cargo test -p photosuite-algo --release --lib cutout::reference -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a Photoshop reference render"]
    fn against_photoshop() {
        let (Ok(src), Ok(rf)) = (std::env::var("CUTOUT_SRC"), std::env::var("CUTOUT_REF")) else { return };
        let read = |p: &str| {
            let b = std::fs::read(p).unwrap();
            let mut toks = Vec::new();
            let mut i = 0;
            while toks.len() < 4 {
                while b[i].is_ascii_whitespace() {
                    i += 1;
                }
                let j = i;
                while !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                toks.push(String::from_utf8_lossy(&b[j..i]).to_string());
            }
            let (w, h): (usize, usize) = (toks[1].parse().unwrap(), toks[2].parse().unwrap());
            let px: Vec<[f32; 3]> = b[i + 1..].chunks_exact(3).map(|c| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0]).collect();
            (w, h, px)
        };
        let settings = std::env::var("CUTOUT_SETTINGS").unwrap_or_else(|_| "4/4/2".into());
        let v: Vec<f32> = settings.split('/').map(|s| s.parse().unwrap()).collect();
        let (w, h, s) = read(&src);
        let (_, _, r) = read(&rf);
        let clock = std::time::Instant::now();
        let mut shape = super::Shape::from_sliders(v[0] as u32, v[1], v[2]);
        let env = |k: &str| std::env::var(k).ok().and_then(|x| x.parse::<f64>().ok());
        if let Some(x) = env("CUT_PASSES") {
            shape.passes = x as u32;
        }
        if let Some(x) = env("CUT_MIN_AREA") {
            shape.min_area = x;
        }
        if let Some(x) = env("CUT_TOL") {
            shape.tolerance = x as f32;
        }
        let out = super::cutout_shaped(&s, w, h, v[0] as u32, shape);
        let ms = clock.elapsed().as_secs_f64() * 1000.0;
        let diff: f64 = out.iter().zip(&r).map(|(a, b)| (0..3).map(|c| f64::from((a[c] - b[c]).abs()) * 255.0).sum::<f64>()).sum::<f64>() / (w * h * 3) as f64;
        eprintln!("{settings}: mean abs diff vs Photoshop {diff:.2} levels ({ms:.0} ms)");
        if let Ok(o) = std::env::var("CUTOUT_OUT") {
            let mut b = format!("P6 {w} {h} 255\n").into_bytes();
            for p in &out {
                b.extend(p.iter().map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8));
            }
            std::fs::write(o, b).unwrap();
        }
    }
}

#[cfg(test)]
mod bench {
    /// `cargo test -p photosuite-algo --release --lib cutout::bench -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark"]
    fn cutout_24mp() {
        let (w, h) = (6000, 4000);
        let src: Vec<[f32; 3]> = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                let n = ((x * 7919 + y * 104_729) % 97) as f32 / 97.0 * 0.08;
                [(x as f32 / w as f32) * 0.8 + n, (y as f32 / h as f32) * 0.7, 0.3 + n]
            })
            .collect();
        let clock = std::time::Instant::now();
        let out = super::cutout(&src, w, h, 4.0, 4.0, 2.0);
        eprintln!("cutout 6000x4000: {:.2} s", clock.elapsed().as_secs_f64());
        assert_eq!(out.len(), w * h);
    }
}
